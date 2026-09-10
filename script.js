/**
 * CSM DRIVE | ULTRA PRO — script.js v4
 * Developer: Csm Mohasin Alam
 *
 * Features:
 *  - Firebase Realtime DB + Cloudinary storage
 *  - IndexedDB offline cache (files + folders + sync queue + upload queue)
 *  - Offline-first load + full CRUD synced offline
 *  - Background sync (online event + SW postMessage)
 *  - NexusLightbox — custom zero-CDN lightbox with working zoom/pan
 *  - Scroll-reveal animations (AOS via IntersectionObserver)
 *  - Smart upload with multi-file staging, drag-drop, progress
 *  - Folder system with color picker
 *  - Star, lock (passcode-gated), trash, restore, permanent delete
 *  - Multi-select with batch operations
 *  - Context menu (right-click + long press mobile)
 *  - Toast notifications
 *  - Sort + search + grid/list view
 *  - Particle canvas background
 *  - Light/dark theme toggle
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, getIdToken } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getDatabase, ref, push, set, get, onValue, remove, update } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

/* ─── Firebase config ───────────────────────────────────────── */
const firebaseConfig = {
    apiKey:      "AIzaSyBtmUmV1KxQDB0jN9gUQnh-eYWKllMPav0",
    authDomain:  "photos-58c8e.firebaseapp.com",
    projectId:   "photos-58c8e",
    databaseURL: "https://photos-58c8e-default-rtdb.firebaseio.com"
};
const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);
const db    = getDatabase(fbApp);
const DB_PATH       = 'my_gallery';
const FOLDERS_PATH  = 'folders';
const SETTINGS_PATH = 'settings';
const ACCOUNTS_PATH = 'cloudinary_accounts';
const BACKUP_PATH   = 'account_password_backup'; // plaintext recovery copy — app NEVER reads this back, admin-console-only

/* ─── Multi-Cloudinary Worker (backend brain) ──────────────────
   Uploads/deletes go through this Worker instead of straight to
   Cloudinary, so the Worker can pick the right account and keep
   API secrets off the browser. Set this to YOUR deployed Worker URL
   (see the deployment guide) — e.g. "https://csm-drive-worker.you.workers.dev" */
const WORKER_URL = 'https://backend.csm-mohasin.workers.dev';

/** Always fetches a fresh Firebase ID token (auto-refreshes silently
 *  since login is persistent — this is exactly the flow the security
 *  design calls for, no manual re-login needed). */
async function getAuthToken() {
    if (!auth.currentUser) throw new Error('Not signed in');
    return getIdToken(auth.currentUser, /* forceRefresh */ false);
}

/* ─── Storage growth trend (built entirely from existing file records —
   no extra data needed: each file already has a time + size) ────── */
function buildStorageTrendSVG() {
    const files = nonHiddenFiles().filter(f => f.time && f.size);
    if (!files.length) return null;

    const byDay = {};
    files.forEach(f => {
        const day = new Date(f.time).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + (parseFloat(f.size) || 0);
    });
    const days = Object.keys(byDay).sort();
    let running = 0;
    const points = days.map(day => { running += byDay[day]; return { day, total: running }; });
    if (points.length < 2) points.unshift({ day: points[0].day, total: 0 });

    const W = 600, H = 220, padL = 50, padR = 14, padT = 14, padB = 26;
    const maxY = Math.max(...points.map(p => p.total), 1);
    const n = points.length;
    const xAt = i => padL + (n === 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
    const yAt = v => H - padB - (v / maxY) * (H - padT - padB);

    const linePts = points.map((p, i) => `${xAt(i)},${yAt(p.total)}`).join(' ');
    const areaPts = `${xAt(0)},${H - padB} ${linePts} ${xAt(n - 1)},${H - padB}`;

    let grid = '';
    for (let i = 0; i <= 3; i++) {
        const v = (maxY / 3) * i;
        const y = yAt(v);
        grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
        grid += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#8a8a9a" font-family="monospace">${v >= 1024 ? (v/1024).toFixed(1)+'GB' : v.toFixed(0)+'MB'}</text>`;
    }
    const firstLabel = points[0].day.slice(5);
    const lastLabel  = points[n - 1].day.slice(5);

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">
        ${grid}
        <polygon points="${areaPts}" fill="rgba(0,255,204,0.12)" />
        <polyline points="${linePts}" fill="none" stroke="#00ffcc" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        <text x="${padL}" y="${H - 6}" font-size="9" fill="#8a8a9a" font-family="monospace">${firstLabel}</text>
        <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="9" fill="#8a8a9a" font-family="monospace">${lastLabel}</text>
    </svg>`;
}
function renderStorageTrend() {
    const wrap = document.getElementById('storageTrendChart');
    if (!wrap) return;
    const svg = buildStorageTrendSVG();
    wrap.innerHTML = svg || `<div class="acct-empty">Not enough data yet — upload a few files first.</div>`;
}

/* ─── Cloudinary account usage (for the Settings tab) ───────────── */
let cloudinaryAccounts = {};
function loadCloudinaryAccounts() {
    onValue(ref(db, ACCOUNTS_PATH), snap => {
        cloudinaryAccounts = snap.val() || {};
        renderAccountUsage();
        render(); updateStats(); renderFolders(); // hidden/locked accounts can change what's visible
    });
}

/** Accounts in a stable display order — this order is what the #N badge
 *  on each card and the "#N" label in Settings refer to. */
function getSortedAccountIds() {
    return Object.keys(cloudinaryAccounts).sort((a, b) => a.localeCompare(b));
}
function isAcctHidden(file) { return !!(file?.account && cloudinaryAccounts[file.account]?.hidden); }
function isAcctLocked(file) { return !!(file?.account && cloudinaryAccounts[file.account]?.locked); }
/** All files minus anything whose account is fully hidden — used everywhere
 *  stats/folders/grids are computed so a hidden account truly disappears. */
function nonHiddenFiles() {
    // Duress mode overrides everything else: only the pre-selected decoy
    // files exist as far as the rest of the app is concerned.
    if (duressActive) return allFiles.filter(f => f.duress);
    return allFiles.filter(f => !isAcctHidden(f));
}

function renderAccountUsage() {
    // Cache the live account list (hide/lock/enabled flags included) so
    // offline app-opens see the REAL state instead of an empty object —
    // see the comment in onAuthStateChanged for why this matters.
    idbPut('settings', { key: 'cloudinaryAccounts', value: cloudinaryAccounts }).catch(() => {});

    const ids = getSortedAccountIds();

    // Slim summary button on the main page
    const summaryEl = document.getElementById('cloudAccountsSummary');
    if (summaryEl) {
        if (!ids.length) {
            summaryEl.textContent = 'No accounts yet';
        } else {
            let usedTotal = 0, limitTotal = 0, enabledCount = 0;
            ids.forEach(id => {
                const a = cloudinaryAccounts[id];
                usedTotal  += Number(a.used_mb)  || 0;
                limitTotal += Number(a.limit_mb) || 0;
                if (a.enabled !== false) enabledCount++;
            });
            const pct = limitTotal ? (usedTotal / limitTotal * 100) : 0;
            summaryEl.textContent = `${enabledCount}/${ids.length} active · ${pct.toFixed(0)}% used`;
        }
    }

    renderSettingsAccounts(ids);
}

/** Full manager list rendered inside the Settings tab: usage bar, editable
 *  label + limit, enable/disable, hide, lock, default-account radio, remove. */
function renderSettingsAccounts(ids) {
    ids = ids || getSortedAccountIds();
    const wrap = document.getElementById('settingsAccountsList');
    if (wrap) {
        if (!ids.length) {
            wrap.innerHTML = `<div class="acct-empty">No Cloudinary accounts registered yet — see the deployment guide.</div>`;
        } else {
            wrap.innerHTML = ids.map((id, idx) => {
                const a       = cloudinaryAccounts[id];
                const used    = Number(a.used_mb)  || 0;
                const limit   = Number(a.limit_mb) || 1;
                const pct     = Math.min(used / limit * 100, 100);
                const level   = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'ok';
                const enabled = a.enabled !== false;
                const label   = (a.label || '').replace(/"/g, '&quot;');
                return `
                <div class="acct-manage-row ${!enabled ? 'disabled' : ''}">
                    <div class="acct-manage-top">
                        <span class="acct-manage-num">#${idx + 1}</span>
                        <input class="acct-inline-input acct-label-input" value="${label}" placeholder="${id}"
                            onchange="window.updateAccountField('${id}','label',this.value)">
                        ${a.default
                            ? `<span class="acct-default-tag"><i class="fas fa-star"></i> Default</span>`
                            : `<button class="settings-mini-btn" onclick="window.setDefaultAccount('${id}')">Set Default</button>`}
                        ${a.isScreenshotTarget
                            ? `<span class="acct-default-tag" style="color:#7aa2ff;background:rgba(122,162,255,0.1);border-color:rgba(122,162,255,0.25);"><i class="fas fa-camera"></i> Screenshots</span>`
                            : `<button class="settings-mini-btn" onclick="window.setScreenshotAccount('${id}')" title="Screenshots (by filename) auto-upload here when Auto is selected"><i class="fas fa-camera"></i> Set for Screenshots</button>`}
                    </div>
                    <div class="acct-bar-wrap"><div class="acct-bar acct-bar-${level}" style="width:${pct}%"></div></div>
                    <div class="acct-sub">${(used/1024).toFixed(2)} GB used · ${a.cloud_name || id} · <span class="acct-${level}">${pct.toFixed(1)}%</span></div>
                    <div class="acct-manage-grid">
                        <label class="acct-field">
                            <span>LIMIT (MB)</span>
                            <input type="number" min="1" value="${limit}"
                                onchange="window.updateAccountField('${id}','limit_mb',Number(this.value)||1)">
                        </label>
                        <label class="acct-field acct-field-toggle">
                            <span>ENABLED</span>
                            <label class="csm-switch small">
                                <input type="checkbox" ${enabled ? 'checked' : ''} onchange="window.updateAccountField('${id}','enabled',this.checked)">
                                <span class="csm-switch-slider"></span>
                            </label>
                        </label>
                        <label class="acct-field acct-field-toggle">
                            <span>HIDE FILES</span>
                            <label class="csm-switch small">
                                <input type="checkbox" ${a.hidden ? 'checked' : ''} onchange="window.updateAccountField('${id}','hidden',this.checked)">
                                <span class="csm-switch-slider"></span>
                            </label>
                        </label>
                        <label class="acct-field acct-field-toggle">
                            <span>LOCK FILES</span>
                            <label class="csm-switch small">
                                <input type="checkbox" ${a.locked ? 'checked' : ''} onchange="window.updateAccountField('${id}','locked',this.checked)">
                                <span class="csm-switch-slider"></span>
                            </label>
                        </label>
                    </div>
                    <div class="acct-manage-actions">
                        <button class="settings-mini-btn ${a.passwordHash ? 'accent' : ''}" onclick="window.openAccountPasswordSetup('${id}')" title="Custom password used when this account is locked">
                            <i class="fas fa-key"></i> ${a.passwordHash ? 'Change account password' : 'Set account password'}
                        </button>
                        ${a.passwordHash ? `<button class="settings-mini-btn danger" onclick="window.removeAccountPassword('${id}')"><i class="fas fa-lock-open"></i> Remove password</button>` : ''}
                    </div>
                    <div class="acct-manage-actions">
                        <button class="settings-mini-btn" onclick="window.tagUntaggedFiles('${id}')" title="Assign files with no account tag (old uploads) to this account"><i class="fas fa-tags"></i> Tag untagged files here</button>
                        <button class="settings-mini-btn danger" onclick="window.deleteAccountEntry('${id}')"><i class="fas fa-trash"></i> Remove</button>
                    </div>
                </div>`;
            }).join('');
        }
    }

    // Keep the upload popup's account selector in sync
    const sel = document.getElementById('uploadAccount');
    if (sel) {
        const cur = sel.value;
        let opts = `<option value="">⚡ Auto (recommended)</option>`;
        ids.filter(id => cloudinaryAccounts[id].enabled !== false).forEach(id => {
            const a = cloudinaryAccounts[id];
            opts += `<option value="${id}">${(a.label || id)}${a.default ? ' ★ default' : ''}</option>`;
        });
        sel.innerHTML = opts;
        const defId = ids.find(id => cloudinaryAccounts[id].default);
        const stillValid = [...sel.options].some(o => o.value === cur);
        sel.value = (cur && stillValid) ? cur : (defId || '');
    }
}

/** Called once on entering the main app. Under duress mode this hides the
 *  parts of the UI that would otherwise reveal real accounts/settings even
 *  though the file grid itself is already limited to the decoy set. */
function applyDuressUIRestrictions() {
    document.querySelector('.cloud-accounts-section')?.classList.toggle('hidden', duressActive);
    document.querySelector('.upload-btn')?.classList.toggle('hidden', duressActive);
}

/* ─── Settings tab (full-page) ───────────────────────────────────── */
window.openSettings = (section) => {
    document.getElementById('settingsOverlay').classList.remove('hidden');
    const pt = document.getElementById('passcodeEnabledToggle');
    if (pt) pt.checked = passcodeEnabled;
    refreshPatternSettingsUI();
    renderAccountUsage();
    renderStorageTrend();
    document.getElementById('settingsAccountsSection')?.classList.toggle('hidden', duressActive);
    document.getElementById('settingsTrendSection')?.classList.toggle('hidden', duressActive);
    document.getElementById('settingsDuressSection')?.classList.toggle('hidden', duressActive);
    document.getElementById('settingsOcrSection')?.classList.toggle('hidden', duressActive);
    refreshDuressSettingsUI();
    if (section === 'accounts') {
        setTimeout(() => document.getElementById('settingsAccountsSection')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
};
window.closeSettings = () => {
    document.getElementById('settingsOverlay').classList.add('hidden');
};

window.setPasscodeEnabled = val => {
    passcodeEnabled = val;
    if (navigator.onLine) update(ref(db, SETTINGS_PATH), { passcodeEnabled: val }).catch(() => {});
    showToast(val ? 'Passcode lock enabled' : 'Passcode lock disabled', 'info');
};

/** Generic single-field save for an account entry — optimistic locally,
 *  persisted to Firebase when online. Also re-renders the grid since
 *  hidden/locked can change what's visible right away. */
window.updateAccountField = (id, field, value) => {
    if (!cloudinaryAccounts[id]) cloudinaryAccounts[id] = {};
    cloudinaryAccounts[id][field] = value;

    // Persist first, so a re-render hiccup can never block the actual save.
    if (navigator.onLine) {
        update(ref(db, `${ACCOUNTS_PATH}/${id}`), { [field]: value })
            .then(() => showToast(`Saved · ${field.replace(/_/g,' ')}`, 'success'))
            .catch(e => showToast(`Failed to save: ${e.message}`, 'error'));
    } else {
        showToast('Offline — change will sync once online', 'warning');
    }

    try { renderAccountUsage(); } catch (e) { console.error('renderAccountUsage failed', e); }
    try { render(); } catch (e) { console.error('render failed', e); }
    try { updateStats(); } catch (e) { console.error('updateStats failed', e); }
    try { renderFolders(); } catch (e) { console.error('renderFolders failed', e); }
};

window.setDefaultAccount = id => {
    const ids = getSortedAccountIds();
    const updates = {};
    ids.forEach(aid => {
        if (!cloudinaryAccounts[aid]) cloudinaryAccounts[aid] = {};
        cloudinaryAccounts[aid].default = (aid === id);
        updates[`${ACCOUNTS_PATH}/${aid}/default`] = (aid === id);
    });
    renderAccountUsage();
    if (navigator.onLine) {
        update(ref(db), updates).catch(e => showToast(`Failed to save: ${e.message}`, 'error'));
    } else {
        showToast('Offline — default will sync once online', 'warning');
    }
    showToast('Default upload account set', 'success');
};
/** Marks one account as the auto-target for files whose name looks like a
 *  screenshot — see looksLikeScreenshot(). Exclusive like "Default": only
 *  one account can hold this at a time. Only kicks in when the upload
 *  popup's account selector is left on "Auto" — an explicit manual choice
 *  always wins. */
window.setScreenshotAccount = id => {
    const ids = getSortedAccountIds();
    const updates = {};
    ids.forEach(aid => {
        if (!cloudinaryAccounts[aid]) cloudinaryAccounts[aid] = {};
        cloudinaryAccounts[aid].isScreenshotTarget = (aid === id);
        updates[`${ACCOUNTS_PATH}/${aid}/isScreenshotTarget`] = (aid === id);
    });
    renderAccountUsage();
    if (navigator.onLine) {
        update(ref(db), updates).catch(e => showToast(`Failed to save: ${e.message}`, 'error'));
    } else {
        showToast('Offline — will sync once online', 'warning');
    }
    showToast('Screenshot uploads will now default to this account', 'success');
};

window.deleteAccountEntry = id => {
    const label = cloudinaryAccounts[id]?.label || id;
    showModal({
        title: 'REMOVE ACCOUNT',
        body:  `Remove tracking for "${label}"? This only stops the app from tracking/uploading to it — it does NOT delete files already stored there, and does NOT remove it from the Worker's CLOUDINARY_ACCOUNTS secret.`,
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Remove', cls: 'modal-btn-danger', action: async () => {
                closeModal();
                delete cloudinaryAccounts[id];
                renderAccountUsage();
                if (navigator.onLine) await remove(ref(db, `${ACCOUNTS_PATH}/${id}`));
                showToast('Account entry removed', 'info');
            }}
        ]
    });
};

