// CSM DRIVE | ULTRA PRO - script.js v3
// Custom NexusLightbox (zero CDN deps), offline blob preview, background sync uploads

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getDatabase, ref, push, set, onValue, remove, update } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

// ===== FIREBASE =====
const firebaseConfig = {
    apiKey: "AIzaSyBtmUmV1KxQDB0jN9gUQnh-eYWKllMPav0",
    authDomain: "photos-58c8e.firebaseapp.com",
    projectId: "photos-58c8e",
    databaseURL: "https://photos-58c8e-default-rtdb.firebaseio.com"
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getDatabase(fbApp);
const DB_PATH = 'my_gallery';
const FOLDERS_PATH = 'folders';
const SETTINGS_PATH = 'settings';

// ===== APP STATE =====
let allFiles = [];
let folders = [];
let currentTab = 'all';
let currentFolder = 'all';
let searchText = '';
let sortMode = 'newest';
let viewMode = 'grid';
let selectMode = false;
let selectedIds = new Set();
let contextTarget = null;
let appPasscode = '2240';
let passcodeEnabled = true;
let passcodeCallback = null;
let passcodeInput = '';
let sessionUnlocked = false;
let pendingUploadFiles = [];
let uploadInProgress = false;

// ===== INDEXEDDB =====
const IDB_NAME = 'csm_drive_db';
const IDB_VERSION = 2; // bumped for new offlineData store
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
            // BUG FIX #2: store name matches what processSyncQueue reads
            if (!d.objectStoreNames.contains('pendingUploads'))
                d.createObjectStore('pendingUploads', { keyPath: 'uid', autoIncrement: true });
            if (!d.objectStoreNames.contains('settings'))
                d.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = e => { idb = e.target.result; resolve(idb); };
        req.onerror = e => reject(e.target.error);
    });
}

function idbTx(store, mode = 'readonly') {
    return idb.transaction(store, mode).objectStore(store);
}

function idbGetAll(store) {
    return new Promise((res, rej) => {
        const req = idbTx(store).getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => rej(req.error);
    });
}

function idbGet(store, key) {
    return new Promise((res, rej) => {
        const req = idbTx(store).get(key);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

function idbPut(store, value) {
    return new Promise((res, rej) => {
        const req = idbTx(store, 'readwrite').put(value);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

function idbDelete(store, key) {
    return new Promise((res, rej) => {
        const req = idbTx(store, 'readwrite').delete(key);
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
    });
}

function idbClear(store) {
    return new Promise((res, rej) => {
        const req = idbTx(store, 'readwrite').clear();
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
    });
}

// ===== BUG FIX #1: Fetch image → Base64 blob and store in IDB =====
async function cacheImageOfflineData(fileId, imageUrl) {
    try {
        const existing = await idbGet('files', fileId);
        if (existing && existing.offlineData) return; // already cached
        const resp = await fetch(imageUrl);
        if (!resp.ok) return;
        const blob = await resp.blob();
        const base64 = await blobToBase64(blob);
        if (existing) {
            await idbPut('files', { ...existing, offlineData: base64 });
        }
    } catch (e) { /* silent — user may be offline */ }
}

function blobToBase64(blob) {
    return new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result);
        reader.onerror = rej;
        reader.readAsDataURL(blob);
    });
}

// After Firebase data loads, kick off background caching for all image thumbs
async function preCacheAllImages() {
    if (!navigator.onLine) return;
    const files = await idbGetAll('files');
    for (const f of files) {
        if (f.cat === 'image' && f.url && !f.offlineData) {
            // use Cloudinary thumb URL (smaller payload)
            let thumbUrl = f.url;
            if (thumbUrl.includes('/upload/')) {
                thumbUrl = thumbUrl.replace('/upload/', '/upload/w_800,q_auto,f_auto/');
            }
            await cacheImageOfflineData(f.id, thumbUrl);
        }
    }
}

// ===== IDB CACHE HELPERS =====
async function cacheFilesToIDB(files) {
    try {
        await idbClear('files');
        for (const f of files) await idbPut('files', f);
    } catch (e) { console.warn('[IDB] cache files:', e); }
}

async function cacheFoldersToIDB(foldersArr) {
    try {
        await idbClear('folders');
        for (const f of foldersArr) await idbPut('folders', f);
    } catch (e) { console.warn('[IDB] cache folders:', e); }
}

// ===== SYNC QUEUE =====
async function addToSyncQueue(operation) {
    try {
        await idbPut('syncQueue', { ...operation, ts: Date.now() });
        await registerBgSync('csm-sync-queue');
    } catch (e) { console.warn('[SyncQ]', e); }
}

async function registerBgSync(tag) {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        try {
            const reg = await navigator.serviceWorker.ready;
            await reg.sync.register(tag);
        } catch (e) { console.warn('[BgSync] register failed:', e); }
    }
}

async function processSyncQueue() {
    if (!navigator.onLine) return;
    const queue = await idbGetAll('syncQueue');
    if (!queue.length) return;
    console.log(`[Sync] Processing ${queue.length} queued ops`);
    for (const op of queue) {
        try {
            await executeSyncOp(op);
            await idbDelete('syncQueue', op.qid);
        } catch (e) { console.warn('[Sync] op failed:', op, e); }
    }
    if (queue.length) showToast(`${queue.length} offline change(s) synced!`, 'success');
}

async function executeSyncOp(op) {
    switch (op.type) {
        case 'update':
            await update(ref(db, `${DB_PATH}/${op.id}`), op.data); break;
        case 'trash':
            await update(ref(db, `${DB_PATH}/${op.id}`), { trash: op.trash, trashedAt: op.trashedAt || null }); break;
        case 'delete':
            await remove(ref(db, `${DB_PATH}/${op.id}`)); break;
        case 'updateFolder':
            await update(ref(db, `${FOLDERS_PATH}/${op.id}`), op.data); break;
        case 'deleteFolder':
            await remove(ref(db, `${FOLDERS_PATH}/${op.id}`)); break;
    }
}

// ===== BUG FIX #2: pendingUploads queue + auto-sync =====
async function addToPendingUploads(item) {
    // item.blob is a File/Blob
    try {
        // Convert blob to base64 so IDB can store it reliably
        const base64 = await blobToBase64(item.blob);
        await idbPut('pendingUploads', { ...item, blob: null, base64, ts: Date.now() });
        await registerBgSync('csm-upload-queue');
    } catch (e) { console.warn('[UploadQ]', e); }
}

async function processUploadQueue() {
    if (!navigator.onLine) return;
    const queue = await idbGetAll('pendingUploads');
    if (!queue.length) return;
    showToast(`Uploading ${queue.length} queued file(s)...`, 'info');
    for (const item of queue) {
        try {
            await uploadQueuedItem(item);
            await idbDelete('pendingUploads', item.uid);
        } catch (e) { console.warn('[UploadQ] item failed:', e); }
    }
}

async function uploadQueuedItem(item) {
    // Reconstruct blob from base64
    const resp = await fetch(item.base64);
    const blob = await resp.blob();
    const form = new FormData();
    form.append('file', blob, item.name);
    form.append('upload_preset', 'github_unsigned');
    const res = await (await fetch('https://api.cloudinary.com/v1_1/dx7aankx2/auto/upload', {
        method: 'POST', body: form
    })).json();
    if (res.secure_url) {
        await push(ref(db, DB_PATH), {
            url: res.secure_url, name: item.name, cat: item.cat,
            size: item.size, time: Date.now(), trash: false, starred: false,
            locked: item.locked || false, folder: item.folder || null
        });
        showToast(`"${item.name}" synced!`, 'success');
    }
}

// ===== SYNC MANAGER =====
function initSyncManager() {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Listen for SW messages (Background Sync API callback)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', e => {
            if (e.data && e.data.type === 'PROCESS_SYNC_QUEUE') processSyncQueue();
            if (e.data && e.data.type === 'PROCESS_UPLOAD_QUEUE') processUploadQueue();
        });
    }

    // Check initial state
    if (!navigator.onLine) {
        showOfflineBanner(true);
    }
}

function handleOnline() {
    showOfflineBanner(false);
    showToast('Back online — syncing changes...', 'success');
    // FIX #2: immediately trigger both queues on reconnect
    processSyncQueue();
    processUploadQueue();
}

function handleOffline() {
    showOfflineBanner(true);
    showToast("You're offline. Changes will sync when back online.", 'warning');
}

function showOfflineBanner(isOffline) {
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.toggle('visible', isOffline);
}

