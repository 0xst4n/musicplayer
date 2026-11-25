import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Library, AUDIO_MIME, isAudio, dirInside } from './library.js';
import { Playlists } from './playlists.js';
import { Importer, toolVersion, safeName } from './importer.js';
import { FolderSync } from './folders.js';
import { Auth, LOGIN_PAGE } from './auth.js';
import { ToolUpdater } from './updater.js';
import { Trash } from './trash.js';
import { sameSong } from './titles.js';
import { Subsonic } from './subsonic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig();
const PORT = Number(process.env.PORT || config.port || 4321);
const HOST = process.env.HOST || config.host || '127.0.0.1';
const MUSIC_DIR = path.resolve(ROOT, process.env.MUSIC_DIR || config.musicDir || 'music');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TRANSCODE_DIR = path.join(DATA_DIR, 'transcoded');
const PASSWORD = process.env.MUSICPLAYER_PASSWORD || config.password || '';
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB per file
// Extra host names allowed without a password (besides localhost and IP addresses).
const ALLOWED_HOSTS = new Set(
  [...String(process.env.MUSICPLAYER_ALLOWED_HOSTS || '').split(','), ...[].concat(config.allowedHosts ?? [])]
    .map((h) => String(h).trim().toLowerCase())
    .filter(Boolean),
);
const TRUST_PROXY = process.env.MUSICPLAYER_TRUST_PROXY === '1' || config.trustProxy === true;

// Reachable from other machines without a password = anyone on that network can use it.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
if (!LOOPBACK.includes(HOST) && !PASSWORD && process.env.MUSICPLAYER_ALLOW_NO_PASSWORD !== '1') {
  console.error(`Refusing to listen on ${HOST} without a password. Set MUSICPLAYER_PASSWORD (or MUSICPLAYER_ALLOW_NO_PASSWORD=1 on a private network).`);
  process.exit(1);
}

async function loadConfig() {
  try {
    return JSON.parse(await fsp.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
const pending = new Set();
let flushTimer = null;
function broadcast(type) {
  pending.add(type);
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    for (const t of pending) for (const res of clients) res.write(`event: ${t}\ndata: {}\n\n`);
    pending.clear();
  }, 150);
}
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

await fsp.mkdir(DATA_DIR, { recursive: true });
// In Docker HOME points into /data so spotDL/yt-dlp settings and caches persist.
if (process.env.HOME?.startsWith(DATA_DIR)) await fsp.mkdir(process.env.HOME, { recursive: true });
await fsp.mkdir(TRANSCODE_DIR, { recursive: true });
const playlists = new Playlists({ dataDir: DATA_DIR, onChange: () => broadcast('playlists') });
let folders = null;
const library = new Library({
  musicDir: MUSIC_DIR,
  dataDir: DATA_DIR,
  onChange: () => broadcast('library'),
  onScanned: () => folders?.sync(), // every folder with songs becomes a playlist
});
folders = new FolderSync({ library, playlists, musicDir: MUSIC_DIR });
const importer = new Importer({ rootDir: ROOT, dataDir: DATA_DIR, library, playlists, folders, onChange: () => broadcast('jobs') });
const auth = new Auth({ dataDir: DATA_DIR, password: PASSWORD, trustProxy: TRUST_PROXY });
const updater = new ToolUpdater({ rootDir: ROOT, importer, onChange: () => broadcast('jobs') });
const trash = new Trash({ dataDir: DATA_DIR, musicDir: MUSIC_DIR });
const subsonic = new Subsonic({
  library,
  playlists,
  auth,
  transcode: (full) => transcode(full),
  sendFile: (...args) => sendFile(...args),
  audioMime: AUDIO_MIME,
  coversDir: path.join(DATA_DIR, 'covers'),
});
await auth.init();
await playlists.init();

await importer.init();
console.log(`Scanning ${MUSIC_DIR} ...`);
await library.init();
console.log(`Found ${library.tracks.size} tracks.`);

// Rescan when files are added/removed in the music folder (e.g. copied in via Explorer).
let watchTimer = null;
try {
  fs.watch(MUSIC_DIR, { recursive: true }, () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => library.scan(), 2000);
  });
} catch {
  console.warn('File watching unavailable; use the rescan button after adding music.');
}

