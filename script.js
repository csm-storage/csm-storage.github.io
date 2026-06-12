/* ==========================================================================
   🎛️ CSM SYMBOL BAR & SHORTCUTS 
   [ ⌘ ] [ ⌥ ] [ ⇧ ] [ ⌕ ] [ ⚙️ ] [ 💾 ] [ 🔄 ] [ ⚡ ] [ 🪐 ] [ 🌐 ] [ 🛡️ ]
   ========================================================================== */

/* ---- Cloudflare Worker URL (Realtime Sync Engine) ---- */
const WORKER_URL = "https://csm-drive-proxy.csm-mohasin.workers.dev";[cite: 17]

/* ---- App State ---- */
let allFiles        = [];[cite: 13]
let folders         = [];[cite: 13]
let currentTab      = 'all';[cite: 13]
let currentFolder   = 'all';[cite: 13]
let searchText      = '';[cite: 13]
let sortMode        = 'newest';[cite: 13]
let viewMode        = 'grid';[cite: 13]
let selectMode      = 'false';[cite: 13]
let selectedIds     = new Set();[cite: 13]
let contextTarget   = null;[cite: 13]
let appPasscode     = '2242';[cite: 13]
let passcodeEnabled = true;[cite: 13]
let passcodeCallback= null;[cite: 13]
let passcodeInput   = '';[cite: 13]
let sessionUnlocked = false;[cite: 13]
let pendingUploadFiles = [];[cite: 13]
let uploadInProgress   = false;[cite: 13]

/* ==========================================================================
   ⚡ REALTIME AUTO-SYNC: FETCH FROM GOOGLE PHOTOS & CLOUDINARY
   ========================================================================== */
async function loadFilesRealtime() {
    showLoading(true);
    try {
        // ফায়ারবেস ছাড়াই ওর্কার থেকে সরাসরি রিয়েল-টাইমে গুগল ফটোজ এবং ক্লাউডিনারির ফাইল লিস্ট রিড করা হচ্ছে
        const response = await fetch(`${WORKER_URL}/api/media-sync`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) throw new Error('Failed to fetch realtime storage data');
        
        const data = await response.json();
        
        // টাস্ক কন্সোল লগ: ওর্কার থেকে আসা ডেটা টেস্ট করার জন্য
        console.log("⚡ CSM Realtime Data Received:", data); 
        
        // ১-৩ সেকেন্ডের মধ্যে এপিআই থেকে আসা ডেটা অ্যারেতে সেট হচ্ছে
        allFiles = data.files || [];
        folders = data.folders || [];

        // লোকাল অফলাইন ব্যাকআপ আপডেট করে রাখা হচ্ছে
        await saveToIndexedDB(allFiles, folders);

        // রিয়েল-টাইম ডেটা দিয়ে ইউআই রেন্ডার
        renderDashboard();
        updateStorageStats();

    } catch (error) {
        console.error("❌ Realtime Sync Failed: ", error);
        showToast("Sync failed. Checking local offline cache...");
        // অফলাইন সাপোর্ট: সিঙ্ক ফেইল করলে ইনডেক্সড-ডিবি থেকে ডেটা লোড হবে
        await loadFromIndexedDB();
    } finally {
        showLoading(false);
    }
}

/* ==========================================================================
   📦 INDEXEDDB & STORAGE MANAGEMENT (OFFLINE-FIRST fallback)
   ========================================================================== */
const IDB_NAME = 'csm_drive_db';[cite: 13]
const IDB_VERSION = 4;[cite: 13]
let idb = null;[cite: 13]

function openIDB() {[cite: 13]
    return new Promise((resolve, reject) => {[cite: 13]
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);[cite: 13]
        req.onupgradeneeded = e => {[cite: 13]
            const db = e.target.result;[cite: 13]
            if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });[cite: 13]
            if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });[cite: 13]
        };[cite: 13]
        req.onsuccess = e => { idb = e.target.result; resolve(idb); };[cite: 13]
        req.onerror = e => reject(e.target.error);[cite: 13]
    });[cite: 13]
}