// ===== PARTICLES =====
function initParticles() {
    const canvas = document.getElementById('particles');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const particles = [];
    const count = window.innerWidth < 768 ? 25 : 60;
    for (let i = 0; i < count; i++) {
        particles.push({
            x: Math.random() * canvas.width, y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
            size: Math.random() * 2 + 0.5, opacity: Math.random() * 0.3 + 0.05
        });
    }
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(0, 255, 204, ${p.opacity})`;
            ctx.fill();
        });
        const maxDist = window.innerWidth < 768 ? 80 : 120;
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < maxDist) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(0, 255, 204, ${0.03 * (1 - dist / maxDist)})`;
                    ctx.stroke();
                }
            }
        }
        requestAnimationFrame(animate);
    }
    animate();
    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    });
}

// ===== AUTH =====
onAuthStateChanged(auth, async user => {
    if (user) {
        document.getElementById('loginSection').classList.add('hidden');

        // Load from IDB first for instant offline display
        const cachedFiles = await idbGetAll('files');
        const cachedFolders = await idbGetAll('folders');
        if (cachedFiles.length > 0) {
            allFiles = cachedFiles;
            folders = cachedFolders;
            updateStats(); renderFolders(); render(); updateFolderSelect();
        }

        if (passcodeEnabled && !sessionUnlocked) {
            showPasscodeScreen(() => {
                sessionUnlocked = true;
                document.getElementById('passcodeSection').classList.add('hidden');
                document.getElementById('mainContent').classList.remove('hidden');
                document.getElementById('mainContent').classList.add('fade-in');
                loadData(); loadFolders(); loadSettings();
            });
        } else {
            document.getElementById('mainContent').classList.remove('hidden');
            document.getElementById('mainContent').classList.add('fade-in');
            loadData(); loadFolders(); loadSettings();
        }

        // Process any queued operations
        setTimeout(() => {
            if (navigator.onLine) {
                processSyncQueue();
                processUploadQueue();
            }
        }, 2500);
    } else {
        document.getElementById('loginSection').classList.remove('hidden');
        document.getElementById('mainContent').classList.add('hidden');
        document.getElementById('passcodeSection').classList.add('hidden');
        sessionUnlocked = false;
    }
});

document.getElementById('doLogin').onclick = async () => {
    const btn = document.getElementById('doLogin');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&nbsp; AUTHENTICATING...';
    btn.disabled = true;
    try {
        await signInWithEmailAndPassword(
            auth,
            document.getElementById('loginEmail').value,
            document.getElementById('loginPass').value
        );
    } catch (e) {
        showToast('Authentication Failed', 'error');
        btn.innerHTML = '<i class="fas fa-fingerprint"></i>&nbsp; UNLOCK SYSTEM';
        btn.disabled = false;
    }
};
document.getElementById('loginPass').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('doLogin').click();
});

// ===== PASSCODE =====
function showPasscodeScreen(callback) {
    passcodeCallback = callback;
    passcodeInput = '';
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
                document.getElementById('passcodeMessage').textContent = 'Incorrect passcode. Try again.';
                setTimeout(() => {
                    passcodeInput = '';
                    document.querySelectorAll('.passcode-dot').forEach(d => d.classList.remove('error'));
                    updatePasscodeDots();
                }, 800);
            }
        }, 200);
    }
};
window.clearPasscode = () => { passcodeInput = passcodeInput.slice(0, -1); updatePasscodeDots(); };
window.cancelPasscode = () => {
    passcodeInput = '';
    updatePasscodeDots();
    if (!sessionUnlocked) signOut(auth);
    document.getElementById('passcodeSection').classList.add('hidden');
    passcodeCallback = null;
};
function updatePasscodeDots() {
    document.querySelectorAll('#passcodeDots .passcode-dot')
        .forEach((d, i) => d.classList.toggle('filled', i < passcodeInput.length));
}

window.confirmLogout = () => {
    showModal({
        icon: 'fas fa-right-from-bracket', title: 'Confirm Logout',
        desc: 'Are you sure you want to sign out?',
        confirmText: 'Logout', confirmClass: 'danger',
        onConfirm: () => { sessionUnlocked = false; signOut(auth); showToast('Logged out successfully', 'info'); }
    });
};

// ===== DATA LOADING (Firebase → IDB) =====
function loadData() {
    onValue(ref(db, DB_PATH), async snap => {
        allFiles = [];
        const data = snap.val();
        if (data) {
            Object.keys(data).forEach(k => {
                let item = data[k];
                if (!item.cat) {
                    const url = item.url || '';
                    const ext = url.split('.').pop().split('?')[0].toLowerCase();
                    item.cat = ['mp4','mov','avi','mkv','webm'].includes(ext) ? 'video' : 'image';
                }
                if (!item.time) item.time = 0;
                allFiles.push({ id: k, ...item });
            });
        }
        // Merge existing offlineData from IDB into new allFiles (preserve cached blobs)
        const cached = await idbGetAll('files');
        const cachedMap = {};
        cached.forEach(f => { cachedMap[f.id] = f; });
        allFiles = allFiles.map(f => ({
            ...f,
            offlineData: cachedMap[f.id] ? cachedMap[f.id].offlineData : null
        }));

        await cacheFilesToIDB(allFiles);
        updateStats();
        render();

        // Background: cache image blobs for offline lightbox
        if (navigator.onLine) {
            setTimeout(preCacheAllImages, 1000);
        }
    });
}

function loadFolders() {
    onValue(ref(db, FOLDERS_PATH), async snap => {
        folders = [];
        const data = snap.val();
        if (data) Object.keys(data).forEach(k => folders.push({ id: k, ...data[k] }));
        await cacheFoldersToIDB(folders);
        renderFolders();
        updateFolderSelect();
    });
}

function loadSettings() {
    onValue(ref(db, SETTINGS_PATH), snap => {
        const data = snap.val();
        if (data) {
            if (data.passcode) appPasscode = data.passcode;
            if (data.passcodeEnabled !== undefined) passcodeEnabled = data.passcodeEnabled;
        }
    });
}

// ===== STATS =====
function updateStats() {
    const active = allFiles.filter(f => !f.trash);
    const imgs = active.filter(f => f.cat === 'image').length;
    const vids = active.filter(f => f.cat === 'video').length;
    const stars = active.filter(f => f.starred).length;
    const trashed = allFiles.filter(f => f.trash).length;
    const total = active.length;
    document.getElementById('countAll').innerText = total;
    document.getElementById('countImg').innerText = imgs;
    document.getElementById('countVid').innerText = vids;
    document.getElementById('countStar').innerText = stars;
    document.getElementById('countTrash').innerText = trashed;
    document.getElementById('countFolders').innerText = folders.length;
    const max = Math.max(total, 1);
    document.getElementById('imgBar').style.width = (imgs / max * 100) + '%';
    document.getElementById('vidBar').style.width = (vids / max * 100) + '%';
    document.getElementById('starBar').style.width = (stars / max * 100) + '%';
    document.getElementById('trashBar').style.width = (trashed / Math.max(trashed + total, 1) * 100) + '%';
    document.getElementById('folderBar').style.width = Math.min(folders.length * 20, 100) + '%';
    let totalSize = 0;
    allFiles.forEach(f => { if (f.size) totalSize += parseFloat(f.size); });
    const storageCap = 1024;
    document.getElementById('storageFill').style.width = Math.min((totalSize / storageCap) * 100, 100) + '%';
    document.getElementById('storageText').innerText = `${totalSize.toFixed(1)} MB / ${storageCap} MB (${allFiles.length} files)`;
}

// ===== FOLDERS =====
function renderFolders() {
    const bar = document.getElementById('folderBar');
    bar.innerHTML = `<div class="folder-pill ${currentFolder === 'all' ? 'active' : ''}" onclick="window.setFolder('all', this)">
        <i class="fas fa-folder"></i> All <span class="count">${allFiles.filter(f => !f.trash).length}</span>
    </div>`;
    folders.forEach(f => {
        const count = allFiles.filter(file => file.folder === f.id && !file.trash).length;
        bar.innerHTML += `<div class="folder-pill ${currentFolder === f.id ? 'active' : ''}" onclick="window.setFolder('${f.id}', this)" oncontextmenu="window.folderContext(event, '${f.id}')">
            <i class="fas fa-folder" style="color:${f.color || 'var(--neon)'}"></i> ${f.name} <span class="count">${count}</span>
        </div>`;
    });
    bar.innerHTML += `<div class="folder-pill add-folder" onclick="window.createFolder()"><i class="fas fa-plus"></i> New</div>`;
}

function updateFolderSelect() {
    const sel = document.getElementById('uploadFolder');
    sel.innerHTML = '<option value="">No Folder</option>';
    folders.forEach(f => sel.innerHTML += `<option value="${f.id}">${f.name}</option>`);
}

