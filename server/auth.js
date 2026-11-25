import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const COOKIE = 'mp_session';
const MAX_AGE = 60 * 60 * 24 * 365; // 1 year: stay signed in on your phone

/**
 * Optional single-password login. Sessions are signed cookies; the signing key lives in
 * data/secret.key (survives restarts) and is mixed with the password, so changing the
 * password signs everyone out.
 */
export class Auth {
  constructor({ dataDir, password, trustProxy = false }) {
    this.password = password || '';
    // Only behind a reverse proxy (Caddy) is X-Forwarded-For set by someone we trust.
    this.trustProxy = trustProxy;
    this.keyFile = path.join(dataDir, 'secret.key');
    this.attempts = new Map();
  }

  get enabled() {
    return !!this.password;
  }

  async init() {
    if (!this.enabled) return;
    let secret;
    try {
      secret = (await fs.readFile(this.keyFile, 'utf8')).trim();
    } catch {
      secret = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(this.keyFile, secret, { mode: 0o600 });
    }
    this.key = crypto.createHmac('sha256', secret).update(this.password).digest();
  }

  #sign(value) {
    return crypto.createHmac('sha256', this.key).update(value).digest('base64url');
  }

  isAuthed(req) {
    if (!this.enabled) return true;
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return false;
    const [issued, sig] = raw.split('.');
    if (!issued || !sig) return false;
    const expected = this.#sign(issued);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    return Date.now() - Number(issued) < MAX_AGE * 1000;
  }

  /** Who is trying to log in: the proxy-reported client (last X-Forwarded-For entry) or the connection. */
  #clientKey(req) {
    const remote = req.socket.remoteAddress || '';
    if (!this.trustProxy) return remote;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return forwarded.at(-1) || remote;
  }

  /** Failed attempts of this client in the last minute (5 allowed), shared by web login and Subsonic apps. */
  #recentFailures(ip) {
    const now = Date.now();
    if (this.attempts.size > 1000) {
      // Forget clients without failed attempts in the last minute.
      for (const [key, times] of this.attempts) if (!times.some((t) => now - t < 60_000)) this.attempts.delete(key);
    }
    return (this.attempts.get(ip) || []).filter((t) => now - t < 60_000);
  }

  #samePassword(candidate) {
    const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
    const b = crypto.createHash('sha256').update(this.password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** Returns [status, body, headers]. */
  login(req, password) {
    const ip = this.#clientKey(req);
    const recent = this.#recentFailures(ip);
    if (recent.length >= 5) return [429, { error: 'Too many attempts. Wait a minute and try again.' }];
    if (!this.#samePassword(password)) {
      recent.push(Date.now());
      this.attempts.set(ip, recent);
      return [401, { error: 'Wrong password' }];
    }
    this.attempts.delete(ip);
    const issued = String(Date.now());
    return [200, { ok: true }, { 'Set-Cookie': this.#cookie(req, `${issued}.${this.#sign(issued)}`, MAX_AGE) }];
  }

  /**
   * Subsonic apps send credentials with every request: the password ("p", plain or "enc:<hex>")
   * or a token ("t" = md5(password + salt "s")). Same rate limit as the web login.
   * Returns 'ok', 'wrong' or 'limited'.
   */
  checkSubsonic(req, { p, t, s }) {
    if (!this.enabled) return 'ok';
    const ip = this.#clientKey(req);
    const recent = this.#recentFailures(ip);
    if (recent.length >= 5) return 'limited';
    let ok = false;
    if (t && s) {
      const expected = crypto.createHash('md5').update(this.password + s).digest('hex');
      const given = String(t).toLowerCase();
      ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    } else if (p) {
      let pw = String(p);
      if (pw.startsWith('enc:')) pw = Buffer.from(pw.slice(4), 'hex').toString('utf8');
      ok = this.#samePassword(pw);
    }
    if (!ok) {
      recent.push(Date.now());
      this.attempts.set(ip, recent);
      return 'wrong';
    }
    this.attempts.delete(ip);
    return 'ok';
  }

  logout(req) {
    return { 'Set-Cookie': this.#cookie(req, '', 0) };
  }

  #cookie(req, value, maxAge) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
    return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icons/icon-180.png"><link rel="manifest" href="/manifest.webmanifest">
<title>Sign in – Musicplayer</title>
<style>
@font-face{font-family:Figtree;font-weight:300 900;src:url(/fonts/figtree-latin-wght-normal.woff2) format('woff2-variations')}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:linear-gradient(#123a30,#000 70%);color:#fff;font:15px/1.45 Figtree,-apple-system,"Segoe UI",sans-serif;padding:24px}
form{width:min(360px,100%);display:flex;flex-direction:column;gap:14px;text-align:center}
img{width:72px;height:72px;border-radius:16px;margin:0 auto 4px}h1{margin:0 0 8px;font-size:28px;letter-spacing:-.02em}
input{height:48px;border-radius:6px;border:1px solid #ffffff30;background:#1f1f1f;color:#fff;padding:0 14px;font:inherit;outline:none}
input:focus{border-color:#fff}button{height:48px;border:0;border-radius:99px;background:#2fd6a3;color:#000;font:inherit;font-weight:800;cursor:pointer}
.err{color:#f15e6c;min-height:1.4em;font-size:14px}
</style></head><body>
<form id="f"><img src="/icons/icon-192.png" alt=""><h1>Musicplayer</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button>Sign in</button><div class="err" id="e"></div></form>
<script src="/login.js"></script></body></html>`;