window.addAccountEntry = () => {
    showModal({
        title: 'ADD CLOUD ACCOUNT',
        body: `<div style="display:flex;flex-direction:column;gap:10px;">
            <input id="newAcctId" class="modal-input" style="margin-bottom:0" placeholder="Account ID — must match the Worker's CLOUDINARY_ACCOUNTS id (e.g. account3)">
            <input id="newAcctLabel" class="modal-input" style="margin-bottom:0" placeholder="Display label (e.g. Backup Drive)">
            <input id="newAcctCloud" class="modal-input" style="margin-bottom:0" placeholder="Cloudinary cloud name (for display only)">
            <input id="newAcctLimit" type="number" class="modal-input" style="margin-bottom:0" placeholder="Limit in MB (e.g. 25000)">
        </div>`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Add', cls: 'modal-btn-confirm', action: async () => {
                const id    = document.getElementById('newAcctId')?.value.trim();
                const label = document.getElementById('newAcctLabel')?.value.trim();
                const cloud = document.getElementById('newAcctCloud')?.value.trim();
                const limit = Number(document.getElementById('newAcctLimit')?.value) || 20000;
                if (!id) { showToast('Account ID is required', 'warning'); return; }
                if (cloudinaryAccounts[id]) { showToast('That account ID already exists', 'warning'); return; }
                closeModal();
                const data = { label: label || id, cloud_name: cloud || '', limit_mb: limit, used_mb: 0, enabled: true, hidden: false, locked: false, default: false };
                cloudinaryAccounts[id] = data;
                renderAccountUsage();
                if (navigator.onLine) await set(ref(db, `${ACCOUNTS_PATH}/${id}`), data);
                showToast('Account added — also add it to the Worker CLOUDINARY_ACCOUNTS secret to enable uploads', 'success');
            }}
        ]
    });
};

window.tagUntaggedFiles = id => {
    const untagged = allFiles.filter(f => !f.account);
    if (!untagged.length) { showToast('No untagged files found — every file already has an account.', 'info'); return; }
    const label = cloudinaryAccounts[id]?.label || id;
    showModal({
        title: 'TAG EXISTING FILES',
        body:  `Assign all ${untagged.length} file(s) that don't have a cloud-account tag yet (usually older uploads from before multi-account support) to "${label}"? This only labels them for Hide/Lock/the number badge — it does NOT move or re-upload the actual files.`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Tag them', cls: 'modal-btn-confirm', action: async () => {
                closeModal();
                const updates = {};
                untagged.forEach(f => { f.account = id; updates[`${DB_PATH}/${f.id}/account`] = id; });
                render(); updateStats(); renderFolders();
                if (navigator.onLine) {
                    try {
                        await update(ref(db), updates);
                        showToast(`Tagged ${untagged.length} file(s) to ${label}`, 'success');
                    } catch (e) {
                        showToast(`Failed to tag files: ${e.message}`, 'error');
                    }
                } else {
                    showToast('Offline — redo this once online', 'warning');
                }
            }}
        ]
    });
};

/** Dropdown "Move to Account" / "Copy to Account" — the actual asset gets
 *  downloaded and re-uploaded under the target account's own credentials
 *  by the Worker (only it holds the API secrets), so this always needs
 *  to be online. */
/** Adjusts an account's tracked used_mb by a delta (read-then-write —
 *  fine for this app's low-concurrency personal-use scale). Used by the
 *  relabel-based move/copy below so account usage bars stay meaningful
 *  even though no physical Cloudinary transfer happens. */
async function fbAdjustUsage(accountId, deltaMb) {
    if (!accountId || !navigator.onLine) return;
    try {
        const snap = await get(ref(db, `${ACCOUNTS_PATH}/${accountId}/used_mb`));
        const next = Math.max((Number(snap.val()) || 0) + deltaMb, 0);
        await update(ref(db, `${ACCOUNTS_PATH}/${accountId}`), { used_mb: next });
        if (cloudinaryAccounts[accountId]) cloudinaryAccounts[accountId].used_mb = next;
        renderAccountUsage();
    } catch (e) {
        console.error(`Usage adjust failed for ${accountId}:`, e.message);
    }
}

/** Relabels which account a file "belongs to" — instant, Firebase-only,
 *  no Cloudinary API calls. The physical asset never moves; only which
 *  account's hide/lock/enabled toggles and usage bar it counts against
 *  changes. "Copy" adds a second Firebase listing pointing at the SAME
 *  underlying Cloudinary asset (a shared reference, not a real duplicate
 *  upload) so no extra storage is actually used on Cloudinary's side. */
async function relabelFileAccount(file, targetAccountId, mode, { silent = false } = {}) {
    const sizeMb = parseFloat(file.size) || 0;
    const oldAccountId = file.account;
    try {
        if (mode === 'move') {
            file.account = targetAccountId;
            if (navigator.onLine) {
                await update(ref(db, `${DB_PATH}/${file.id}`), { account: targetAccountId });
                await fbAdjustUsage(oldAccountId, -sizeMb);
                await fbAdjustUsage(targetAccountId, sizeMb);
            } else {
                await idbPut('files', file);
            }
            render();
            if (!silent) showToast(navigator.onLine ? 'File relabeled to the new account' : 'Offline — change will sync once online', navigator.onLine ? 'success' : 'warning');
        } else {
            if (!navigator.onLine) { if (!silent) showToast('Copying needs an internet connection', 'warning'); return; }
            const { id: _drop, ...rest } = file;
            const newRec = { ...rest, account: targetAccountId, time: Date.now() };
            const newRef = push(ref(db, DB_PATH));
            await set(newRef, newRec);
            await fbAdjustUsage(targetAccountId, sizeMb);
            if (!silent) showToast('Listing copied to the new account', 'success');
        }
    } catch (e) {
        if (!silent) showToast(`Failed: ${e.message}`, 'error');
        throw e;
    }
}

window.openAccountTransferPicker = (id, mode) => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    const ids = getSortedAccountIds().filter(aid => aid !== file.account && cloudinaryAccounts[aid]?.enabled !== false);
    if (!ids.length) { showToast('No other enabled account available', 'warning'); return; }
    const options = ids.map(aid => `<option value="${aid}">${cloudinaryAccounts[aid]?.label || aid}</option>`).join('');
    showModal({
        title: mode === 'move' ? 'MOVE TO ACCOUNT' : 'COPY TO ACCOUNT',
        body: `<div style="display:flex;flex-direction:column;gap:10px;">
            <div class="settings-row-sub" style="padding:0;">${mode === 'move'
                ? 'Relabels this file as belonging to another account — instant, no re-upload. The physical file itself stays exactly where it is on Cloudinary; only which account it counts against (and which account has hide/lock control over it) changes.'
                : 'Adds a second listing for this file under another account (a shared reference to the same file — no extra Cloudinary storage used).'}</div>
            <select id="transferTargetSelect" class="modal-input" style="margin-bottom:0;">${options}</select>
        </div>`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: mode === 'move' ? 'Move' : 'Copy', cls: 'modal-btn-confirm', action: async () => {
                const targetAccountId = document.getElementById('transferTargetSelect')?.value;
                if (!targetAccountId) return;
                closeModal();
                await relabelFileAccount(file, targetAccountId, mode);
            }}
        ]
    });
};

window.openAccountPasswordSetup = id => {
    const label = cloudinaryAccounts[id]?.label || id;
    showModal({
        title: 'ACCOUNT PASSWORD',
        body: `<div style="display:flex;flex-direction:column;gap:10px;">
            <div class="settings-row-sub" style="padding:0;">Set a custom password for "${label}". While this account is locked, opening its files will ask for THIS password instead of your app passcode/pattern.</div>
            <input id="acctPwInput" type="password" class="modal-input" style="margin-bottom:0" placeholder="New password (min 4 characters)" autocomplete="new-password">
            <input id="acctPwConfirm" type="password" class="modal-input" style="margin-bottom:0" placeholder="Confirm password" autocomplete="new-password">
        </div>`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Save', cls: 'modal-btn-confirm', action: async () => {
                const pw  = document.getElementById('acctPwInput')?.value || '';
                const pw2 = document.getElementById('acctPwConfirm')?.value || '';
                if (pw.length < 4) { showToast('Password must be at least 4 characters', 'warning'); return; }
                if (pw !== pw2) { showToast("Passwords don't match", 'warning'); return; }
                closeModal();
                const hash = await sha256Hex(pw);
                if (!cloudinaryAccounts[id]) cloudinaryAccounts[id] = {};
                cloudinaryAccounts[id].passwordHash = hash;
                renderAccountUsage();
                if (navigator.onLine) {
                    try {
                        await update(ref(db, `${ACCOUNTS_PATH}/${id}`), { passwordHash: hash });
                        // Plaintext recovery copy — a separate path the app itself
                        // never reads back; only visible via the Firebase console.
                        await set(ref(db, `${BACKUP_PATH}/${id}`), pw);
                        showToast('Account password saved', 'success');
                    } catch (e) {
                        showToast(`Failed to save: ${e.message}`, 'error');
                    }
                } else {
                    showToast('Offline — password will sync once online', 'warning');
                }
            }}
        ]
    });
};
window.removeAccountPassword = id => {
    const label = cloudinaryAccounts[id]?.label || id;
    showModal({
        title: 'REMOVE ACCOUNT PASSWORD',
        body: `Remove the custom password for "${label}"? While locked, its files will then ask for your app passcode/pattern again instead.`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Remove', cls: 'modal-btn-danger', action: async () => {
                closeModal();
                if (cloudinaryAccounts[id]) delete cloudinaryAccounts[id].passwordHash;
                renderAccountUsage();
                if (navigator.onLine) {
                    try {
                        await update(ref(db, `${ACCOUNTS_PATH}/${id}`), { passwordHash: null });
                        await remove(ref(db, `${BACKUP_PATH}/${id}`));
                        showToast('Account password removed', 'info');
                    } catch (e) {
                        showToast(`Failed: ${e.message}`, 'error');
                    }
                } else {
                    showToast('Offline — change will sync once online', 'warning');
                }
            }}
        ]
    });
};


