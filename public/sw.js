// Musicplayer service worker: offline app shell, cached library data, and downloaded audio.
const SHELL = 'mp-shell-v4';
const DATA = 'mp-data-v1';
const AUDIO = 'mp-audio-v1'; // filled by the page when you download a playlist
const COVERS = 'mp-covers-v1';
const SHELL_FILES = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/fonts/figtree-latin-wght-normal.woff2', '/fonts/figtree-latin-ext-wght-normal.woff2'];

// Only real, signed-in copies of app files go into the offline cache. A login redirect or a
// failed file is skipped instead of breaking the whole install (cache.addAll is all-or-nothing).
// Complete responses only: a 206 (part of a file, for seeking) can't be cached and would fail.
const cacheable = (res) => res && res.status === 200 && !res.redirected && res.type === 'basic';

async function precacheShell() {
  const cache = await caches.open(SHELL);
  await Promise.all(
    SHELL_FILES.map(async (path) => {
      try {
        const res = await fetch(path, { cache: 'reload', credentials: 'same-origin', redirect: 'follow' });
        if (cacheable(res)) await cache.put(path, res);
      } catch {
        // offline or server unreachable: keep whatever is cached
      }
    }),
  );
}

self.addEventListener('install', (e) => {
  e.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

// Library and playlists, so the app can show them offline. Needed on the very first visit:
// the page loads this data before the service worker controls it, so it would not be cached.
async function precacheData() {
  const cache = await caches.open(DATA);
  await Promise.all(
    ['/api/library', '/api/playlists'].map(async (path) => {
      try {
        const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
        if (cacheable(res)) await cache.put(path, res);
      } catch {
        // offline: keep the previous copy
      }
    }),
  );
}

// The page asks for this after it has loaded while signed in, so the cache always holds the app
// itself and the latest library/playlists.
self.addEventListener('message', (e) => {
  if (e.data === 'refresh-shell') e.waitUntil(Promise.all([precacheShell(), precacheData()]));
});

/** Safari refuses to open a page from a cached response that went through a redirect. */
async function clean(res) {
  if (!res || !res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('activate', (e) => {
  const keep = [SHELL, DATA, AUDIO, COVERS];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname === '/api/stream') return e.respondWith(audio(req));
  if (url.pathname.startsWith('/covers/')) return e.respondWith(cacheFirst(req, COVERS));
  if (url.pathname === '/api/library' || url.pathname === '/api/playlists') {
    // The page asks for fresh data with cache: 'no-store' (live updates, reconnect); otherwise
    // answer instantly from the cache and refresh in the background.
    if (req.cache === 'no-store' || req.cache === 'reload') return e.respondWith(networkFirst(req, DATA, 5000, true));
    return e.respondWith(staleWhileRevalidate(e, req, DATA, true));
  }
  if (url.pathname.startsWith('/api/')) return; // live endpoints: network only
  if (url.pathname.startsWith('/rest/')) return; // Subsonic API for apps: never cached (credentials are in the URL)
  // The app itself opens instantly from the cache; a new version is fetched in the background
  // and used on the next launch. Other pages (e.g. /login) stay network-first.
  if (req.mode === 'navigate' && url.pathname !== '/') return e.respondWith(networkFirst(req, SHELL, 3000, false));
  e.respondWith(staleWhileRevalidate(e, req, SHELL, false));
});

/**
 * Answer from the cache right away (no waiting for a slow or unreachable server) and update
 * the cache in the background. With notify, tell open pages when the data actually changed.
 */
async function staleWhileRevalidate(e, req, name, notify) {
  const cache = await caches.open(name);
  const nav = req.mode === 'navigate';
  const cached = await clean((await cache.match(req, { ignoreSearch: nav })) || (nav ? await cache.match('/index.html') : null));
  const network = fetch(req).then(async (res) => {
    if (!cacheable(res)) return res;
    if (notify && cached) {
      const [fresh, old] = await Promise.all([res.clone().text(), cached.clone().text()]);
      await cache.put(req, res.clone());
      if (fresh !== old) for (const client of await self.clients.matchAll()) client.postMessage('data-updated');
    } else {
      await cache.put(req, res.clone());
    }
    return res;
  });
  if (cached) {
    e.waitUntil(network.catch(() => {}));
    return cached;
  }
  return network;
}

/** Downloaded tracks are served from the cache, with Range support (iOS Safari requires 206 responses). */
async function audio(req) {
  const cache = await caches.open(AUDIO);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (!hit) return fetch(req);
  const blob = await hit.blob();
  const type = hit.headers.get('Content-Type') || 'audio/mpeg';
  const size = blob.size;
  const range = req.headers.get('Range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m || (!m[1] && !m[2])) {
    return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  let start;
  let end;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, name, timeoutMs, markOffline) {
  const cache = await caches.open(name);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (cacheable(res)) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const nav = req.mode === 'navigate';
    const hit = await clean(
      (await cache.match(req, { ignoreSearch: nav })) ||
      (nav && ((await cache.match('/')) || (await cache.match('/index.html')))),
    );
    if (!hit) throw err;
    if (!markOffline) return hit;
    const headers = new Headers(hit.headers);
    headers.set('X-Musicplayer-Offline', '1');
    return new Response(await hit.blob(), { status: 200, headers });
  }
}
