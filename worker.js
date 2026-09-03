/**
 * CSM DRIVE | ULTRA PRO — Cloudflare Worker
 * worker.js
 *
 * ================================================================
 *  ROUTES
 * ================================================================
 *   GET  /drive/:fileId            — Stream private Google Drive file (token required)
 *   GET  /drive/:fileId/thumb      — Thumbnail redirect (token required)
 *   GET  /drive/:fileId?dl=1       — Force-download header
 *
 *   POST /cloudinary/upload        — Upload a photo/video (multipart/form-data, "file" field)
 *   POST /cloudinary/delete        — Delete a photo/video from Cloudinary + adjust usage
 *   POST /cloudinary/sync-usage    — Re-read real usage from Cloudinary and fix Firebase counters
 *
 * ================================================================
 *  WHY THIS FILE CHANGED (multi-Cloudinary system)
 * ================================================================
 *  Before: the browser uploaded directly to Cloudinary using an UNSIGNED
 *  upload preset. That only works with ONE fixed cloud_name — there was
 *  no way to pick between several accounts, and no way to enforce that
 *  only YOU (not anyone with the preset name) can upload/delete.
 *
 *  Now: the browser never talks to Cloudinary directly. It sends the
 *  file to this Worker with your Firebase ID token attached. The Worker:
 *    1. Verifies the token really belongs to your Firebase user (UID
 *       check, not just "is it a valid Firebase token").
 *    2. Reads live usage numbers from Firebase Realtime Database to
 *       decide WHICH Cloudinary account (of 2-4 configured) should
 *       receive this upload — the first one still under 70% full.
 *    3. Uploads to Cloudinary using a SIGNED upload (api_key + api_secret
 *       stay in this Worker's secrets, never sent to the browser).
 *    4. Writes the new usage total back to Firebase.
 *  Deletes work the same way in reverse: Worker deletes from Cloudinary,
 *  then subtracts the file's size from that account's Firebase counter.
 *
 * ================================================================
 *  ENVIRONMENT VARIABLES  (Cloudflare dashboard → Worker → Settings → Variables and Secrets)
 * ================================================================
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — (existing, for Drive) service account email
 *   GOOGLE_PRIVATE_KEY            — (existing, for Drive) service account private key (PEM)
 *   FIREBASE_PROJECT_ID           — your Firebase project ID, e.g. "photos-58c8e"
 *   FIREBASE_DB_URL               — your Realtime Database URL,
 *                                    e.g. "https://photos-58c8e-default-rtdb.firebaseio.com"
 *   ALLOWED_UID                   — YOUR Firebase Auth user UID (Firebase console →
 *                                    Authentication → Users → copy the "User UID" column).
 *                                    Any request whose token UID doesn't match this is
 *                                    rejected with 403, even if the token is a perfectly
 *                                    valid Firebase token for some OTHER account.
 *   ALLOWED_ORIGIN                 — your GitHub Pages URL, e.g. "https://csm-storage.github.io"
 *   CLOUDINARY_ACCOUNTS  (SECRET)  — JSON array, one entry per Cloudinary account:
 *       [
 *         { "id":"account1", "cloud_name":"dgxbcqtly", "api_key":"...", "api_secret":"..." },
 *         { "id":"account2", "cloud_name":"dx7aankx2", "api_key":"...", "api_secret":"..." }
 *       ]
 *     The "id" here must match the key you use under cloudinary_accounts/ in Firebase
 *     (see the deployment guide). Order in this array = priority order for filling.
 *
 *  This file needs the "jose" npm package (for JWT verification) bundled at deploy
 *  time — see the deployment guide for `npm install jose`.
 */

import { importX509, jwtVerify, decodeProtectedHeader } from 'jose';

const GOOGLE_CERTS_URL =
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const USAGE_THRESHOLD = 0.70; // 70% — matches the plan described in the request

