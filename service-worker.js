const CACHE_NAME = 'gameplan-v3-alpha4-screen5';
const APP_SHELL = [
  "./","./index.html","./manifest.json",
  "./css/app.css?v=3.0.7-alpha3-1","./js/config.js?v=3.0.7-alpha3-1",
  "./js/app.js?v=3.0.7-alpha3-1","./js/api.js?v=3.0.7-alpha3-1",
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