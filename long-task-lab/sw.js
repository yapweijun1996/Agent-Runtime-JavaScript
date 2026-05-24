const CACHE_NAME = 'agrun-long-task-lab-shell-mpjyi0xj';
const SHELL_ASSETS = [
  '/',
  '/offline.html',
  '/robots.txt',
  '/llms.txt',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-icon-192.png',
  '/icons/maskable-icon-512.png',
  '/icons/icon.svg',
  '/icons/maskable-icon.svg',
];
// Injected at build time by inject-sw-precache Vite plugin — empty in dev
const PRECACHE_ASSETS = ["/assets/index-BK_LB2QR.css","/assets/react-vendor-auj285-g.js","/assets/ui-vendor-DTzWvfsn.js","/assets/runtime-vendor-CtiTHnAA.js","/assets/index-D6EvTgbT.js"];
const PRIVATE_PREFIXES = ['/openai-gateway'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([...SHELL_ASSETS, ...PRECACHE_ASSETS]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PRIVATE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put('/', response.clone());
    return response;
  } catch {
    return await caches.match(request) || await caches.match('/') || await caches.match('/offline.html');
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then(async (response) => {
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cached);
  return cached || await fetchPromise || new Response('', { status: 504, statusText: 'Offline' });
}