// ===== VISIBLE FILES =====
function getVisibleFiles() {
    let list = allFiles.filter(f => {
        if (currentTab === 'trash') return f.trash;
        if (currentTab === 'starred') return f.starred && !f.trash;
        if (currentTab === 'locked') return f.locked && !f.trash;
        if (currentTab === 'all') return !f.trash;
        return f.cat === currentTab && !f.trash;
    });
    if (currentFolder !== 'all' && currentTab !== 'trash') list = list.filter(f => f.folder === currentFolder);
    if (searchText) list = list.filter(f => (f.name || '').toLowerCase().includes(searchText.toLowerCase()));
    return list;
}

// ===== NEXUS LIGHTBOX GALLERY BUILDER =====
// Builds the items array for NexusLightbox from the current visible list.
// Works fully offline: uses offlineData (base64 blob) when available.
function buildLightboxItems(list) {
    return list.filter(f => !f.trash).map(file => {
        let thumbUrl = file.url || '';
        if (thumbUrl.includes('/upload/')) thumbUrl = thumbUrl.replace('/upload/', '/upload/w_200,q_auto,f_auto/');
        const folderObj = folders.find(fo => fo.id === file.folder);
        const dateStr = file.time
            ? new Date(file.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : '—';
        return {
            id:          file.id,
            src:         file.url || '',
            thumb:       thumbUrl,
            offlineData: file.offlineData || null,
            name:        file.name || 'Untitled',
            size:        file.size || '—',
            date:        dateStr,
            cat:         file.cat || 'image',
            starred:     !!file.starred,
            folder:      folderObj ? folderObj.name : 'No folder',
        };
    });
}

// ===== RENDER =====
function render() {
    const grid = document.getElementById('fileGrid');
    grid.innerHTML = '';
    grid.className = viewMode === 'list' ? 'grid list-view' : 'grid';

    const trashActions = document.getElementById('trashActions');
    if (currentTab === 'trash') { trashActions.classList.remove('hidden'); trashActions.style.display = 'flex'; }
    else { trashActions.classList.add('hidden'); }

    let list = getVisibleFiles();
    list.sort((a, b) => {
        if (sortMode === 'newest') return (b.time || 0) - (a.time || 0);
        if (sortMode === 'oldest') return (a.time || 0) - (b.time || 0);
        if (sortMode === 'az') return (a.name || '').localeCompare(b.name || '');
        if (sortMode === 'za') return (b.name || '').localeCompare(a.name || '');
        if (sortMode === 'largest') return parseFloat(b.size || 0) - parseFloat(a.size || 0);
        if (sortMode === 'smallest') return parseFloat(a.size || 0) - parseFloat(b.size || 0);
        return 0;
    });

    if (list.length === 0) {
        grid.innerHTML = `<div class="empty-state">
            <div class="empty-icon"><i class="fas fa-${currentTab === 'trash' ? 'trash-can' : 'ghost'}"></i></div>
            <div class="empty-title">${currentTab === 'trash' ? 'Trash is Empty' : 'No Files Found'}</div>
            <div class="empty-desc">${currentTab === 'trash' ? 'Deleted files will appear here' : 'Upload files or change your filter'}</div>
        </div>`;
        return;
    }

    const isOffline = !navigator.onLine;
    // Build the lightbox gallery for the non-trash items in the current view
    const lbItems = buildLightboxItems(list);

    list.forEach((file, idx) => {
        let thumb = file.url || '';
        if (thumb.includes('/upload/')) thumb = thumb.replace('/upload/', '/upload/w_400,q_auto,f_auto/');

        // Use offlineData blob as thumbnail source when offline
        const thumbSrc = (isOffline && file.offlineData) ? file.offlineData : thumb;

        const isVid = file.cat === 'video';
        const date = file.time
            ? new Date(file.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '—';
        const folderObj = folders.find(f => f.id === file.folder);
        const isLocked = file.locked && !file._unlocked;

        const card = document.createElement('div');
        card.className = `card ${selectedIds.has(file.id) ? 'selected' : ''} ${isLocked ? 'locked' : ''}`;
        card.style.animationDelay = `${idx * 0.03}s`;
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
            previewHTML = `<div style="width:100%;height:100%;background:#0a0a15;display:flex;align-items:center;justify-content:center;">
                <i class="fas fa-lock" style="font-size:2rem;color:rgba(255,170,0,0.3);"></i></div>`;
        } else if (isVid) {
            const videoSrc = isOffline ? '' : `${thumbSrc}#t=0.1`;
            previewHTML = `${videoSrc
                ? `<video src="${videoSrc}" muted preload="metadata" playsinline></video>`
                : `<div style="width:100%;height:100%;background:#0a0a15;display:flex;align-items:center;justify-content:center;"><i class="fas fa-video" style="font-size:2rem;color:rgba(168,85,247,0.4);"></i></div>`}
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:32px;height:32px;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,0.2);">
                <i class="fas fa-play" style="color:white;font-size:0.7rem;margin-left:2px;"></i></div>`;
        } else {
            previewHTML = `<img src="${thumbSrc}" loading="lazy" alt="${file.name || ''}">`;
        }

        const trashMenuHTML = `
            <div class="dd-header">Trash Actions</div>
            <div class="dd-item" onclick="window.restoreFile('${file.id}')"><i class="fas fa-rotate-left"></i> Restore</div>
            <div class="dd-item danger" onclick="window.permanentDelete('${file.id}')"><i class="fas fa-fire"></i> Delete Forever</div>`;

        const normalMenuHTML = `
            <div class="dd-header">File Actions</div>
            <div class="dd-item" onclick="window.openPreview('${file.id}')"><i class="fas fa-external-link"></i> Open</div>
            <div class="dd-item" onclick="window.showFileInfo('${file.id}')"><i class="fas fa-circle-info"></i> Details</div>
            <div class="dd-divider"></div>
            <div class="dd-item" onclick="window.renameFile('${file.id}')"><i class="fas fa-pen"></i> Rename</div>
            <div class="dd-item" onclick="window.copyToFolder('${file.id}')"><i class="fas fa-copy"></i> Copy</div>
            <div class="dd-item" onclick="window.moveToFolder('${file.id}')"><i class="fas fa-folder-open"></i> Move</div>
            <div class="dd-divider"></div>
            <div class="dd-item" onclick="window.star('${file.id}', ${!!file.starred})"><i class="fas fa-star"></i> ${file.starred ? 'Unstar' : 'Star'}</div>
            <div class="dd-item" onclick="window.toggleLock('${file.id}')"><i class="fas fa-${file.locked ? 'unlock' : 'lock'}"></i> ${file.locked ? 'Unlock' : 'Lock'}</div>
            <div class="dd-item" onclick="window.copyLink('${file.url}')"><i class="fas fa-link"></i> Copy Link</div>
            <div class="dd-item" onclick="window.downloadFile('${file.url}', '${file.name}')"><i class="fas fa-download"></i> Download</div>
            <div class="dd-divider"></div>
            <div class="dd-item danger" onclick="window.trashFile('${file.id}')"><i class="fas fa-trash"></i> Trash</div>`;

        const selectCheckHTML = selectMode
            ? `<div class="select-check ${selectedIds.has(file.id) ? 'checked' : ''}" onclick="event.stopPropagation(); window.toggleSelect('${file.id}')"></div>`
            : '';

        // Click on preview opens NexusLightbox
        // Find this file's index inside the lbItems array
        const lbIdx = lbItems.findIndex(li => li.id === file.id);
        const previewClickAttr = (!isLocked && !selectMode)
            ? `onclick="window.openNexusLightbox('${file.id}')"`
            : (isLocked ? `onclick="window.unlockFile('${file.id}')"` : '');

        card.innerHTML = `
            ${selectCheckHTML}
            <div class="dots" onclick="event.stopPropagation(); window.toggleMenu(event, '${file.id}')"><i class="fas fa-ellipsis-v"></i></div>
            <div id="menu-${file.id}" class="dropdown">
                ${currentTab === 'trash' ? trashMenuHTML : normalMenuHTML}
            </div>
            ${file.starred && !isLocked ? '<div class="star-badge"><i class="fas fa-star"></i></div>' : ''}
            ${file.locked ? '<div class="lock-badge"><i class="fas fa-shield-halved"></i></div>' : ''}
            <div class="preview" ${previewClickAttr}>
                <span class="file-badge ${isVid ? 'badge-vid' : 'badge-img'}">${isVid ? 'Vid' : 'Img'}</span>
                ${previewHTML}
                <div class="preview-overlay"></div>
            </div>
            <div class="meta">
                <div class="filename" title="${file.name || ''}">${file.name || 'Untitled'}</div>
                <div class="fileinfo"><span>${file.size || '—'}</span><span>${date}</span></div>
                ${folderObj ? `<div class="folder-tag"><i class="fas fa-folder" style="font-size:0.55rem;"></i> ${folderObj.name}</div>` : ''}
            </div>`;
        grid.appendChild(card);
    });

    updateMultiBarActions();
}

// ===== NEXUS LIGHTBOX OPENER =====
// Called from card preview click. Finds the file in the current view,
// builds the gallery, and opens at the right index.
window.openNexusLightbox = (fileId) => {
    const file = allFiles.find(f => f.id === fileId);
    if (!file) return;
    if (file.locked && !file._unlocked) { window.unlockFile(fileId); return; }

    // Build gallery from current visible + sorted list (same order as grid)
    let list = getVisibleFiles();
    list.sort((a, b) => {
        if (sortMode === 'newest') return (b.time || 0) - (a.time || 0);
        if (sortMode === 'oldest') return (a.time || 0) - (b.time || 0);
        if (sortMode === 'az') return (a.name || '').localeCompare(b.name || '');
        if (sortMode === 'za') return (b.name || '').localeCompare(a.name || '');
        if (sortMode === 'largest') return parseFloat(b.size || 0) - parseFloat(a.size || 0);
        if (sortMode === 'smallest') return parseFloat(a.size || 0) - parseFloat(b.size || 0);
        return 0;
    });

    const lbItems = buildLightboxItems(list);
    const startIdx = lbItems.findIndex(li => li.id === fileId);

    NexusLightbox.open(lbItems, startIdx >= 0 ? startIdx : 0, {
        // Star toggle from inside lightbox
        onStar: async (id, curStarred) => {
            const f = allFiles.find(x => x.id === id);
            if (!f) return;
            f.starred = !curStarred;
            NexusLightbox.updateItem(id, { starred: f.starred });
            render(); // refresh grid star badges
            if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { starred: !curStarred });
            else { await idbPut('files', f); await addToSyncQueue({ type: 'update', id, data: { starred: !curStarred } }); }
            showToast(curStarred ? 'Star removed' : 'File starred', 'success');
        },
        // Trash from inside lightbox
        onTrash: (id) => {
            NexusLightbox.close();
            window.trashFile(id);
        }
    });
};