// ---------- on-demand AAC transcoding for files the browser can't play (e.g. Ogg Opus on older iOS) ----------
const transcoding = new Map();
async function transcode(full) {
  const st = await fsp.stat(full);
  const key = crypto.createHash('sha1').update(`${full}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 24);
  const out = path.join(TRANSCODE_DIR, key + '.m4a');
  if (fs.existsSync(out)) return out;
  if (transcoding.has(key)) return transcoding.get(key);
  const tmp = path.join(TRANSCODE_DIR, key + '.part.m4a');
  const job = new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-v', 'error', '-i', full, '-vn', '-map_metadata', '0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', async (code) => {
      if (code !== 0) return reject(new Error(err.trim() || 'ffmpeg failed'));
      await fsp.rename(tmp, out);
      resolve(out);
    });
  }).finally(() => transcoding.delete(key));
  transcoding.set(key, job);
  return job;
}

// ---------- helpers ----------
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function sendFile(req, res, file, type, cacheControl) {
  let st;
  try {
    st = await fsp.stat(file);
    if (!st.isFile()) throw new Error();
  } catch {
    return json(res, 404, { error: 'Not found' });
  }
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
    } else {
      start = Math.max(0, st.size - Number(m[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

/** Store an uploaded song in the playlist's folder (creating Uploads/<playlist> if it has none). */
async function upload(req, res, playlistId, rawName) {
  const pl = playlists.get(playlistId);
  if (!pl) return json(res, 404, { error: 'No such playlist' });
  const name = path.basename(String(rawName || ''));
  if (!isAudio(name)) return json(res, 415, { error: `${name || 'File'} is not a supported audio file` });
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return json(res, 413, { error: 'File is larger than 1 GB' });

  let folder = pl.folder;
  if (typeof folder !== 'string') {
    folder = `Uploads/${safeName(pl.name)}`;
    await playlists.linkFolder(pl.id, folder);
  }
  const destDir = dirInside(MUSIC_DIR, folder);
  if (!destDir) return json(res, 400, { error: 'This playlist has an invalid folder' });
  await fsp.mkdir(destDir, { recursive: true });
  const ext = path.extname(name);
  const tmpDir = path.join(DATA_DIR, 'incoming');
  await fsp.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `upload-${crypto.randomUUID()}${ext}`);
  let size = 0;
  try {
    await pipeline(
      req,
      new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          cb(size > MAX_UPLOAD ? Object.assign(new Error('File is larger than 1 GB'), { status: 413 }) : null, chunk);
        },
      }),
      fs.createWriteStream(tmp),
    );
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  // The library as it was before this file arrived, to spot a song you already had.
  const before = library.list();
  const base = safeName(path.basename(name, ext));
  let dest = path.join(destDir, base + ext);
  for (let n = 2; ; n++) {
    const existing = await fsp.stat(dest).catch(() => null);
    if (!existing) {
      try {
        await fsp.rename(tmp, dest);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(tmp, dest);
        await fsp.rm(tmp, { force: true });
      }
      break;
    }
    if (existing.size === size) {
      await fsp.rm(tmp, { force: true }); // same file uploaded before
      break;
    }
    dest = path.join(destDir, `${base} (${n})${ext}`);
  }
  const id = path.relative(MUSIC_DIR, dest).split(path.sep).join('/');
  await library.scan();
  if (library.tracks.has(id)) await playlists.addTracks(pl.id, [id]);
  // Same song (title + main artist, read from the file's tags) already in the library as
  // another file? Then the app asks whether to keep both. Re-uploading the very same file
  // into the same folder doesn't count: that reuses the existing file.
  let duplicateOf = null;
  const track = library.tracks.get(id);
  if (track && !before.some((t) => t.id === id)) {
    const match = before.find((b) => sameSong(track, b));
    if (match) duplicateOf = { id: match.id, title: match.title, artist: match.artist };
  }
  return json(res, 201, { id, title: track?.title ?? null, duplicateOf });
}

/**
 * Without a password, only answer requests addressed to localhost, an IP address or an
 * explicitly allowed name. A DNS-rebinding attack always uses its own domain name, so a
 * malicious website can't reach the unprotected local instance through the browser.
 */
function hostAllowed(hostHeader) {
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return net.isIP(hostname) !== 0 || hostname === 'localhost' || ALLOWED_HOSTS.has(hostname);
}

/** Block cross-site requests (another website poking the API in your browser). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === req.headers['x-forwarded-host'];
  } catch {
    return false;
  }
}

// ---------- security headers (on every response) ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'", // no inline scripts anywhere
  "style-src 'self' 'unsafe-inline'", // inline style attributes are used for colours/layout
  "img-src 'self' data: blob: https://i.ytimg.com", // song-search thumbnails come from YouTube
  "media-src 'self' blob:", // blob: = offline playback straight from device storage
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Only over HTTPS (Caddy), never on the plain-HTTP local instance.
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ---------- routes ----------
async function handle(req, res) {
  securityHeaders(req, res);
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const method = req.method;

  if (!auth.enabled && !hostAllowed(req.headers.host || '')) {
    return json(res, 403, {
      error: 'Host not allowed. Without a password, open Musicplayer via localhost or an IP address, or add this name to MUSICPLAYER_ALLOWED_HOSTS.',
    });
  }

  if (p.startsWith('/api/') && method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    return json(res, 403, { error: 'Cross-origin request blocked' });
  }

  // ----- sign-in -----
  if (p === '/api/ping') return json(res, auth.isAuthed(req) ? 200 : 401, { ok: true });
  if (p === '/login' && method === 'GET') {
    if (!auth.enabled || auth.isAuthed(req)) return redirect(res, '/');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(LOGIN_PAGE);
  }
  if (p === '/api/login' && method === 'POST') {
    const [status, body, headers] = auth.login(req, (await readJson(req)).password);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    return res.end(JSON.stringify(body));
  }
  if (p === '/api/logout' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...auth.logout(req) });
    return res.end('{"ok":true}');
  }
  // Subsonic API for native apps (Amperfy, play:Sub, …): they send credentials with every request.
  if (p.startsWith('/rest/')) return subsonic.handle(req, res, url);

  const isPublic = p.startsWith('/icons/') || p.startsWith('/fonts/') || p.startsWith('/covers/') || p === '/manifest.webmanifest' || p === '/sw.js' || p === '/login.js';
  if (!isPublic && !auth.isAuthed(req)) {
    return p.startsWith('/api/') ? json(res, 401, { error: 'Sign in required' }) : redirect(res, '/login');
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/library' && method === 'GET') {
    return json(res, 200, { tracks: library.list(), scanning: !!library.scanning, musicDir: MUSIC_DIR, authEnabled: auth.enabled });
  }
  if (p === '/api/rescan' && method === 'POST') {
    library.scan();
    return json(res, 202, { ok: true });
  }

  if (p === '/api/stream' && (method === 'GET' || method === 'HEAD')) {
    const full = library.resolve(url.searchParams.get('id'));
    if (!full || !library.tracks.has(url.searchParams.get('id'))) return json(res, 404, { error: 'Unknown track' });
    if (url.searchParams.get('fmt') === 'aac') {
      try {
        return sendFile(req, res, await transcode(full), 'audio/mp4', 'private, max-age=31536000, immutable');
      } catch (err) {
        return json(res, 500, { error: 'Transcode failed: ' + err.message });
      }
    }
    const type = AUDIO_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    return sendFile(req, res, full, type, 'private, no-cache');
  }

  if (p.startsWith('/covers/') && method === 'GET') {
    const name = path.basename(p);
    if (!/^[a-f0-9]{20}\.(jpg|png|webp)$/.test(name)) return json(res, 404, { error: 'Not found' });
    return sendFile(req, res, path.join(DATA_DIR, 'covers', name), STATIC_TYPES[path.extname(name)], 'public, max-age=31536000, immutable');
  }

  // Playlists
  if (p === '/api/playlists') {
    if (method === 'GET') return json(res, 200, { playlists: playlists.list() });
    if (method === 'POST') {
      // Only user-settable fields; `folder` and `source` are set by the server itself.
      const { name, trackIds } = await readJson(req);
      return json(res, 201, await playlists.create({ name, trackIds }));
    }
  }
  let m;
  if ((m = p.match(/^\/api\/playlists\/([\w-]+)$/))) {
    if (method === 'PATCH') {
      const r = await playlists.update(m[1], await readJson(req));
      return r ? json(res, 200, r) : json(res, 404, { error: 'No such playlist' });
    }
    if (method === 'DELETE') return (await playlists.remove(m[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such playlist' });
  }
  if ((m = p.match(/^\/api\/playlists\/([\w-]+)\/tracks$/)) && method === 'POST') {
    const { trackIds } = await readJson(req);
    const r = await playlists.addTracks(m[1], trackIds);
    return r ? json(res, 200, r) : json(res, 404, { error: 'No such playlist' });
  }

  // Remove songs from a playlist. A song that is in no other playlist is also removed from the
  // music folder: moved to data/trash (kept 30 days), so a mistake can still be undone.
  if ((m = /^\/api\/playlists\/([\w-]+)\/remove$/.exec(p)) && method === 'POST') {
    const body = await readJson(req);
    const ids = [...new Set((Array.isArray(body.trackIds) ? body.trackIds : []).filter((x) => typeof x === 'string'))];
    if (!(await playlists.removeTracks(m[1], ids))) return json(res, 404, { error: 'No such playlist' });
    let trashed = 0;
    let kept = 0;
    for (const id of ids) {
      if (playlists.isUsed(id)) {
        kept++; // still in another playlist: keep the file
        continue;
      }
      const full = library.resolve(id);
      if (!full || !library.tracks.has(id)) continue;
      try {
        await trash.put(full);
        trashed++;
      } catch (err) {
        console.warn(`Could not move ${id} to the trash: ${err.message}`);
      }
    }
    if (trashed) await library.scan();
    return json(res, 200, { removed: ids.length, trashed, kept });
  }

  if ((m = /^\/api\/playlists\/([\w-]+)\/upload$/.exec(p)) && method === 'PUT') {
    return upload(req, res, m[1], url.searchParams.get('name'));
  }

  // Imports
  if (p === '/api/tools' && method === 'GET') {
    const [ytdlp, spotdl, ffmpeg] = await Promise.all([
      toolVersion(importer.ytdlp),
      toolVersion(importer.spotdl),
      toolVersion('ffmpeg', ['-version']),
    ]);
    return json(res, 200, { ytdlp, spotdl, ffmpeg, update: updater.status });
  }
  if (p === '/api/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) return json(res, 400, { error: 'Type something to search for.' });
    try {
      return json(res, 200, { results: await importer.search(q) });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }
  if (p === '/api/jobs' && method === 'GET') return json(res, 200, { jobs: importer.list() });
  if (p === '/api/import' && method === 'POST') {
    try {
      return json(res, 202, importer.add(await readJson(req)));
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }
  }
  if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/)) && method === 'POST') return json(res, 200, { ok: importer.cancel(m[1]) });
  if ((m = p.match(/^\/api\/jobs\/([\w-]+)$/)) && method === 'DELETE') return json(res, 200, { ok: importer.dismiss(m[1]) });

  if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

  // Static UI
  if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
  const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return sendFile(req, res, file, type, 'no-cache');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message });
    else res.end();
  });
});

updater.start();
trash.start();

server.listen(PORT, HOST, () => {
  console.log(`\nMusicplayer is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Music folder: ${MUSIC_DIR}\n`);
});
