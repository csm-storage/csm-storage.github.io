// CSM DRIVE | ULTRA PRO - Service Worker
const CACHE_NAME = 'csm-drive-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Orbitron:wght@400;500;700;900&family=JetBrains+Mono:wght@400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/@fancyapps/ui@5.0/dist/fancybox/fancybox.css',
  'https://cdn.jsdelivr.net/npm/@fancyapps/ui@5.0/dist/fancybox/fancybox.umd.js'
];

// Install: cache all static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: Cache-First with Network Fallthrough
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, Firebase, and Cloudinary requests (dynamic/API)
  if (request.method !== 'GET') return;
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('googleapis.com') && url.pathname.includes('/identitytoolkit')) return;
  if (url.hostname.includes('cloudinary.com') && url.pathname.includes('/upload')) return;
  if (url.hostname.includes('api.cloudinary.com')) return;

  // For Cloudinary media (images/videos) - Network First to ensure freshness but cache for offline
  if (url.hostname.includes('cloudinary.com') || url.hostname.includes('res.cloudinary.com')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-First for everything else
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Fallback for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// Background Sync for queued operations
self.addEventListener('sync', event => {
  if (event.tag === 'csm-sync-queue') {
    event.waitUntil(processSyncQueue());
  }
});

async function processSyncQueue() {
  // Notify all clients to process their sync queue
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'PROCESS_SYNC_QUEUE' }));
}

// Push notification support (future use)
self.addEventListener('push', event => {
  if (event.data) {
    const data = event.data.json();
    self.registration.showNotification(data.title || 'CSM DRIVE', {
      body: data.body || '',
      icon: '/manifest.json',
      badge: '/manifest.json'
    });
  }
});
