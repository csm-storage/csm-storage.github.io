// CSM DRIVE | ULTRA PRO — Service Worker v4
// Developer: Csm Mohasin Alam
const CACHE = 'csm-drive-v4';
const STATIC = [
    '/', '/index.html', '/style.css', '/script.js', '/lightbox.js', '/manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@300;400;500;600&family=Orbitron:wght@400;600;700;900&display=swap'
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(cache =>
            Promise.allSettled(STATIC.map(url => cache.add(url).catch(() => {})))
        ).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const { request: req } = e;
    if (req.method !== 'GET') return;
    if (req.url.includes('firebaseio.com')) return;
    if (req.url.includes('googleapis.com/identitytoolkit')) return;
    if (req.url.includes('securetoken.googleapis.com')) return;
    if (req.url.includes('cloudinary.com') && req.url.includes('/upload')) return;

    e.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(res => {
                if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(req, clone));
                }
                return res;
            }).catch(() => {
                if (req.mode === 'navigate') return caches.match('/index.html');
            });
        })
    );
});

self.addEventListener('sync', e => {
    if (e.tag === 'csm-sync-queue')   e.waitUntil(broadcast('PROCESS_SYNC_QUEUE'));
    if (e.tag === 'csm-upload-queue') e.waitUntil(broadcast('PROCESS_UPLOAD_QUEUE'));
});

async function broadcast(type) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach(c => c.postMessage({ type }));
}