/* ─── Entry ───────────────────────────────────────────────────── */
export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return corsResponse('', 204, env);

        const url  = new URL(request.url);
        const path = url.pathname;

        try {
            if (path.startsWith('/drive/'))            return await handleDrive(request, url, env);
            if (path === '/cloudinary/upload')          return await handleCloudinaryUpload(request, env);
            if (path === '/cloudinary/delete')          return await handleCloudinaryDelete(request, env);
            if (path === '/cloudinary/sync-usage')       return await handleSyncUsage(request, env);
        } catch (e) {
            console.error('Unhandled error:', e);
            return jsonResponse({ error: e.message || 'Server error' }, 500, env);
        }

        return corsResponse('Not found', 404, env);
    }
};

/* ════════════════════════════════════════════════════════════════
   AUTH — shared Firebase ID token verification (uses jose)
   ════════════════════════════════════════════════════════════════ */

/**
 * Verifies a Firebase ID token's signature + standard claims.
 * If requireOwnerUid is true, ALSO requires payload.sub === env.ALLOWED_UID.
 * Throws on any failure — callers should catch and return 401/403.
 */
async function verifyFirebaseIdToken(idToken, env, { requireOwnerUid = true } = {}) {
    if (!idToken) throw new AuthError('No token provided', 401);

    let kid;
    try {
        ({ kid } = decodeProtectedHeader(idToken));
    } catch {
        throw new AuthError('Malformed token', 401);
    }
    if (!kid) throw new AuthError('Token missing key id', 401);

    const certsRes = await fetch(GOOGLE_CERTS_URL);
    if (!certsRes.ok) throw new AuthError('Could not fetch verification keys', 500);
    const certs = await certsRes.json();
    const pem = certs[kid];
    if (!pem) throw new AuthError('Unknown signing key', 401);

    const publicKey = await importX509(pem, 'RS256');

    let payload;
    try {
        ({ payload } = await jwtVerify(idToken, publicKey, {
            issuer:   `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
            audience: env.FIREBASE_PROJECT_ID,
        }));
    } catch {
        throw new AuthError('Token verification failed', 401);
    }

    if (requireOwnerUid && payload.sub !== env.ALLOWED_UID) {
        throw new AuthError('Forbidden — UID mismatch', 403);
    }

    return payload; // includes .sub (uid), .email, etc.
}

class AuthError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

function getBearerToken(request) {
    const h = request.headers.get('Authorization') || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/* ════════════════════════════════════════════════════════════════
   GOOGLE DRIVE ROUTES (existing feature — logic unchanged, now
   sharing the jose-based verifier above instead of the old
   hand-rolled crypto.subtle verification)
   ════════════════════════════════════════════════════════════════ */

async function handleDrive(request, url, env) {
    const parts   = url.pathname.replace('/drive/', '').split('/');
    const fileId   = parts[0];
    const isThumb  = parts[1] === 'thumb';
    if (!fileId) return corsResponse('Missing file ID', 400, env);

    // Drive route historically accepted the token as a query param
    // (since <img> / <video> tags can't set Authorization headers).
    const token = url.searchParams.get('token');
    try {
        // Drive access just needs a valid token for your Firebase project,
        // not necessarily a UID match — kept as before to avoid breaking
        // any existing Drive links. Tighten with requireOwnerUid:true if
        // you want Drive locked to your UID specifically too.
        await verifyFirebaseIdToken(token, env, { requireOwnerUid: false });
    } catch (e) {
        return corsResponse(`Unauthorized: ${e.message}`, e.status || 401, env);
    }

    let gToken;
    try {
        gToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);
    } catch (e) {
        return corsResponse('Server error: ' + e.message, 500, env);
    }

    if (isThumb) {
        const metaRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`,
            { headers: { Authorization: `Bearer ${gToken}` } }
        );
        if (!metaRes.ok) return corsResponse('Drive error', 502, env);
        const meta = await metaRes.json();
        const thumb = meta.thumbnailLink || '';
        if (!thumb) return corsResponse('No thumbnail', 404, env);
        return Response.redirect(thumb.replace('=s220', '=s400'), 302);
    }

    const dl = url.searchParams.get('dl') === '1';
    const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${gToken}` } }
    );
    if (!driveRes.ok) return corsResponse(`Drive error: ${driveRes.status}`, 502, env);

    const headers = {
        'Content-Type':  driveRes.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    };
    if (dl) {
        const filename = url.searchParams.get('name') || fileId;
        headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }
    return new Response(driveRes.body, { status: 200, headers });
}

/* ════════════════════════════════════════════════════════════════
   CLOUDINARY — multi-account config helper
   ════════════════════════════════════════════════════════════════ */

function getCloudinaryAccounts(env) {
    let accounts;
    try {
        accounts = JSON.parse(env.CLOUDINARY_ACCOUNTS);
    } catch {
        throw new Error('CLOUDINARY_ACCOUNTS secret is missing or not valid JSON');
    }
    if (!Array.isArray(accounts) || !accounts.length) {
        throw new Error('CLOUDINARY_ACCOUNTS must be a non-empty array');
    }
    return accounts;
}

/* ════════════════════════════════════════════════════════════════
   FIREBASE REALTIME DATABASE — usage tracking helpers
   These reuse the SAME Firebase ID token the browser already sent
   (it's just forwarded as ?auth=<idToken> to the RTDB REST API).
   No separate service account is needed for this part — your
   existing database rules already trust this user, since the rest
   of the app reads/writes with the same token via the SDK.
   ════════════════════════════════════════════════════════════════ */

async function fbGet(path, idToken, env) {
    const res = await fetch(`${env.FIREBASE_DB_URL}/${path}.json?auth=${idToken}`);
    if (!res.ok) throw new Error(`Firebase read failed (${res.status})`);
    return res.json();
}

async function fbIncrement(path, deltaMb, idToken, env) {
    // Firebase RTDB supports atomic server-side increments via the
    // special ".sv" (server value) object — avoids read-then-write races.
    const res = await fetch(`${env.FIREBASE_DB_URL}/${path}.json?auth=${idToken}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ '.sv': { increment: deltaMb } }),
    });
    if (!res.ok) throw new Error(`Firebase usage update failed (${res.status})`);
}

