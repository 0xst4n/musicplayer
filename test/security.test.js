// Security behaviour of a running server: sign-in, rate limit, DNS rebinding, CSRF, headers, paths.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, writeSongs } from './helpers.js';

describe('without a password (local mode)', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  test('answers on localhost and IP addresses', async () => {
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`, `192.168.1.50:${s.port}`]) {
      const r = await s.req('/api/library', { headers: { host } });
      assert.equal(r.status, 200, host);
    }
  });

  test('refuses other host names (DNS rebinding)', async () => {
    const host = `rebind.attacker.example:${s.port}`;
    assert.equal((await s.req('/api/library', { headers: { host } })).status, 403);
    const r = await s.req('/api/playlists', { method: 'POST', json: { name: 'x' }, headers: { host, origin: `http://${host}` } });
    assert.equal(r.status, 403, 'rebound page posting same-origin');
  });

  test('blocks cross-site writes (CSRF)', async () => {
    const r = await s.req('/api/playlists', { method: 'POST', json: { name: 'x' }, headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    const plain = await s.req('/api/playlists', { method: 'POST', body: '{"name":"x"}', headers: { 'content-type': 'text/plain' } });
    assert.equal(plain.status, 415, 'non-JSON body (would avoid the CORS preflight)');
  });

  test('sends security headers', async () => {
    const r = await s.req('/');
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['strict-transport-security'], undefined, 'no HSTS on plain HTTP');
    const https = await s.req('/', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(https.headers['strict-transport-security'], /max-age=/);
  });

  test('has no inline scripts (they would break under the CSP)', async () => {
    const page = await s.req('/');
    assert.doesNotMatch(page.text, /<script>(?!<\/script>)/);
  });
});

describe('with a password', () => {
  let s;
  before(async () => {
    s = await startServer({
      password: 'right-password',
      prepare: ({ musicDir }) => writeSongs(musicDir, { 'Album/one.wav': { title: 'One', artist: 'Band' } }),
    });
  });
  after(() => s.stop());

  test('requires sign-in, but serves the public files', async () => {
    assert.equal((await s.req('/api/library')).status, 401);
    const page = await s.req('/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/login');
    for (const p of ['/login', '/login.js', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png']) {
      assert.equal((await s.req(p)).status, 200, p);
    }
  });

  test('login sets an HttpOnly session cookie; the wrong password does not', async () => {
    const wrong = await s.login('nope');
    assert.equal(wrong.status, 401);
    const ok = await s.login('right-password');
    assert.equal(ok.status, 200);
    assert.match(ok.headers['set-cookie'][0], /HttpOnly/);
    assert.match(ok.headers['set-cookie'][0], /SameSite=Lax/);
    assert.equal((await s.req('/api/library')).status, 200);
  });

  test('a forged or tampered session cookie is rejected', async () => {
    const forged = await s.req('/api/library', { headers: { cookie: 'mp_session=9999999999999.AAAA' } });
    assert.equal(forged.status, 401);
  });

  test('rate limit cannot be bypassed with X-Forwarded-For (no proxy configured)', async () => {
    const codes = [];
    for (let i = 1; i <= 7; i++) {
      const r = await s.req('/api/login', { method: 'POST', json: { password: 'wrong' }, headers: { cookie: '', 'x-forwarded-for': `10.0.0.${i}` } });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), `expected a 429 in ${codes}`);
  });

  test('cannot read files outside the music and public folders', async () => {
    for (const id of ['../data/secret.key', '../../etc/passwd', 'Album/../../data/playlists.json']) {
      const r = await s.req(`/api/stream?id=${encodeURIComponent(id)}`);
      assert.equal(r.status, 404, id);
    }
    for (const p of ['/..%2Fserver%2Findex.js', '/%2e%2e/package.json', '/covers/..%2F..%2Fdata%2Fsecret.key']) {
      const r = await s.req(p);
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(r.text, /import |"dependencies"/, p);
    }
  });
});

describe('behind a proxy (MUSICPLAYER_TRUST_PROXY=1)', () => {
  let s;
  before(async () => {
    s = await startServer({ password: 'pw', env: { MUSICPLAYER_TRUST_PROXY: '1' } });
  });
  after(() => s.stop());

  test('limits per client address reported by the proxy', async () => {
    const attempt = (ip) => s.req('/api/login', { method: 'POST', json: { password: 'x' }, headers: { 'x-forwarded-for': ip } });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt('203.0.113.7')).status);
    assert.equal(codes[5], 429, 'the same client is limited');
    assert.equal((await attempt('203.0.113.8')).status, 401, 'another client is not');
  });
});
