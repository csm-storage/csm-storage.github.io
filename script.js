// ============================================================
// CSM DRIVE | ULTRA PRO - script.js
// Production PWA with IndexedDB, Offline Sync, Background Sync
// ============================================================

// ---- SERVICE WORKER REGISTRATION ----
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => {
                console.log('[PWA] SW registered:', reg.scope);
                // Listen for SW messages
                navigator.serviceWorker.addEventListener('message', (e) => {
                    if (e.data && e.data.type === 'PROCESS_SYNC_QUEUE') processSyncQueue();
                });
            })
            .catch(err => console.warn('[PWA] SW registration failed:', err));
    });
}

// ---- INDEXEDDB SETUP ----
const IDB_NAME = 'csm-drive-db';
const IDB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_FOLDERS = 'folders';
const STORE_SETTINGS = 'settings';
const STORE_SYNC_QUEUE = 'syncQueue';
const STORE_PENDING_UPLOADS = 'pendingUploads';

let idb = null;

function openIDB() {
    return new Promise((resolve, reject) => {
        if (idb) return resolve(idb);
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => { idb = req.result; resolve(idb); };
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_FILES)) {
                const store = db.createObjectStore(STORE_FILES, { keyPath: 'id' });
                store.createIndex('trash', 'trash', { unique: false });
                store.createIndex('cat', 'cat', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_FOLDERS))
                db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(STORE_SETTINGS))
                db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
            if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE))
                db.createObjectStore(STORE_SYNC_QUEUE, { keyPath: 'id', autoIncrement: true });
            if (!db.objectStoreNames.contains(STORE_PENDING_UPLOADS))
                db.createObjectStore(STORE_PENDING_UPLOADS, { keyPath: 'id', autoIncrement: true });
        };
    });
}

async function idbGetAll(storeName) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function idbPut(storeName, data) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).put(data);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbDelete(storeName, key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function idbClearStore(storeName) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// Save all files to IDB
async function saveFilesToIDB(files) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_FILES, 'readwrite');
        const store = tx.objectStore(STORE_FILES);
        files.forEach(f => store.put(f));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function saveFoldersToIDB(folders) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_FOLDERS, 'readwrite');
        const store = tx.objectStore(STORE_FOLDERS);
        folders.forEach(f => store.put(f));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Add to sync queue
async function addToSyncQueue(action) {
    await idbPut(STORE_SYNC_QUEUE, { ...action, timestamp: Date.now() });
    // Request background sync if supported
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        try { await reg.sync.register('csm-sync-queue'); } catch(e) {}
    }
}

// ---- SYNC MANAGER ----
async function processSyncQueue() {
    const queue = await idbGetAll(STORE_SYNC_QUEUE);
    if (queue.length === 0) return;
    for (const item of queue) {
        try {
            if (item.action === 'update') {
                await fbUpdate(`${DB_PATH}/${item.id}`, item.data);
            } else if (item.action === 'delete') {
                await fbRemove(`${DB_PATH}/${item.id}`);
            } else if (item.action === 'folderUpdate') {
                await fbUpdate(`${FOLDERS_PATH}/${item.id}`, item.data);
            } else if (item.action === 'folderDelete') {
                await fbRemove(`${FOLDERS_PATH}/${item.id}`);
            } else if (item.action === 'folderCreate') {
                await fbSet(`${FOLDERS_PATH}/${item.id}`, item.data);
            } else if (item.action === 'create') {
                await fbSet(`${DB_PATH}/${item.id}`, item.data);
            }
            await idbDelete(STORE_SYNC_QUEUE, item.id);
        } catch (e) {
            console.warn('[SYNC] Failed to sync item:', item, e);
        }
    }
    // Process pending uploads
    await processPendingUploads();
}

async function processPendingUploads() {
    const pending = await idbGetAll(STORE_PENDING_UPLOADS);
    if (pending.length === 0) return;
    for (const item of pending) {
        try {
            // Re-upload blob to Cloudinary
            const blob = item.blob;
            if (!blob) { await idbDelete(STORE_PENDING_UPLOADS, item.id); continue; }
            const file = new File([blob], item.name, { type: item.mimeType });
            const form = new FormData();
            form.append('file', file);
            form.append('upload_preset', 'github_unsigned');
            const res = await fetch(`https://api.cloudinary.com/v1_1/dx7aankx2/auto/upload`, { method: 'POST', body: form });
            const data = await res.json();
            if (data.secure_url) {
                const fileRecord = {
                    url: data.secure_url, name: item.name, cat: item.cat,
                    size: item.size, time: item.time, trash: false,
                    starred: false, locked: item.locked, folder: item.folder || null
                };
                const newKey = await fbPush(DB_PATH, fileRecord);
                fileRecord.id = newKey;
                await idbPut(STORE_FILES, fileRecord);
                await idbDelete(STORE_PENDING_UPLOADS, item.id);
                showToast(`"${item.name}" synced`, 'success');
            }
        } catch(e) {
            console.warn('[SYNC] Failed to upload pending file:', item.name, e);
        }
    }
}

// Network status manager
function setupSyncManager() {
    window.addEventListener('online', () => {
        showToast('Back online! Syncing...', 'success');
        updateOfflineBadge(false);
        processSyncQueue().then(() => {
            if (allFiles.length === 0) loadData();
        });
    });
    window.addEventListener('offline', () => {
        showToast('You are offline. Changes will sync later.', 'warning');
        updateOfflineBadge(true);
    });
    // Initial state
    updateOfflineBadge(!navigator.onLine);
}

function updateOfflineBadge(isOffline) {
    let badge = document.getElementById('offlineBadge');
    const headerActions = document.querySelector('.header-actions');
    if (isOffline) {
        if (!badge && headerActions) {
            badge = document.createElement('div');
            badge.id = 'offlineBadge';
            badge.className = 'offline-badge';
            badge.innerHTML = '<i class="fas fa-wifi-slash"></i> OFFLINE';
            headerActions.prepend(badge);
        }
    } else {
        if (badge) badge.remove();
    }
}

// ---- FIREBASE HELPERS (promise-based wrappers) ----
// These are set after Firebase is initialized
let fbUpdate, fbRemove, fbSet, fbPush, fbGet;

// ============================================================
// MAIN APP LOGIC (replaces inline script)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getDatabase, ref, push, set, onValue, remove, update, get } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyBtmUmV1KxQDB0jN9gUQnh-eYWKllMPav0",
    authDomain: "photos-58c8e.firebaseapp.com",
    projectId: "photos-58c8e",
    databaseURL: "https://photos-58c8e-default-rtdb.firebaseio.com"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const DB_PATH = 'my_gallery';
const FOLDERS_PATH = 'folders';
const SETTINGS_PATH = 'settings';

// Wire up Firebase helpers
fbUpdate = (path, data) => update(ref(db, path), data);
fbRemove = (path) => remove(ref(db, path));
fbSet = (path, data) => set(ref(db, path), data);
fbPush = async (path, data) => {
    const newRef = push(ref(db, path));
    await set(newRef, data);
    return newRef.key;
};
fbGet = (path) => get(ref(db, path));

let allFiles = [];
let folders = [];
let currentTab = 'all';
let currentFolder = 'all';
let searchText = "";
let sortMode = "newest";
let viewMode = "grid";
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