function updateMultiBarActions() {
    const actionsDiv = document.getElementById('multiBarActions');
    if (currentTab === 'trash') {
        actionsDiv.innerHTML = `
            <button class="multi-btn restore" onclick="window.multiRestore()"><i class="fas fa-rotate-left"></i> <span>Restore</span></button>
            <button class="multi-btn danger" onclick="window.multiPermanentDelete()"><i class="fas fa-fire"></i> <span>Delete</span></button>`;
    } else {
        actionsDiv.innerHTML = `
            <button class="multi-btn" onclick="window.multiCopy()"><i class="fas fa-copy"></i> <span>Copy</span></button>
            <button class="multi-btn" onclick="window.multiStar()"><i class="fas fa-star"></i> <span>Star</span></button>
            <button class="multi-btn" onclick="window.multiDownload()"><i class="fas fa-download"></i></button>
            <button class="multi-btn danger" onclick="window.multiTrash()"><i class="fas fa-trash"></i></button>`;
    }
}

// ===== TABS & VIEW =====
window.setTab = (t, el) => {
    currentTab = t;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    selectedIds.clear(); updateMultiBar(); render();
};
window.setFolder = (fid, el) => {
    currentFolder = fid;
    document.querySelectorAll('.folder-pill').forEach(p => p.classList.remove('active'));
    if (el) el.classList.add('active');
    render();
};
window.handleSearch = () => { searchText = document.getElementById('searchInput').value.trim(); render(); };
window.handleSort = () => { sortMode = document.getElementById('sortSelect').value; render(); };
window.setView = mode => {
    viewMode = mode;
    document.getElementById('gridViewBtn').classList.toggle('active', mode === 'grid');
    document.getElementById('listViewBtn').classList.toggle('active', mode === 'list');
    render();
};

// ===== MENUS =====
window.toggleMenu = (e, id) => {
    e.stopPropagation();
    document.querySelectorAll('.dropdown').forEach(d => { if (d.id !== `menu-${id}`) d.classList.remove('active'); });
    document.getElementById(`menu-${id}`).classList.toggle('active');
};

window.showContextMenu = (e, id) => {
    contextTarget = id;
    const menu = document.getElementById('contextMenu');
    const file = allFiles.find(f => f.id === id);
    if (file && file.trash) {
        menu.innerHTML = `
            <div class="ctx-item" onclick="window.ctxAction('restore')"><i class="fas fa-rotate-left"></i> Restore</div>
            <div class="ctx-divider"></div>
            <div class="ctx-item danger" onclick="window.ctxAction('permDelete')"><i class="fas fa-fire"></i> Delete Forever</div>`;
    } else {
        menu.innerHTML = `
            <div class="ctx-item" onclick="window.ctxAction('open')"><i class="fas fa-external-link"></i> Open</div>
            <div class="ctx-item" onclick="window.ctxAction('info')"><i class="fas fa-circle-info"></i> Info</div>
            <div class="ctx-divider"></div>
            <div class="ctx-item" onclick="window.ctxAction('rename')"><i class="fas fa-pen"></i> Rename</div>
            <div class="ctx-item" onclick="window.ctxAction('copy')"><i class="fas fa-copy"></i> Copy</div>
            <div class="ctx-item" onclick="window.ctxAction('star')"><i class="fas fa-star"></i> Star</div>
            <div class="ctx-item" onclick="window.ctxAction('lock')"><i class="fas fa-lock"></i> Lock</div>
            <div class="ctx-item" onclick="window.ctxAction('link')"><i class="fas fa-link"></i> Link</div>
            <div class="ctx-item" onclick="window.ctxAction('download')"><i class="fas fa-download"></i> Download</div>
            <div class="ctx-divider"></div>
            <div class="ctx-item danger" onclick="window.ctxAction('trash')"><i class="fas fa-trash"></i> Trash</div>`;
    }
    menu.style.left = Math.min(e.clientX, window.innerWidth - 210) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 300) + 'px';
    menu.classList.add('active');
};

window.ctxAction = action => {
    document.getElementById('contextMenu').classList.remove('active');
    const id = contextTarget; if (!id) return;
    const file = allFiles.find(f => f.id === id); if (!file) return;
    switch (action) {
        case 'open': window.openPreview(id); break;
        case 'info': window.showFileInfo(id); break;
        case 'rename': window.renameFile(id); break;
        case 'copy': window.copyToFolder(id); break;
        case 'star': window.star(id, !!file.starred); break;
        case 'lock': window.toggleLock(id); break;
        case 'link': window.copyLink(file.url); break;
        case 'download': window.downloadFile(file.url, file.name); break;
        case 'trash': window.trashFile(id); break;
        case 'restore': window.restoreFile(id); break;
        case 'permDelete': window.permanentDelete(id); break;
    }
};

// ===== FILE ACTIONS (offline-aware) =====
window.copyLink = url => { navigator.clipboard.writeText(url); showToast('Link copied', 'success'); };

window.star = async (id, cur) => {
    const file = allFiles.find(f => f.id === id); if (!file) return;
    file.starred = !cur; render();
    if (navigator.onLine) {
        update(ref(db, `${DB_PATH}/${id}`), { starred: !cur });
    } else {
        await idbPut('files', file);
        await addToSyncQueue({ type: 'update', id, data: { starred: !cur } });
    }
    showToast(cur ? 'Star removed' : 'File starred', 'success');
};

window.toggleLock = id => {
    const file = allFiles.find(f => f.id === id); if (!file) return;
    if (file.locked) {
        showPasscodeScreen(async () => {
            document.getElementById('passcodeSection').classList.add('hidden');
            file.locked = false; render();
            if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { locked: false });
            else { await idbPut('files', file); await addToSyncQueue({ type: 'update', id, data: { locked: false } }); }
            showToast('Protection removed', 'info');
        });
    } else {
        file.locked = true; render();
        if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { locked: true });
        else { idbPut('files', file); addToSyncQueue({ type: 'update', id, data: { locked: true } }); }
        showToast('File protected', 'success');
    }
};

window.unlockFile = id => {
    showPasscodeScreen(() => {
        document.getElementById('passcodeSection').classList.add('hidden');
        const file = allFiles.find(f => f.id === id);
        if (file) { file._unlocked = true; render(); showToast('Unlocked temporarily', 'success'); }
    });
};

