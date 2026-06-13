<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyBtmUmV1KxQDB0jN9gUQnh-eYWKllMPav0",
    authDomain: "photos-58c8e.firebaseapp.com",
    projectId: "photos-58c8e",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const WORKER_URL = "https://small-pine-55ff.csm-mohasin.workers.dev"; // ← এটা ঠিক করো

let allFiles = [];

/* Login Section দেখানো */
onAuthStateChanged(auth, user => {
    if (user) {
        document.getElementById('loginSection').classList.add('hidden');
        document.getElementById('mainContent').classList.remove('hidden');
        loadFiles();
    } else {
        document.getElementById('loginSection').classList.remove('hidden');
        document.getElementById('mainContent').classList.add('hidden');
    }
});

/* Files লোড করা */
function loadFiles() {
    const q = query(collection(db, "files"), orderBy('time', 'desc'));
    onSnapshot(q, (snap) => {
        allFiles = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderFiles();
    }, error => {
        console.error("Firestore Error:", error);
        alert("Firestore Error: " + error.message);
    });
}

/* Thumbnail */
function getThumbnail(file) {
    if (file.thumbnail) return file.thumbnail;
    if (file.photos_id) return `https://photoslibrary.googleapis.com/v1/mediaItems/${file.photos_id}?key=AIzaSyBtmUmV1KxQDB0jN9gUQnh-eYWKllMPav0`;
    return "https://via.placeholder.com/300x300?text=Loading...";
}

/* Render */
function renderFiles() {
    const grid = document.getElementById('fileGrid');
    if (!grid) {
        console.error("fileGrid element not found!");
        return;
    }
    
    if (allFiles.length === 0) {
        grid.innerHTML = "<p style='color:white; text-align:center; padding:50px;'>No photos yet. Upload in Google Photos.</p>";
        return;
    }

    grid.innerHTML = allFiles
        .filter(f => !f.trash)
        .map(file => `
            <div class="card" onclick="openPhoto('${file.id}')">
                <img src="${getThumbnail(file)}" loading="lazy">
                <div class="file-name">${file.name || 'Photo'}</div>
            </div>
        `).join('');
}

window.openPhoto = (id) => {
    const file = allFiles.find(f => f.id === id);
    if (!file) return;
    alert("Photo: " + (file.name || "Untitled") + "\n\nID: " + id);
};

/* Login Button */
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