// ---- PARTICLES ----
function initParticles() {
    const canvas = document.getElementById('particles');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const particles = [];
    const count = window.innerWidth < 768 ? 25 : 60;
    for (let i = 0; i < count; i++) {
        particles.push({ x: Math.random()*canvas.width, y: Math.random()*canvas.height, vx:(Math.random()-0.5)*0.3, vy:(Math.random()-0.5)*0.3, size:Math.random()*2+0.5, opacity:Math.random()*0.3+0.05 });
    }
    function animate() {
        ctx.clearRect(0,0,canvas.width,canvas.height);
        particles.forEach(p => {
            p.x+=p.vx; p.y+=p.vy;
            if(p.x<0||p.x>canvas.width) p.vx*=-1;
            if(p.y<0||p.y>canvas.height) p.vy*=-1;
            ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,Math.PI*2);
            ctx.fillStyle=`rgba(0,255,204,${p.opacity})`; ctx.fill();
        });
        const maxDist = window.innerWidth<768?80:120;
        for(let i=0;i<particles.length;i++) {
            for(let j=i+1;j<particles.length;j++) {
                const dx=particles[i].x-particles[j].x, dy=particles[i].y-particles[j].y;
                const dist=Math.sqrt(dx*dx+dy*dy);
                if(dist<maxDist) { ctx.beginPath(); ctx.moveTo(particles[i].x,particles[i].y); ctx.lineTo(particles[j].x,particles[j].y); ctx.strokeStyle=`rgba(0,255,204,${0.03*(1-dist/maxDist)})`; ctx.stroke(); }
            }
        }
        requestAnimationFrame(animate);
    }
    animate();
    window.addEventListener('resize', ()=>{ canvas.width=window.innerWidth; canvas.height=window.innerHeight; });
}
initParticles();
setupSyncManager();