/** Settings tab's "Force OCR now" button — calls the Worker's backlog
 *  endpoint immediately instead of waiting for the once-daily Cron job.
 *  Safe to press repeatedly; each press processes another small batch. */
window.forceOcrBacklog = async () => {
    const btn = document.getElementById('forceOcrBtn');
    // Guards against exactly what happened: rapid multi-tapping used to fire
    // several overlapping requests that all read the SAME "still pending"
    // list before any of them had written anything back, so they mostly
    // OCR'd the same 20 files over and over instead of making real progress.
    if (btn?.disabled) return;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    const label = document.getElementById('ocrStatusLabel');
    if (label) label.textContent = 'Status: running…';
    try {
        const token = await getAuthToken();
        const res = await fetch(`${WORKER_URL}/cloudinary/ocr-backlog`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (label) label.textContent = `Status: processed ${data.processed} · ${data.remaining} remaining`;
        showToast(`OCR: processed ${data.processed}, ${data.remaining} left`, 'success');
    } catch (e) {
        if (label) label.textContent = `Status: failed — ${e.message}`;
        showToast(`OCR backlog failed: ${e.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
};

window.syncCloudUsage = async () => {
    try {
        const token = await getAuthToken();
        const res = await fetch(`${WORKER_URL}/cloudinary/sync-usage`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sync failed');
        showToast('Usage recalculated from Cloudinary', 'success');
    } catch (e) {
        showToast(`Sync failed: ${e.message}`, 'error');
    }
};

/* ─── App State ─────────────────────────────────────────────── */
let allFiles        = [];
let folders         = [];
let currentTab      = 'all';
let currentFolder   = 'all';
let searchText      = '';
let sortMode        = 'newest';
let viewMode        = 'grid';
let selectMode      = false;
let selectedIds     = new Set();
let contextTarget   = null;
let appPasscode     = '2240';
let passcodeEnabled = true;
let unlockPattern    = null;      // array of dot indices (0-8), the saved unlock pattern
let pcMode            = 'passcode'; // which UI is showing on the lock screen right now
let duressPasscode   = null;      // optional secondary 4-digit code -> opens the decoy set instead
let duressPattern    = null;      // optional secondary pattern -> same idea
let duressActive     = false;     // true for the rest of this session once the duress code was used
let pcAllowDuress     = false;    // only the main app-open lock screen checks for the duress code
let passcodeCallback= null;
let passcodeInput   = '';
let sessionUnlocked = false;
let pendingUploadFiles = [];
let uploadInProgress   = false;

/* ─── IndexedDB ─────────────────────────────────────────────── */
const IDB_NAME    = 'csm_drive_db';
const IDB_VERSION = 3;
let idb = null;

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = e => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains('files'))
                d.createObjectStore('files', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('folders'))
                d.createObjectStore('folders', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('syncQueue'))
                d.createObjectStore('syncQueue', { keyPath: 'qid', autoIncrement: true });
            if (!d.objectStoreNames.contains('pendingUploads'))
                d.createObjectStore('pendingUploads', { keyPath: 'uid', autoIncrement: true });
            if (!d.objectStoreNames.contains('settings'))
                d.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}
async function ensureIDB() { if (!idb) idb = await openIDB(); }
async function idbPut(store, val) {
    await ensureIDB();
    return new Promise((res, rej) => {
        const tx = idb.transaction(store, 'readwrite');
        tx.objectStore(store).put(val).onsuccess = () => res();
        tx.onerror = () => rej(tx.error);
    });
}
async function idbGet(store, key) {
    await ensureIDB();
    return new Promise((res, rej) => {
        const tx = idb.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
    });
}
async function idbGetAll(store) {
    await ensureIDB();
    return new Promise((res, rej) => {
        const tx  = idb.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror   = () => rej(req.error);
    });
}
async function idbDelete(store, key) {
    await ensureIDB();
    return new Promise((res, rej) => {
        const tx = idb.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key).onsuccess = () => res();
        tx.onerror = () => rej(tx.error);
    });
}
async function idbClear(store) {
    await ensureIDB();
    return new Promise((res, rej) => {
        const tx = idb.transaction(store, 'readwrite');
        tx.objectStore(store).clear().onsuccess = () => res();
        tx.onerror = () => rej(tx.error);
    });
}

/* ─── Init ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
    await ensureIDB();
    initAOS();
    initParticles();
    initSyncManager();
    initTheme();
    // Toast container
    const tc = document.createElement('div');
    tc.id = 'toastContainer';
    document.body.appendChild(tc);
});

/* ─── AOS — Scroll reveal ───────────────────────────────────── */
function initAOS() {
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('aos-in');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
    document.querySelectorAll('[data-aos]').forEach(el => observer.observe(el));
}

/* ─── Theme toggle ──────────────────────────────────────────── */
function initTheme() {
    const saved = localStorage.getItem('csm_theme');
    if (saved === 'light') document.body.classList.add('theme-light');
}
window.toggleTheme = () => {
    document.body.classList.toggle('theme-light');
    localStorage.setItem('csm_theme', document.body.classList.contains('theme-light') ? 'light' : 'dark');
};

/* ─── Particles ─────────────────────────────────────────────── */
function initParticles() {
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const count = window.innerWidth < 768 ? 25 : 55;
    const pts = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r:  Math.random() * 1.8 + 0.4,
        o:  Math.random() * 0.25 + 0.04
    }));
    const draw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pts.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            if (p.x < 0 || p.x > canvas.width)  p.vx *= -1;
            if (p.y < 0 || p.y > canvas.height)  p.vy *= -1;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(0,255,204,${p.o})`; ctx.fill();
        });
        const max = window.innerWidth < 768 ? 70 : 110;
        for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
                const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
                const d  = Math.sqrt(dx*dx + dy*dy);
                if (d < max) {
                    ctx.beginPath();
                    ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y);
                    ctx.strokeStyle = `rgba(0,255,204,${0.025 * (1 - d/max)})`; ctx.stroke();
                }
            }
        }
        requestAnimationFrame(draw);
    };
    draw();
    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    });
}

/* ─── Sync Manager ──────────────────────────────────────────── */
function initSyncManager() {
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', e => {
            if (e.data?.type === 'PROCESS_SYNC_QUEUE')   processSyncQueue();
            if (e.data?.type === 'PROCESS_UPLOAD_QUEUE') processUploadQueue();
        });
    }
}

function handleOnline() {
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.add('hidden');
    setSyncBadge('syncing', 'SYNCING…');
    showToast('Back online — syncing…', 'info');
    processSyncQueue();
    processUploadQueue();
}

function handleOffline() {
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.remove('hidden');
    setSyncBadge('offline', 'OFFLINE');
    showToast('Offline — changes will sync later', 'warning');
}

function setSyncBadge(cls, label) {
    const b = document.getElementById('syncStatusBadge');
    if (!b) return;
    b.className = 'sync-badge' + (cls ? ' ' + cls : '');
    b.innerHTML = cls === 'syncing'
        ? `<i class="fas fa-sync fa-spin"></i> <span>${label}</span>`
        : cls === 'offline'
        ? `<i class="fas fa-wifi-slash"></i> <span>${label}</span>`
        : `<i class="fas fa-check-circle"></i> <span>${label}</span>`;
}

/* ─── Auth ──────────────────────────────────────────────────── */
onAuthStateChanged(auth, async user => {
    if (user) {
        document.getElementById('loginSection').classList.add('hidden');

        // Instant offline load from IDB — files/folders AND the last-known
        // account hide/lock state + passcode/pattern/duress settings.
        // This must all load BEFORE anything renders: without the cached
        // account state, isAcctHidden()/isAcctLocked() would see an EMPTY
        // cloudinaryAccounts object while offline (the live Firebase
        // listener never fires without a connection) and treat every
        // account as neither hidden nor locked — silently bypassing both
        // protections for as long as the device stays offline.
        const [cachedFiles, cachedFolders, cachedAccounts, cachedSecurity] = await Promise.all([
            idbGetAll('files'), idbGetAll('folders'),
            idbGet('settings', 'cloudinaryAccounts'),
            idbGet('settings', 'appSecurity'),
        ]);
        if (cachedAccounts?.value)  cloudinaryAccounts = cachedAccounts.value;
        if (cachedSecurity?.value)  applySettingsSnapshot(cachedSecurity.value);
        if (cachedFiles.length) {
            allFiles = cachedFiles; folders = cachedFolders;
            updateStats(); renderFolders(); render(); updateFolderSelect();
        }

        // Must know the REAL passcodeEnabled/unlockPattern before deciding
        // which lock screen to show — otherwise this always falls back to
        // the hardcoded numeric-passcode default. Online, this refreshes
        // everything above with the live values; offline, it's a no-op and
        // the cached values loaded above are what's used instead.
        await fetchSettingsOnce();

        if (passcodeEnabled && !sessionUnlocked) {
            showPasscodeScreen(() => {
                sessionUnlocked = true;
                document.getElementById('passcodeSection').classList.add('hidden');
                showMain();
                // loadData() only re-renders once its Firebase listener fires,
                // which never happens offline — so without this, a successful
                // duress (or normal) unlock offline would keep showing whatever
                // was drawn BEFORE the unlock decision (the full, unfiltered
                // cached list), duress filtering never actually applied.
                // Force a fresh render right now, online or not.
                updateStats(); renderFolders(); render(); updateFolderSelect();
                loadData(); loadFolders(); loadSettings();
            }, true); // allowDuress — only the main app-open gate checks the duress code
        } else {
            showMain();
            loadData(); loadFolders(); loadSettings();
        }
        loadCloudinaryAccounts();

        setTimeout(() => {
            if (navigator.onLine) { processSyncQueue(); processUploadQueue(); }
        }, 2500);
    } else {
        document.getElementById('loginSection').classList.remove('hidden');
        document.getElementById('mainContent').classList.add('hidden');
        document.getElementById('passcodeSection').classList.add('hidden');
        sessionUnlocked = false;
    }
});

function showMain() {
    const mc = document.getElementById('mainContent');
    mc.classList.remove('hidden');
    mc.classList.add('fade-in');
    applyDuressUIRestrictions();
    // Trigger AOS for newly visible elements
    setTimeout(() => {
        document.querySelectorAll('[data-aos]:not(.aos-in)').forEach(el => {
            const observer = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) { e.target.classList.add('aos-in'); observer.unobserve(e.target); }
                });
            }, { threshold: 0.08 });
            observer.observe(el);
        });
    }, 100);
}

/* ─── Login ─────────────────────────────────────────────────── */
document.getElementById('doLogin').onclick = async () => {
    const btn   = document.getElementById('doLogin');
    const idle  = btn.querySelector('.btn-idle');
    const loading = btn.querySelector('.btn-loading');
    idle.classList.add('hidden');
    loading.classList.remove('hidden');
    btn.disabled = true;
    try {
        await signInWithEmailAndPassword(auth,
            document.getElementById('loginEmail').value,
            document.getElementById('loginPass').value);
    } catch (e) {
        showToast('Authentication failed', 'error');
        idle.classList.remove('hidden');
        loading.classList.add('hidden');
        btn.disabled = false;
    }
};
document.getElementById('loginPass').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('doLogin').click();
});

/* ─── Passcode / Pattern / Account-password unlock ───────────── */
async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
let pendingAccountUnlock = null; // { hash, cb } — set while the account-password screen is showing

function showPasscodeScreen(cb, allowDuress = false) {
    passcodeCallback = cb; passcodeInput = '';
    pcAllowDuress = allowDuress;
    document.getElementById('passcodeSection').classList.remove('hidden');
    pcMode = 'passcode';
    renderPcMode();
}
function renderPcMode() {
    const numMode = document.getElementById('pcNumericMode');
    const patMode = document.getElementById('pcPatternMode');
    const apMode  = document.getElementById('pcAccountPassMode');
    const link    = document.getElementById('pcSwitchLink');
    const cancelBtn = document.getElementById('pcStandaloneCancel');
    const hasPattern = Array.isArray(unlockPattern) && unlockPattern.length >= 4;
    pendingAccountUnlock = null;
    apMode?.classList.add('hidden');

    if (pcMode === 'pattern' && hasPattern) {
        numMode.classList.add('hidden');
        patMode.classList.remove('hidden');
        cancelBtn?.classList.remove('hidden');
        document.getElementById('passcodeMessage').textContent = 'Draw your unlock pattern';
        initPatternGrid('patternSvg', path => {
            const isDuress = pcAllowDuress && duressPattern && patternsEqual(path, duressPattern);
            if (patternsEqual(path, unlockPattern) || isDuress) {
                duressActive = isDuress;
                if (passcodeCallback) passcodeCallback();
                passcodeCallback = null;
            } else {
                document.getElementById('passcodeMessage').textContent = 'Wrong pattern — try again';
                setTimeout(() => {
                    document.getElementById('patternSvg')?._resetVisual?.();
                    document.getElementById('passcodeMessage').textContent = 'Draw your unlock pattern';
                }, 600);
            }
        });
        if (link) { link.classList.remove('hidden'); link.innerHTML = '<i class="fas fa-hashtag"></i> Unlock with passcode instead'; }
    } else {
        patMode.classList.add('hidden');
        numMode.classList.remove('hidden');
        cancelBtn?.classList.add('hidden');
        document.getElementById('passcodeMessage').textContent = 'Enter your 4-digit access code';
        updatePasscodeDots();
        if (link) {
            if (hasPattern) { link.classList.remove('hidden'); link.innerHTML = '<i class="fas fa-diagram-project"></i> Unlock with pattern instead'; }
            else link.classList.add('hidden');
        }
    }
}
window.togglePcMode = () => { pcMode = (pcMode === 'pattern') ? 'passcode' : 'pattern'; renderPcMode(); };

/** Shown instead of the shared app passcode/pattern when the file being
 *  opened belongs to an account that has its OWN custom password set. */
