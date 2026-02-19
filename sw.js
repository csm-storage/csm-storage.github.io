// CSM DRIVE | ULTRA PRO - Service Worker (Updated)
const CACHE_NAME = 'csm-drive-v1';

// লোকাল ফাইলসহ স্ট্যাটিক অ্যাসেট তালিকা
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/fancybox.css',     // লোকাল পাথ (আপনার আপলোড করা ফাইল)
  '/fancybox.umd.js',   // লোকাল পাথ (আপনার আপলোড করা ফাইল)
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Orbitron:wght@400;500;700;900&family=JetBrains+Mono:wght@400;500&display=swap'
];

// Install: সব ফাইল ক্যাশে সেভ করা
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

// Activate: পুরনো ক্যাশে ডিলিট করা
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: নেটওয়ার্ক না থাকলে ক্যাশে থেকে ফাইল দেওয়া
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // POST বা ফায়ারবেস/ক্লাউডিনারি রিকোয়েস্টগুলো বাদ দেওয়া
  if (request.method !== 'GET') return;
  if (url.hostname.includes('firebaseio.com') || (url.hostname.includes('googleapis.com') && url.pathname.includes('/identitytoolkit'))) return;
  if (url.hostname.includes('cloudinary.com') && url.pathname.includes('/upload')) return;
  if (url.hostname.includes('api.cloudinary.com')) return;

  // মিডিয়া ফাইলের জন্য Network-First এপ্রোচ (যাতে নতুন ফটো দেখা যায়)
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

  // অন্যান্য ফাইলের জন্য Cache-First এপ্রোচ
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
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// Background Sync হ্যান্ডল করা
self.addEventListener('sync', event => {
  if (event.tag === 'csm-sync-queue') {
    event.waitUntil(processSyncQueue());
  }
});

async function processSyncQueue() {
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'PROCESS_SYNC_QUEUE' }));
}