// ---- AUTH ----
onAuthStateChanged(auth, async user => {
    if (user) {
        document.getElementById('loginSection').classList.add('hidden');
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
        await signInWithEmailAndPassword(auth, document.getElementById('loginEmail').value, document.getElementById('loginPass').value);
    } catch(e) {
        showToast("Authentication Failed", "error");
        btn.innerHTML = '<i class="fas fa-fingerprint"></i>&nbsp; UNLOCK SYSTEM';
        btn.disabled = false;
    }
};
document.getElementById('loginPass').addEventListener('keydown', (e)=>{ if(e.key==='Enter') document.getElementById('doLogin').click(); });

// ---- PASSCODE ----
function showPasscodeScreen(callback) {
    passcodeCallback = callback; passcodeInput = '';
    document.getElementById('passcodeSection').classList.remove('hidden');
    document.getElementById('passcodeMessage').textContent = 'Enter your 4-digit access code';
    updatePasscodeDots();
}
window.enterPasscode = (num) => {
    if (passcodeInput.length >= 4) return;
    passcodeInput += num; updatePasscodeDots();
    if (passcodeInput.length === 4) {
        setTimeout(() => {
            if (passcodeInput === appPasscode) { if (passcodeCallback) passcodeCallback(); passcodeCallback = null; }
            else {
                document.querySelectorAll('.passcode-dot').forEach(d=>d.classList.add('error'));
                document.getElementById('passcodeMessage').textContent = 'Incorrect passcode. Try again.';
                setTimeout(()=>{ passcodeInput=''; document.querySelectorAll('.passcode-dot').forEach(d=>d.classList.remove('error')); updatePasscodeDots(); }, 800);
            }
        }, 200);
    }
};
window.clearPasscode = () => { passcodeInput = passcodeInput.slice(0,-1); updatePasscodeDots(); };
window.cancelPasscode = () => {
    passcodeInput=''; updatePasscodeDots();
    if (!sessionUnlocked) signOut(auth);
    document.getElementById('passcodeSection').classList.add('hidden'); passcodeCallback = null;
};
function updatePasscodeDots() {
    document.querySelectorAll('#passcodeDots .passcode-dot').forEach((d,i)=>d.classList.toggle('filled', i<passcodeInput.length));
}

window.confirmLogout = () => {
    showModal({ icon:'fas fa-right-from-bracket', title:'Confirm Logout', desc:'Are you sure you want to sign out?',
        confirmText:'Logout', confirmClass:'danger', onConfirm:()=>{ sessionUnlocked=false; signOut(auth); showToast("Logged out successfully","info"); }
    });
};

// ---- DATA LOADING (Offline-First) ----
async function loadData() {
    // Always load from IDB first for instant display
    const cached = await idbGetAll(STORE_FILES);
    if (cached.length > 0) {
        allFiles = cached;
        updateStats(); render();
    }

    // Also include pending uploads (offline queued)
    const pending = await idbGetAll(STORE_PENDING_UPLOADS);
    const pendingItems = pending.map(p => ({
        id: `pending_${p.id}`, name: p.name, cat: p.cat,
        size: p.size, time: p.time, trash: false, starred: false,
        locked: p.locked, folder: p.folder, _pending: true
    }));
    if (pendingItems.length > 0) {
        allFiles = [...allFiles.filter(f => !f._pending), ...pendingItems];
        updateStats(); render();
    }

    if (!navigator.onLine) return;

    // Fetch fresh from Firebase and update IDB
    onValue(ref(db, DB_PATH), async snap => {
        const fresh = [];
        const data = snap.val();
        if (data) {
            Object.keys(data).forEach(k => {
                let item = data[k];
                if (!item.cat) {
                    const ext = (item.url||'').split('.').pop().split('?')[0].toLowerCase();
                    item.cat = ['mp4','mov','avi','mkv','webm'].includes(ext) ? 'video' : 'image';
                }
                if (!item.time) item.time = 0;
                fresh.push({ id: k, ...item });
            });
        }
        // Merge with pending (don't remove them)
        await saveFilesToIDB(fresh);
        allFiles = [...fresh, ...pendingItems];
        updateStats(); render();
    });
}

async function loadFolders() {
    const cached = await idbGetAll(STORE_FOLDERS);
    if (cached.length > 0) { folders = cached; renderFolders(); updateFolderSelect(); }

    if (!navigator.onLine) return;

    onValue(ref(db, FOLDERS_PATH), async snap => {
        folders = [];
        const data = snap.val();
        if (data) Object.keys(data).forEach(k => folders.push({ id: k, ...data[k] }));
        await saveFoldersToIDB(folders);
        renderFolders(); updateFolderSelect();
    });
}

async function loadSettings() {
    if (!navigator.onLine) {
        const s = await idbGetAll(STORE_SETTINGS);
        s.forEach(item => { if (item.key==='passcode') appPasscode=item.value; if (item.key==='passcodeEnabled') passcodeEnabled=item.value; });
        return;
    }
    onValue(ref(db, SETTINGS_PATH), async snap => {
        const data = snap.val();
        if (data) {
            if (data.passcode) { appPasscode = data.passcode; await idbPut(STORE_SETTINGS, { key:'passcode', value:data.passcode }); }
            if (data.passcodeEnabled !== undefined) { passcodeEnabled = data.passcodeEnabled; await idbPut(STORE_SETTINGS, { key:'passcodeEnabled', value:data.passcodeEnabled }); }
        }
    });
}

// ---- STATS ----
function updateStats() {
    const active = allFiles.filter(f=>!f.trash&&!f._pending);
    const imgs = active.filter(f=>f.cat==='image').length;
    const vids = active.filter(f=>f.cat==='video').length;
    const stars = active.filter(f=>f.starred).length;
    const trashed = allFiles.filter(f=>f.trash).length;
    const total = active.length;
    document.getElementById('countAll').innerText = total;
    document.getElementById('countImg').innerText = imgs;
    document.getElementById('countVid').innerText = vids;
    document.getElementById('countStar').innerText = stars;
    document.getElementById('countTrash').innerText = trashed;
    document.getElementById('countFolders').innerText = folders.length;
    const max = Math.max(total,1);
    document.getElementById('imgBar').style.width=(imgs/max*100)+'%';
    document.getElementById('vidBar').style.width=(vids/max*100)+'%';
    document.getElementById('starBar').style.width=(stars/max*100)+'%';
    document.getElementById('trashBar').style.width=(trashed/Math.max(trashed+total,1)*100)+'%';
    document.getElementById('folderBar').style.width=Math.min(folders.length*20,100)+'%';
    let totalSize = 0;
    allFiles.forEach(f=>{ if(f.size) totalSize+=parseFloat(f.size); });
    const storageCap = 1024;
    document.getElementById('storageFill').style.width=Math.min((totalSize/storageCap)*100,100)+'%';
    document.getElementById('storageText').innerText=`${totalSize.toFixed(1)} MB / ${storageCap} MB (${allFiles.length} files)`;
}

// ---- FOLDERS ----
function renderFolders() {
    const bar = document.getElementById('folderBar');
    bar.innerHTML = `<div class="folder-pill ${currentFolder==='all'?'active':''}" onclick="window.setFolder('all',this)">
        <i class="fas fa-folder"></i> All <span class="count">${allFiles.filter(f=>!f.trash).length}</span>
    </div>`;
    folders.forEach(f => {
        const count = allFiles.filter(file=>file.folder===f.id&&!file.trash).length;
        bar.innerHTML += `<div class="folder-pill ${currentFolder===f.id?'active':''}" onclick="window.setFolder('${f.id}',this)" oncontextmenu="window.folderContext(event,'${f.id}')">
            <i class="fas fa-folder" style="color:${f.color||'var(--neon)'}"></i> ${f.name} <span class="count">${count}</span>
        </div>`;
    });
    bar.innerHTML += `<div class="folder-pill add-folder" onclick="window.createFolder()"><i class="fas fa-plus"></i> New</div>`;
}

function updateFolderSelect() {
    const sel = document.getElementById('uploadFolder');
    sel.innerHTML = '<option value="">No Folder</option>';
    folders.forEach(f => sel.innerHTML+=`<option value="${f.id}">${f.name}</option>`);
}

// ---- RENDER ----
function getVisibleFiles() {
    let list = allFiles.filter(f => {
        if (currentTab==='trash') return f.trash;
        if (currentTab==='starred') return f.starred&&!f.trash;
        if (currentTab==='locked') return f.locked&&!f.trash;
        if (currentTab==='all') return !f.trash;
        return f.cat===currentTab&&!f.trash;
    });
    if (currentFolder!=='all'&&currentTab!=='trash') list=list.filter(f=>f.folder===currentFolder);
    if (searchText) list=list.filter(f=>(f.name||'').toLowerCase().includes(searchText.toLowerCase()));
    return list;
}

function render() {
    const grid = document.getElementById('fileGrid');
    grid.innerHTML = "";
    grid.className = viewMode==='list'?'grid list-view':'grid';
    const trashActions = document.getElementById('trashActions');
    if (currentTab==='trash') { trashActions.classList.remove('hidden'); trashActions.style.display='flex'; }
    else { trashActions.classList.add('hidden'); }
    let list = getVisibleFiles();
    list.sort((a,b) => {
        if(sortMode==='newest') return (b.time||0)-(a.time||0);
        if(sortMode==='oldest') return (a.time||0)-(b.time||0);
        if(sortMode==='az') return (a.name||'').localeCompare(b.name||'');
        if(sortMode==='za') return (b.name||'').localeCompare(a.name||'');
        if(sortMode==='largest') return parseFloat(b.size||0)-parseFloat(a.size||0);
        if(sortMode==='smallest') return parseFloat(a.size||0)-parseFloat(b.size||0);
        return 0;
    });
    if(list.length===0) {
        grid.innerHTML=`<div class="empty-state">
            <div class="empty-icon"><i class="fas fa-${currentTab==='trash'?'trash-can':'ghost'}"></i></div>
            <div class="empty-title">${currentTab==='trash'?'Trash is Empty':'No Files Found'}</div>
            <div class="empty-desc">${currentTab==='trash'?'Deleted files will appear here':'Upload files or change your filter'}</div>
        </div>`;
        return;
    }
    list.forEach((file,idx) => {
        let thumb = file.url||'';
        if(file.url&&file.url.includes('/upload/')) thumb=file.url.replace('/upload/','/upload/w_400,q_auto,f_auto/');
        const isVid = file.cat==='video';
        const date = file.time ? new Date(file.time).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—';
        const folderObj = folders.find(f=>f.id===file.folder);
        const isLocked = file.locked&&!file._unlocked;
        const isPending = !!file._pending;

        const card = document.createElement('div');
        card.className = `card ${selectedIds.has(file.id)?'selected':''} ${isLocked?'locked':''} ${isPending?'pending-upload':''}`;
        card.style.animationDelay = `${idx*0.03}s`;
        card.setAttribute('data-id', file.id);
        if (!isPending) card.oncontextmenu = (e)=>{ e.preventDefault(); window.showContextMenu(e,file.id); };

        if(selectMode&&!isPending) { card.onclick=(e)=>{ if(e.target.closest('.dots')||e.target.closest('.dropdown')||e.target.closest('.select-check')) return; window.toggleSelect(file.id); }; }

        let previewHTML;
        if(isLocked) {
            previewHTML=`<div style="width:100%;height:100%;background:#0a0a15;display:flex;align-items:center;justify-content:center;"><i class="fas fa-lock" style="font-size:2rem;color:rgba(255,170,0,0.3);"></i></div>`;
        } else if(isPending) {
            previewHTML=`<div style="width:100%;height:100%;background:#0a0a0f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">
                <i class="fas fa-cloud-arrow-up" style="font-size:1.5rem;color:rgba(255,170,0,0.4);"></i>
                <span style="font-size:0.6rem;color:#555;">Queued</span></div>`;
        } else if(isVid) {
            previewHTML=`<video src="${thumb}#t=0.1" muted preload="metadata" playsinline></video>
                <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:32px;height:32px;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,0.2);">
                <i class="fas fa-play" style="color:white;font-size:0.7rem;margin-left:2px;"></i></div>`;
        } else {
            previewHTML=`<img src="${thumb}" loading="lazy" alt="${file.name}">`;
        }

        const trashMenuHTML = `<div class="dd-header">Trash Actions</div>
            <div class="dd-item" onclick="window.restoreFile('${file.id}')"><i class="fas fa-rotate-left"></i> Restore</div>
            <div class="dd-item danger" onclick="window.permanentDelete('${file.id}')"><i class="fas fa-fire"></i> Delete Forever</div>`;

        const normalMenuHTML = `<div class="dd-header">File Actions</div>
            <div class="dd-item" onclick="window.openPreview('${file.id}')"><i class="fas fa-external-link"></i> Open</div>
            <div class="dd-item" onclick="window.showFileInfo('${file.id}')"><i class="fas fa-circle-info"></i> Details</div>
            <div class="dd-divider"></div>
            <div class="dd-item" onclick="window.renameFile('${file.id}')"><i class="fas fa-pen"></i> Rename</div>
            <div class="dd-item" onclick="window.copyToFolder('${file.id}')"><i class="fas fa-copy"></i> Copy</div>
            <div class="dd-item" onclick="window.moveToFolder('${file.id}')"><i class="fas fa-folder-open"></i> Move</div>
            <div class="dd-divider"></div>
            <div class="dd-item" onclick="window.star('${file.id}',${!!file.starred})"><i class="fas fa-star"></i> ${file.starred?'Unstar':'Star'}</div>
            <div class="dd-item" onclick="window.toggleLock('${file.id}')"><i class="fas fa-${file.locked?'unlock':'lock'}"></i> ${file.locked?'Unlock':'Lock'}</div>
            <div class="dd-item" onclick="window.copyLink('${file.url}')"><i class="fas fa-link"></i> Copy Link</div>
            <div class="dd-item" onclick="window.downloadFile('${file.url}','${file.name}')"><i class="fas fa-download"></i> Download</div>
            <div class="dd-divider"></div>
            <div class="dd-item danger" onclick="window.trashFile('${file.id}')"><i class="fas fa-trash"></i> Trash</div>`;

        const selectCheckHTML = selectMode&&!isPending ? `<div class="select-check ${selectedIds.has(file.id)?'checked':''}" onclick="event.stopPropagation();window.toggleSelect('${file.id}')"></div>` : '';
        const fancyboxAttr = (!isLocked&&!selectMode&&!isPending) ? `data-fancybox="gallery" data-src="${file.url}" data-caption="${file.name}"` : '';
        const previewClick = isLocked ? `onclick="window.unlockFile('${file.id}')"` : '';

        card.innerHTML = `${selectCheckHTML}
            ${!isPending?`<div class="dots" onclick="event.stopPropagation();window.toggleMenu(event,'${file.id}')"><i class="fas fa-ellipsis-v"></i></div>
            <div id="menu-${file.id}" class="dropdown">${currentTab==='trash'?trashMenuHTML:normalMenuHTML}</div>`:''}
            ${file.starred&&!isLocked?'<div class="star-badge"><i class="fas fa-star"></i></div>':''}
            ${file.locked?'<div class="lock-badge"><i class="fas fa-shield-halved"></i></div>':''}
            <div class="preview" ${fancyboxAttr} ${previewClick}>
                <span class="file-badge ${isVid?'badge-vid':'badge-img'}">${isVid?'Vid':'Img'}</span>
                ${previewHTML}
                <div class="preview-overlay"></div>
            </div>
            <div class="meta">
                <div class="filename" title="${file.name}">${file.name||'Untitled'}</div>
                <div class="fileinfo"><span>${file.size||'—'}</span><span>${date}</span></div>
                ${folderObj?`<div class="folder-tag"><i class="fas fa-folder" style="font-size:0.55rem;"></i> ${folderObj.name}</div>`:''}
            </div>`;
        grid.appendChild(card);
    });

    if(!selectMode) {
        try { Fancybox.destroy(); } catch(e){}
        Fancybox.bind("[data-fancybox]", {
            Toolbar: { display: { left:[], middle:["prev","counter","next"], right:["slideshow","fullscreen","thumbs","close"] } }
        });
    }
    updateMultiBarActions();
}

function updateMultiBarActions() {
    const actionsDiv = document.getElementById('multiBarActions');
    if (currentTab==='trash') {
        actionsDiv.innerHTML=`<button class="multi-btn restore" onclick="window.multiRestore()"><i class="fas fa-rotate-left"></i> <span>Restore</span></button>
            <button class="multi-btn danger" onclick="window.multiPermanentDelete()"><i class="fas fa-fire"></i> <span>Delete</span></button>`;
    } else {
        actionsDiv.innerHTML=`<button class="multi-btn" onclick="window.multiCopy()"><i class="fas fa-copy"></i> <span>Copy</span></button>
            <button class="multi-btn" onclick="window.multiStar()"><i class="fas fa-star"></i> <span>Star</span></button>
            <button class="multi-btn" onclick="window.multiDownload()"><i class="fas fa-download"></i></button>
            <button class="multi-btn danger" onclick="window.multiTrash()"><i class="fas fa-trash"></i></button>`;
    }
}

// ---- TABS / FILTERS ----
window.setTab = (t,el) => { currentTab=t; document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active')); el.classList.add('active'); selectedIds.clear(); updateMultiBar(); render(); };
window.setFolder = (fid,el) => { currentFolder=fid; document.querySelectorAll('.folder-pill').forEach(p=>p.classList.remove('active')); if(el)el.classList.add('active'); render(); };
window.handleSearch = () => { searchText=document.getElementById('searchInput').value.trim(); render(); };
window.handleSort = () => { sortMode=document.getElementById('sortSelect').value; render(); };
window.setView = (mode) => { viewMode=mode; document.getElementById('gridViewBtn').classList.toggle('active',mode==='grid'); document.getElementById('listViewBtn').classList.toggle('active',mode==='list'); render(); };

// ---- MENUS ----
window.toggleMenu = (e,id) => {
    e.stopPropagation();
    document.querySelectorAll('.dropdown').forEach(d=>{ if(d.id!==`menu-${id}`) d.classList.remove('active'); });
    document.getElementById(`menu-${id}`).classList.toggle('active');
};

window.showContextMenu = (e,id) => {
    contextTarget=id;
    const menu=document.getElementById('contextMenu');
    const file=allFiles.find(f=>f.id===id);
    if(file&&file.trash) {
        menu.innerHTML=`<div class="ctx-item" onclick="window.ctxAction('restore')"><i class="fas fa-rotate-left"></i> Restore</div>
            <div class="ctx-divider"></div>
            <div class="ctx-item danger" onclick="window.ctxAction('permDelete')"><i class="fas fa-fire"></i> Delete Forever</div>`;
    } else {
        menu.innerHTML=`<div class="ctx-item" onclick="window.ctxAction('open')"><i class="fas fa-external-link"></i> Open</div>
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
    menu.style.left=Math.min(e.clientX,window.innerWidth-210)+'px';
    menu.style.top=Math.min(e.clientY,window.innerHeight-300)+'px';
    menu.classList.add('active');
};

window.ctxAction = (action) => {
    document.getElementById('contextMenu').classList.remove('active');
    const id=contextTarget; if(!id) return;
    const file=allFiles.find(f=>f.id===id); if(!file) return;
    const map = { open:()=>window.openPreview(id), info:()=>window.showFileInfo(id), rename:()=>window.renameFile(id), copy:()=>window.copyToFolder(id), star:()=>window.star(id,!!file.starred), lock:()=>window.toggleLock(id), link:()=>window.copyLink(file.url), download:()=>window.downloadFile(file.url,file.name), trash:()=>window.trashFile(id), restore:()=>window.restoreFile(id), permDelete:()=>window.permanentDelete(id) };
    if(map[action]) map[action]();
};

// ---- FILE ACTIONS (Online/Offline Aware) ----
async function offlineAwareUpdate(id, data, successMsg) {
    // Update local cache immediately
    const idx = allFiles.findIndex(f=>f.id===id);
    if(idx>-1) { allFiles[idx] = { ...allFiles[idx], ...data }; await idbPut(STORE_FILES, allFiles[idx]); }
    updateStats(); render();
    if(navigator.onLine) {
        await fbUpdate(`${DB_PATH}/${id}`, data);
    } else {
        await addToSyncQueue({ action:'update', id, data });
        showToast(`${successMsg} (syncing later)`, 'warning');
        return;
    }
    showToast(successMsg, 'success');
}

async function offlineAwareDelete(id) {
    // Remove from local cache immediately
    allFiles = allFiles.filter(f=>f.id!==id);
    await idbDelete(STORE_FILES, id);
    updateStats(); render();
    if(navigator.onLine) {
        await fbRemove(`${DB_PATH}/${id}`);
    } else {
        await addToSyncQueue({ action:'delete', id });
        showToast('Deleted (will sync later)', 'warning');
    }
}

window.copyLink = (url) => { if(url) { navigator.clipboard.writeText(url); showToast("Link copied","success"); } };

window.star = async (id,cur) => {
    await offlineAwareUpdate(id, { starred:!cur }, cur?'Star removed':'File starred');
};

window.toggleLock = (id) => {
    const file=allFiles.find(f=>f.id===id); if(!file) return;
    if(file.locked) {
        showPasscodeScreen(()=>{ document.getElementById('passcodeSection').classList.add('hidden'); offlineAwareUpdate(id,{locked:false},'Protection removed'); });
    } else { offlineAwareUpdate(id,{locked:true},'File protected'); }
};

window.unlockFile = (id) => {
    showPasscodeScreen(()=>{
        document.getElementById('passcodeSection').classList.add('hidden');
        const file=allFiles.find(f=>f.id===id);
        if(file){file._unlocked=true; render(); showToast("Unlocked temporarily","success");}
    });
};

window.openPreview = (id) => {
    const file=allFiles.find(f=>f.id===id);
    if(file){ if(file.locked) window.unlockFile(id); else window.open(file.url,'_blank'); }
};

window.renameFile = (id) => {
    const file=allFiles.find(f=>f.id===id); if(!file) return;
    showModal({ title:'Rename File', desc:'Enter a new name.', inputValue:file.name, inputPlaceholder:'New file name', confirmText:'Rename',
        onConfirm:(val)=>{ if(val&&val.trim()) offlineAwareUpdate(id,{name:val.trim()},'Renamed'); }
    });
};

window.copyToFolder = (id) => {
    if(folders.length===0){showToast("Create a folder first","warning");return;}
    showFolderPickerModal('Copy to Folder', async (folderId) => {
        const file=allFiles.find(f=>f.id===id);
        if(file&&folderId) {
            const {id:_,...fileData} = file;
            const newData = {...fileData, folder:folderId, time:Date.now(), _unlocked:undefined, _pending:undefined};
            if(navigator.onLine) {
                const newKey = await fbPush(DB_PATH, newData);
                await idbPut(STORE_FILES, {...newData, id:newKey});
            } else {
                const tempId = `local_${Date.now()}`;
                await idbPut(STORE_FILES, {...newData, id:tempId});
                await addToSyncQueue({ action:'create', id:tempId, data:newData });
            }
            showToast("File copied","success");
        }
    });
};

window.moveToFolder = (id) => {
    if(folders.length===0){showToast("Create a folder first","warning");return;}
    showFolderPickerModal('Move to Folder', (folderId)=>{ if(folderId) offlineAwareUpdate(id,{folder:folderId},'File moved'); });
};

window.trashFile = (id) => {
    if(id.startsWith('pending_')) { showToast("Cannot trash a pending upload","warning"); return; }
    showModal({ title:'Move to Trash', desc:'Move to trash? Restore within 30 days.', confirmText:'Trash', confirmClass:'danger', icon:'fas fa-trash',
        onConfirm:()=>offlineAwareUpdate(id,{trash:true,trashedAt:Date.now()},'Trashed')
    });
};

window.restoreFile = (id) => offlineAwareUpdate(id,{trash:false,trashedAt:null},'Restored');

window.permanentDelete = (id) => {
    showModal({ title:'Delete Permanently', desc:'⚠️ Cannot be undone!', confirmText:'Delete Forever', confirmClass:'danger', icon:'fas fa-exclamation-triangle',
        onConfirm:()=>offlineAwareDelete(id)
    });
};

window.restoreAll = () => {
    const trashed=allFiles.filter(f=>f.trash); if(!trashed.length) return;
    showModal({ title:'Restore All', desc:`Restore ${trashed.length} file(s)?`, confirmText:'Restore All',
        onConfirm:()=>{ trashed.forEach(f=>offlineAwareUpdate(f.id,{trash:false,trashedAt:null},'Restored')); showToast(`${trashed.length} restored`,"success"); }
    });
};

window.emptyTrash = () => {
    const trashed=allFiles.filter(f=>f.trash); if(!trashed.length) return;
    showModal({ title:'Empty Trash', desc:`⚠️ Delete ${trashed.length} file(s) forever?`, confirmText:'Delete All', confirmClass:'danger', icon:'fas fa-fire',
        onConfirm:()=>{ trashed.forEach(f=>offlineAwareDelete(f.id)); showToast("Trash emptied","error"); }
    });
};

window.downloadFile = (url,name) => {
    if(!url){showToast("No URL available","error");return;}
    const a=document.createElement('a'); a.href=url; a.target='_blank'; a.download=name||'file';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast("Download started","success");
};

// ---- FILE INFO ----
window.showFileInfo = (id) => {
    const file=allFiles.find(f=>f.id===id); if(!file) return;
    const panel=document.getElementById('infoPanel');
    const preview=document.getElementById('infoPanelPreview');
    const content=document.getElementById('infoPanelContent');
    const isVid=file.cat==='video';
    preview.innerHTML = file._pending
        ? `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#0a0a15;"><i class="fas fa-cloud-arrow-up" style="font-size:3rem;color:var(--warning);opacity:0.4;"></i></div>`
        : isVid
            ? `<video src="${file.url}" controls playsinline style="width:100%;height:100%;object-fit:cover;"></video>`
            : `<img src="${file.url}" alt="${file.name}">`;
    const date=file.time?new Date(file.time).toLocaleString():'Unknown';
    const folderObj=folders.find(f=>f.id===file.folder);
    content.innerHTML=`
        <div class="info-row"><span class="info-label">Name</span><span class="info-value">${file.name||'Untitled'}</span></div>
        <div class="info-row"><span class="info-label">Type</span><span class="info-value">${file.cat==='video'?'Video':'Image'}</span></div>
        <div class="info-row"><span class="info-label">Size</span><span class="info-value">${file.size||'Unknown'}</span></div>
        <div class="info-row"><span class="info-label">Uploaded</span><span class="info-value">${date}</span></div>
        <div class="info-row"><span class="info-label">Folder</span><span class="info-value">${folderObj?folderObj.name:'None'}</span></div>
        <div class="info-row"><span class="info-label">Starred</span><span class="info-value">${file.starred?'⭐ Yes':'No'}</span></div>
        <div class="info-row"><span class="info-label">Protected</span><span class="info-value">${file.locked?'🔒 Yes':'No'}</span></div>
        <div class="info-row"><span class="info-label">Status</span><span class="info-value">${file._pending?'⏳ Queued':file.trash?'🗑️ Trash':'✅ Active'}</span></div>
        ${!file._pending?`<div style="margin-top:15px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn-neon" style="flex:1;padding:10px;font-size:0.75rem;font-family:'Inter';" onclick="window.copyLink('${file.url}')"><i class="fas fa-link"></i> Link</button>
            <button class="btn-neon btn-outline" style="flex:1;padding:10px;font-size:0.75rem;font-family:'Inter';" onclick="window.downloadFile('${file.url}','${file.name}')"><i class="fas fa-download"></i> Download</button>
        </div>`:''}`;
    panel.classList.add('active');
};
window.closeInfoPanel = () => document.getElementById('infoPanel').classList.remove('active');

// ---- FOLDERS ----
window.createFolder = () => {
    showModal({ title:'New Folder', desc:'Enter a name.', inputPlaceholder:'Folder name', confirmText:'Create',
        onConfirm: async (val) => {
            if(val&&val.trim()) {
                const colors=['#00ffcc','#00d4ff','#a855f7','#ff6b6b','#ffd700','#00ff88'];
                const data={name:val.trim(), color:colors[Math.floor(Math.random()*colors.length)], created:Date.now()};
                if(navigator.onLine) {
                    const newKey = await fbPush(FOLDERS_PATH, data);
                    await idbPut(STORE_FOLDERS, {...data, id:newKey});
                } else {
                    const tempId=`local_folder_${Date.now()}`;
                    await idbPut(STORE_FOLDERS, {...data, id:tempId});
                    await addToSyncQueue({ action:'folderCreate', id:tempId, data });
                }
                showToast("Folder created","success");
            }
        }
    });
};

window.folderContext = (e,fid) => {
    e.preventDefault(); e.stopPropagation();
    showModal({ title:'Folder Options', desc:'Choose an action.',
        customActions:`<button class="modal-cancel" onclick="window.renameFolder('${fid}')"><i class="fas fa-pen"></i> Rename</button>
            <button class="modal-confirm danger" onclick="window.deleteFolder('${fid}')"><i class="fas fa-trash"></i> Delete</button>`
    });
};

window.renameFolder = (fid) => {
    closeModal();
    const folder=folders.find(f=>f.id===fid);
    showModal({ title:'Rename Folder', inputValue:folder?folder.name:'', inputPlaceholder:'New name', confirmText:'Rename',
        onConfirm: async (val)=>{
            if(val&&val.trim()){
                const idx=folders.findIndex(f=>f.id===fid);
                if(idx>-1){ folders[idx].name=val.trim(); await idbPut(STORE_FOLDERS,folders[idx]); }
                if(navigator.onLine) await fbUpdate(`${FOLDERS_PATH}/${fid}`,{name:val.trim()});
                else await addToSyncQueue({action:'folderUpdate',id:fid,data:{name:val.trim()}});
                renderFolders(); showToast("Renamed","success");
            }
        }
    });
};

window.deleteFolder = async (fid) => {
    closeModal();
    showModal({ title:'Delete Folder', desc:'Files will be unassigned.', confirmText:'Delete', confirmClass:'danger',
        onConfirm: async ()=>{
            allFiles.filter(f=>f.folder===fid).forEach(f=>{ f.folder=null; idbPut(STORE_FILES,f); if(navigator.onLine) fbUpdate(`${DB_PATH}/${f.id}`,{folder:null}); });
            folders = folders.filter(f=>f.id!==fid);
            await idbDelete(STORE_FOLDERS, fid);
            if(navigator.onLine) await fbRemove(`${FOLDERS_PATH}/${fid}`);
            else await addToSyncQueue({action:'folderDelete',id:fid});
            if(currentFolder===fid) currentFolder='all';
            renderFolders(); showToast("Folder deleted","success");
        }
    });
};

// ---- SELECT MODE ----
window.toggleSelectMode = () => {
    selectMode=!selectMode; selectedIds.clear(); updateMultiBar();
    document.getElementById('selectModeBtn').classList.toggle('active-mode',selectMode);
    render(); showToast(selectMode?"Selection mode ON":"Selection mode off","info");
};
window.toggleSelect = (id) => { if(selectedIds.has(id))selectedIds.delete(id); else selectedIds.add(id); updateMultiBar(); render(); };
window.selectAllVisible = () => { const visible=getVisibleFiles(); if(selectedIds.size===visible.length)selectedIds.clear(); else visible.forEach(f=>selectedIds.add(f.id)); updateMultiBar(); render(); };
window.clearSelection = () => { selectedIds.clear(); selectMode=false; document.getElementById('selectModeBtn').classList.remove('active-mode'); updateMultiBar(); render(); };
function updateMultiBar() { const bar=document.getElementById('multiBar'); document.getElementById('selectCount').textContent=selectedIds.size; bar.classList.toggle('active',selectedIds.size>0); updateMultiBarActions(); }

// ---- MULTI ACTIONS ----
window.multiCopy = () => {
    if(folders.length===0){showToast("Create a folder first","warning");return;}
    showFolderPickerModal('Copy Selected', async (folderId)=>{
        for(const id of selectedIds) {
            const file=allFiles.find(f=>f.id===id);
            if(file&&folderId) {
                const {id:_,...fileData}=file;
                const newData={...fileData,folder:folderId,time:Date.now(),_unlocked:undefined,_pending:undefined};
                if(navigator.onLine){ const k=await fbPush(DB_PATH,newData); await idbPut(STORE_FILES,{...newData,id:k}); }
                else { const t=`local_${Date.now()}_${Math.random()}`; await idbPut(STORE_FILES,{...newData,id:t}); await addToSyncQueue({action:'create',id:t,data:newData}); }
            }
        }
        showToast(`${selectedIds.size} copied`,"success"); window.clearSelection();
    });
};
window.multiStar = () => { selectedIds.forEach(id=>offlineAwareUpdate(id,{starred:true},'Starred')); showToast(`${selectedIds.size} starred`,"success"); window.clearSelection(); };
window.multiTrash = () => {
    const count=selectedIds.size;
    showModal({ title:'Trash Selected', desc:`Move ${count} file(s) to trash?`, confirmText:'Trash', confirmClass:'danger', icon:'fas fa-trash',
        onConfirm:()=>{ selectedIds.forEach(id=>offlineAwareUpdate(id,{trash:true,trashedAt:Date.now()},'Trashed')); showToast(`${count} trashed`,"info"); window.clearSelection(); }
    });
};
window.multiDownload = () => { selectedIds.forEach(id=>{ const f=allFiles.find(x=>x.id===id); if(f&&f.url) window.downloadFile(f.url,f.name); }); showToast("Downloads started","success"); };
window.multiRestore = () => {
    const count=selectedIds.size;
    showModal({ title:'Restore Selected', desc:`Restore ${count} file(s)?`, confirmText:'Restore', icon:'fas fa-rotate-left',
        onConfirm:()=>{ selectedIds.forEach(id=>offlineAwareUpdate(id,{trash:false,trashedAt:null},'Restored')); showToast(`${count} restored`,"success"); window.clearSelection(); }
    });
};
window.multiPermanentDelete = () => {
    const count=selectedIds.size;
    showModal({ title:'Delete Forever', desc:`⚠️ Delete ${count} file(s) permanently?`, confirmText:'Delete', confirmClass:'danger', icon:'fas fa-exclamation-triangle',
        onConfirm:()=>{ selectedIds.forEach(id=>offlineAwareDelete(id)); showToast(`${count} deleted`,"error"); window.clearSelection(); }
    });
};

// ---- SETTINGS ----
window.showSettings = () => {
    showModal({ title:'Settings', desc:'',
        customContent:`<div style="margin-bottom:15px;">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
                <div><div style="color:white;font-size:0.85rem;font-weight:500;">Passcode Lock</div><div style="color:#555;font-size:0.7rem;">Require on app open</div></div>
                <label style="position:relative;width:44px;height:24px;cursor:pointer;">
                    <input type="checkbox" id="settPassEnabled" ${passcodeEnabled?'checked':''} style="opacity:0;width:0;height:0;" onchange="window.togglePasscodeEnabled(this.checked)">
                    <span style="position:absolute;inset:0;background:${passcodeEnabled?'var(--neon)':'#333'};border-radius:12px;transition:0.3s;"></span>
                    <span style="position:absolute;top:3px;left:${passcodeEnabled?'23px':'3px'};width:18px;height:18px;background:${passcodeEnabled?'#000':'#666'};border-radius:50%;transition:0.3s;"></span>
                </label>
            </div>
            <div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;" onclick="window.changePasscode()">
                <div style="color:white;font-size:0.85rem;font-weight:500;">Change Passcode</div>
                <div style="color:#555;font-size:0.7rem;">Update 4-digit code</div>
            </div>
            <div style="padding:10px 0;">
                <div style="color:white;font-size:0.85rem;font-weight:500;">Version</div>
                <div style="color:var(--neon);font-size:0.7rem;font-family:'JetBrains Mono';">CSM DRIVE Ultra Pro PWA v4.0</div>
            </div>
        </div>`,
        confirmText:'Close', hideCancel:true, onConfirm:()=>{}
    });
};
window.togglePasscodeEnabled = async (enabled) => {
    passcodeEnabled=enabled;
    const data={passcode:appPasscode,passcodeEnabled};
    await idbPut(STORE_SETTINGS,{key:'passcodeEnabled',value:enabled});
    if(navigator.onLine) await fbSet(SETTINGS_PATH,data);
    showToast(enabled?"Passcode enabled":"Passcode disabled","info");
};
window.changePasscode = () => {
    closeModal();
    showModal({ title:'Change Passcode', desc:'Enter new 4-digit code.', inputPlaceholder:'4-digit passcode', inputType:'password', confirmText:'Update',
        onConfirm: async (val)=>{
            if(val&&val.length===4&&/^\d{4}$/.test(val)) {
                appPasscode=val;
                await idbPut(STORE_SETTINGS,{key:'passcode',value:val});
                if(navigator.onLine) await fbSet(SETTINGS_PATH,{passcode:val,passcodeEnabled});
                showToast("Passcode updated","success");
            } else showToast("Use 4 digits","error");
        }
    });
};

// ---- UPLOAD (Online + Offline Queue) ----
window.toggleUpload = () => {
    const box=document.getElementById('uploadBox');
    box.classList.toggle('active');
    if(!box.classList.contains('active')) resetUploadUI();
};

function resetUploadUI() {
    pendingUploadFiles=[]; uploadInProgress=false;
    document.getElementById('fileInput').value='';
    document.getElementById('customName').value='';
    document.getElementById('uploadQueue').innerHTML='';
    document.getElementById('selectedFilesPreview').classList.add('hidden');
    document.getElementById('neonProgressSection').classList.add('hidden');
    document.getElementById('uploadStartBtnWrap').classList.add('hidden');
    document.getElementById('neonProgressFill').style.width='0%';
    document.getElementById('neonProgressFill').classList.remove('complete');
}

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover',(e)=>{ e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave',()=>uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop',(e)=>{ e.preventDefault(); uploadZone.classList.remove('dragover'); if(e.dataTransfer.files.length) stageFiles(e.dataTransfer.files); });
document.getElementById('fileInput').onchange=(e)=>{ if(e.target.files.length) stageFiles(e.target.files); };

function stageFiles(fileList) {
    pendingUploadFiles=Array.from(fileList);
    const preview=document.getElementById('selectedFilesPreview');
    const queue=document.getElementById('uploadQueue');
    const startWrap=document.getElementById('uploadStartBtnWrap');
    const count=pendingUploadFiles.length;
    const totalSize=pendingUploadFiles.reduce((s,f)=>s+f.size,0);
    const totalSizeMB=(totalSize/(1024*1024)).toFixed(2);
    preview.classList.remove('hidden');
    preview.innerHTML=`<div class="selected-files-preview"><div class="selected-files-text">
        <i class="fas fa-paperclip"></i>
        <strong>${count} file${count>1?'s':''}</strong> (${totalSizeMB} MB)
        <span style="margin-left:auto;cursor:pointer;color:var(--danger);" onclick="window.clearStagedFiles()" title="Clear"><i class="fas fa-xmark"></i></span>
    </div></div>`;
    queue.innerHTML='';
    pendingUploadFiles.forEach((file,idx)=>{
        const sizeMB=(file.size/(1024*1024)).toFixed(1);
        const isVid=isVideoFile(file.name);
        queue.innerHTML+=`<div class="upload-queue-item" id="uqi-${idx}">
            <div class="uq-icon"><i class="fas fa-${isVid?'video':'image'}" style="color:${isVid?'var(--neon3)':'var(--neon)'};"></i></div>
            <div style="flex:1;min-width:0;">
                <div class="uq-name" title="${file.name}">${file.name}</div>
                <div class="uq-progress-bar"><div class="uq-progress-fill" id="uqp-${idx}"></div></div>
                <div class="upload-speed-info"><span id="uq-size-${idx}">${sizeMB} MB</span><span id="uq-speed-${idx}"></span></div>
            </div>
            <div class="uq-pct" id="uq-pct-${idx}">—</div>
            <div class="uq-status-icon queued" id="uqs-${idx}"><i class="fas fa-clock"></i></div>
        </div>`;
    });
    startWrap.classList.remove('hidden');
    document.getElementById('uploadStartBtn').disabled=false;
    document.getElementById('uploadStartBtn').innerHTML=`<i class="fas fa-cloud-arrow-up"></i>&nbsp; Upload ${count} File${count>1?'s':''}`;
    if(!navigator.onLine) {
        document.getElementById('uploadStartBtn').innerHTML=`<i class="fas fa-clock"></i>&nbsp; Queue ${count} File${count>1?'s':''} (Offline)`;
    }
}

function isVideoFile(name) {
    return ['mp4','mov','avi','mkv','webm'].includes(name.split('.').pop().toLowerCase());
}
window.clearStagedFiles = () => resetUploadUI();

window.startUpload = async () => {
    if(uploadInProgress||pendingUploadFiles.length===0) return;
    if(!navigator.onLine) { await queueFilesOffline(); return; }
    uploadInProgress=true;
    const files=pendingUploadFiles;
    const folder=document.getElementById('uploadFolder').value;
    const isLocked=document.getElementById('uploadLocked').checked;
    const customName=document.getElementById('customName').value.trim();
    const neonSection=document.getElementById('neonProgressSection');
    neonSection.classList.remove('hidden');
    document.getElementById('uploadStartBtnWrap').classList.add('hidden');
    let completed=0, totalBytesAll=files.reduce((s,f)=>s+f.size,0), uploadedBytesAll=0, uploadStartTime=Date.now();

    function updateOverallNeon() {
        const pct=total>0?Math.round((completed/total)*100):0;
        const fill=document.getElementById('neonProgressFill');
        fill.style.width=pct+'%';
        if(completed===total){ fill.classList.add('complete'); document.getElementById('neonProgressTitle').textContent='COMPLETE'; document.getElementById('neonProgressPct').textContent='100%'; document.getElementById('neonProgressSub').textContent=`All ${total} files uploaded!`; document.getElementById('neonProgressFiles').textContent=`${total}/${total} files`; document.getElementById('neonProgressSpeed').textContent=''; document.getElementById('neonProgressEta').textContent='✓ Done'; }
        else { document.getElementById('neonProgressTitle').textContent='UPLOADING'; document.getElementById('neonProgressPct').textContent=pct+'%'; document.getElementById('neonProgressSub').textContent=`Processing file ${completed+1} of ${total}`; document.getElementById('neonProgressFiles').textContent=`${completed}/${total} files`; const el=(Date.now()-uploadStartTime)/1000; if(el>0&&uploadedBytesAll>0){const sp=uploadedBytesAll/el;const rem=totalBytesAll-uploadedBytesAll;document.getElementById('neonProgressSpeed').textContent=formatSpeed(sp);document.getElementById('neonProgressEta').textContent='ETA: '+formatTime(rem/sp);} }
    }

    const total=files.length;
    updateOverallNeon();

    function uploadFile(idx) {
        if(idx>=total){ showToast(`${total} file${total>1?'s':''} uploaded!`,"success"); setTimeout(()=>{ document.getElementById('uploadBox').classList.remove('active'); resetUploadUI(); },2000); return; }
        const file=files[idx];
        const ext=file.name.split('.').pop().toLowerCase();
        const cat=['mp4','mov','avi','mkv','webm'].includes(ext)?'video':'image';
        const size=(file.size/(1024*1024)).toFixed(2)+" MB";
        const displayName=(total===1&&customName)?customName:file.name;
        const itemEl=document.getElementById(`uqi-${idx}`);
        const statusEl=document.getElementById(`uqs-${idx}`);
        const pctEl=document.getElementById(`uq-pct-${idx}`);
        const progressEl=document.getElementById(`uqp-${idx}`);
        const speedEl=document.getElementById(`uq-speed-${idx}`);
        if(itemEl){itemEl.classList.add('active');itemEl.classList.remove('done','error');}
        if(statusEl){statusEl.className='uq-status-icon uploading';statusEl.innerHTML='<i class="fas fa-spinner fa-spin"></i>';}
        if(pctEl) pctEl.textContent='0%';
        const qc=document.getElementById('uploadQueue');
        if(itemEl&&qc) itemEl.scrollIntoView({behavior:'smooth',block:'nearest'});
        const form=new FormData(); form.append("file",file); form.append("upload_preset","github_unsigned");
        const fileStartTime=Date.now(); let lastLoaded=0;
        const xhr=new XMLHttpRequest();
        xhr.open("POST","https://api.cloudinary.com/v1_1/dx7aankx2/auto/upload");
        xhr.upload.onprogress=ev=>{
            if(ev.lengthComputable){
                const pc=Math.round((ev.loaded/ev.total)*100);
                if(progressEl)progressEl.style.width=pc+'%';
                if(pctEl)pctEl.textContent=pc+'%';
                const fe=(Date.now()-fileStartTime)/1000;
                if(fe>0.5&&speedEl)speedEl.textContent=formatSpeed(ev.loaded/fe);
                const delta=ev.loaded-lastLoaded; lastLoaded=ev.loaded; uploadedBytesAll+=delta;
                const realPct=Math.round((uploadedBytesAll/totalBytesAll)*100);
                const fillEl=document.getElementById('neonProgressFill');
                fillEl.style.width=Math.min(realPct,99)+'%';
                document.getElementById('neonProgressPct').textContent=Math.min(realPct,99)+'%';
                const te=(Date.now()-uploadStartTime)/1000;
                if(te>0.5){const sp=uploadedBytesAll/te;document.getElementById('neonProgressSpeed').textContent=formatSpeed(sp);document.getElementById('neonProgressEta').textContent='ETA: '+formatTime((totalBytesAll-uploadedBytesAll)/sp);}
            }
        };
        xhr.onload=async()=>{
            try {
                const res=JSON.parse(xhr.responseText);
                if(res.secure_url){
                    const record={url:res.secure_url,name:displayName,cat,size,time:Date.now(),trash:false,starred:false,locked:isLocked,folder:folder||null};
                    const newKey=await fbPush(DB_PATH,record);
                    record.id=newKey;
                    await idbPut(STORE_FILES,record);
                    if(statusEl){statusEl.className='uq-status-icon done';statusEl.innerHTML='<i class="fas fa-check"></i>';}
                    if(progressEl){progressEl.style.width='100%';progressEl.classList.add('complete');}
                    if(pctEl)pctEl.textContent='100%';
                    if(itemEl){itemEl.classList.remove('active');itemEl.classList.add('done');}
                } else markError(idx);
            } catch(err){markError(idx);}
            completed++; updateOverallNeon(); uploadFile(idx+1);
        };
        xhr.onerror=()=>{markError(idx);completed++;updateOverallNeon();uploadFile(idx+1);};
        xhr.send(form);
    }

    function markError(idx){
        const statusEl=document.getElementById(`uqs-${idx}`),pctEl=document.getElementById(`uq-pct-${idx}`),progressEl=document.getElementById(`uqp-${idx}`),itemEl=document.getElementById(`uqi-${idx}`);
        if(statusEl){statusEl.className='uq-status-icon error';statusEl.innerHTML='<i class="fas fa-xmark"></i>';}
        if(pctEl)pctEl.textContent='ERR';
        if(progressEl)progressEl.classList.add('error');
        if(itemEl){itemEl.classList.remove('active');itemEl.classList.add('error');}
    }

    uploadFile(0);
};

async function queueFilesOffline() {
    const files=pendingUploadFiles;
    const folder=document.getElementById('uploadFolder').value;
    const isLocked=document.getElementById('uploadLocked').checked;
    const customName=document.getElementById('customName').value.trim();
    let queued=0;
    for(let i=0;i<files.length;i++){
        const file=files[i];
        const ext=file.name.split('.').pop().toLowerCase();
        const cat=['mp4','mov','avi','mkv','webm'].includes(ext)?'video':'image';
        const size=(file.size/(1024*1024)).toFixed(2)+' MB';
        const displayName=(files.length===1&&customName)?customName:file.name;
        // Read as blob for storage
        const blob=await file.arrayBuffer().then(ab=>new Blob([ab],{type:file.type}));
        await idbPut(STORE_PENDING_UPLOADS,{
            name:displayName, cat, size, time:Date.now(), locked:isLocked,
            folder:folder||null, mimeType:file.type, blob
        });
        // Also show as pending in allFiles
        const tempId=`pending_${Date.now()}_${i}`;
        const tempRecord={id:tempId,name:displayName,cat,size,time:Date.now(),trash:false,starred:false,locked:isLocked,folder:folder||null,_pending:true};
        allFiles.push(tempRecord);
        const statusEl=document.getElementById(`uqs-${i}`);
        const pctEl=document.getElementById(`uq-pct-${i}`);
        if(statusEl){statusEl.className='uq-status-icon queued';statusEl.innerHTML='<i class="fas fa-clock"></i>';}
        if(pctEl)pctEl.textContent='Queued';
        queued++;
    }
    updateStats(); render();
    showToast(`${queued} file${queued>1?'s':''} queued for upload when online`,'warning');
    setTimeout(()=>{ document.getElementById('uploadBox').classList.remove('active'); resetUploadUI(); },2000);
}

function formatSpeed(bps){ if(bps>1024*1024)return(bps/(1024*1024)).toFixed(1)+' MB/s'; if(bps>1024)return(bps/1024).toFixed(0)+' KB/s'; return bps.toFixed(0)+' B/s'; }
function formatTime(s){ if(s<0||!isFinite(s))return '--'; if(s<60)return Math.ceil(s)+'s'; return `${Math.floor(s/60)}m ${Math.ceil(s%60)}s`; }

// ---- MODALS ----
function showModal(opts) {
    const container=document.getElementById('modalContainer');
    container.innerHTML=`<div class="modal-overlay" onclick="if(event.target===this)window.closeModal()">
        <div class="modal">
            ${opts.icon?`<div style="width:45px;height:45px;border-radius:12px;background:rgba(255,51,85,0.1);display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:var(--danger);font-size:1.1rem;"><i class="${opts.icon}"></i></div>`:''}
            <div class="modal-title">${opts.title||''}</div>
            <div class="modal-desc">${opts.desc||''}</div>
            ${opts.customContent||''}
            ${opts.inputPlaceholder!==undefined?`<input type="${opts.inputType||'text'}" class="modal-input" id="modalInput" placeholder="${opts.inputPlaceholder}" value="${opts.inputValue||''}" maxlength="${opts.inputType==='password'?4:100}" autofocus>`:''}
            ${opts.customActions?`<div class="modal-actions">${opts.customActions}</div>`:`<div class="modal-actions">
                ${opts.hideCancel?'':`<button class="modal-cancel" onclick="window.closeModal()">Cancel</button>`}
                <button class="modal-confirm ${opts.confirmClass||''}" onclick="window.confirmModal()">${opts.confirmText||'Confirm'}</button>
            </div>`}
        </div>
    </div>`;
    window._modalOnConfirm=opts.onConfirm;
    const input=document.getElementById('modalInput');
    if(input){ setTimeout(()=>input.focus(),100); input.addEventListener('keydown',(e)=>{if(e.key==='Enter')window.confirmModal();}); }
}
window.confirmModal=()=>{ const input=document.getElementById('modalInput'); const val=input?input.value:null; if(window._modalOnConfirm)window._modalOnConfirm(val); closeModal(); };
window.closeModal=()=>{ document.getElementById('modalContainer').innerHTML=''; window._modalOnConfirm=null; };
function closeModal(){window.closeModal();}

function showFolderPickerModal(title,callback) {
    const container=document.getElementById('modalContainer');
    let folderHTML=folders.map(f=>`<div class="folder-option" onclick="this.parentElement.querySelectorAll('.folder-option').forEach(x=>x.classList.remove('selected'));this.classList.add('selected');this.parentElement.dataset.selected='${f.id}'">
        <i class="fas fa-folder" style="color:${f.color||'var(--neon)'}"></i><span>${f.name}</span>
        <span style="margin-left:auto;font-size:0.65rem;color:#555;">${allFiles.filter(x=>x.folder===f.id&&!x.trash).length}</span>
    </div>`).join('');
    container.innerHTML=`<div class="modal-overlay" onclick="if(event.target===this)window.closeModal()">
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
    window._folderPickCallback=callback;
}
window.confirmFolderPick=()=>{ const list=document.getElementById('folderPickerList'); const sel=list?list.dataset.selected:''; if(sel&&window._folderPickCallback)window._folderPickCallback(sel); else{showToast("Select a folder","warning");return;} closeModal(); };

// ---- TOAST ----
function showToast(msg,type="success") {
    const t=document.getElementById('toast');
    const icons={success:'✓',error:'✕',warning:'⚠',info:'ℹ'};
    const colors={success:'linear-gradient(135deg,rgba(0,255,136,0.15),rgba(0,255,204,0.15))',error:'linear-gradient(135deg,rgba(255,51,85,0.15),rgba(255,100,100,0.15))',warning:'linear-gradient(135deg,rgba(255,170,0,0.15),rgba(255,200,50,0.15))',info:'linear-gradient(135deg,rgba(0,212,255,0.15),rgba(100,180,255,0.15))'};
    const textColors={success:'var(--success)',error:'var(--danger)',warning:'var(--warning)',info:'var(--neon2)'};
    const borderColors={success:'rgba(0,255,136,0.3)',error:'rgba(255,51,85,0.3)',warning:'rgba(255,170,0,0.3)',info:'rgba(0,212,255,0.3)'};
    t.innerHTML=`<span class="toast-icon">${icons[type]||'✓'}</span> ${msg}`;
    t.style.background=colors[type]||colors.success;
    t.style.color=textColors[type]||textColors.success;
    t.style.borderColor=borderColors[type]||borderColors.success;
    t.classList.add('active');
    setTimeout(()=>t.classList.remove('active'),3000);
}
// Expose for service worker use
window.showToast = showToast;

// ---- EVENT LISTENERS ----
document.addEventListener('click',(e)=>{ document.querySelectorAll('.dropdown').forEach(d=>d.classList.remove('active')); document.getElementById('contextMenu').classList.remove('active'); });
document.addEventListener('keydown',(e)=>{
    if(e.key==='Escape'){ closeModal(); window.closeInfoPanel(); document.getElementById('uploadBox').classList.remove('active'); document.getElementById('contextMenu').classList.remove('active'); if(selectMode)window.clearSelection(); }
    if(e.ctrlKey&&e.key==='a'&&selectMode){e.preventDefault();window.selectAllVisible();}
});
document.addEventListener('touchmove',(e)=>{ const uploadBox=document.getElementById('uploadBox'); const infoPanel=document.getElementById('infoPanel'); if((uploadBox.classList.contains('active')&&uploadBox.contains(e.target))||(infoPanel.classList.contains('active')&&infoPanel.contains(e.target))){} },{passive:true});