window.openPreview = id => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    if (file.locked && !file._unlocked) { window.unlockFile(id); return; }
    // Always open via NexusLightbox (works online and offline)
    window.openNexusLightbox(id);
};

window.renameFile = id => {
    const file = allFiles.find(f => f.id === id); if (!file) return;
    showModal({
        title: 'Rename File', desc: 'Enter a new name.',
        inputValue: file.name, inputPlaceholder: 'New file name', confirmText: 'Rename',
        onConfirm: async val => {
            if (val && val.trim()) {
                file.name = val.trim(); render();
                if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { name: val.trim() });
                else { await idbPut('files', file); await addToSyncQueue({ type: 'update', id, data: { name: val.trim() } }); }
                showToast('Renamed', 'success');
            }
        }
    });
};

window.copyToFolder = id => {
    if (!folders.length) { showToast('Create a folder first', 'warning'); return; }
    showFolderPickerModal('Copy to Folder', folderId => {
        const file = allFiles.find(f => f.id === id);
        if (file && folderId) {
            const newR = push(ref(db, DB_PATH));
            const { id: _, ...fd } = file;
            set(newR, { ...fd, folder: folderId, time: Date.now() });
            showToast('File copied', 'success');
        }
    });
};

window.moveToFolder = id => {
    if (!folders.length) { showToast('Create a folder first', 'warning'); return; }
    showFolderPickerModal('Move to Folder', async folderId => {
        if (folderId) {
            const file = allFiles.find(f => f.id === id);
            if (file) { file.folder = folderId; render(); }
            if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { folder: folderId });
            else { if (file) await idbPut('files', file); await addToSyncQueue({ type: 'update', id, data: { folder: folderId } }); }
            showToast('File moved', 'success');
        }
    });
};

window.trashFile = id => {
    showModal({
        title: 'Move to Trash', desc: 'Move to trash? Restore within 30 days.',
        confirmText: 'Trash', confirmClass: 'danger', icon: 'fas fa-trash',
        onConfirm: async () => {
            const file = allFiles.find(f => f.id === id);
            const now = Date.now();
            if (file) { file.trash = true; file.trashedAt = now; render(); updateStats(); }
            if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { trash: true, trashedAt: now });
            else { if (file) await idbPut('files', file); await addToSyncQueue({ type: 'trash', id, trash: true, trashedAt: now }); }
            showToast('Trashed', 'info');
        }
    });
};

window.restoreFile = async id => {
    const file = allFiles.find(f => f.id === id);
    if (file) { file.trash = false; file.trashedAt = null; render(); updateStats(); }
    if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { trash: false, trashedAt: null });
    else { if (file) await idbPut('files', file); await addToSyncQueue({ type: 'trash', id, trash: false, trashedAt: null }); }
    showToast('Restored', 'success');
};

window.permanentDelete = id => {
    showModal({
        title: 'Delete Permanently', desc: '⚠️ Cannot be undone!',
        confirmText: 'Delete Forever', confirmClass: 'danger', icon: 'fas fa-exclamation-triangle',
        onConfirm: async () => {
            allFiles = allFiles.filter(f => f.id !== id); render(); updateStats();
            if (navigator.onLine) remove(ref(db, `${DB_PATH}/${id}`));
            else { await idbDelete('files', id); await addToSyncQueue({ type: 'delete', id }); }
            showToast('Permanently deleted', 'error');
        }
    });
};

window.restoreAll = () => {
    const trashed = allFiles.filter(f => f.trash); if (!trashed.length) return;
    showModal({
        title: 'Restore All', desc: `Restore ${trashed.length} file(s)?`, confirmText: 'Restore All',
        onConfirm: async () => {
            trashed.forEach(f => { f.trash = false; f.trashedAt = null; });
            render(); updateStats();
            if (navigator.onLine) trashed.forEach(f => update(ref(db, `${DB_PATH}/${f.id}`), { trash: false, trashedAt: null }));
            else for (const f of trashed) { await idbPut('files', f); await addToSyncQueue({ type: 'trash', id: f.id, trash: false, trashedAt: null }); }
            showToast(`${trashed.length} restored`, 'success');
        }
    });
};

window.emptyTrash = () => {
    const trashed = allFiles.filter(f => f.trash); if (!trashed.length) return;
    showModal({
        title: 'Empty Trash', desc: `⚠️ Delete ${trashed.length} file(s) forever?`,
        confirmText: 'Delete All', confirmClass: 'danger', icon: 'fas fa-fire',
        onConfirm: async () => {
            allFiles = allFiles.filter(f => !f.trash); render(); updateStats();
            if (navigator.onLine) trashed.forEach(f => remove(ref(db, `${DB_PATH}/${f.id}`)));
            else for (const f of trashed) { await idbDelete('files', f.id); await addToSyncQueue({ type: 'delete', id: f.id }); }
            showToast('Trash emptied', 'error');
        }
    });
};

window.downloadFile = (url, name) => {
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.download = name || 'file';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast('Download started', 'success');
};

// ===== FILE INFO =====
window.showFileInfo = id => {
    const file = allFiles.find(f => f.id === id); if (!file) return;
    const panel = document.getElementById('infoPanel');
    const preview = document.getElementById('infoPanelPreview');
    const content = document.getElementById('infoPanelContent');
    const isVid = file.cat === 'video';
    const displaySrc = (!navigator.onLine && file.offlineData) ? file.offlineData : file.url;
    preview.innerHTML = isVid
        ? `<video src="${displaySrc}" controls playsinline style="width:100%;height:100%;object-fit:cover;"></video>`
        : `<img src="${displaySrc}" alt="${file.name || ''}">`;
    const date = file.time ? new Date(file.time).toLocaleString() : 'Unknown';
    const folderObj = folders.find(f => f.id === file.folder);
    content.innerHTML = `
        <div class="info-row"><span class="info-label">Name</span><span class="info-value">${file.name || 'Untitled'}</span></div>
        <div class="info-row"><span class="info-label">Type</span><span class="info-value">${isVid ? 'Video' : 'Image'}</span></div>
        <div class="info-row"><span class="info-label">Size</span><span class="info-value">${file.size || 'Unknown'}</span></div>
        <div class="info-row"><span class="info-label">Uploaded</span><span class="info-value">${date}</span></div>
        <div class="info-row"><span class="info-label">Folder</span><span class="info-value">${folderObj ? folderObj.name : 'None'}</span></div>
        <div class="info-row"><span class="info-label">Starred</span><span class="info-value">${file.starred ? '⭐ Yes' : 'No'}</span></div>
        <div class="info-row"><span class="info-label">Protected</span><span class="info-value">${file.locked ? '🔒 Yes' : 'No'}</span></div>
        <div class="info-row"><span class="info-label">Status</span><span class="info-value">${file.trash ? '🗑️ Trash' : '✅ Active'}</span></div>
        <div class="info-row"><span class="info-label">Cached</span><span class="info-value">${file.offlineData ? '✅ Offline ready' : '❌ Online only'}</span></div>
        <div style="margin-top:15px; display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn-neon" style="flex:1;padding:10px;font-size:0.75rem;font-family:'Inter';" onclick="window.copyLink('${file.url}')"><i class="fas fa-link"></i> Link</button>
            <button class="btn-neon btn-outline" style="flex:1;padding:10px;font-size:0.75rem;font-family:'Inter';" onclick="window.downloadFile('${file.url}', '${file.name}')"><i class="fas fa-download"></i> Download</button>
        </div>`;
    panel.classList.add('active');
};
window.closeInfoPanel = () => document.getElementById('infoPanel').classList.remove('active');

