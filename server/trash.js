import fs from 'node:fs/promises';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;

/**
 * Removed songs are moved to data/trash/<YYYY-MM-DD>/<original path> instead of being deleted
 * right away, so a mistake can be undone by moving the file back. Folders older than 30 days
 * are deleted for good (checked at start and daily).
 */
export class Trash {
  constructor({ dataDir, musicDir }) {
    this.dir = path.join(dataDir, 'trash');
    this.musicDir = musicDir;
  }

  start() {
    this.purge();
    setInterval(() => this.purge(), DAY).unref();
  }

  /** Move a file from the music folder into today's trash folder; returns the new path. */
  async put(full) {
    const rel = path.relative(this.musicDir, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Not inside the music folder');
    const day = new Date().toISOString().slice(0, 10);
    let dest = path.join(this.dir, day, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    for (let n = 2; await exists(dest); n++) {
      const ext = path.extname(rel);
      dest = path.join(this.dir, day, `${rel.slice(0, -ext.length || undefined)} (${n})${ext}`);
    }
    try {
      await fs.rename(full, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err; // /music and /data are separate volumes in Docker
      await fs.copyFile(full, dest);
      await fs.unlink(full);
    }
    // Leave no empty album folders behind (stop at the music folder itself).
    for (let d = path.dirname(full); d.startsWith(this.musicDir + path.sep); d = path.dirname(d)) {
      try {
        await fs.rmdir(d);
      } catch {
        break; // not empty
      }
    }
    return dest;
  }

  async purge() {
    const cutoff = Date.now() - KEEP_DAYS * DAY;
    let days;
    try {
      days = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const day of days) {
      const t = Date.parse(day);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && t < cutoff) {
        await fs.rm(path.join(this.dir, day), { recursive: true, force: true });
        console.log(`[trash] emptied ${day}`);
      }
    }
  }
}

const exists = (p) => fs.stat(p).then(() => true, () => false);