function showAccountPasswordScreen(accountId, hash, cb) {
    passcodeCallback = null;
    pendingAccountUnlock = { hash, cb };
    document.getElementById('passcodeSection').classList.remove('hidden');
    document.getElementById('pcNumericMode').classList.add('hidden');
    document.getElementById('pcPatternMode').classList.add('hidden');
    document.getElementById('pcSwitchLink').classList.add('hidden');
    document.getElementById('pcStandaloneCancel').classList.remove('hidden');
    const apMode = document.getElementById('pcAccountPassMode');
    apMode.classList.remove('hidden');
    const label = cloudinaryAccounts[accountId]?.label || accountId;
    document.getElementById('passcodeMessage').textContent = `Enter password for "${label}"`;
    const input = document.getElementById('acctUnlockInput');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
}
window.submitAccountPassword = async () => {
    if (!pendingAccountUnlock) return;
    const input = document.getElementById('acctUnlockInput');
    const pw = input?.value || '';
    const hash = await sha256Hex(pw);
    if (hash === pendingAccountUnlock.hash) {
        const cb = pendingAccountUnlock.cb;
        pendingAccountUnlock = null;
        document.getElementById('passcodeSection').classList.add('hidden');
        cb();
    } else {
        document.getElementById('passcodeMessage').textContent = 'Wrong password — try again';
        if (input) { input.value = ''; input.focus(); }
    }
};

/* ─── Pattern grid (Android-style 3x3 dot lock) ──────────────────
   Exact-sequence match (not fuzzy scoring) — much harder to fake
   than a freehand shape, same as a real pattern lock. */
function patternsEqual(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

/** Wires up drag capture on a pattern-grid <svg id="svgId"> containing
 *  <circle class="pattern-dot" data-idx="N"> dots and a <g id="{svgId}Lines">
 *  for the connecting lines. Safe to call repeatedly — only binds once,
 *  just swaps the completion callback + resets the visual on later calls. */
function initPatternGrid(svgId, onComplete) {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    svg._onComplete = onComplete;
    if (svg._bound) { svg._resetVisual(); return; }
    svg._bound = true;

    const dots  = [...svg.querySelectorAll('.pattern-dot')];
    const lines = document.getElementById(svgId + 'Lines');
    let path = [];
    let dragging = false;

    const svgPoint = e => {
        const rect = svg.getBoundingClientRect();
        const t = e.touches && e.touches[0];
        const clientX = t ? t.clientX : e.clientX, clientY = t ? t.clientY : e.clientY;
        const vb = svg.viewBox.baseVal;
        return { x: (clientX - rect.left) / rect.width * vb.width, y: (clientY - rect.top) / rect.height * vb.height };
    };
    const dotAt = pt => dots.find(d => Math.hypot(parseFloat(d.getAttribute('cx')) - pt.x, parseFloat(d.getAttribute('cy')) - pt.y) < 22);
    const redraw = cursor => {
        let html = '';
        for (let i = 0; i < path.length - 1; i++) {
            const a = dots[path[i]], b = dots[path[i + 1]];
            html += `<line x1="${a.getAttribute('cx')}" y1="${a.getAttribute('cy')}" x2="${b.getAttribute('cx')}" y2="${b.getAttribute('cy')}" stroke="#00ffcc" stroke-width="4" stroke-linecap="round"/>`;
        }
        if (path.length && cursor) {
            const a = dots[path[path.length - 1]];
            html += `<line x1="${a.getAttribute('cx')}" y1="${a.getAttribute('cy')}" x2="${cursor.x}" y2="${cursor.y}" stroke="rgba(0,255,204,0.4)" stroke-width="4" stroke-linecap="round"/>`;
        }
        lines.innerHTML = html;
    };
    const reset = () => {
        path = []; dragging = false;
        dots.forEach(d => d.classList.remove('active'));
        lines.innerHTML = '';
    };
    const start = e => {
        e.preventDefault();
        reset(); dragging = true;
        const pt = svgPoint(e), d = dotAt(pt);
        if (d) { path.push(dots.indexOf(d)); d.classList.add('active'); redraw(pt); }
    };
    const move = e => {
        if (!dragging) return;
        e.preventDefault();
        const pt = svgPoint(e), d = dotAt(pt);
        if (d) {
            const idx = dots.indexOf(d);
            if (!path.includes(idx)) { path.push(idx); d.classList.add('active'); }
        }
        redraw(pt);
    };
    const end = () => {
        if (!dragging) return;
        dragging = false;
        redraw(null);
        if (svg._onComplete) svg._onComplete(path.slice());
    };
    svg.addEventListener('mousedown', start);
    svg.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    svg.addEventListener('touchstart', start, { passive: false });
    svg.addEventListener('touchmove', move, { passive: false });
    svg.addEventListener('touchend', end);
    svg._resetVisual = reset;
}

/* ─── Pattern setup (draw twice to confirm, like a phone's pattern lock) ─ */
let patternSetupFirst  = null;
let patternSetupTarget = 'unlock'; // 'unlock' | 'duress'
window.openPatternSetup = (target = 'unlock') => {
    patternSetupTarget = target;
    patternSetupFirst = null;
    document.getElementById('patSetupMsg').textContent = 'Connect at least 4 dots to set your pattern';
    document.getElementById('patternSetupOverlay').classList.remove('hidden');
    initPatternGrid('patternSetupSvg', path => {
        if (path.length < 4) {
            showToast('Connect at least 4 dots', 'warning');
            document.getElementById('patternSetupSvg')?._resetVisual?.();
            return;
        }
        if (!patternSetupFirst) {
            patternSetupFirst = path;
            document.getElementById('patSetupMsg').textContent = 'Draw the same pattern again to confirm';
            setTimeout(() => document.getElementById('patternSetupSvg')?._resetVisual?.(), 400);
        } else if (patternsEqual(path, patternSetupFirst)) {
            if (patternSetupTarget === 'duress' && unlockPattern && patternsEqual(path, unlockPattern)) {
                showToast('Duress pattern must differ from your real pattern', 'warning');
                patternSetupFirst = null;
                document.getElementById('patSetupMsg').textContent = 'Connect at least 4 dots to set your pattern';
                setTimeout(() => document.getElementById('patternSetupSvg')?._resetVisual?.(), 400);
                return;
            }
            if (patternSetupTarget === 'duress') {
                duressPattern = path;
                if (navigator.onLine) {
                    update(ref(db, SETTINGS_PATH), { duressPattern: path })
                        .then(() => showToast('Duress pattern saved', 'success'))
                        .catch(e => showToast(`Failed to save: ${e.message}`, 'error'));
                } else {
                    showToast('Offline — will sync once online', 'warning');
                }
                refreshDuressSettingsUI();
            } else {
                unlockPattern = path;
                if (navigator.onLine) {
                    update(ref(db, SETTINGS_PATH), { pattern: path })
                        .then(() => showToast('Pattern saved', 'success'))
                        .catch(e => showToast(`Failed to save: ${e.message}`, 'error'));
                } else {
                    showToast('Offline — pattern will sync once online', 'warning');
                }
                refreshPatternSettingsUI();
            }
            window.closePatternSetup();
        } else {
            showToast("Patterns didn't match — try again", 'error');
            patternSetupFirst = null;
            document.getElementById('patSetupMsg').textContent = 'Connect at least 4 dots to set your pattern';
            setTimeout(() => document.getElementById('patternSetupSvg')?._resetVisual?.(), 400);
        }
    });
};
window.openDuressPatternSetup = () => window.openPatternSetup('duress');
window.closePatternSetup = () => document.getElementById('patternSetupOverlay').classList.add('hidden');
window.clearPatternSetup = () => {
    document.getElementById('patternSetupSvg')?._resetVisual?.();
    patternSetupFirst = null;
    document.getElementById('patSetupMsg').textContent = 'Connect at least 4 dots to set your pattern';
};
window.removePattern = () => {
    unlockPattern = null;
    if (navigator.onLine) update(ref(db, SETTINGS_PATH), { pattern: null }).catch(() => {});
    showToast('Pattern removed', 'info');
    refreshPatternSettingsUI();
};
function refreshPatternSettingsUI() {
    const hasPattern = Array.isArray(unlockPattern) && unlockPattern.length >= 4;
    const label = document.getElementById('patternSetupBtnLabel');
    if (label) label.textContent = hasPattern ? 'Change pattern' : 'Set pattern';
    document.getElementById('removePatternBtn')?.classList.toggle('hidden', !hasPattern);
}

/* ─── Duress mode setup ───────────────────────────────────────── */
window.setDuressPasscode = () => {
    showModal({
        title: 'DURESS PASSCODE',
        body: `<div style="display:flex;flex-direction:column;gap:10px;">
            <div class="settings-row-sub" style="padding:0;">Must differ from your real passcode. Entering this code at the lock screen opens ONLY your decoy files — real content stays fully hidden, with no trace it exists.</div>
            <input id="duressPwInput" type="text" inputmode="numeric" maxlength="4" class="modal-input" style="margin-bottom:0;text-align:center;letter-spacing:8px;" placeholder="4-digit code">
        </div>`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Save', cls: 'modal-btn-confirm', action: () => {
                const code = document.getElementById('duressPwInput')?.value || '';
                if (!/^\d{4}$/.test(code)) { showToast('Enter exactly 4 digits', 'warning'); return; }
                if (code === appPasscode) { showToast('Must differ from your real passcode', 'warning'); return; }
                closeModal();
                duressPasscode = code;
                if (navigator.onLine) {
                    update(ref(db, SETTINGS_PATH), { duressPasscode: code })
                        .then(() => showToast('Duress passcode saved', 'success'))
                        .catch(e => showToast(`Failed: ${e.message}`, 'error'));
                } else {
                    showToast('Offline — will sync once online', 'warning');
                }
                refreshDuressSettingsUI();
            }}
        ]
    });
};
function refreshDuressSettingsUI() {
    const hasDp   = !!duressPasscode;
    const hasDpat = Array.isArray(duressPattern) && duressPattern.length >= 4;
    const l1 = document.getElementById('duressPasscodeBtnLabel'); if (l1) l1.textContent = hasDp ? 'Change' : 'Set';
    const l2 = document.getElementById('duressPatternBtnLabel'); if (l2) l2.textContent = hasDpat ? 'Change' : 'Set';
    const cnt = allFiles.filter(f => f.duress).length;
    const countLabel = document.getElementById('duressCountLabel');
    if (countLabel) countLabel.textContent = `${cnt} file(s) marked`;
}
/** Toggles a single file's decoy-set membership (per-file dropdown action). */
window.toggleDuress = id => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    const val = !file.duress;
    file.duress = val;
    render(); refreshDuressSettingsUI();
    if (navigator.onLine) {
        update(ref(db, `${DB_PATH}/${id}`), { duress: val })
            .then(() => showToast(val ? 'Added to duress set' : 'Removed from duress set', 'success'))
            .catch(e => showToast(`Failed: ${e.message}`, 'error'));
    } else {
        showToast('Offline — change will sync once online', 'warning');
    }
};
/** Bulk-marks all currently-selected files as decoy content. */
window.bulkAddToDuress = () => {
    if (!selectedIds.size) return;
    const updates = {};
    selectedIds.forEach(id => {
        const f = allFiles.find(x => x.id === id);
        if (f) { f.duress = true; updates[`${DB_PATH}/${id}/duress`] = true; }
    });
    render(); refreshDuressSettingsUI();
    if (navigator.onLine) {
        update(ref(db), updates)
            .then(() => showToast(`Added ${selectedIds.size} file(s) to duress set`, 'success'))
            .catch(e => showToast(`Failed: ${e.message}`, 'error'));
    } else {
        showToast('Offline — change will sync once online', 'warning');
    }
};

window.enterPasscode = num => {
    if (passcodeInput.length >= 4) return;
    passcodeInput += num;
    updatePasscodeDots();
    if (passcodeInput.length === 4) {
        setTimeout(() => {
            const isDuress = pcAllowDuress && duressPasscode && passcodeInput === duressPasscode;
            if (passcodeInput === appPasscode || isDuress) {
                duressActive = isDuress;
                if (passcodeCallback) passcodeCallback();
                passcodeCallback = null;
            } else {
                document.querySelectorAll('.passcode-dot').forEach(d => d.classList.add('error'));
                document.getElementById('passcodeMessage').textContent = 'Incorrect code. Try again.';
                setTimeout(() => {
                    passcodeInput = '';
                    document.querySelectorAll('.passcode-dot').forEach(d => d.classList.remove('error'));
                    updatePasscodeDots();
                    document.getElementById('passcodeMessage').textContent = 'Enter your 4-digit access code';
                }, 800);
            }
        }, 200);
    }
};
window.clearPasscode   = () => { passcodeInput = passcodeInput.slice(0,-1); updatePasscodeDots(); };
window.cancelPasscode  = () => {
    passcodeInput = ''; updatePasscodeDots();
    pendingAccountUnlock = null;
    document.getElementById('pcAccountPassMode')?.classList.add('hidden');
    if (!sessionUnlocked) signOut(auth);
    document.getElementById('passcodeSection').classList.add('hidden');
    passcodeCallback = null;
};
function updatePasscodeDots() {
    document.querySelectorAll('#passcodeDots .passcode-dot')
        .forEach((d, i) => d.classList.toggle('filled', i < passcodeInput.length));
}

/* ─── Logout ─────────────────────────────────────────────────── */
window.confirmLogout = () => {
    showModal({
        title: 'SIGN OUT',
        body:  'Are you sure you want to sign out?',
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Sign Out', cls: 'modal-btn-danger', action: async () => { closeModal(); await signOut(auth); sessionUnlocked = false; } }
        ]
    });
};