// ===== FOLDERS (offline-aware) =====
window.createFolder = () => {
    showModal({
        title: 'New Folder', desc: 'Enter a name.',
        inputPlaceholder: 'Folder name', confirmText: 'Create',
        onConfirm: async val => {
            if (val && val.trim()) {
                const colors = ['#00ffcc','#00d4ff','#a855f7','#ff6b6b','#ffd700','#00ff88'];
                const newF = { name: val.trim(), color: colors[Math.floor(Math.random() * colors.length)], created: Date.now() };
                if (navigator.onLine) push(ref(db, FOLDERS_PATH), newF);
                else {
                    const tid = 'offline_folder_' + Date.now();
                    folders.push({ id: tid, ...newF });
                    await idbPut('folders', { id: tid, ...newF });
                    renderFolders(); updateFolderSelect();
                }
                showToast('Folder created', 'success');
            }
        }
    });
};
window.folderContext = (e, fid) => {
    e.preventDefault(); e.stopPropagation();
    showModal({
        title: 'Folder Options', desc: 'Choose an action.',
        customActions: `
            <button class="modal-cancel" onclick="window.renameFolder('${fid}')"><i class="fas fa-pen"></i> Rename</button>
            <button class="modal-confirm danger" onclick="window.deleteFolder('${fid}')"><i class="fas fa-trash"></i> Delete</button>`
    });
};
window.renameFolder = async fid => {
    closeModal();
    const folder = folders.find(f => f.id === fid);
    showModal({
        title: 'Rename Folder', inputValue: folder ? folder.name : '', inputPlaceholder: 'New name', confirmText: 'Rename',
        onConfirm: async val => {
            if (val && val.trim()) {
                if (folder) folder.name = val.trim();
                renderFolders(); updateFolderSelect();
                if (navigator.onLine) update(ref(db, `${FOLDERS_PATH}/${fid}`), { name: val.trim() });
                else { if (folder) await idbPut('folders', folder); await addToSyncQueue({ type: 'updateFolder', id: fid, data: { name: val.trim() } }); }
                showToast('Renamed', 'success');
            }
        }
    });
};
window.deleteFolder = async fid => {
    closeModal();
    showModal({
        title: 'Delete Folder', desc: 'Files will be unassigned.',
        confirmText: 'Delete', confirmClass: 'danger',
        onConfirm: async () => {
            allFiles.filter(f => f.folder === fid).forEach(f => { f.folder = null; });
            folders = folders.filter(f => f.id !== fid);
            if (currentFolder === fid) currentFolder = 'all';
            renderFolders(); updateFolderSelect(); render();
            if (navigator.onLine) {
                allFiles.forEach(f => { if (!f.folder) update(ref(db, `${DB_PATH}/${f.id}`), { folder: null }); });
                remove(ref(db, `${FOLDERS_PATH}/${fid}`));
            } else {
                await idbDelete('folders', fid);
                await addToSyncQueue({ type: 'deleteFolder', id: fid });
            }
            showToast('Folder deleted', 'success');
        }
    });
};

// ===== SELECT MODE =====
window.toggleSelectMode = () => {
    selectMode = !selectMode;
    selectedIds.clear(); updateMultiBar();
    document.getElementById('selectModeBtn').classList.toggle('active-mode', selectMode);
    render();
    showToast(selectMode ? 'Selection mode ON' : 'Selection mode off', 'info');
};
window.toggleSelect = id => {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    updateMultiBar(); render();
};
window.selectAllVisible = () => {
    const visible = getVisibleFiles();
    if (selectedIds.size === visible.length) selectedIds.clear();
    else visible.forEach(f => selectedIds.add(f.id));
    updateMultiBar(); render();
};
window.clearSelection = () => {
    selectedIds.clear(); selectMode = false;
    document.getElementById('selectModeBtn').classList.remove('active-mode');
    updateMultiBar(); render();
};
function updateMultiBar() {
    const bar = document.getElementById('multiBar');
    document.getElementById('selectCount').textContent = selectedIds.size;
    bar.classList.toggle('active', selectedIds.size > 0);
    updateMultiBarActions();
}

// ===== MULTI ACTIONS =====
window.multiCopy = () => {
    if (!folders.length) { showToast('Create a folder first', 'warning'); return; }
    showFolderPickerModal('Copy Selected', folderId => {
        selectedIds.forEach(id => {
            const file = allFiles.find(f => f.id === id);
            if (file && folderId) {
                const nr = push(ref(db, DB_PATH));
                const { id: _, ...fd } = file;
                set(nr, { ...fd, folder: folderId, time: Date.now() });
            }
        });
        showToast(`${selectedIds.size} copied`, 'success');
        window.clearSelection();
    });
};
window.multiStar = () => {
    selectedIds.forEach(id => {
        const file = allFiles.find(f => f.id === id);
        if (file) { file.starred = true; if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { starred: true }); }
    });
    showToast(`${selectedIds.size} starred`, 'success');
    window.clearSelection();
};
window.multiTrash = () => {
    const count = selectedIds.size;
    showModal({
        title: 'Trash Selected', desc: `Move ${count} file(s) to trash?`,
        confirmText: 'Trash', confirmClass: 'danger', icon: 'fas fa-trash',
        onConfirm: async () => {
            for (const id of selectedIds) {
                const file = allFiles.find(f => f.id === id);
                const now = Date.now();
                if (file) { file.trash = true; file.trashedAt = now; }
                if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { trash: true, trashedAt: now });
                else { if (file) await idbPut('files', file); await addToSyncQueue({ type: 'trash', id, trash: true, trashedAt: now }); }
            }
            showToast(`${count} trashed`, 'info');
            window.clearSelection(); render(); updateStats();
        }
    });
};
window.multiDownload = () => {
    selectedIds.forEach(id => { const file = allFiles.find(f => f.id === id); if (file) window.downloadFile(file.url, file.name); });
    showToast('Downloads started', 'success');
};
window.multiRestore = () => {
    const count = selectedIds.size;
    showModal({
        title: 'Restore Selected', desc: `Restore ${count} file(s)?`, confirmText: 'Restore',
        onConfirm: async () => {
            for (const id of selectedIds) {
                const file = allFiles.find(f => f.id === id);
                if (file) { file.trash = false; file.trashedAt = null; }
                if (navigator.onLine) update(ref(db, `${DB_PATH}/${id}`), { trash: false, trashedAt: null });
                else { if (file) await idbPut('files', file); await addToSyncQueue({ type: 'trash', id, trash: false, trashedAt: null }); }
            }
            showToast(`${count} restored`, 'success');
            window.clearSelection(); render(); updateStats();
        }
    });
};
window.multiPermanentDelete = () => {
    const count = selectedIds.size;
    showModal({
        title: 'Delete Forever', desc: `⚠️ Delete ${count} file(s) permanently?`,
        confirmText: 'Delete', confirmClass: 'danger', icon: 'fas fa-exclamation-triangle',
        onConfirm: async () => {
            for (const id of selectedIds) {
                allFiles = allFiles.filter(f => f.id !== id);
                if (navigator.onLine) remove(ref(db, `${DB_PATH}/${id}`));
                else { await idbDelete('files', id); await addToSyncQueue({ type: 'delete', id }); }
            }
            showToast(`${count} deleted`, 'error');
            window.clearSelection(); render(); updateStats();
        }
    });
};

// ===== SETTINGS =====
window.showSettings = () => {
    showModal({
        title: 'Settings', desc: '',
        customContent: `
            <div style="margin-bottom:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                    <div><div style="color:white; font-size:0.85rem; font-weight:500;">Passcode Lock</div>
                    <div style="color:#555; font-size:0.7rem;">Require on app open</div></div>
                    <label style="position:relative; width:44px; height:24px; cursor:pointer;">
                        <input type="checkbox" id="settPassEnabled" ${passcodeEnabled ? 'checked' : ''} style="opacity:0; width:0; height:0;" onchange="window.togglePasscodeEnabled(this.checked)">
                        <span style="position:absolute;inset:0;background:${passcodeEnabled ? 'var(--neon)' : '#333'};border-radius:12px;transition:0.3s;"></span>
                        <span style="position:absolute;top:3px;left:${passcodeEnabled ? '23px' : '3px'};width:18px;height:18px;background:${passcodeEnabled ? '#000' : '#666'};border-radius:50%;transition:0.3s;"></span>
                    </label>
                </div>
                <div style="padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer;" onclick="window.changePasscode()">
                    <div style="color:white; font-size:0.85rem; font-weight:500;">Change Passcode</div>
                    <div style="color:#555; font-size:0.7rem;">Update 4-digit code</div>
                </div>
                <div style="padding:10px 0;">
                    <div style="color:white; font-size:0.85rem; font-weight:500;">Version</div>
                    <div style="color:var(--neon); font-size:0.7rem; font-family:'JetBrains Mono';">CSM DRIVE Ultra Pro v3.2 PWA</div>
                </div>
            </div>`,
        confirmText: 'Close', hideCancel: true, onConfirm: () => {}
    });
};
window.togglePasscodeEnabled = enabled => {
    passcodeEnabled = enabled;
    set(ref(db, SETTINGS_PATH), { passcode: appPasscode, passcodeEnabled });
    showToast(enabled ? 'Passcode enabled' : 'Passcode disabled', 'info');
};
window.changePasscode = () => {
    closeModal();
    showModal({
        title: 'Change Passcode', desc: 'Enter new 4-digit code.',
        inputPlaceholder: '4-digit passcode', inputType: 'password', confirmText: 'Update',
        onConfirm: val => {
            if (val && val.length === 4 && /^\d{4}$/.test(val)) {
                appPasscode = val;
                set(ref(db, SETTINGS_PATH), { passcode: appPasscode, passcodeEnabled });
                showToast('Passcode updated', 'success');
            } else showToast('Use 4 digits', 'error');
        }
    });
};

