/* sw.js — offline support.
 * The app has no build step and no backend, so "works offline after first load" means caching the
 * shell here plus whatever Tesseract.js pulls from its CDN the first time you run OCR.
 * Only active when the page is served over http(s); file:// pages have no service workers.
 */
// v2: the app moved from index.html to app.html, so an installed shell has to be replaced rather than
// reused — the cache name is the only signal the browser gives an existing install.
// v3: the sync client joined the shell.
// v4: quick add (the natural-language timetable entry) joined the shell.
const VERSION = 'v4';
const SHELL = `attendance-shell-${VERSION}`;
const RUNTIME = `attendance-runtime-${VERSION}`;
const SHELL_FILES = [
  'app.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/manipal-calendar.js',
  'js/calc.js',
  'js/store.js',
  'js/github.js',
  'js/charts.js',
  'js/ocr.js',
  'js/magic.js',
  'js/sample-data.js',
  'js/ui.js',
  'js/panels.js',
  'js/app.js',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'tessdata.projectnaptha.com', 'cdnjs.cloudflare.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // OCR engine, its wasm and the language model: keep them for offline reruns.
  if (CDN_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit || network;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Local files: network first (so editing the app shows up immediately), cache as the offline
  // fallback. A personal app is edited more often than it is used without a network.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('app.html') : undefined))),
  );
});
