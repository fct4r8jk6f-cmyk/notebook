/* =========================================================================
   My Notebook — the second file, and the only one.

   The app is still one file: index.html carries the markup, the styles, the
   fonts (base64), the icons (data URIs) and both brains. Nothing is fetched
   from anywhere. But a service worker cannot live inside the page it caches —
   the browser refuses to register one from a blob: or data: URL, so making the
   installed app open without a signal costs exactly one extra file, and this
   is it.

   index.html still works on its own. Registration is wrapped in a try/catch
   and skipped on file:// — email yourself the one file and it opens fine, just
   without the offline shell.

   Network-first, cache as the fallback: merging to main deploys through Pages,
   and a cache-first worker would serve yesterday's notebook to someone who is
   online. Fresh when there's a signal, cached when there isn't.
   ========================================================================= */

const CACHE = 'notebook-shell-v1';
const SHELL = ['./', './index.html'];

self.addEventListener('install', (e) => {
  /* take over as soon as this version is ready — a notebook shouldn't need
     two reloads to pick up a fix */
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  /* Only the page shell is ours. Everything else — notably the Anthropic API —
     goes straight to the network: a cached POST reply would be a stale sort. */
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.mode !== 'navigate' && !req.url.endsWith('.html') && !req.url.endsWith('/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
