// CSM DRIVE | ULTRA PRO - Service Worker v2
const CACHE_NAME = 'csm-drive-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  // Fancybox CSS + JS (both included)
  'https://cdn.jsdelivr.net/npm/@fancyapps/ui@5.0/dist/fancybox/fancybox.css',
  'https://cdn.jsdelivr.net/npm/@fancyapps/ui@5.0/dist/fancybox/fancybox.umd.js',
  // FontAwesome
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  // Google Fonts
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Orbitron:wght@400;500;700;900&family=JetBrains+Mono:wght@400;500&display=swap'
];

// ===== INSTALL: pre-cache all static assets =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Add each individually so one failure doesn't block others
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(e => console.warn('[SW] Failed to cache:', url, e)))
      );
    }).then(() => self.skipWaiting())
  );
});

// ===== ACTIVATE: remove old caches =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ===== FETCH: Cache-First, Network Fallback =====
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Let Firebase real-time DB, auth, and Cloudinary uploads go straight to network
  const url = request.url;
  if (
    url.includes('firebaseio.com') ||
    url.includes('googleapis.com/identitytoolkit') ||
    url.includes('securetoken.googleapis.com') ||
    (url.includes('cloudinary.com') && url.includes('/upload'))
  ) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(networkResp => {
        // Cache valid cors/basic responses
        if (networkResp && networkResp.status === 200 &&
           (networkResp.type === 'basic' || networkResp.type === 'cors')) {
          const clone = networkResp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return networkResp;
      }).catch(() => {
        // For navigation requests, serve cached shell
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        // For image requests serve nothing (graceful fail)
        return new Response('', { status: 408, statusText: 'Offline' });
      });
    })
  );
});

// ===== BACKGROUND SYNC =====
// Triggered by the browser when connectivity is restored after sync.register()
self.addEventListener('sync', event => {
  console.log('[SW] Sync event tag:', event.tag);
  if (event.tag === 'csm-sync-queue') {
    // Notify all open windows to process pending CRUD operations
    event.waitUntil(broadcastToClients({ type: 'PROCESS_SYNC_QUEUE' }));
  }
  if (event.tag === 'csm-upload-queue') {
    // Notify all open windows to process pending file uploads
    event.waitUntil(broadcastToClients({ type: 'PROCESS_UPLOAD_QUEUE' }));
  }
});

async function broadcastToClients(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  if (clients.length === 0) {
    console.warn('[SW] No clients to notify for sync');
    return;
  }
  clients.forEach(client => {
    client.postMessage(msg);
    console.log('[SW] Notified client:', client.id, msg.type);
  });
}