/* ─── Firebase — Load Data ───────────────────────────────────── */
function loadData() {
    if (!navigator.onLine) return;
    onValue(ref(db, DB_PATH), async snap => {
        allFiles = [];
        snap.forEach(child => {
            allFiles.push({ id: child.key, ...child.val() });
        });
        // Preserve offlineData from IDB cache
        const cached = await idbGetAll('files');
        const cacheMap = Object.fromEntries(cached.map(f => [f.id, f]));
        allFiles.forEach(f => {
            if (cacheMap[f.id]?.offlineData) f.offlineData = cacheMap[f.id].offlineData;
        });
        // Save to IDB
        await Promise.all(allFiles.map(f => idbPut('files', f)));
        updateStats(); renderFolders(); render(); updateFolderSelect();
        setSyncBadge('', 'SYNCED');

        // Background: pre-cache image blobs for offline lightbox
        setTimeout(() => { if (navigator.onLine) preCacheAllImages(); }, 1500);
    });
}

function loadFolders() {
    if (!navigator.onLine) return;
    onValue(ref(db, FOLDERS_PATH), async snap => {
        folders = [];
        snap.forEach(child => folders.push({ id: child.key, ...child.val() }));
        await Promise.all(folders.map(f => idbPut('folders', f)));
        renderFolders(); updateFolderSelect();
    });
}

function applySettingsSnapshot(s) {
    if (s?.passcode)        appPasscode     = s.passcode;
    if (s?.passcodeEnabled !== undefined) passcodeEnabled = s.passcodeEnabled;
    if (Array.isArray(s?.pattern)) unlockPattern = s.pattern;
    if (s?.duressPasscode)        duressPasscode = s.duressPasscode;
    if (Array.isArray(s?.duressPattern)) duressPattern = s.duressPattern;
    // Cache the raw settings snapshot so offline app-opens still know the
    // REAL passcode/pattern/duress state instead of falling back to the
    // hardcoded in-memory defaults (see the comment in onAuthStateChanged).
    if (s) idbPut('settings', { key: 'appSecurity', value: s }).catch(() => {});
}
/** One-time fetch, awaited BEFORE the passcode/gesture gate decides what to
 *  show — without this, the gate would use the hardcoded defaults (numeric
 *  passcode) on every fresh page load, since the live onValue listener
 *  below only resolves after that decision already ran. */
async function fetchSettingsOnce() {
    if (!navigator.onLine) return;
    try {
        const snap = await get(ref(db, SETTINGS_PATH));
        applySettingsSnapshot(snap.val());
    } catch (e) { console.error('fetchSettingsOnce failed', e); }
}
function loadSettings() {
    if (!navigator.onLine) return;
    onValue(ref(db, SETTINGS_PATH), snap => applySettingsSnapshot(snap.val()));
}

/* ─── Pre-cache images for offline viewing ───────────────────── */
async function preCacheAllImages() {
    const imgs = allFiles.filter(f => f.cat !== 'video' && f.url && !f.offlineData && !f.trash);
    for (const file of imgs) {
        try {
            // Use w_800 transform for reasonable size
            const thumbUrl = file.url.includes('/upload/')
                ? file.url.replace('/upload/', '/upload/w_800,q_auto,f_auto/')
                : file.url;
            const blob   = await fetch(thumbUrl).then(r => r.blob());
            const b64    = await blobToBase64(blob);
            file.offlineData = b64;
            await idbPut('files', { ...file });
        } catch (e) { /* skip failures */ }
    }
}

function blobToBase64(blob) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onloadend = () => res(r.result);
        r.onerror   = rej;
        r.readAsDataURL(blob);
    });
}

/* ─── Sync queue ─────────────────────────────────────────────── */
async function addToSyncQueue(op) {
    await ensureIDB();
    const tx = idb.transaction('syncQueue', 'readwrite');
    tx.objectStore('syncQueue').add({ ...op, ts: Date.now() });
    // Register background sync if available
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        reg.sync.register('csm-sync-queue').catch(() => {});
    }
}

async function processSyncQueue() {
    const items = await idbGetAll('syncQueue');
    if (!items.length) { setSyncBadge('', 'SYNCED'); return; }
    for (const item of items) {
        try {
            if (item.type === 'update') await update(ref(db, `${DB_PATH}/${item.id}`), item.data);
            if (item.type === 'delete') {
                if (item.cloud) { try { await deleteFromCloudinary(item.cloud); } catch (e) { console.warn('[Sync] Cloud delete failed:', e); } }
                await remove(ref(db, `${DB_PATH}/${item.id}`));
            }
            if (item.type === 'create') await set(ref(db, `${DB_PATH}/${item.id}`), item.data);
            if (item.type === 'folderCreate') await set(ref(db, `${FOLDERS_PATH}/${item.id}`), item.data);
            if (item.type === 'folderDelete') await remove(ref(db, `${FOLDERS_PATH}/${item.id}`));
            await idbDelete('syncQueue', item.qid);
        } catch (e) { console.warn('[Sync] Failed:', e); }
    }
    setSyncBadge('', 'SYNCED');
    showToast('All changes synced', 'success');
}

/* ─── Upload queue (offline) ─────────────────────────────────── */
async function addToPendingUploads(fileItem) {
    const b64 = await blobToBase64(fileItem.file);
    await ensureIDB();
    const tx = idb.transaction('pendingUploads', 'readwrite');
    tx.objectStore('pendingUploads').add({
        b64, name: fileItem.file.name, type: fileItem.file.type,
        customName: fileItem.customName || '', folder: fileItem.folder || '',
        account: fileItem.account || '',
        ts: Date.now()
    });
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        reg.sync.register('csm-upload-queue').catch(() => {});
    }
}

async function processUploadQueue() {
    const items = await idbGetAll('pendingUploads');
    if (!items.length) return;
    for (const item of items) {
        try {
            const blob   = await fetch(item.b64).then(r => r.blob());
            const file   = new File([blob], item.name, { type: item.type });
            await uploadQueuedItem(file, item.customName, item.folder, item.account);
            await idbDelete('pendingUploads', item.uid);
        } catch (e) { console.warn('[Upload] Failed:', e); }
    }
    updateUploadQueueBadge();
    showToast('Offline uploads complete!', 'success');
}