async function fbSet(path, value, idToken, env) {
    const res = await fetch(`${env.FIREBASE_DB_URL}/${path}.json?auth=${idToken}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`Firebase write failed (${res.status})`);
}

/**
 * Picks which Cloudinary account a new upload should go to.
 * Rule (matches the spec): fill accounts in configured order; once an
 * account crosses 70% used, move on to the next one. If every account
 * is >=70%, fall back to whichever is least-full (still <100%) so
 * uploads keep working, and flag it as "near_capacity". If everything
 * is >=100%, refuse — the person needs to add another account.
 */
function pickAccount(accountsConfig, usageData) {
    const withRatio = accountsConfig.map(acc => {
        const u = usageData?.[acc.id] || {};
        const usedMb  = Number(u.used_mb)  || 0;
        const limitMb = Number(u.limit_mb) || 20000; // fallback ~20GB if unset
        return { ...acc, usedMb, limitMb, ratio: limitMb > 0 ? usedMb / limitMb : 1 };
    });

    const underThreshold = withRatio.filter(a => a.ratio < USAGE_THRESHOLD);
    if (underThreshold.length) return { account: underThreshold[0], nearCapacity: false };

    const notFull = withRatio.filter(a => a.ratio < 1);
    if (notFull.length) {
        notFull.sort((a, b) => a.ratio - b.ratio);
        return { account: notFull[0], nearCapacity: true };
    }

    return { account: null, nearCapacity: true };
}

/* ════════════════════════════════════════════════════════════════
   POST /cloudinary/upload
   ════════════════════════════════════════════════════════════════ */

async function handleCloudinaryUpload(request, env) {
    if (request.method !== 'POST') return corsResponse('Method not allowed', 405, env);

    const idToken = getBearerToken(request);
    let uid;
    try {
        ({ sub: uid } = await verifyFirebaseIdToken(idToken, env, { requireOwnerUid: true }));
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 401, env);
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
        return jsonResponse({ error: 'No file provided' }, 400, env);
    }

    let accountsConfig;
    try { accountsConfig = getCloudinaryAccounts(env); }
    catch (e) { return jsonResponse({ error: e.message }, 500, env); }

    const usageData = await fbGet('cloudinary_accounts', idToken, env);
    const { account, nearCapacity } = pickAccount(accountsConfig, usageData);

    if (!account) {
        return jsonResponse({
            error: 'All connected Cloudinary accounts are full. Add another account (CLOUDINARY_ACCOUNTS secret) and register it under cloudinary_accounts/ in Firebase.'
        }, 507, env);
    }

    // ─── Signed upload directly to Cloudinary (credentials never leave the Worker) ───
    const timestamp = Math.floor(Date.now() / 1000);
    const signature  = await cloudinarySignature({ timestamp }, account.api_secret);

    const cForm = new FormData();
    cForm.append('file', file, file.name || 'upload');
    cForm.append('api_key', account.api_key);
    cForm.append('timestamp', String(timestamp));
    cForm.append('signature', signature);

    const cRes = await fetch(`https://api.cloudinary.com/v1_1/${account.cloud_name}/auto/upload`, {
        method: 'POST',
        body: cForm,
    });
    const cData = await cRes.json();
    if (!cRes.ok) {
        return jsonResponse({ error: cData?.error?.message || 'Cloudinary upload failed' }, 502, env);
    }

    const bytesMb = (cData.bytes || 0) / 1024 / 1024;
    try {
        await fbIncrement(`cloudinary_accounts/${account.id}/used_mb`, bytesMb, idToken, env);
    } catch (e) {
        console.error('Usage increment failed (upload still succeeded):', e.message);
    }

    return jsonResponse({
        secure_url:    cData.secure_url,
        publicId:      cData.public_id,
        resourceType:  cData.resource_type,
        bytes:         cData.bytes,
        account:       account.id,
        cloud_name:    account.cloud_name,
        nearCapacity,
    }, 200, env);
}

