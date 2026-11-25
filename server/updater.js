import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { toolVersion } from './importer.js';

const HOUR = 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps yt-dlp and spotDL current. YouTube changes often and old yt-dlp versions then stop
 * working, so the tools in tools/venv are upgraded with pip once a day (first a minute after
 * start). Never during an import: running imports finish first, new ones wait.
 * Off with MUSICPLAYER_AUTO_UPDATE=0.
 */
export class ToolUpdater {
  constructor({ rootDir, importer, onChange }) {
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
    this.python = path.join(rootDir, 'tools', 'venv', bin, process.platform === 'win32' ? 'python.exe' : 'python');
    this.importer = importer;
    this.onChange = onChange ?? (() => {});
    this.status = { lastCheck: null, ok: null, message: 'Not checked yet' };
    this.running = false;
  }

  start() {
    if (process.env.MUSICPLAYER_AUTO_UPDATE === '0') {
      this.status.message = 'Automatic updates are off';
      return;
    }
    if (!fs.existsSync(this.python)) {
      this.status.message = 'Tools are not in tools/venv; update them yourself';
      return;
    }
    setTimeout(() => this.run(), 60 * 1000).unref();
    setInterval(() => this.run(), 24 * HOUR).unref();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      // Let running imports finish; hold new ones while pip replaces the files.
      while (this.importer.busy) await sleep(30 * 1000);
      this.importer.hold = true;
      const before = await this.#versions();
      // spotDL first, yt-dlp last: if spotDL pins an older yt-dlp, the newest yt-dlp still wins.
      await this.#pip(['install', '--upgrade', '--quiet', 'spotdl']);
      await this.#pip(['install', '--upgrade', '--quiet', 'yt-dlp[default]']);
      const after = await this.#versions();
      const changes = ['ytdlp', 'spotdl']
        .filter((k) => before[k] !== after[k])
        .map((k) => `${k === 'ytdlp' ? 'yt-dlp' : 'spotDL'} ${before[k]} → ${after[k]}`);
      this.status = { lastCheck: Date.now(), ok: true, message: changes.length ? `Updated ${changes.join(', ')}` : 'Up to date' };
      console.log(`[updater] ${this.status.message}`);
    } catch (err) {
      this.status = { lastCheck: Date.now(), ok: false, message: `Update failed: ${err.message.split('\n')[0].slice(0, 200)}` };
      console.warn(`[updater] ${this.status.message}`);
    } finally {
      this.importer.hold = false;
      this.importer.kick();
      this.running = false;
      this.onChange();
    }
  }

  async #versions() {
    const [ytdlp, spotdl] = await Promise.all([toolVersion(this.importer.ytdlp), toolVersion(this.importer.spotdl)]);
    return { ytdlp, spotdl };
  }

  #pip(args) {
    return new Promise((resolve, reject) => {
      execFile(
        this.python,
        ['-m', 'pip', ...args],
        { timeout: 10 * 60 * 1000, windowsHide: true, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1' } },
        (err, _stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()),
      );
    });
  }
}
