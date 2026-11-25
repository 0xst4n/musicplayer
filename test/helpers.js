// Shared helpers for the test suite: throwaway servers, raw HTTP requests and generated songs.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A small WAV file with title/artist tags (RIFF LIST/INFO, read by music-metadata).
 * `tone` changes the audio bytes, so files with the same tags can still differ in content.
 */
// 1×1 PNG, used as embedded cover art.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** ID3v2.3 tag with album and a front-cover picture (APIC), stored in the WAV as an "id3 " chunk. */
function id3Tag({ album, cover }) {
  const frame = (id, data) => {
    const head = Buffer.alloc(10);
    head.write(id, 0, 'ascii');
    head.writeUInt32BE(data.length, 4);
    return Buffer.concat([head, data]);
  };
  const frames = [];
  if (album) frames.push(frame('TALB', Buffer.concat([Buffer.from([0]), Buffer.from(album, 'latin1')])));
  if (cover) frames.push(frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3, 0]), TINY_PNG])));
  const body = Buffer.concat(frames);
  const size = body.length;
  const syncsafe = Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe, body]);
}

export function makeWav({ title = '', artist = '', album = '', cover = false, seconds = 1, tone = 440 } = {}) {
  const rate = 8000;
  const samples = rate * seconds;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * tone * i) / rate) * 8000), i * 2);

  const sub = (id, text) => {
    const data = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.alloc(1)]); // null-terminated
    const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, pad]);
  };
  const info = Buffer.concat([Buffer.from('INFO'), title ? sub('INAM', title) : Buffer.alloc(0), artist ? sub('IART', artist) : Buffer.alloc(0)]);
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // mono
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const parts = [Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('LIST', info), chunk('data', pcm)];
  if (album || cover) parts.push(chunk('id3 ', id3Tag({ album, cover })));
  const body = Buffer.concat(parts);
  return Buffer.concat([chunk('RIFF', body)]);
}

/** Write songs into a music folder: { 'Album A/one.wav': { title, artist, tone } } */
export async function writeSongs(musicDir, songs) {
  for (const [rel, tags] of Object.entries(songs)) {
    const file = path.join(musicDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, makeWav(tags));
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Raw HTTP request with full control over headers (fetch won't let you set Host). */
export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Start Musicplayer on a free port with its own temporary music/data folders.
 * `prepare(dirs)` runs before start (put songs or old trash in place).
 */
export async function startServer({ password = '', env = {}, prepare } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'musicplayer-test-'));
  const musicDir = path.join(base, 'music');
  const dataDir = path.join(base, 'data');
  await fs.mkdir(musicDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  if (prepare) await prepare({ musicDir, dataDir });
  const port = await freePort();
  const childEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', MUSIC_DIR: musicDir, DATA_DIR: dataDir, MUSICPLAYER_AUTO_UPDATE: '0', ...env };
  delete childEnv.MUSICPLAYER_PASSWORD;
  delete childEnv.MUSICPLAYER_TRUST_PROXY;
  if (password) childEnv.MUSICPLAYER_PASSWORD = password;
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  for (let i = 0; ; i++) {
    try {
      await request(port, { path: '/api/ping', headers: { host: `127.0.0.1:${port}` } });
      break;
    } catch {
      if (i > 80 || child.exitCode !== null) throw new Error(`server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 125));
    }
  }

  const server = {
    port,
    musicDir,
    dataDir,
    cookie: '',
    get log() {
      return log;
    },
    /** Request as a same-origin browser would (correct Host, session cookie if logged in). */
    req(p, opts = {}) {
      const headers = { host: `127.0.0.1:${port}`, ...(server.cookie ? { cookie: server.cookie } : {}), ...opts.headers };
      let body = opts.body;
      if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        headers['content-type'] = 'application/json';
      }
      return request(port, { method: opts.method || 'GET', path: p, headers, body });
    },
    async login(pw = password) {
      const r = await server.req('/api/login', { method: 'POST', json: { password: pw } });
      const set = r.headers['set-cookie']?.[0];
      if (set) server.cookie = set.split(';')[0];
      return r;
    },
    /** Wait until the server has noticed file changes (scan + folder sync). */
    async settle(ms = 600) {
      await new Promise((r) => setTimeout(r, ms));
    },
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
  return server;
}

export const exists = (p) => fs.stat(p).then(() => true, () => false);