// ===== UPLOAD (offline-aware with BUG FIX #2) =====
window.toggleUpload = () => {
    const box = document.getElementById('uploadBox');
    box.classList.toggle('active');
    if (!box.classList.contains('active')) resetUploadUI();
};

function resetUploadUI() {
    pendingUploadFiles = [];
    uploadInProgress = false;
    document.getElementById('fileInput').value = '';
    document.getElementById('customName').value = '';
    document.getElementById('uploadQueue').innerHTML = '';
    document.getElementById('selectedFilesPreview').classList.add('hidden');
    document.getElementById('neonProgressSection').classList.add('hidden');
    document.getElementById('uploadStartBtnWrap').classList.add('hidden');
    document.getElementById('neonProgressFill').style.width = '0%';
    document.getElementById('neonProgressFill').classList.remove('complete');
}

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
    e.preventDefault(); uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) stageFiles(e.dataTransfer.files);
});
document.getElementById('fileInput').onchange = e => { if (e.target.files.length) stageFiles(e.target.files); };

function stageFiles(fileList) {
    pendingUploadFiles = Array.from(fileList);
    const preview = document.getElementById('selectedFilesPreview');
    const queue = document.getElementById('uploadQueue');
    const startWrap = document.getElementById('uploadStartBtnWrap');
    const count = pendingUploadFiles.length;
    const totalSizeMB = (pendingUploadFiles.reduce((s, f) => s + f.size, 0) / (1024 * 1024)).toFixed(2);

    preview.classList.remove('hidden');
    preview.innerHTML = `<div class="selected-files-preview">
        <div class="selected-files-text">
            <i class="fas fa-paperclip"></i>
            <strong>${count} file${count > 1 ? 's' : ''}</strong> (${totalSizeMB} MB)
            <span style="margin-left:auto; cursor:pointer; color:var(--danger);" onclick="window.clearStagedFiles()"><i class="fas fa-xmark"></i></span>
        </div>
    </div>`;

    queue.innerHTML = '';
    pendingUploadFiles.forEach((file, idx) => {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        const isVid = isVideoFile(file.name);
        queue.innerHTML += `<div class="upload-queue-item" id="uqi-${idx}">
            <div class="uq-icon"><i class="fas fa-${isVid ? 'video' : 'image'}" style="color:${isVid ? 'var(--neon3)' : 'var(--neon)'};"></i></div>
            <div style="flex:1; min-width:0;">
                <div class="uq-name" title="${file.name}">${file.name}</div>
                <div class="uq-progress-bar"><div class="uq-progress-fill" id="uqp-${idx}"></div></div>
                <div class="upload-speed-info"><span id="uq-size-${idx}">${sizeMB} MB</span><span id="uq-speed-${idx}"></span></div>
            </div>
            <div class="uq-pct" id="uq-pct-${idx}">—</div>
            <div class="uq-status-icon queued" id="uqs-${idx}"><i class="fas fa-clock"></i></div>
        </div>`;
    });

    startWrap.classList.remove('hidden');
    document.getElementById('uploadStartBtn').disabled = false;
    document.getElementById('uploadStartBtn').innerHTML = `<i class="fas fa-cloud-arrow-up"></i>&nbsp; Upload ${count} File${count > 1 ? 's' : ''}`;
}

function isVideoFile(name) {
    return ['mp4','mov','avi','mkv','webm'].includes(name.split('.').pop().toLowerCase());
}
window.clearStagedFiles = () => resetUploadUI();

