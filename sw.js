/* ═══════════════════════════════════════════════════════════════
   Halzyn Service Worker v5
   
   ZONA 1 — APP SHELL (cache-first, precacheia no install)
     HTML, manifest, icon → sempre do cache, atualiza em bg
   
   ZONA 2 — BIBLIOTECA WebLLM + JS (stale-while-revalidate)
     esm.run, esm.sh, cdn.jsdelivr, unpkg → cacheia na 1ª visita,
     serve do cache offline, atualiza silenciosamente quando online
   
   ZONA 3 — MODELO MLC (bypass total)
     Blobs .wasm, .bin, huggingface, mlc.ai → passa direto pela rede.
     O WebLLM gerencia esses arquivos no próprio Cache API com chave
     "webllm/model/..." — não duplicamos aqui.
═══════════════════════════════════════════════════════════════ */

const VER          = 'halzyn-v5';
const CACHE_APP    = VER + '-app';
const CACHE_LIB    = VER + '-lib';

/* App shell — caminhos relativos à origem do SW */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
];

/* Domínios de biblioteca JS que devem ser cacheados */
const LIB_HOSTS = [
  'esm.run',
  'esm.sh',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdn.skypack.dev',
];

/* Domínios de modelo — NUNCA cachear aqui (WebLLM cuida) */
const MODEL_HOSTS = [
  'huggingface.co',
  'mlc.ai',
  'github.com',
  'raw.githubusercontent.com',
];

/* Extensões de blob de modelo — NUNCA cachear aqui */
const MODEL_EXTS = ['.wasm', '.bin', '.safetensors', '.gguf', '.mlc'];

function isModelRequest(url) {
  if (MODEL_HOSTS.some(h => url.hostname.includes(h))) return true;
  if (MODEL_EXTS.some(e => url.pathname.endsWith(e)))   return true;
  // WebLLM salva chunks como /mlc-chat-config.json, /tokenizer.model, etc.
  if (url.pathname.includes('/resolve/main/'))           return true;
  return false;
}

function isLibRequest(url) {
  return LIB_HOSTS.some(h => url.hostname.includes(h));
}

function isAppShell(url) {
  return url.origin === self.location.origin;
}

/* ── INSTALL: precacheia só o app shell ──────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_APP)
      .then(cache =>
        Promise.all(
          APP_SHELL.map(url =>
            cache.add(url).catch(err =>
              console.warn('[SW] Não foi possível cachear', url, err)
            )
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: limpa caches de versões antigas ───────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k !== CACHE_APP && k !== CACHE_LIB)
            // Preserva caches do WebLLM (começam com "webllm-" ou similares)
            .filter(k => !k.startsWith('webllm'))
            .map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ── FETCH: roteamento por zona ─────────────────────── */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT passam direto

  const url = new URL(req.url);

  /* ZONA 3: modelo — bypass total, nem intercepta */
  if (isModelRequest(url)) return;

  /* ZONA 2: bibliotecas JS — stale-while-revalidate */
  if (isLibRequest(url)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_LIB));
    return;
  }

  /* ZONA 1: app shell — cache-first com fallback de rede */
  if (isAppShell(url)) {
    event.respondWith(cacheFirstWithNetworkFallback(req, CACHE_APP));
    return;
  }

  /* Qualquer outra coisa: rede com fallback de cache */
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

/* ── ESTRATÉGIAS ─────────────────────────────────────── */

/**
 * Cache-first: serve do cache se existir, caso contrário busca na rede
 * e salva no cache para a próxima vez.
 */
async function cacheFirstWithNetworkFallback(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    // Offline e sem cache — retorna página offline mínima se for navegação
    if (req.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Stale-while-revalidate: serve do cache imediatamente (mesmo desatualizado),
 * atualiza o cache em background quando online.
 * Ideal para bibliotecas JS que raramente mudam de conteúdo.
 */
async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  const networkFetch = fetch(req).then(fresh => {
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  }).catch(() => null);

  /* Se tiver cache, devolve imediatamente e atualiza em bg */
  if (cached) {
    networkFetch; // dispara em background sem await
    return cached;
  }

  /* Sem cache: aguarda a rede */
  const fresh = await networkFetch;
  if (fresh) return fresh;

  return new Response('Biblioteca não disponível offline. Conecte-se à internet uma vez para cachear.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