async function uploadQueuedItem(file, customName, folder, account) {
    const token = await getAuthToken();
    const fd = new FormData();
    fd.append('file', file);
    if (account) fd.append('account', account);
    const res = await fetch(`${WORKER_URL}/cloudinary/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    const cat = data.resourceType === 'video' ? 'video' : data.resourceType === 'image' ? 'image' : 'file';
    const rec = {
        url:          data.secure_url,
        publicId:     data.publicId,
        account:      data.account,
        resourceType: data.resourceType,
        cat:     cat,
        name:    customName || file.name.replace(/\.[^.]+$/, ''),
        ext:     (file.name.match(/\.([^.]+)$/) || [,''])[1].toLowerCase(),
        size:    (file.size / 1024 / 1024).toFixed(2) + ' MB',
        folder:  folder || '',
        time:    Date.now(),
        ocrText: data.ocrText || '',
        ocrDone: !!data.ocrDone,
        starred: false, locked: false, trash: false, duress: false
    };
    const newRef = push(ref(db, DB_PATH));
    await set(newRef, rec);
    if (data.nearCapacity) showToast('A Cloudinary account is nearing capacity', 'warning');
}

function updateUploadQueueBadge() {
    idbGetAll('pendingUploads').then(items => {
        const badge = document.getElementById('uploadQueueBadge');
        if (!badge) return;
        if (items.length > 0) {
            badge.textContent = items.length;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    });
}

/* ─── Stats ──────────────────────────────────────────────────── */
function updateStats() {
    const files    = nonHiddenFiles();
    const active   = files.filter(f => !f.trash);
    const imgs     = active.filter(f => f.cat === 'image' || !f.cat).length;
    const vids     = active.filter(f => f.cat === 'video').length;
    const docs     = active.filter(f => f.cat === 'file').length;
    const stars    = active.filter(f => f.starred).length;
    const trashed  = files.filter(f => f.trash).length;
    const total    = Math.max(active.length, 1);

    document.getElementById('imgCount').textContent   = imgs;
    document.getElementById('vidCount').textContent   = vids;
    document.getElementById('fileCount').textContent  = docs;
    document.getElementById('starCount').textContent  = stars;
    document.getElementById('trashCount').textContent = trashed;

    document.getElementById('imgBar').style.width   = (imgs  / total * 100) + '%';
    document.getElementById('vidBar').style.width   = (vids  / total * 100) + '%';
    document.getElementById('fileBar').style.width  = (docs  / total * 100) + '%';
    document.getElementById('starBar').style.width  = (stars / total * 100) + '%';
    document.getElementById('trashBar').style.width = (trashed / Math.max(trashed + total, 1) * 100) + '%';

    let totalSize = 0;
    files.forEach(f => { if (f.size) totalSize += parseFloat(f.size); });
    const cap = 1024;
    document.getElementById('storageFill').style.width = Math.min(totalSize / cap * 100, 100) + '%';
    document.getElementById('storageText').textContent = `${totalSize.toFixed(1)} MB / ${cap} MB (${files.length} files)`;
}

/* ─── Folders ────────────────────────────────────────────────── */
function renderFolders() {
    const bar = document.getElementById('folderBar');
    const files = nonHiddenFiles();
    const allCount = files.filter(f => !f.trash).length;
    bar.innerHTML = `<div class="folder-pill ${currentFolder === 'all' ? 'active' : ''}" onclick="window.setFolder('all', this)">
        <i class="fas fa-folder"></i> All <span class="count">${allCount}</span></div>`;
    folders.forEach(f => {
        const cnt = files.filter(file => file.folder === f.id && !file.trash).length;
        bar.innerHTML += `<div class="folder-pill ${currentFolder === f.id ? 'active' : ''}"
            onclick="window.setFolder('${f.id}', this)"
            oncontextmenu="window.folderContext(event,'${f.id}')">
            <i class="fas fa-folder" style="color:${f.color||'var(--neon)'}"></i>
            ${f.name} <span class="count">${cnt}</span></div>`;
    });
    bar.innerHTML += `<div class="folder-pill add-folder" onclick="window.createFolder()"><i class="fas fa-plus"></i> New</div>`;
}

function updateFolderSelect() {
    const sel = document.getElementById('uploadFolder');
    sel.innerHTML = '<option value="">No Folder</option>';
    folders.forEach(f => sel.innerHTML += `<option value="${f.id}">${f.name}</option>`);
}

/* ─── Visible files ──────────────────────────────────────────── */
function getVisibleFiles() {
    let list = nonHiddenFiles().filter(f => {
        if (currentTab === 'trash')   return f.trash;
        if (currentTab === 'starred') return f.starred && !f.trash;
        if (currentTab === 'locked')  return (f.locked || isAcctLocked(f)) && !f.trash;
        if (currentTab === 'all')     return !f.trash;
        return f.cat === currentTab && !f.trash;
    });
    if (currentFolder !== 'all' && currentTab !== 'trash')
        list = list.filter(f => f.folder === currentFolder);
    if (searchText)
        list = list.filter(f => (f.name || '').toLowerCase().includes(searchText.toLowerCase())
            || (f.ocrText || '').toLowerCase().includes(searchText.toLowerCase()));
    return list;
}

function sortedList(list) {
    return [...list].sort((a, b) => {
        if (sortMode === 'newest')   return (b.time  || 0) - (a.time  || 0);
        if (sortMode === 'oldest')   return (a.time  || 0) - (b.time  || 0);
        if (sortMode === 'az')       return (a.name  || '').localeCompare(b.name || '');
        if (sortMode === 'za')       return (b.name  || '').localeCompare(a.name || '');
        if (sortMode === 'largest')  return parseFloat(b.size || 0) - parseFloat(a.size || 0);
        if (sortMode === 'smallest') return parseFloat(a.size || 0) - parseFloat(b.size || 0);
        return 0;
    });
}

/* ─── Build lightbox items ───────────────────────────────────── */
function buildLbItems(list) {
    return list.map(file => {
        let thumb = file.url || '';
        if (thumb.includes('/upload/')) thumb = thumb.replace('/upload/', '/upload/w_200,q_auto,f_auto/');
        const fo = folders.find(f => f.id === file.folder);
        const dateStr = file.time ? new Date(file.time).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
        return {
            id:          file.id,
            src:         file.url || '',
            thumb,
            offlineData: file.offlineData || null,
            name:        file.name || 'Untitled',
            size:        file.size || '—',
            date:        dateStr,
            cat:         file.cat || 'image',
            starred:     !!file.starred,
            folder:      fo ? fo.name : 'None',
        };
    });
}

/* ─── Render ─────────────────────────────────────────────────── */
/** Screenshot detection is filename-based — reliable for Android's default
 *  "Screenshot_YYYYMMDD-HHMMSS.png" naming (and similar patterns from
 *  Windows/other tools), with no EXIF/ML analysis needed. If a file was
 *  renamed and doesn't match, the per-file "Move to Account" action in the
 *  dropdown menu covers the miss manually. */
function looksLikeScreenshot(filename) {
    const n = (filename || '').toLowerCase();
    return n.includes('screenshot')
        || n.includes('screen shot')
        || n.includes('screen_shot')
        || n.includes('screen-shot')
        || n.includes('scrnshot')
        || n.includes('screencapture')
        || n.includes('screen capture');
}
/** Resolves which account a single file in the current upload batch should
 *  go to: an explicit account picked in the upload popup ALWAYS wins; only
 *  when that's left on "Auto" does screenshot auto-routing kick in. */
function resolveUploadAccountForFile(file, chosenAccount) {
    if (chosenAccount) return chosenAccount;
    if (looksLikeScreenshot(file.name)) {
        const ssId = getSortedAccountIds().find(id =>
            cloudinaryAccounts[id]?.isScreenshotTarget && cloudinaryAccounts[id]?.enabled !== false);
        if (ssId) return ssId;
    }
    return '';
}

/** Picks a FontAwesome icon name for a non-media "file" card based on extension. */
function getDocIcon(ext) {
    ext = (ext || '').toLowerCase();
    if (ext === 'pdf') return 'file-pdf';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return 'file-zipper';
    if (['doc','docx'].includes(ext)) return 'file-word';
    if (['xls','xlsx','csv'].includes(ext)) return 'file-excel';
    if (['ppt','pptx'].includes(ext)) return 'file-powerpoint';
    if (ext === 'apk') return 'mobile-screen-button';
    if (['txt','md','log'].includes(ext)) return 'file-lines';
    if (['mp3','wav','ogg','m4a'].includes(ext)) return 'file-audio';
    if (['json','xml','yml','yaml'].includes(ext)) return 'file-code';
    return 'file';
}

function render() {
    const grid = document.getElementById('fileGrid');
    grid.innerHTML = '';
    grid.className = viewMode === 'list' ? 'grid list-view' : 'grid';

    const ta = document.getElementById('trashActions');
    if (currentTab === 'trash') { ta.classList.remove('hidden'); ta.style.display = 'flex'; }
    else ta.classList.add('hidden');

    const list = sortedList(getVisibleFiles());

    if (!list.length) {
        grid.innerHTML = `<div class="empty-state">
            <div class="empty-icon"><i class="fas fa-${currentTab === 'trash' ? 'trash-can' : 'ghost'}"></i></div>
            <div class="empty-title">${currentTab === 'trash' ? 'Trash is Empty' : 'No Files Found'}</div>
            <div class="empty-desc">${currentTab === 'trash' ? 'Deleted files appear here' : 'Upload files or adjust your filter'}</div>
        </div>`;
        return;
    }

    const isOffline = !navigator.onLine;
    const lbItems   = buildLbItems(list);
    const acctIds   = getSortedAccountIds();

    list.forEach((file, idx) => {
        let thumb = file.url || '';
        if (thumb.includes('/upload/')) thumb = thumb.replace('/upload/', '/upload/w_400,q_auto,f_auto/');
        const thumbSrc   = (isOffline && file.offlineData) ? file.offlineData : thumb;
        const isVid      = file.cat === 'video';
        const acctLocked = isAcctLocked(file);
        const isLocked   = (file.locked || acctLocked) && !file._unlocked;
        const acctIdx    = file.account ? acctIds.indexOf(file.account) : -1;
        const acctNum    = acctIdx >= 0 ? acctIdx + 1 : null;
        const acctLabel  = acctNum ? (cloudinaryAccounts[file.account]?.label || file.account) : '';
        const fo       = folders.find(f => f.id === file.folder);
        const date     = file.time ? new Date(file.time).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '—';

        const card = document.createElement('div');
        card.className = `card ${selectedIds.has(file.id) ? 'selected' : ''} ${isLocked ? 'locked' : ''}`;
        card.style.animationDelay = `${Math.min(idx * 0.03, 0.5)}s`;
        card.setAttribute('data-id', file.id);
        card.oncontextmenu = e => { e.preventDefault(); window.showContextMenu(e, file.id); };

        if (selectMode) {
            card.onclick = e => {
                if (e.target.closest('.dots') || e.target.closest('.dropdown') || e.target.closest('.select-check')) return;
                window.toggleSelect(file.id);
            };
        }

        let previewHTML;
        const docIcon = getDocIcon(file.ext || (file.name || '').split('.').pop());
        if (isLocked) {
            previewHTML = `<div style="width:100%;height:100%;background:#0a0a15;display:flex;align-items:center;justify-content:center;"><i class="fas fa-lock" style="font-size:2rem;color:rgba(255,170,0,0.3);"></i></div>`;
        } else if (file.cat === 'file') {
            previewHTML = `<div style="width:100%;height:100%;background:#0a0a15;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">
                <i class="fas fa-${docIcon}" style="font-size:2.2rem;color:#7aa2ff;"></i>
                <span style="font-size:0.6rem;color:var(--text-dim);font-family:var(--font-mono);text-transform:uppercase;">${(file.ext || '').slice(0,6)}</span>
            </div>`;
        } else if (isVid) {
            const vsrc = isOffline ? '' : `${thumbSrc}#t=0.1`;
            previewHTML = (vsrc
                ? `<video src="${vsrc}" muted preload="metadata" playsinline></video>`
                : `<div style="width:100%;height:100%;background:#0a0a15;display:flex;align-items:center;justify-content:center;"><i class="fas fa-video" style="font-size:2rem;color:rgba(168,85,247,0.4);"></i></div>`)
                + `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:32px;height:32px;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,0.2);"><i class="fas fa-play" style="color:white;font-size:0.7rem;margin-left:2px;"></i></div>`;
        } else {
            previewHTML = `<img src="${thumbSrc}" loading="lazy" alt="${file.name || ''}">`;
        }

        const trashMenu = `<div class="dd-header">Trash Actions</div>
            <div class="dd-item" onclick="window.restoreFile('${file.id}')"><i class="fas fa-rotate-left"></i> Restore</div>
            <div class="dd-item danger" onclick="window.permanentDelete('${file.id}')"><i class="fas fa-fire"></i> Delete Forever</div>`;
        const normalMenu = `<div class="dd-header">File Actions</div>
            <div class="dd-item" onclick="window.openNexusLightbox('${file.id}')"><i class="fas fa-expand"></i> View</div>
            <div class="dd-item" onclick="window.showFileInfo('${file.id}')"><i class="fas fa-circle-info"></i> Details</div>
            <div class="dd-divider"></div>
            <div class="dd-item" onclick="window.renameFile('${file.id}')"><i class="fas fa-pen"></i> Rename</div>
            <div class="dd-item" onclick="window.copyToFolder('${file.id}')"><i class="fas fa-copy"></i> Copy to</div>
            <div class="dd-item" onclick="window.moveToFolder('${file.id}')"><i class="fas fa-folder-open"></i> Move to</div>
            <div class="dd-divider"></div>
            <div class="dd-item" onclick="window.star('${file.id}', ${!!file.starred})"><i class="fas fa-star"></i> ${file.starred ? 'Unstar' : 'Star'}</div>
            <div class="dd-item" onclick="window.toggleLock('${file.id}')"><i class="fas fa-${file.locked ? 'unlock' : 'lock'}"></i> ${file.locked ? 'Unlock' : 'Lock'}</div>
            <div class="dd-item" onclick="window.toggleDuress('${file.id}')"><i class="fas fa-user-secret"></i> ${file.duress ? 'Remove from Duress Set' : 'Add to Duress Set'}</div>
            <div class="dd-item" onclick="window.openAccountTransferPicker('${file.id}','move')"><i class="fas fa-right-left"></i> Move to Account</div>
            <div class="dd-item" onclick="window.openAccountTransferPicker('${file.id}','copy')"><i class="fas fa-copy"></i> Copy to Account</div>
            <div class="dd-item" onclick="window.copyLink('${file.url}')"><i class="fas fa-link"></i> Copy Link</div>
            <div class="dd-item" onclick="window.downloadFile('${file.url}','${file.name}')"><i class="fas fa-download"></i> Download</div>
            <div class="dd-divider"></div>
            <div class="dd-item danger" onclick="window.trashFile('${file.id}')"><i class="fas fa-trash"></i> Trash</div>`;

        const selCheck = selectMode
            ? `<div class="select-check ${selectedIds.has(file.id) ? 'checked' : ''}" onclick="event.stopPropagation(); window.toggleSelect('${file.id}')"></div>` : '';

        const previewClick = isLocked
            ? `onclick="window.unlockFile('${file.id}')"`
            : selectMode ? ''
            : file.cat === 'file' ? `onclick="window.downloadFile('${file.url}','${file.name}')"`
            : `onclick="window.openNexusLightbox('${file.id}')"`;

        card.innerHTML = `
            ${selCheck}
            <div class="dots" onclick="event.stopPropagation(); window.toggleMenu(event,'${file.id}')"><i class="fas fa-ellipsis-v"></i></div>
            <div id="menu-${file.id}" class="dropdown">${currentTab === 'trash' ? trashMenu : normalMenu}</div>
            ${acctNum ? `<div class="acct-num-badge" title="${acctLabel}">${acctNum}</div>` : ''}
            ${file.ocrText ? `<div class="ocr-badge" title="Text found: ${file.ocrText.slice(0,80).replace(/"/g,'&quot;')}"><i class="fas fa-magnifying-glass"></i></div>` : ''}
            ${file.starred && !isLocked ? '<div class="star-badge"><i class="fas fa-star"></i></div>' : ''}
            ${(file.locked || acctLocked) ? '<div class="lock-badge"><i class="fas fa-shield-halved"></i></div>' : ''}
            <div class="preview" ${previewClick}>
                <span class="file-badge ${isVid ? 'badge-vid' : file.cat === 'file' ? 'badge-doc' : 'badge-img'}">${isVid ? 'Vid' : file.cat === 'file' ? (file.ext || 'Doc') : 'Img'}</span>
                ${previewHTML}
                <div class="preview-overlay"></div>
            </div>
            <div class="meta">
                <div class="filename" title="${file.name||''}">${file.name||'Untitled'}</div>
                <div class="fileinfo"><span>${file.size||'—'}</span><span>${date}</span></div>
                ${fo ? `<div class="folder-tag"><i class="fas fa-folder" style="font-size:.55rem;"></i> ${fo.name}</div>` : ''}
            </div>`;

        grid.appendChild(card);
    });

    updateMultiBarActions();

    // Re-trigger AOS for new card elements
    const obs = new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('aos-in'); obs.unobserve(e.target); } });
    }, { threshold: 0.05 });
    grid.querySelectorAll('.card').forEach(c => obs.observe(c));
}

function updateMultiBarActions() {
    const ad = document.getElementById('multiBarActions');
    if (currentTab === 'trash') {
        ad.innerHTML = `
            <button class="multi-btn restore" onclick="window.multiRestore()"><i class="fas fa-rotate-left"></i> <span>Restore</span></button>
            <button class="multi-btn danger" onclick="window.multiPermanentDelete()"><i class="fas fa-fire"></i> <span>Delete</span></button>`;
    } else {
        ad.innerHTML = `
            <button class="multi-btn" onclick="window.multiMoveToAccount()" title="Move to Account"><i class="fas fa-right-left"></i></button>
            <button class="multi-btn" onclick="window.multiCopyToAccount()" title="Copy to Account"><i class="fas fa-copy"></i></button>
            <button class="multi-btn" onclick="window.multiStar()"><i class="fas fa-star"></i> <span>Star</span></button>
            <button class="multi-btn" onclick="window.bulkAddToDuress()" title="Add to Duress Set"><i class="fas fa-user-secret"></i></button>
            <button class="multi-btn" onclick="window.multiDownload()" title="Download all as .zip"><i class="fas fa-download"></i></button>
            <button class="multi-btn danger" onclick="window.multiTrash()"><i class="fas fa-trash"></i></button>`;
    }
}

/* ─── NexusLightbox opener ───────────────────────────────────── */
window.openNexusLightbox = fileId => {
    const file = allFiles.find(f => f.id === fileId);
    if (!file) return;
    if ((file.locked || isAcctLocked(file)) && !file._unlocked) { window.unlockFile(fileId); return; }

    const list = sortedList(getVisibleFiles());
    const lbItems = buildLbItems(list);
    const startIdx = lbItems.findIndex(li => li.id === fileId);

    NexusLightbox.open(lbItems, startIdx >= 0 ? startIdx : 0, {
        onStar: async (id, curStarred) => {
            const f = allFiles.find(x => x.id === id);
            if (!f) return;
            f.starred = !curStarred;
            NexusLightbox.updateItem(id, { starred: f.starred });
            render();
            if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { starred: f.starred });
            else { await idbPut('files', f); await addToSyncQueue({ type:'update', id, data:{ starred: f.starred } }); }
            showToast(curStarred ? 'Removed from starred' : 'Added to starred', 'success');
        },
        onTrash: id => { window.trashFile(id); }
    });
};

window.openPreview = id => window.openNexusLightbox(id);

/* ─── Tabs / View / Search / Sort ───────────────────────────── */
window.setTab    = (t, el) => { currentTab = t; document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); el.classList.add('active'); selectedIds.clear(); updateMultiBar(); render(); };
window.setFolder = (fid, el) => { currentFolder = fid; document.querySelectorAll('.folder-pill').forEach(p => p.classList.remove('active')); if (el) el.classList.add('active'); render(); };
window.handleSearch = () => {
    searchText = document.getElementById('searchInput').value.trim();
    document.getElementById('searchClearBtn').style.opacity = searchText ? '1' : '0';
    render();
};
window.clearSearch = () => {
    document.getElementById('searchInput').value = '';
    searchText = '';
    document.getElementById('searchClearBtn').style.opacity = '0';
    render();
};
window.handleSort = () => { sortMode = document.getElementById('sortSelect').value; render(); };
window.setView = mode => {
    viewMode = mode;
    document.getElementById('gridViewBtn').classList.toggle('active', mode === 'grid');
    document.getElementById('listViewBtn').classList.toggle('active', mode === 'list');
    render();
};

/* ─── Upload ─────────────────────────────────────────────────── */
window.toggleUploadPanel = () => {
    const p = document.getElementById('uploadPanel');
    const isHidden = p.classList.toggle('hidden');
    if (!isHidden) updateUploadQueueBadge();
};
window.handleDrop = e => {
    e.preventDefault();
    document.getElementById('dropZone').classList.remove('drag-over');
    stageFiles([...e.dataTransfer.files]);
};
window.handleFileSelect = e => stageFiles([...e.target.files]);

function stageFiles(files) {
    const valid = files.filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
    valid.forEach(f => {
        if (!pendingUploadFiles.find(pf => pf.file.name === f.name && pf.file.size === f.size)) {
            pendingUploadFiles.push({ file: f });
        }
    });
    renderStagedFiles();
}

function renderStagedFiles() {
    const staged = document.getElementById('stagedFiles');
    staged.innerHTML = '';
    pendingUploadFiles.forEach((item, i) => {
        const size = (item.file.size / 1024 / 1024).toFixed(2) + ' MB';
        const icon = item.file.type.startsWith('video') ? 'fa-video' : 'fa-image';
        const statusHtml = item.status ? `<span class="staged-status ${item.status}">${item.status}</span>` : '';
        const div = document.createElement('div');
        div.className = 'staged-item';
        div.innerHTML = `<i class="fas ${icon}"></i>
            <span class="staged-name">${item.file.name}</span>
            <span class="staged-size">${size}</span>
            ${statusHtml}
            <button onclick="window.removeStagedFile(${i})" style="color:var(--danger);font-size:0.9rem;padding:0 4px;">×</button>`;
        staged.appendChild(div);
    });
}
window.removeStagedFile = i => { pendingUploadFiles.splice(i, 1); renderStagedFiles(); };

window.startUpload = async () => {
    if (!pendingUploadFiles.length) { showToast('No files staged', 'warning'); return; }
    if (uploadInProgress) return;
    const folder = document.getElementById('uploadFolder').value;
    const customName = document.getElementById('uploadName').value.trim();
    const chosenAccount = document.getElementById('uploadAccount')?.value || '';

    if (!navigator.onLine) {
        // Queue for later
        for (const item of pendingUploadFiles) {
            const fileAccount = resolveUploadAccountForFile(item.file, chosenAccount);
            await addToPendingUploads({ file: item.file, customName, folder, account: fileAccount });
            item.status = 'queued';
        }
        renderStagedFiles();
        updateUploadQueueBadge();
        showToast(`${pendingUploadFiles.length} file(s) queued — will upload when online`, 'warning');
        return;
    }

    uploadInProgress = true;
    const btn = document.getElementById('uploadBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…';

    const progress = document.getElementById('uploadProgress');
    const upBar    = document.getElementById('upBar');
    const upPct    = document.getElementById('upPercent');
    const upName   = document.getElementById('upFileName');
    progress.classList.remove('hidden');

    for (let i = 0; i < pendingUploadFiles.length; i++) {
        const item = pendingUploadFiles[i];
        const fileAccount = resolveUploadAccountForFile(item.file, chosenAccount);
        upName.textContent = item.file.name;
        upPct.textContent  = '0%';
        upBar.style.width  = '0%';
        try {
            await uploadSingleFile(item.file, customName, folder, pct => {
                upBar.style.width = pct + '%';
                upPct.textContent  = pct + '%';
            }, fileAccount);
            item.status = 'done';
        } catch (e) {
            item.status = 'error';
            showToast(`Failed: ${item.file.name}`, 'error');
        }
        renderStagedFiles();
    }

    progress.classList.add('hidden');
    uploadInProgress = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-rocket"></i> Upload';
    pendingUploadFiles = pendingUploadFiles.filter(f => f.status !== 'done');
    renderStagedFiles();
    showToast('Upload complete!', 'success');
    if (!pendingUploadFiles.length) setTimeout(() => window.toggleUploadPanel(), 1000);
};

async function uploadSingleFile(file, customName, folder, onProgress, account) {
    const token = await getAuthToken();
    return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);
        if (account) fd.append('account', account);
        const xhr = new XMLHttpRequest();
        // Progress reflects the browser → Worker leg. The Worker → Cloudinary
        // leg (plus the Firebase usage update) happens after that reaches
        // 90%, so we hold at 90% until the response comes back.
        xhr.upload.onprogress = e => {
            if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 90));
        };
        xhr.onload = async () => {
            let data;
            try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
            if (xhr.status >= 200 && xhr.status < 300) {
                onProgress(95);
                const cat = data.resourceType === 'video' ? 'video' : data.resourceType === 'image' ? 'image' : 'file';
                const rec = {
                    url:          data.secure_url,
                    publicId:     data.publicId,
                    account:      data.account,
                    resourceType: data.resourceType,
                    cat:     cat,
                    name:    customName || file.name.replace(/\.[^.]+$/, ''),
                    ext:     (file.name.match(/\.([^.]+)$/) || [,''])[1].toLowerCase(),
                    size:    (file.size / 1024 / 1024).toFixed(2) + ' MB',
                    folder:  folder || '',
                    time:    Date.now(),
                    ocrText: data.ocrText || '',
                    ocrDone: !!data.ocrDone,
                    starred: false, locked: false, trash: false, duress: false
                };
                const newRef = push(ref(db, DB_PATH));
                await set(newRef, rec);
                onProgress(100);
                if (data.nearCapacity) showToast('A Cloudinary account is nearing capacity', 'warning');
                resolve();
            } else reject(new Error(data.error || xhr.statusText));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.open('POST', `${WORKER_URL}/cloudinary/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(fd);
    });
}

