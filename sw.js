const CACHE="csm-final-v1";
self.addEventListener("fetch",e=>{
 e.respondWith(
  caches.match(e.request).then(r=>r||fetch(e.request).then(n=>{
   return caches.open(CACHE).then(c=>{
    c.put(e.request,n.clone());return n;
   });
  }))
 );
});