/* ════════════════════════════════════════════════════════════════
   POST /cloudinary/delete
   Body: { "publicId": "...", "account": "account1", "resourceType": "image", "sizeMb": 1.23 }
   ════════════════════════════════════════════════════════════════ */

async function handleCloudinaryDelete(request, env) {
    if (request.method !== 'POST') return corsResponse('Method not allowed', 405, env);

    const idToken = getBearerToken(request);
    try {
        await verifyFirebaseIdToken(idToken, env, { requireOwnerUid: true });
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 401, env);
    }

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, env); }
    const { publicId, account: accountId, resourceType = 'image', sizeMb = 0 } = body;
    if (!publicId || !accountId) {
        return jsonResponse({ error: 'publicId and account are required' }, 400, env);
    }

    let accountsConfig;
    try { accountsConfig = getCloudinaryAccounts(env); }
    catch (e) { return jsonResponse({ error: e.message }, 500, env); }

    const account = accountsConfig.find(a => a.id === accountId);
    if (!account) return jsonResponse({ error: `Unknown account "${accountId}"` }, 400, env);

    const timestamp = Math.floor(Date.now() / 1000);
    const signature  = await cloudinarySignature({ timestamp, public_id: publicId }, account.api_secret);

    const cForm = new FormData();
    cForm.append('public_id', publicId);
    cForm.append('api_key', account.api_key);
    cForm.append('timestamp', String(timestamp));
    cForm.append('signature', signature);

    const cRes = await fetch(
        `https://api.cloudinary.com/v1_1/${account.cloud_name}/${resourceType}/destroy`,
        { method: 'POST', body: cForm }
    );
    const cData = await cRes.json();
    if (!cRes.ok || (cData.result !== 'ok' && cData.result !== 'not found')) {
        return jsonResponse({ error: cData?.error?.message || 'Cloudinary delete failed' }, 502, env);
    }

    if (sizeMb > 0) {
        try {
            await fbIncrement(`cloudinary_accounts/${accountId}/used_mb`, -sizeMb, getBearerToken(request), env);
        } catch (e) {
            console.error('Usage decrement failed (delete still succeeded):', e.message);
        }
    }

    return jsonResponse({ ok: true, result: cData.result }, 200, env);
}