/* ─── Dropdown menu ──────────────────────────────────────────── */
window.toggleMenu = (e, id) => {
    e.stopPropagation();
    const open = document.querySelector('.dropdown.show');
    if (open && open.id !== `menu-${id}`) open.classList.remove('show');
    document.getElementById(`menu-${id}`)?.classList.toggle('show');
};
document.addEventListener('click', e => {
    if (!e.target.closest('.dropdown') && !e.target.closest('.dots'))
        document.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));
});

/* ─── Context menu (right-click / long press) ────────────────── */
let longPressTimer = null;
window.showContextMenu = (e, id) => {
    contextTarget = id;
    const cm = document.getElementById('contextMenu');
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    cm.innerHTML = `
        <div class="dd-header">QUICK ACTIONS</div>
        <div class="dd-item" onclick="window.openNexusLightbox('${id}'); window.hideContextMenu()"><i class="fas fa-expand"></i> View</div>
        <div class="dd-item" onclick="window.star('${id}',${!!file.starred}); window.hideContextMenu()"><i class="fas fa-star"></i> ${file.starred?'Unstar':'Star'}</div>
        <div class="dd-item" onclick="window.renameFile('${id}'); window.hideContextMenu()"><i class="fas fa-pen"></i> Rename</div>
        <div class="dd-item" onclick="window.downloadFile('${file.url}','${file.name}'); window.hideContextMenu()"><i class="fas fa-download"></i> Download</div>
        <div class="dd-divider"></div>
        <div class="dd-item danger" onclick="window.trashFile('${id}'); window.hideContextMenu()"><i class="fas fa-trash"></i> Trash</div>`;
    cm.style.left = Math.min(e.clientX, window.innerWidth  - 190) + 'px';
    cm.style.top  = Math.min(e.clientY, window.innerHeight - 220) + 'px';
    cm.classList.remove('hidden');
};
window.hideContextMenu = () => document.getElementById('contextMenu').classList.add('hidden');
document.addEventListener('click', () => window.hideContextMenu());

/* ─── File operations ────────────────────────────────────────── */
async function fbUpdate(id, data) {
    const f = allFiles.find(x => x.id === id);
    if (f) Object.assign(f, data);
    if (navigator.onLine) {
        update(ref(db, `${DB_PATH}/${id}`), data);
    } else {
        if (f) await idbPut('files', f);
        await addToSyncQueue({ type: 'update', id, data });
        setSyncBadge('offline', 'OFFLINE');
    }
    updateStats(); render();
}

window.star = async (id, cur) => {
    await fbUpdate(id, { starred: !cur });
    showToast(cur ? 'Removed from starred' : 'Starred!', 'success');
};

window.trashFile = async id => {
    await fbUpdate(id, { trash: true });
    showToast('Moved to trash', 'info');
};

window.restoreFile = async id => {
    await fbUpdate(id, { trash: false });
    showToast('File restored', 'success');
};

/** Deletes a file's actual media from Cloudinary via the Worker
 *  (using its own account + publicId), so storage is really reclaimed
 *  and the account's usage counter stays accurate. Files uploaded
 *  before this system existed have no publicId/account — those are
 *  skipped here and just removed from the gallery as before. */
