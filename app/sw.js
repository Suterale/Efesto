// Offline support for the installed app. Network first, so a new version shows up on the next launch; the cache
// is only the fallback when offline. Everything the editor needs is precached on install, the rest as it loads.
const CACHE = 'sdfcad-v1';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/themes.css',
  'js/main.js', 'js/sdf.js', 'js/text.js', 'js/mesher.js', 'js/stl.js', 'js/themes.js', 'js/preview.js',
  'js/simplify.js', 'js/ascii.js',
  'vendor/three.module.js', 'vendor/addons/OrbitControls.js', 'vendor/addons/TransformControls.js',
  'vendor/fonts/Inter.ttf', 'vendor/fonts/JetBrainsMono.ttf', 'vendor/fonts/Lora.ttf', 'vendor/fonts/Orbitron.ttf',
  'vendor/fonts/Rajdhani-Medium.ttf', 'vendor/fonts/Rajdhani-SemiBold.ttf', 'vendor/fonts/SpaceGrotesk.ttf',
  'vendor/fonts/VT323-Regular.ttf',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // The local server's project API (server.py) must always hit the network.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  }, () => caches.match(e.request, { ignoreSearch: true })
    .then(hit => hit || (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
