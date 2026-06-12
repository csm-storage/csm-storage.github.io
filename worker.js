/**
 * CSM DRIVE | ULTRA PRO — Cloudflare Worker
 * worker.js
 *
 * Routes:
 *   GET /drive/:fileId               — Stream private Drive file (token required)
 *   GET /drive/:fileId/thumb         — Serve thumbnail URL redirect (token required)
 *   GET /drive/:fileId?dl=1          — Force-download header
 *
 * Environment Variables (set in Cloudflare dashboard → Workers → Settings → Variables):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL     — service account email
 *   GOOGLE_PRIVATE_KEY               — service account private key (PEM, \\n escaped)
 *   FIREBASE_PROJECT_ID              — your Firebase project ID (e.g. photos-58c8e)
 *   ALLOWED_ORIGIN                   — your GitHub Pages URL (e.g. https://csm-storage.github.io)
 */

/* ─── Entry ───────────────────────────────────────────────────── */
export default {
    async fetch(request, env) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return corsResponse('', 204, env);
        }

        const url = new URL(request.url);
        const path = url.pathname; // e.g. /drive/1aBcXxx or /drive/1aBcXxx/thumb

        if (!path.startsWith('/drive/')) {
            return corsResponse('Not found', 404, env);
        }

        // Parse /drive/:fileId[/thumb]
        const parts  = path.replace('/drive/', '').split('/');
        const fileId = parts[0];
        const isThumb = parts[1] === 'thumb';

        if (!fileId) return corsResponse('Missing file ID', 400, env);

        // ─── Verify Firebase ID token ───────────────────────────
        const token = url.searchParams.get('token');
        if (!token) return corsResponse('Unauthorized: no token', 401, env);

        const isValid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
        if (!isValid) return corsResponse('Unauthorized: invalid token', 401, env);

        // ─── Get Google API access token ────────────────────────
        let gToken;
        try {
            gToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);
        } catch (e) {
            return corsResponse('Server error: ' + e.message, 500, env);
        }

        // ─── Handle thumbnail redirect ──────────────────────────
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

        // ─── Stream the Drive file ──────────────────────────────
        const dl = url.searchParams.get('dl') === '1';
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

        const driveRes = await fetch(driveUrl, {
            headers: { Authorization: `Bearer ${gToken}` }
        });

        if (!driveRes.ok) {
            return corsResponse(`Drive error: ${driveRes.status}`, 502, env);
        }

        const contentType = driveRes.headers.get('Content-Type') || 'application/octet-stream';
        const headers = {
            'Content-Type':  contentType,
            'Cache-Control': 'private, max-age=3600',
            'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
        };
        if (dl) {
            const filename = url.searchParams.get('name') || fileId;
            headers['Content-Disposition'] = `attachment; filename="${filename}"`;
        }

        return new Response(driveRes.body, { status: 200, headers });
    }
};

/* ─── CORS helper ─────────────────────────────────────────────── */
function corsResponse(body, status, env) {
    return new Response(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  env?.ALLOWED_ORIGIN || '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'text/plain',
        }
    });
}

/* ─── Firebase token verification ────────────────────────────── */
async function verifyFirebaseToken(idToken, projectId) {
    try {
        // Fetch Firebase public keys
        const keysRes = await fetch(
            'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
        );
        const keys = await keysRes.json();

        // Decode JWT header to get key ID
        const [headerB64] = idToken.split('.');
        const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
        const kid    = header.kid;

        if (!keys[kid]) return false;

        // Import public key
        const certPem = keys[kid];
        const certDer = pemToDer(certPem);
        const pubKey  = await crypto.subtle.importKey(
            'spki', certDer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false, ['verify']
        );

        // Verify signature
        const [, payloadB64, sigB64] = idToken.split('.');
        const sigBuf  = b64UrlToBuf(sigB64);
        const dataBuf = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
        const valid   = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pubKey, sigBuf, dataBuf);
        if (!valid) return false;

        // Validate claims
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
        const now     = Math.floor(Date.now() / 1000);
        if (payload.exp < now)  return false;
        if (payload.iat > now + 300) return false;
        if (payload.aud !== projectId) return false;
        if (payload.iss !== `https://securetoken.google.com/${projectId}`) return false;

        return true;
    } catch (e) {
        console.error('Token verify error:', e);
        return false;
    }
}

/* ─── Google Service Account → access token ──────────────────── */
async function getGoogleAccessToken(email, privateKeyPem) {
    const now   = Math.floor(Date.now() / 1000);
    const scope = 'https://www.googleapis.com/auth/drive.readonly';

    // Build JWT claim set
    const header  = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: email,
        scope,
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    };

    const b64Header  = btoa(JSON.stringify(header))  .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const b64Payload = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const signingInput = `${b64Header}.${b64Payload}`;

    // Import private key
    const privKeyDer = pemToDer(privateKeyPem);
    const privKey    = await crypto.subtle.importKey(
        'pkcs8', privKeyDer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );

    // Sign
    const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privKey, new TextEncoder().encode(signingInput));
    const b64Sig = bufToB64Url(sig);
    const jwt    = `${signingInput}.${b64Sig}`;

    // Exchange for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:   `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });

    if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await tokenRes.json();
    return data.access_token;
}

/* ─── Crypto helpers ─────────────────────────────────────────── */
function pemToDer(pem) {
    const b64 = pem
        .replace(/-----BEGIN[^-]+-----/g, '')
        .replace(/-----END[^-]+-----/g, '')
        .replace(/\s+/g, '');
    return b64ToBuf(b64);
}

function b64ToBuf(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}

function b64UrlToBuf(b64url) {
    return b64ToBuf(b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(
        b64url.length + (4 - b64url.length % 4) % 4, '='
    ));
}

function bufToB64Url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
