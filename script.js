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
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getDatabase, ref, push, set, onValue, remove, update } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

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

        // Instant offline load from IDB
        const [cachedFiles, cachedFolders] = await Promise.all([
            idbGetAll('files'), idbGetAll('folders')
        ]);
        if (cachedFiles.length) {
            allFiles = cachedFiles; folders = cachedFolders;
            updateStats(); renderFolders(); render(); updateFolderSelect();
        }

        if (passcodeEnabled && !sessionUnlocked) {
            showPasscodeScreen(() => {
                sessionUnlocked = true;
                document.getElementById('passcodeSection').classList.add('hidden');
                showMain();
                loadData(); loadFolders(); loadSettings();
            });
        } else {
            showMain();
            loadData(); loadFolders(); loadSettings();
        }

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

/* ─── Passcode ──────────────────────────────────────────────── */
function showPasscodeScreen(cb) {
    passcodeCallback = cb; passcodeInput = '';
    document.getElementById('passcodeSection').classList.remove('hidden');
    document.getElementById('passcodeMessage').textContent = 'Enter your 4-digit access code';
    updatePasscodeDots();
}
window.enterPasscode = num => {
    if (passcodeInput.length >= 4) return;
    passcodeInput += num;
    updatePasscodeDots();
    if (passcodeInput.length === 4) {
        setTimeout(() => {
            if (passcodeInput === appPasscode) {
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

function loadSettings() {
    if (!navigator.onLine) return;
    onValue(ref(db, SETTINGS_PATH), snap => {
        const s = snap.val();
        if (s?.passcode)        appPasscode     = s.passcode;
        if (s?.passcodeEnabled !== undefined) passcodeEnabled = s.passcodeEnabled;
    });
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
            if (item.type === 'delete') await remove(ref(db, `${DB_PATH}/${item.id}`));
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
            await uploadQueuedItem(file, item.customName, item.folder);
            await idbDelete('pendingUploads', item.uid);
        } catch (e) { console.warn('[Upload] Failed:', e); }
    }
    updateUploadQueueBadge();
    showToast('Offline uploads complete!', 'success');
}

async function uploadQueuedItem(file, customName, folder) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', 'github_unsigned');
    const res  = await fetch('https://api.cloudinary.com/v1_1/dgxbcqtly/auto/upload', { method: 'POST', body: fd });
    const data = await res.json();
    const isVid = file.type.startsWith('video');
    const rec = {
        url:     data.secure_url,
        cat:     isVid ? 'video' : 'image',
        name:    customName || file.name.replace(/\.[^.]+$/, ''),
        size:    (file.size / 1024 / 1024).toFixed(2) + ' MB',
        folder:  folder || '',
        time:    Date.now(),
        starred: false, locked: false, trash: false
    };
    const newRef = push(ref(db, DB_PATH));
    await set(newRef, rec);
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
    const active   = allFiles.filter(f => !f.trash);
    const imgs     = active.filter(f => f.cat !== 'video').length;
    const vids     = active.filter(f => f.cat === 'video').length;
    const stars    = active.filter(f => f.starred).length;
    const trashed  = allFiles.filter(f => f.trash).length;
    const total    = Math.max(active.length, 1);

    document.getElementById('imgCount').textContent   = imgs;
    document.getElementById('vidCount').textContent   = vids;
    document.getElementById('starCount').textContent  = stars;
    document.getElementById('trashCount').textContent = trashed;

    document.getElementById('imgBar').style.width   = (imgs  / total * 100) + '%';
    document.getElementById('vidBar').style.width   = (vids  / total * 100) + '%';
    document.getElementById('starBar').style.width  = (stars / total * 100) + '%';
    document.getElementById('trashBar').style.width = (trashed / Math.max(trashed + total, 1) * 100) + '%';

    let totalSize = 0;
    allFiles.forEach(f => { if (f.size) totalSize += parseFloat(f.size); });
    const cap = 1024;
    document.getElementById('storageFill').style.width = Math.min(totalSize / cap * 100, 100) + '%';
    document.getElementById('storageText').textContent = `${totalSize.toFixed(1)} MB / ${cap} MB (${allFiles.length} files)`;
}

/* ─── Folders ────────────────────────────────────────────────── */
function renderFolders() {
    const bar = document.getElementById('folderBar');
    const allCount = allFiles.filter(f => !f.trash).length;
    bar.innerHTML = `<div class="folder-pill ${currentFolder === 'all' ? 'active' : ''}" onclick="window.setFolder('all', this)">
        <i class="fas fa-folder"></i> All <span class="count">${allCount}</span></div>`;
    folders.forEach(f => {
        const cnt = allFiles.filter(file => file.folder === f.id && !file.trash).length;
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
    let list = allFiles.filter(f => {
        if (currentTab === 'trash')   return f.trash;
        if (currentTab === 'starred') return f.starred && !f.trash;
        if (currentTab === 'locked')  return f.locked  && !f.trash;
        if (currentTab === 'all')     return !f.trash;
        return f.cat === currentTab && !f.trash;
    });
    if (currentFolder !== 'all' && currentTab !== 'trash')
        list = list.filter(f => f.folder === currentFolder);
    if (searchText)
        list = list.filter(f => (f.name || '').toLowerCase().includes(searchText.toLowerCase()));
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

    list.forEach((file, idx) => {
        let thumb = file.url || '';
        if (thumb.includes('/upload/')) thumb = thumb.replace('/upload/', '/upload/w_400,q_auto,f_auto/');
        const thumbSrc = (isOffline && file.offlineData) ? file.offlineData : thumb;
        const isVid    = file.cat === 'video';
        const isLocked = file.locked && !file._unlocked;
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
        if (isLocked) {
            previewHTML = `<div style="width:100%;height:100%;background:#0a0a15;display:flex;align-items:center;justify-content:center;"><i class="fas fa-lock" style="font-size:2rem;color:rgba(255,170,0,0.3);"></i></div>`;
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
            <div class="dd-item" onclick="window.copyLink('${file.url}')"><i class="fas fa-link"></i> Copy Link</div>
            <div class="dd-item" onclick="window.downloadFile('${file.url}','${file.name}')"><i class="fas fa-download"></i> Download</div>
            <div class="dd-divider"></div>
            <div class="dd-item danger" onclick="window.trashFile('${file.id}')"><i class="fas fa-trash"></i> Trash</div>`;

        const selCheck = selectMode
            ? `<div class="select-check ${selectedIds.has(file.id) ? 'checked' : ''}" onclick="event.stopPropagation(); window.toggleSelect('${file.id}')"></div>` : '';

        const previewClick = !isLocked && !selectMode
            ? `onclick="window.openNexusLightbox('${file.id}')"`
            : isLocked ? `onclick="window.unlockFile('${file.id}')"` : '';

        card.innerHTML = `
            ${selCheck}
            <div class="dots" onclick="event.stopPropagation(); window.toggleMenu(event,'${file.id}')"><i class="fas fa-ellipsis-v"></i></div>
            <div id="menu-${file.id}" class="dropdown">${currentTab === 'trash' ? trashMenu : normalMenu}</div>
            ${file.starred && !isLocked ? '<div class="star-badge"><i class="fas fa-star"></i></div>' : ''}
            ${file.locked ? '<div class="lock-badge"><i class="fas fa-shield-halved"></i></div>' : ''}
            <div class="preview" ${previewClick}>
                <span class="file-badge ${isVid ? 'badge-vid' : 'badge-img'}">${isVid ? 'Vid' : 'Img'}</span>
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
            <button class="multi-btn" onclick="window.multiCopy()"><i class="fas fa-copy"></i> <span>Copy</span></button>
            <button class="multi-btn" onclick="window.multiStar()"><i class="fas fa-star"></i> <span>Star</span></button>
            <button class="multi-btn" onclick="window.multiDownload()"><i class="fas fa-download"></i></button>
            <button class="multi-btn danger" onclick="window.multiTrash()"><i class="fas fa-trash"></i></button>`;
    }
}

/* ─── NexusLightbox opener ───────────────────────────────────── */
window.openNexusLightbox = fileId => {
    const file = allFiles.find(f => f.id === fileId);
    if (!file) return;
    if (file.locked && !file._unlocked) { window.unlockFile(fileId); return; }

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

    if (!navigator.onLine) {
        // Queue for later
        for (const item of pendingUploadFiles) {
            await addToPendingUploads({ file: item.file, customName, folder });
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
        upName.textContent = item.file.name;
        upPct.textContent  = '0%';
        upBar.style.width  = '0%';
        try {
            await uploadSingleFile(item.file, customName, folder, pct => {
                upBar.style.width = pct + '%';
                upPct.textContent  = pct + '%';
            });
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

function uploadSingleFile(file, customName, folder, onProgress) {
    return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('upload_preset', 'github_unsigned');
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = e => {
            if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 90));
        };
        xhr.onload = async () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const data = JSON.parse(xhr.responseText);
                onProgress(95);
                const isVid = file.type.startsWith('video');
                const rec = {
                    url:     data.secure_url,
                    cat:     isVid ? 'video' : 'image',
                    name:    customName || file.name.replace(/\.[^.]+$/, ''),
                    size:    (file.size / 1024 / 1024).toFixed(2) + ' MB',
                    folder:  folder || '',
                    time:    Date.now(),
                    starred: false, locked: false, trash: false
                };
                const newRef = push(ref(db, DB_PATH));
                await set(newRef, rec);
                onProgress(100);
                resolve();
            } else reject(new Error(xhr.statusText));
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.open('POST', 'https://api.cloudinary.com/v1_1/dgxbcqtly/auto/upload');
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

window.permanentDelete = id => {
    showModal({
        title: 'DELETE FOREVER',
        body:  'This action cannot be undone. The file will be permanently deleted.',
        btns:  [
            { label: 'Cancel', cls: 'modal-btn-cancel', action: closeModal },
            { label: 'Delete Forever', cls: 'modal-btn-danger', action: async () => {
                closeModal();
                if (navigator.onLine) { await remove(ref(db, `${DB_PATH}/${id}`)); }
                else { await addToSyncQueue({ type: 'delete', id }); }
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
    if (!file?.locked) return;
    showPasscodeScreen(() => {
        document.getElementById('passcodeSection').classList.add('hidden');
        file._unlocked = true;
        render();
        setTimeout(() => window.openNexusLightbox(id), 100);
    });
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
    showModal({
        title: 'FILE DETAILS',
        body: `<div style="display:flex;flex-direction:column;gap:8px;font-size:0.75rem;color:var(--text-muted);">
            <div><b style="color:var(--text)">Name:</b> ${file.name || '—'}</div>
            <div><b style="color:var(--text)">Type:</b> ${file.cat === 'video' ? 'Video' : 'Image'}</div>
            <div><b style="color:var(--text)">Size:</b> ${file.size || '—'}</div>
            <div><b style="color:var(--text)">Date:</b> ${date}</div>
            <div><b style="color:var(--text)">Folder:</b> ${fo ? fo.name : 'None'}</div>
            <div><b style="color:var(--text)">Starred:</b> ${file.starred ? '⭐ Yes' : 'No'}</div>
            <div><b style="color:var(--text)">Locked:</b> ${file.locked ? '🔒 Yes' : 'No'}</div>
            <div><b style="color:var(--text)">Cache:</b> ${cached}</div>
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
                    if (navigator.onLine) await remove(ref(db, `${DB_PATH}/${f.id}`));
                    else await addToSyncQueue({ type: 'delete', id: f.id });
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
                    if (navigator.onLine) await remove(ref(db, `${DB_PATH}/${id}`));
                    else await addToSyncQueue({ type:'delete', id });
                    allFiles = allFiles.filter(f => f.id !== id);
                    await idbDelete('files', id);
                }
                selectedIds.clear(); updateMultiBar(); updateStats(); render();
                showToast('Files permanently deleted', 'warning');
            }}
        ]
    });
};
window.multiDownload = () => {
    for (const id of selectedIds) {
        const f = allFiles.find(x => x.id === id);
        if (f) window.downloadFile(f.url, f.name);
    }
};
window.multiCopy = () => {
    if (selectedIds.size) showFolderPicker([...selectedIds][0], false);
};

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
