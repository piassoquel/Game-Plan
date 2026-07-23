const CACHE_NAME = 'gameplan-v3.3.2-fix03a2-address';
const APP_SHELL = [
  "./","./index.html","./manifest.json",
  "./css/app.css?v=3.3.2-fix03a2",
  "./js/config.js?v=3.0.5-alpha2-3",
  "./js/app.js?v=3.3.2-fix03a2",
  "./js/api.js?v=3.3.0-fix03a",
  "./assets/logo/gameplan-logo.svg","./assets/icons/icon.svg"
];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key))
  )));
  self.clients.claim();
});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  const fresh=event.request.mode==="navigate"||
    ["document","script","style"].includes(event.request.destination);
  if(fresh){
    event.respondWith(
      fetch(event.request).then(response=>{
        const copy=response.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));
        return response;
      }).catch(()=>caches.match(event.request).then(cached=>cached||caches.match("./index.html")))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));
      return response;
    }))
  );
});