async function saveToIndexedDB(files, foldersList) {
    if (!idb) await openIDB();
    return new Promise((resolve, reject) => {
        const tx = idb.transaction(['files', 'folders'], 'readwrite');
        const fileStore = tx.objectStore('files');
        const folderStore = tx.objectStore('folders');
        
        fileStore.clear();
        folderStore.clear();
        
        files.forEach(file => fileStore.put(file));
        foldersList.forEach(f => folderStore.put(f));
        
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function loadFromIndexedDB() {
    if (!idb) await openIDB();
    return new Promise((resolve) => {
        const tx = idb.transaction(['files', 'folders'], 'readonly');
        const fileStore = tx.objectStore('files');
        const folderStore = tx.objectStore('folders');
        
        const filesReq = fileStore.getAll();
        const foldersReq = folderStore.getAll();
        
        tx.oncomplete = () => {
            allFiles = filesReq.result || [];
            folders = foldersReq.result || [];
            renderDashboard();
            updateStorageStats();
            console.log("Loaded safely from IndexedDB fallback.");
        };
    });
}

/* ==========================================================================
   📊 STORAGE STATS CALCULATOR
   ========================================================================== */
function updateStorageStats() {
    let totalSize = allFiles.reduce((acc, file) => acc + (file.size || 0), 0);
    let totalMB = (totalSize / (1024 * 1024)).toFixed(1);
    
    const storageText = document.querySelector('.storage-info-text') || document.getElementById('storageStatus');
    const storageProgress = document.querySelector('.storage-progress-bar') || document.getElementById('storageProgress');
    
    if (storageText) {
        storageText.innerText = `${totalMB} MB / 1024 MB (${allFiles.length} Files)`;
    }
    if (storageProgress) {
        let percentage = Math.min((totalMB / 1024) * 1024, 100);
        storageProgress.style.width = `${percentage}%`;
    }
}

/* ==========================================================================
   🖥️ CYBERPUNK UI RENDER ENGINE
   ========================================================================== */
function renderDashboard() {
    const grid = document.getElementById('file-grid') || document.querySelector('.grid-container');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    // ফিল্টারিং লজিক (Tab & Search)
    let filteredFiles = allFiles.filter(file => {
        let matchTab = true;
        if (currentTab === 'images') matchTab = file.mimeType.startsWith('image/');
        if (currentTab === 'videos') matchTab = file.mimeType.startsWith('video/');
        if (currentTab === 'starred') matchTab = file.starred === true;
        if (currentTab === 'trash') matchTab = file.trashed === true;
        
        let matchSearch = file.name.toLowerCase().includes(searchText.toLowerCase());
        return matchTab && matchSearch;
    });

    // সোর্টিং লজিক
    if (sortMode === 'newest') filteredFiles.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (sortMode === 'oldest') filteredFiles.sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (filteredFiles.length === 0) {
        grid.innerHTML = `
            <div class="no-files-found" style="grid-column: 1/-1; text-align:center; padding: 40px;">
                <div class="ghost-icon" style="font-size: 48px; margin-bottom:10px;">👻</div>
                <p style="color: var(--neon); font-family: monospace;">No Files Found</p>
                <small style="color: #666;">Upload files or adjust your filter</small>
            </div>`;
        return;
    }

    filteredFiles.forEach(file => {
        const card = document.createElement('div');
        card.className = `file-card ${viewMode === 'list' ? 'list-view' : ''}`;
        card.setAttribute('data-id', file.id);
        
        // গুগল ফটোজ/ক্লাউডিনারি প্রক্সি থাম্বনেইল ইউআরএল জেনারেট
        const thumbUrl = file.thumbnailUrl || `${WORKER_URL}/api/stream?id=${file.id}&thumb=true`;

        card.innerHTML = `
            <div class="file-preview">
                ${file.mimeType.startsWith('image/') 
                    ? `<img src="${thumbUrl}" alt="${file.name}" loading="lazy">` 
                    : `<div class="video-icon-placeholder">📹</div>`
                }
            </div>
            <div class="file-info">
                <span class="file-name">${file.name}</span>
                <span class="file-size">${(file.size / (1024 * 1024)).toFixed(2)} MB</span>
            </div>
        `;
        
        // ক্লিক করলে Nexus Lightbox v3.0 ওপেন হবে
        card.addEventListener('click', () => {
            if (typeof openLightbox === 'function') {
                openLightbox(file);
            } else {
                window.open(`${WORKER_URL}/api/stream?id=${file.id}`, '_blank');
            }
        });

        grid.appendChild(card);
    });
}

/* ==========================================================================
   🌐 UI AUXILIARY CONTROLS (Toasts & Loaders)
   ========================================================================== */
function showLoading(show) {
    const loader = document.getElementById('loading-indicator') || document.getElementById('loader');
    if (loader) loader.style.display = show ? 'block' : 'none';
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'csm-cyber-toast';
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

/* ==========================================================================
   🔄 APP INITIALIZATION
   ========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
    // ট্যাব ফিল্টার অ্যাক্টিভেশন লজিক
    document.querySelectorAll('.tab-btn, .filter-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
            currentTab = e.target.getAttribute('data-tab') || 'all';
            renderDashboard();
        });
    });

    // সার্চ বার বাইন্ডিং
    const searchInput = document.getElementById('search-files') || document.querySelector('.search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchText = e.target.value;
            renderDashboard();
        });
    }

    // অ্যাপ রেডি হওয়া মাত্রই ব্যাকএন্ড ওর্কার থেকে সরাসরি রিয়েল-টাইম সিঙ্ক রান হবে
    openIDB().then(() => {
        loadFilesRealtime();
    });
});
