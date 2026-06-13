<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

/* Firebase Config */
const firebaseConfig = {
    apiKey: "AIzaSyBtmUmV1KxQDB0jN9gUQnh-eYWKllMPav0",
    authDomain: "photos-58c8e.firebaseapp.com",
    projectId: "photos-58c8e",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* তোমার Worker URL */
const WORKER_URL = "https://small-pine-55ff.csm-mohasin.workers.dev"; 

let allFiles = [];

/* Auth */
onAuthStateChanged(auth, user => {
    if (user) {
        document.getElementById('loginSection').classList.add('hidden');
        document.getElementById('mainContent').classList.remove('hidden');
        loadPhotos();
    } else {
        document.getElementById('loginSection').classList.remove('hidden');
        document.getElementById('mainContent').classList.add('hidden');
    }
});

/* Load Photos from Firestore */
function loadPhotos() {
    const q = query(collection(db, "files"), orderBy('time', 'desc'));
    onSnapshot(q, (snap) => {
        allFiles = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
                         .filter(f => f.source === 'gphotos' || f.source === 'gdrive'); // শুধু Google Photos
        renderPhotos();
    });
}

/* Thumbnail & Full URL */
function getThumbnail(file) {
    if (file.thumbnail) return file.thumbnail;
    return `\( {WORKER_URL}/drive/ \){file.drive_id || file.photos_id}/thumb`;
}

async function getFileUrl(file) {
    if (file.drive_id) {
        const token = await auth.currentUser?.getIdToken();
        return `\( {WORKER_URL}/drive/ \){file.drive_id}?token=${encodeURIComponent(token)}`;
    }
    return file.cloudinary_url || '';
}

/* Render */
function renderPhotos() {
    const grid = document.getElementById('fileGrid');
    if (!grid) return;

    grid.innerHTML = allFiles.map(file => `
        <div class="card" onclick="openPhoto('${file.id}')">
            <img src="\( {getThumbnail(file)}" loading="lazy" alt=" \){file.name}">
            <div class="file-name">${file.name || 'Photo'}</div>
        </div>
    `).join('');
}

/* Open Photo */
window.openPhoto = async (id) => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;

    const url = await getFileUrl(file);
    const lb = document.createElement('div');
    lb.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.98);display:flex;align-items:center;justify-content:center;z-index:99999;`;
    lb.innerHTML = `<img src="${url}" style="max-width:98%;max-height:98%;object-fit:contain;">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
};

/* Login */
document.getElementById('doLogin').onclick = async () => {
    try {
        await signInWithEmailAndPassword(auth, 
            document.getElementById('loginEmail').value,
            document.getElementById('loginPass').value);
    } catch (e) {
        alert('Login Failed: ' + e.message);
    }
};
</script>