async function deleteFromCloudinary(file) {
    if (!file?.publicId || !file?.account) return; // legacy record, nothing to reclaim
    const token = await getAuthToken();
    const res = await fetch(`${WORKER_URL}/cloudinary/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
            publicId:     file.publicId,
            account:      file.account,
            resourceType: file.resourceType || (file.cat === 'video' ? 'video' : 'image'),
            sizeMb:       parseFloat(file.size) || 0
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Cloud delete failed');
}

window.permanentDelete = id => {
    showModal({
        title: 'DELETE FOREVER',
        body:  'This action cannot be undone. The file will be permanently deleted.',
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Delete Forever', cls: 'modal-btn-danger', action: async () => {
                closeModal();
                const file = allFiles.find(f => f.id === id);
                if (navigator.onLine) {
                    try { await deleteFromCloudinary(file); }
                    catch (e) { showToast(`Could not delete from cloud: ${e.message}`, 'error'); return; }
                    await remove(ref(db, `${DB_PATH}/${id}`));
                } else {
                    await addToSyncQueue({ type: 'delete', id, cloud: file });
                }
                allFiles = allFiles.filter(f => f.id !== id);
                await idbDelete('files', id);
                updateStats(); render();
                showToast('File permanently deleted', 'warning');
            }}
        ]
    });
};

window.renameFile = id => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    showModal({
        title:   'RENAME FILE',
        body:    'Enter a new name for this file:',
        input:   file.name || '',
        btns:    [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Rename', cls: 'modal-btn-confirm', action: async () => {
                const newName = document.getElementById('modalInput')?.value.trim();
                if (!newName) { showToast('Name cannot be empty', 'warning'); return; }
                closeModal();
                await fbUpdate(id, { name: newName });
                showToast('File renamed', 'success');
            }}
        ]
    });
};

window.toggleLock = id => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    if (file.locked) {
        showPasscodeScreen(() => {
            document.getElementById('passcodeSection').classList.add('hidden');
            fbUpdate(id, { locked: false });
            showToast('File unlocked', 'success');
        });
    } else {
        fbUpdate(id, { locked: true });
        showToast('File locked', 'success');
    }
};

window.unlockFile = id => {
    const file = allFiles.find(f => f.id === id);
    if (!file || !(file.locked || isAcctLocked(file))) return;
    const openCb = () => {
        document.getElementById('passcodeSection').classList.add('hidden');
        file._unlocked = true;
        render();
        setTimeout(() => window.openNexusLightbox(id), 100);
    };
    const acct = file.account ? cloudinaryAccounts[file.account] : null;
    if (acct && acct.locked && acct.passwordHash) {
        showAccountPasswordScreen(file.account, acct.passwordHash, openCb);
    } else {
        showPasscodeScreen(openCb);
    }
};

window.moveToFolder = id => {
    showFolderPicker(id, true);
};
window.copyToFolder = id => {
    showFolderPicker(id, false);
};

function showFolderPicker(id, move) {
    const opts = [{ value: '', label: 'No Folder' }, ...folders.map(f => ({ value: f.id, label: f.name }))];
    const optHtml = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    showModal({
        title:  move ? 'MOVE TO FOLDER' : 'COPY TO FOLDER',
        body:   `<select id="folderPickerSel" class="modal-input" style="width:100%">${optHtml}</select>`,
        btns:   [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: move ? 'Move' : 'Copy', cls: 'modal-btn-confirm', action: async () => {
                const sel = document.getElementById('folderPickerSel');
                const folderId = sel?.value || '';
                closeModal();
                if (move) {
                    await fbUpdate(id, { folder: folderId });
                    showToast('File moved', 'success');
                } else {
                    // Copy: create new record
                    const file = allFiles.find(f => f.id === id);
                    if (!file) return;
                    const { id: _id, offlineData: _od, ...data } = file;
                    data.folder = folderId;
                    data.time   = Date.now();
                    const newRef = push(ref(db, DB_PATH));
                    if (navigator.onLine) await set(newRef, data);
                    else await addToSyncQueue({ type: 'create', id: newRef.key, data });
                    showToast('File copied', 'success');
                }
            }}
        ]
    });
}

window.copyLink = url => {
    navigator.clipboard?.writeText(url);
    showToast('Link copied', 'success');
};

window.downloadFile = (url, name) => {
    const a = document.createElement('a');
    a.href = url; a.download = name || 'file'; a.target = '_blank';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
};

window.showFileInfo = id => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    const fo   = folders.find(f => f.id === file.folder);
    const date = file.time ? new Date(file.time).toLocaleString() : '—';
    const cached = file.offlineData ? '✅ Cached offline' : '⚡ Online only';
    const ocrRow = file.cat === 'image'
        ? (file.ocrDone
            ? (file.ocrText
                ? `<div><b style="color:var(--text)">OCR text found:</b><br><span style="font-style:italic;">"${file.ocrText.slice(0,300)}${file.ocrText.length>300?'…':''}"</span></div>`
                : `<div><b style="color:var(--text)">OCR:</b> ✅ checked — no readable text found</div>`)
            : `<div><b style="color:var(--text)">OCR:</b> ⏳ not processed yet</div>`)
        : '';
    showModal({
        title: 'FILE DETAILS',
        body: `<div style="display:flex;flex-direction:column;gap:8px;font-size:0.75rem;color:var(--text-muted);">
            <div><b style="color:var(--text)">Name:</b> ${file.name || '—'}</div>
            <div><b style="color:var(--text)">Type:</b> ${file.cat === 'video' ? 'Video' : file.cat === 'file' ? 'Document' : 'Image'}</div>
            <div><b style="color:var(--text)">Size:</b> ${file.size || '—'}</div>
            <div><b style="color:var(--text)">Date:</b> ${date}</div>
            <div><b style="color:var(--text)">Folder:</b> ${fo ? fo.name : 'None'}</div>
            <div><b style="color:var(--text)">Starred:</b> ${file.starred ? '⭐ Yes' : 'No'}</div>
            <div><b style="color:var(--text)">Locked:</b> ${file.locked ? '🔒 Yes' : 'No'}</div>
            <div><b style="color:var(--text)">Cache:</b> ${cached}</div>
            ${ocrRow}
        </div>`,
        btns: [{ label: 'Close', cls: 'modal-btn-cancel', action: closeModal }]
    });
};

/* ─── Trash bulk actions ─────────────────────────────────────── */
window.restoreAll = () => {
    showModal({
        title: 'RESTORE ALL',
        body:  'Restore all files from trash?',
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Restore All', cls: 'modal-btn-confirm', action: async () => {
                closeModal();
                const trashed = allFiles.filter(f => f.trash);
                for (const f of trashed) await fbUpdate(f.id, { trash: false });
                showToast(`Restored ${trashed.length} files`, 'success');
            }}
        ]
    });
};

window.purgeTrash = () => {
    showModal({
        title: 'EMPTY TRASH',
        body:  'Permanently delete ALL trashed files? This cannot be undone.',
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Empty Trash', cls: 'modal-btn-danger', action: async () => {
                closeModal();
                const trashed = allFiles.filter(f => f.trash);
                for (const f of trashed) {
                    if (navigator.onLine) {
                        try { await deleteFromCloudinary(f); } catch (e) { console.warn('[Trash] Cloud delete failed:', e); }
                        await remove(ref(db, `${DB_PATH}/${f.id}`));
                    } else {
                        await addToSyncQueue({ type: 'delete', id: f.id, cloud: f });
                    }
                    await idbDelete('files', f.id);
                }
                allFiles = allFiles.filter(f => !f.trash);
                updateStats(); render();
                showToast(`Permanently deleted ${trashed.length} files`, 'warning');
            }}
        ]
    });
};

/* ─── Folder CRUD ────────────────────────────────────────────── */
window.createFolder = () => {
    const colors = ['#00ffcc','#00d4ff','#7b2fff','#ff3355','#ffaa00','#00ff88','#ff6b35','#ff2d87'];
    let selectedColor = colors[0];
    showModal({
        title: 'NEW FOLDER',
        body: `<input id="folderNameInput" class="modal-input" placeholder="Folder name" style="width:100%;margin-bottom:12px;">
               <div style="margin-bottom:6px;font-size:0.62rem;color:var(--text-muted);letter-spacing:1px;">COLOR</div>
               <div class="color-swatches">${colors.map(c =>
                   `<div class="swatch${c===selectedColor?' active':''}" style="background:${c}" data-color="${c}" onclick="window.pickSwatchColor('${c}')"></div>`
               ).join('')}</div>`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Create', cls: 'modal-btn-confirm', action: async () => {
                const name = document.getElementById('folderNameInput')?.value.trim();
                if (!name) { showToast('Enter a folder name', 'warning'); return; }
                const color = window._pickedFolderColor || colors[0];
                closeModal();
                const newRef = push(ref(db, FOLDERS_PATH));
                const fData = { name, color, time: Date.now() };
                if (navigator.onLine) await set(newRef, fData);
                else await addToSyncQueue({ type:'folderCreate', id: newRef.key, data: fData });
                showToast(`Folder "${name}" created`, 'success');
            }}
        ]
    });
};
window.pickSwatchColor = c => {
    window._pickedFolderColor = c;
    document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === c));
};

window.folderContext = (e, fid) => {
    e.preventDefault();
    const fo = folders.find(f => f.id === fid);
    if (!fo) return;
    showModal({
        title: `FOLDER: ${fo.name}`,
        body:  'What would you like to do with this folder?',
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Rename', cls: 'modal-btn-confirm', action: () => {
                closeModal();
                showModal({
                    title: 'RENAME FOLDER',
                    input: fo.name,
                    btns: [
                        { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
                        { label: 'Rename', cls: 'modal-btn-confirm', action: async () => {
                            const n = document.getElementById('modalInput')?.value.trim();
                            if (!n) return;
                            closeModal();
                            if (navigator.onLine) await update(ref(db, `${FOLDERS_PATH}/${fid}`), { name: n });
                            else await addToSyncQueue({ type:'update', id: fid, data:{ name: n } });
                            showToast('Folder renamed', 'success');
                        }}
                    ]
                });
            }},
            { label: 'Delete', cls: 'modal-btn-danger', action: () => {
                closeModal();
                showModal({
                    title: 'DELETE FOLDER',
                    body:  `Delete folder "${fo.name}"? Files inside will stay but lose their folder.`,
                    btns:  [
                        { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
                        { label: 'Delete', cls: 'modal-btn-danger', action: async () => {
                            closeModal();
                            if (navigator.onLine) await remove(ref(db, `${FOLDERS_PATH}/${fid}`));
                            else await addToSyncQueue({ type:'folderDelete', id: fid });
                            folders = folders.filter(f => f.id !== fid);
                            await idbDelete('folders', fid);
                            renderFolders();
                            showToast('Folder deleted', 'info');
                        }}
                    ]
                });
            }}
        ]
    });
};

/* ─── Select mode ────────────────────────────────────────────── */
window.toggleSelectMode = () => {
    selectMode = !selectMode;
    if (!selectMode) selectedIds.clear();
    document.getElementById('selectModeBtn').classList.toggle('active', selectMode);
    updateMultiBar();
    render();
};
window.toggleSelect = id => {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    updateMultiBar();
    document.querySelectorAll(`.card[data-id="${id}"]`).forEach(c => c.classList.toggle('selected', selectedIds.has(id)));
    document.querySelectorAll(`#menu-${id}`).forEach(m => m.closest('.card')?.querySelector('.select-check')?.classList.toggle('checked', selectedIds.has(id)));
};
function updateMultiBar() {
    const bar = document.getElementById('multiBar');
    if (selectMode) {
        bar.classList.remove('hidden');
        document.getElementById('selectedCount').textContent = selectedIds.size;
    } else {
        bar.classList.add('hidden');
    }
}

/* Multi-select batch ops */
window.multiTrash  = async () => { for (const id of selectedIds) await fbUpdate(id, { trash: true }); showToast(`${selectedIds.size} files trashed`, 'info'); selectedIds.clear(); updateMultiBar(); };
window.multiStar   = async () => { for (const id of selectedIds) await fbUpdate(id, { starred: true }); showToast(`${selectedIds.size} files starred`, 'success'); };
window.multiRestore = async () => { for (const id of selectedIds) await fbUpdate(id, { trash: false }); showToast(`${selectedIds.size} files restored`, 'success'); selectedIds.clear(); updateMultiBar(); };
window.multiPermanentDelete = () => {
    showModal({
        title: 'DELETE SELECTED',
        body:  `Permanently delete ${selectedIds.size} files?`,
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Delete All', cls: 'modal-btn-danger', action: async () => {
                closeModal();
                for (const id of selectedIds) {
                    const file = allFiles.find(f => f.id === id);
                    if (navigator.onLine) {
                        try { await deleteFromCloudinary(file); } catch (e) { console.warn('[MultiDelete] Cloud delete failed:', e); }
                        await remove(ref(db, `${DB_PATH}/${id}`));
                    } else {
                        await addToSyncQueue({ type:'delete', id, cloud: file });
                    }
                    allFiles = allFiles.filter(f => f.id !== id);
                    await idbDelete('files', id);
                }
                selectedIds.clear(); updateMultiBar(); updateStats(); render();
                showToast('Files permanently deleted', 'warning');
            }}
        ]
    });
};
/** Downloads all selected files bundled into ONE .zip (via JSZip, loaded
 *  from cdnjs — no server involvement needed, Cloudinary URLs are public
 *  GETs with permissive CORS). Falls back to one-by-one browser downloads
 *  if JSZip fails to load for any reason. */
window.multiDownload = async () => {
    if (!selectedIds.size) return;
    const files = [...selectedIds].map(id => allFiles.find(f => f.id === id)).filter(Boolean);
    if (!files.length) return;

    if (typeof JSZip === 'undefined') {
        showToast('Zip library unavailable — downloading files individually instead', 'warning');
        files.forEach(f => window.downloadFile(f.url, f.name));
        return;
    }

    showToast(`Zipping ${files.length} file(s)…`, 'info');
    try {
        const zip = new JSZip();
        const usedNames = new Set();
        let done = 0;
        for (const f of files) {
            try {
                const res = await fetch(f.url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                let name = (f.name || f.id) + (f.ext ? `.${f.ext}` : (f.cat === 'video' ? '.mp4' : '.jpg'));
                while (usedNames.has(name)) name = `_${name}`; // avoid collisions inside the zip
                usedNames.add(name);
                zip.file(name, blob);
            } catch (e) {
                console.error(`Skipped ${f.name} in zip:`, e.message);
            }
            done++;
        }
        const content = await zip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = `csm-drive-${Date.now()}.zip`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        showToast(`Downloaded ${done} file(s) as a zip`, 'success');
    } catch (e) {
        showToast(`Zip failed: ${e.message} — try individual downloads`, 'error');
    }
};

/** Bulk "Move to Account" / "Copy to Account" — same underlying Worker
 *  endpoint as the single-file version, just looped over every selected
 *  file. Files already on the chosen target are silently skipped. */
window.multiTransferToAccount = mode => {
    if (!selectedIds.size) return;
    const files = [...selectedIds].map(id => allFiles.find(f => f.id === id)).filter(Boolean);
    if (!files.length) return;
    const targetIds = getSortedAccountIds().filter(aid => cloudinaryAccounts[aid]?.enabled !== false);
    if (!targetIds.length) { showToast('No enabled account available', 'warning'); return; }
    const options = targetIds.map(aid => `<option value="${aid}">${cloudinaryAccounts[aid]?.label || aid}</option>`).join('');
    showModal({
        title: mode === 'move' ? `MOVE ${files.length} FILES` : `COPY ${files.length} FILES`,
        body: `<div style="display:flex;flex-direction:column;gap:10px;">
            <div class="settings-row-sub" style="padding:0;">${mode === 'move' ? 'Relabels' : 'Adds a second listing for'} ${files.length} selected file(s) under another account — instant, no re-upload, no physical Cloudinary transfer. Files already on the target account are skipped.</div>
            <select id="bulkTransferTarget" class="modal-input" style="margin-bottom:0;">${options}</select>
        </div>`,
        btns: [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: mode === 'move' ? 'Move All' : 'Copy All', cls: 'modal-btn-confirm', action: async () => {
                const targetAccountId = document.getElementById('bulkTransferTarget')?.value;
                if (!targetAccountId) return;
                closeModal();
                if (!navigator.onLine && mode === 'copy') { showToast('Copying needs an internet connection', 'warning'); return; }
                let done = 0, skipped = 0, failed = 0;
                for (const file of files) {
                    if (file.account === targetAccountId) { skipped++; continue; }
                    try {
                        await relabelFileAccount(file, targetAccountId, mode, { silent: true });
                        done++;
                    } catch (e) {
                        failed++;
                        console.error(`Relabel failed for ${file.name}:`, e.message);
                    }
                }
                render();
                selectedIds.clear();
                updateMultiBar();
                showToast(
                    `${mode === 'move' ? 'Moved' : 'Copied'} ${done}${skipped ? `, skipped ${skipped}` : ''}${failed ? `, failed ${failed}` : ''}`,
                    failed ? 'warning' : 'success'
                );
            }}
        ]
    });
};
window.multiMoveToAccount = () => window.multiTransferToAccount('move');
window.multiCopyToAccount = () => window.multiTransferToAccount('copy');

/* ─── Modal ──────────────────────────────────────────────────── */
function showModal({ title, body, input, btns }) {
    const overlay = document.getElementById('modalOverlay');
    const box     = document.getElementById('modalBox');
    const inputHtml = input !== undefined
        ? `<input id="modalInput" class="modal-input" value="${input}" placeholder="Enter name…">`
        : '';
    box.innerHTML = `
        <div class="modal-title">${title}</div>
        ${typeof body === 'string' && body.startsWith('<') ? `<div class="modal-body">${body}</div>` : `<div class="modal-body">${body}</div>`}
        ${inputHtml}
        <div class="modal-btns">${btns.map((b, i) => `<button class="modal-btn ${b.cls}" id="mbtn-${i}">${b.label}</button>`).join('')}</div>`;
    btns.forEach((b, i) => document.getElementById(`mbtn-${i}`).onclick = b.action);
    overlay.classList.remove('hidden');
    const inp = document.getElementById('modalInput');
    if (inp) { inp.focus(); inp.select(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') btns.find(b => b.cls.includes('confirm'))?.action(); }); }
}
function closeModal() { document.getElementById('modalOverlay').classList.add('hidden'); }
document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
});

/* ─── Toast ──────────────────────────────────────────────────── */
function showToast(msg, type = 'info') {
    const tc = document.getElementById('toastContainer');
    if (!tc) return;
    const icons = { success:'check-circle', error:'circle-exclamation', info:'circle-info', warning:'triangle-exclamation' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<i class="fas fa-${icons[type]||'circle-info'}"></i> ${msg}`;
    tc.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3000);
}

/* ─── Settings shortcuts ─────────────────────────────────────── */
window.updatePasscode = () => {
    showModal({
        title: 'CHANGE PASSCODE',
        body:  'Enter new 4-digit passcode:',
        input: '',
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Update', cls: 'modal-btn-confirm', action: async () => {
                const n = document.getElementById('modalInput')?.value.trim();
                if (!/^\d{4}$/.test(n)) { showToast('Must be 4 digits', 'warning'); return; }
                closeModal();
                appPasscode = n;
                if (navigator.onLine) update(ref(db, SETTINGS_PATH), { passcode: n });
                showToast('Passcode updated', 'success');
            }}
        ]
    });
};
