const CACHE_NAME = 'halzyn-cache-v4';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Cacheia cada arquivo individualmente: se um faltar (ex.: icon.svg),
      // não derruba a instalação inteira do service worker.
      Promise.all(urlsToCache.map(url => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Só participamos do cache do app shell (mesma origem, GET). Downloads
  // grandes de terceiros (modelo do Llama, CDN do web-llm, etc.) passam
  // direto pela rede: eles já têm cache próprio (IndexedDB do WebLLM) e
  // não faz sentido duplicá-los aqui, o que só gastaria espaço e poderia
  // atrapalhar o carregamento do modelo.
  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(req))
  );
});