window.startUpload = async () => {
    if (uploadInProgress || !pendingUploadFiles.length) return;

    // BUG FIX #2: If offline, save to pendingUploads IDB store and register BG sync
    if (!navigator.onLine) {
        const folder = document.getElementById('uploadFolder').value;
        const isLocked = document.getElementById('uploadLocked').checked;
        const customName = document.getElementById('customName').value.trim();
        showToast('Offline — files queued, will auto-upload when online', 'warning');

        for (let i = 0; i < pendingUploadFiles.length; i++) {
            const file = pendingUploadFiles[i];
            const ext = file.name.split('.').pop().toLowerCase();
            const cat = ['mp4','mov','avi','mkv','webm'].includes(ext) ? 'video' : 'image';
            const displayName = (pendingUploadFiles.length === 1 && customName) ? customName : file.name;
            const size = (file.size / (1024 * 1024)).toFixed(2) + ' MB';

            const statusEl = document.getElementById(`uqs-${i}`);
            if (statusEl) { statusEl.className = 'uq-status-icon queued'; statusEl.innerHTML = '<i class="fas fa-hourglass-half"></i>'; }

            await addToPendingUploads({ blob: file, name: displayName, cat, size, folder: folder || null, locked: isLocked });
        }
        setTimeout(() => {
            document.getElementById('uploadBox').classList.remove('active');
            resetUploadUI();
        }, 1500);
        return;
    }

    // Online: upload immediately
    uploadInProgress = true;
    const files = pendingUploadFiles;
    const folder = document.getElementById('uploadFolder').value;
    const isLocked = document.getElementById('uploadLocked').checked;
    const customName = document.getElementById('customName').value.trim();

    document.getElementById('neonProgressSection').classList.remove('hidden');
    document.getElementById('uploadStartBtnWrap').classList.add('hidden');

    let completed = 0;
    const total = files.length;
    let totalBytesAll = files.reduce((s, f) => s + f.size, 0);
    let uploadedBytesAll = 0;
    let uploadStartTime = Date.now();

    function updateOverallNeon() {
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        const fill = document.getElementById('neonProgressFill');
        fill.style.width = pct + '%';
        if (completed === total) {
            fill.classList.add('complete');
            document.getElementById('neonProgressTitle').textContent = 'COMPLETE';
            document.getElementById('neonProgressPct').textContent = '100%';
            document.getElementById('neonProgressSub').textContent = `All ${total} files uploaded!`;
            document.getElementById('neonProgressFiles').textContent = `${total} / ${total} files`;
            document.getElementById('neonProgressSpeed').textContent = '';
            document.getElementById('neonProgressEta').textContent = '✓ Done';
        } else {
            document.getElementById('neonProgressTitle').textContent = 'UPLOADING';
            document.getElementById('neonProgressPct').textContent = pct + '%';
            document.getElementById('neonProgressSub').textContent = `Processing file ${completed + 1} of ${total}`;
            document.getElementById('neonProgressFiles').textContent = `${completed} / ${total} files`;
            const elapsed = (Date.now() - uploadStartTime) / 1000;
            if (elapsed > 0 && uploadedBytesAll > 0) {
                const speed = uploadedBytesAll / elapsed;
                document.getElementById('neonProgressSpeed').textContent = formatSpeed(speed);
                document.getElementById('neonProgressEta').textContent = 'ETA: ' + formatTime((totalBytesAll - uploadedBytesAll) / speed);
            }
        }
    }
    updateOverallNeon();

    function uploadFile(idx) {
        if (idx >= total) {
            showToast(`${total} file${total > 1 ? 's' : ''} uploaded!`, 'success');
            setTimeout(() => { document.getElementById('uploadBox').classList.remove('active'); resetUploadUI(); }, 2000);
            return;
        }
        const file = files[idx];
        const ext = file.name.split('.').pop().toLowerCase();
        const cat = ['mp4','mov','avi','mkv','webm'].includes(ext) ? 'video' : 'image';
        const size = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
        const displayName = (total === 1 && customName) ? customName : file.name;

        const itemEl = document.getElementById(`uqi-${idx}`);
        const statusEl = document.getElementById(`uqs-${idx}`);
        const pctEl = document.getElementById(`uq-pct-${idx}`);
        const progressEl = document.getElementById(`uqp-${idx}`);
        const speedEl = document.getElementById(`uq-speed-${idx}`);

        if (itemEl) { itemEl.classList.add('active'); itemEl.classList.remove('done', 'error'); }
        if (statusEl) { statusEl.className = 'uq-status-icon uploading'; statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
        if (pctEl) pctEl.textContent = '0%';
        document.getElementById('uploadQueue').scrollTop = itemEl ? itemEl.offsetTop : 0;

        const form = new FormData();
        form.append('file', file);
        form.append('upload_preset', 'github_unsigned');

        const fileStartTime = Date.now();
        let lastLoaded = 0;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://api.cloudinary.com/v1_1/dx7aankx2/auto/upload');

        xhr.upload.onprogress = ev => {
            if (!ev.lengthComputable) return;
            const pc = Math.round(ev.loaded / ev.total * 100);
            if (progressEl) progressEl.style.width = pc + '%';
            if (pctEl) pctEl.textContent = pc + '%';
            const fe = (Date.now() - fileStartTime) / 1000;
            if (fe > 0.5 && speedEl) speedEl.textContent = formatSpeed(ev.loaded / fe);
            uploadedBytesAll += ev.loaded - lastLoaded;
            lastLoaded = ev.loaded;
            const realPct = Math.round(uploadedBytesAll / totalBytesAll * 100);
            document.getElementById('neonProgressFill').style.width = Math.min(realPct, 99) + '%';
            document.getElementById('neonProgressPct').textContent = Math.min(realPct, 99) + '%';
            const te = (Date.now() - uploadStartTime) / 1000;
            if (te > 0.5) {
                const spd = uploadedBytesAll / te;
                document.getElementById('neonProgressSpeed').textContent = formatSpeed(spd);
                document.getElementById('neonProgressEta').textContent = 'ETA: ' + formatTime((totalBytesAll - uploadedBytesAll) / spd);
            }
        };

        xhr.onload = () => {
            try {
                const res = JSON.parse(xhr.responseText);
                if (res.secure_url) {
                    push(ref(db, DB_PATH), { url: res.secure_url, name: displayName, cat, size, time: Date.now(), trash: false, starred: false, locked: isLocked, folder: folder || null });
                    if (statusEl) { statusEl.className = 'uq-status-icon done'; statusEl.innerHTML = '<i class="fas fa-check"></i>'; }
                    if (progressEl) { progressEl.style.width = '100%'; progressEl.classList.add('complete'); }
                    if (pctEl) pctEl.textContent = '100%';
                    if (itemEl) { itemEl.classList.remove('active'); itemEl.classList.add('done'); }
                } else markError(idx);
            } catch { markError(idx); }
            completed++; updateOverallNeon(); uploadFile(idx + 1);
        };
        xhr.onerror = () => { markError(idx); completed++; updateOverallNeon(); uploadFile(idx + 1); };
        xhr.send(form);
    }

    function markError(idx) {
        const s = document.getElementById(`uqs-${idx}`);
        const p = document.getElementById(`uq-pct-${idx}`);
        const b = document.getElementById(`uqp-${idx}`);
        const i = document.getElementById(`uqi-${idx}`);
        if (s) { s.className = 'uq-status-icon error'; s.innerHTML = '<i class="fas fa-xmark"></i>'; }
        if (p) p.textContent = 'ERR';
        if (b) b.classList.add('error');
        if (i) { i.classList.remove('active'); i.classList.add('error'); }
    }

    uploadFile(0);
};

function formatSpeed(b) {
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB/s';
    if (b > 1024) return (b / 1024).toFixed(0) + ' KB/s';
    return b.toFixed(0) + ' B/s';
}
function formatTime(s) {
    if (s < 0 || !isFinite(s)) return '--';
    if (s < 60) return Math.ceil(s) + 's';
    return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
}

// ===== MODALS =====
function showModal(opts) {
    const container = document.getElementById('modalContainer');
    container.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target===this) window.closeModal()">
            <div class="modal">
                ${opts.icon ? `<div style="width:45px;height:45px;border-radius:12px;background:rgba(255,51,85,0.1);display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:var(--danger);font-size:1.1rem;"><i class="${opts.icon}"></i></div>` : ''}
                <div class="modal-title">${opts.title || ''}</div>
                <div class="modal-desc">${opts.desc || ''}</div>
                ${opts.customContent || ''}
                ${opts.inputPlaceholder !== undefined ? `<input type="${opts.inputType || 'text'}" class="modal-input" id="modalInput" placeholder="${opts.inputPlaceholder}" value="${opts.inputValue || ''}" maxlength="${opts.inputType === 'password' ? 4 : 100}" autofocus>` : ''}
                ${opts.customActions ? `<div class="modal-actions">${opts.customActions}</div>` : `
                <div class="modal-actions">
                    ${opts.hideCancel ? '' : `<button class="modal-cancel" onclick="window.closeModal()">Cancel</button>`}
                    <button class="modal-confirm ${opts.confirmClass || ''}" onclick="window.confirmModal()">${opts.confirmText || 'Confirm'}</button>
                </div>`}
            </div>
        </div>`;
    window._modalOnConfirm = opts.onConfirm;
    const input = document.getElementById('modalInput');
    if (input) {
        setTimeout(() => input.focus(), 100);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') window.confirmModal(); });
    }
}
window.confirmModal = () => {
    const input = document.getElementById('modalInput');
    const val = input ? input.value : null;
    if (window._modalOnConfirm) window._modalOnConfirm(val);
    closeModal();
};
window.closeModal = () => { document.getElementById('modalContainer').innerHTML = ''; window._modalOnConfirm = null; };
function closeModal() { window.closeModal(); }

function showFolderPickerModal(title, callback) {
    const container = document.getElementById('modalContainer');
    const folderHTML = folders.map(f =>
        `<div class="folder-option" onclick="this.parentElement.querySelectorAll('.folder-option').forEach(x=>x.classList.remove('selected')); this.classList.add('selected'); this.parentElement.dataset.selected='${f.id}'">
            <i class="fas fa-folder" style="color:${f.color || 'var(--neon)'}"></i>
            <span>${f.name}</span>
            <span style="margin-left:auto;font-size:0.65rem;color:#555;">${allFiles.filter(x => x.folder === f.id && !x.trash).length}</span>
        </div>`).join('');
    container.innerHTML = `
        <div class="modal-overlay" onclick="if(event.target===this) window.closeModal()">
            <div class="modal">
                <div class="modal-title">${title}</div>
                <div class="modal-desc">Select destination.</div>
                <div class="folder-list-modal" id="folderPickerList" data-selected="">${folderHTML}</div>
                <div class="modal-actions">
                    <button class="modal-cancel" onclick="window.closeModal()">Cancel</button>
                    <button class="modal-confirm" onclick="window.confirmFolderPick()">Confirm</button>
                </div>
            </div>
        </div>`;
    window._folderPickCallback = callback;
}
window.confirmFolderPick = () => {
    const list = document.getElementById('folderPickerList');
    const selected = list ? list.dataset.selected : '';
    if (selected && window._folderPickCallback) window._folderPickCallback(selected);
    else { showToast('Select a folder', 'warning'); return; }
    closeModal();
};

// ===== TOAST =====
function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const colors = {
        success: 'linear-gradient(135deg, rgba(0,255,136,0.15), rgba(0,255,204,0.15))',
        error: 'linear-gradient(135deg, rgba(255,51,85,0.15), rgba(255,100,100,0.15))',
        warning: 'linear-gradient(135deg, rgba(255,170,0,0.15), rgba(255,200,50,0.15))',
        info: 'linear-gradient(135deg, rgba(0,212,255,0.15), rgba(100,180,255,0.15))'
    };
    const textColors = { success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)', info: 'var(--neon2)' };
    const borderColors = { success: 'rgba(0,255,136,0.3)', error: 'rgba(255,51,85,0.3)', warning: 'rgba(255,170,0,0.3)', info: 'rgba(0,212,255,0.3)' };
    t.innerHTML = `<span class="toast-icon">${icons[type] || '✓'}</span> ${msg}`;
    t.style.background = colors[type] || colors.success;
    t.style.color = textColors[type] || textColors.success;
    t.style.borderColor = borderColors[type] || borderColors.success;
    t.classList.add('active');
    setTimeout(() => t.classList.remove('active'), 3000);
}

// ===== GLOBAL LISTENERS =====
document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('active'));
    document.getElementById('contextMenu').classList.remove('active');
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeModal(); window.closeInfoPanel();
        document.getElementById('uploadBox').classList.remove('active');
        document.getElementById('contextMenu').classList.remove('active');
        if (selectMode) window.clearSelection();
    }
    if (e.ctrlKey && e.key === 'a' && selectMode) { e.preventDefault(); window.selectAllVisible(); }
});
document.addEventListener('touchmove', e => {
    const ub = document.getElementById('uploadBox');
    const ip = document.getElementById('infoPanel');
    if ((ub.classList.contains('active') && ub.contains(e.target)) ||
        (ip.classList.contains('active') && ip.contains(e.target))) { /* allow scroll */ }
}, { passive: true });

// ===== INIT =====
async function init() {
    await openIDB();
    initParticles();
    initSyncManager();
}
init();