/* ════════════════════════════════════════════════════════════════
   POST /cloudinary/sync-usage
   Recalculates used_mb for every configured account straight from
   Cloudinary's own Admin "usage" endpoint, and overwrites the
   Firebase counters — fixes any drift from the incremental counters.
   Call this occasionally (e.g. from a "Recalculate" button in Settings).
   ════════════════════════════════════════════════════════════════ */

async function handleSyncUsage(request, env) {
    if (request.method !== 'POST') return corsResponse('Method not allowed', 405, env);

    const idToken = getBearerToken(request);
    try {
        await verifyFirebaseIdToken(idToken, env, { requireOwnerUid: true });
    } catch (e) {
        return jsonResponse({ error: e.message }, e.status || 401, env);
    }

    let accountsConfig;
    try { accountsConfig = getCloudinaryAccounts(env); }
    catch (e) { return jsonResponse({ error: e.message }, 500, env); }

    const results = [];
    for (const account of accountsConfig) {
        try {
            const basicAuth = btoa(`${account.api_key}:${account.api_secret}`);
            const uRes = await fetch(`https://api.cloudinary.com/v1_1/${account.cloud_name}/usage`, {
                headers: { Authorization: `Basic ${basicAuth}` },
            });
            const uData = await uRes.json();
            if (!uRes.ok) throw new Error(uData?.error?.message || `HTTP ${uRes.status}`);

            const usedMb = (uData.storage?.usage || 0) / 1024 / 1024;
            await fbSet(`cloudinary_accounts/${account.id}/used_mb`, Math.round(usedMb * 100) / 100, idToken, env);
            results.push({ account: account.id, cloud_name: account.cloud_name, used_mb: usedMb, ok: true });
        } catch (e) {
            results.push({ account: account.id, ok: false, error: e.message });
        }
    }

    return jsonResponse({ results }, 200, env);
}

/* ════════════════════════════════════════════════════════════════
   Cloudinary signature helper (SHA-1 of sorted params + api_secret)
   ════════════════════════════════════════════════════════════════ */

async function cloudinarySignature(params, apiSecret) {
    const toSign = Object.keys(params)
        .sort()
        .map(k => `${k}=${params[k]}`)
        .join('&') + apiSecret;
    const data = new TextEncoder().encode(toSign);
    const hashBuf = await crypto.subtle.digest('SHA-1', data);
    return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ─── Response helpers ────────────────────────────────────────── */
function corsResponse(body, status, env) {
    return new Response(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  env?.ALLOWED_ORIGIN || '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Content-Type': 'text/plain',
        }
    });
}
function jsonResponse(obj, status, env) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Access-Control-Allow-Origin':  env?.ALLOWED_ORIGIN || '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Content-Type': 'application/json',
        }
    });
}

/* ─── Google Service Account → access token (for Drive, unchanged) ─── */
async function getGoogleAccessToken(email, privateKeyPem) {
    const now   = Math.floor(Date.now() / 1000);
    const scope = 'https://www.googleapis.com/auth/drive.readonly';

    const header  = { alg: 'RS256', typ: 'JWT' };
    const payload = { iss: email, scope, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };

    const b64Header  = btoa(JSON.stringify(header)) .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const b64Payload = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const signingInput = `${b64Header}.${b64Payload}`;

    const privKeyDer = pemToDer(privateKeyPem);
    const privKey    = await crypto.subtle.importKey(
        'pkcs8', privKeyDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );
    const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privKey, new TextEncoder().encode(signingInput));
    const b64Sig = bufToB64Url(sig);
    const jwt    = `${signingInput}.${b64Sig}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:   `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
    const data = await tokenRes.json();
    return data.access_token;
}

function pemToDer(pem) {
    const b64 = pem.replace(/-----BEGIN[^-]+-----/g, '').replace(/-----END[^-]+-----/g, '').replace(/\s+/g, '');
    return b64ToBuf(b64);
}
function b64ToBuf(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}
function bufToB64Url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
