import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { cleanSong } from './titles.js';

// Formats that Chromium/Firefox/Edge can play natively in an <audio> element.
export const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
};

// Bump when #readMeta changes so cached tags are re-read.
const META_VERSION = 3;

export const isAudio =(file) => Object.hasOwn(AUDIO_MIME, path.extname(file).toLowerCase());

/**
 * Absolute path of a playlist folder ('Imports/x', '' = the music folder itself), or null
 * if it would end up outside baseDir (e.g. '../..' segments, or '..\..' on Windows).
 */
export function dirInside(baseDir, folder) {
  const dir = path.resolve(baseDir, ...String(folder).split('/').filter(Boolean));
  return dir === baseDir || dir.startsWith(baseDir + path.sep) ? dir : null;
}

// "00012 - Song name [dQw4w9WgXcQ].opus" -> "Song name"
export function titleFromFilename(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/\s*\[[A-Za-z0-9_-]{6,}\]$/, '')
    .replace(/^\d{1,5}\s*[-.]\s*/, '')
    .trim();
}

export class Library {
  constructor({ musicDir, dataDir, onChange, onScanned }) {
    this.musicDir = path.resolve(musicDir);
    this.coversDir = path.join(dataDir, 'covers');
    this.cacheFile = path.join(dataDir, 'library-cache.json');
    this.onChange = onChange ?? (() => {});
    this.onScanned = onScanned ?? (() => {});
    this.tracks = new Map();
    this.cache = {};
    this.scanning = null;
    this.rescanQueued = false;
  }

  async init() {
    await fs.mkdir(this.musicDir, { recursive: true });
    await fs.mkdir(this.coversDir, { recursive: true });
    try {
      this.cache = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
    } catch {
      this.cache = {};
    }
    await this.scan();
  }

  /** Resolve a track id (relative path) to an absolute path inside the music folder, or null. */
  resolve(id) {
    if (typeof id !== 'string' || !id) return null;
    const full = path.resolve(this.musicDir, id);
    if (!full.startsWith(this.musicDir + path.sep)) return null;
    return full;
  }

  list() {
    return [...this.tracks.values()];
  }

  /** Scan the folder. Concurrent calls share one run, and one more run is queued if needed. */
  scan() {
    if (this.scanning) {
      this.rescanQueued = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.rescanQueued = false;
          await this.#scanOnce();
        } while (this.rescanQueued);
      } finally {
        this.scanning = null;
        this.onChange();
      }
      await this.onScanned();
    })();
    this.onChange();
    return this.scanning;
  }

  async #scanOnce() {
    const files = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && isAudio(e.name)) files.push(full);
      }
    };
    await walk(this.musicDir);

    const next = new Map();
    const nextCache = {};
    let changed = false;
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const full = files[i++];
        const id = path.relative(this.musicDir, full).split(path.sep).join('/');
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        const cached = this.cache[id];
        let meta;
        if (cached && cached.v === META_VERSION && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          meta = cached.meta;
        } else {
          meta = await this.#readMeta(full);
          changed = true;
        }
        nextCache[id] = { v: META_VERSION, size: stat.size, mtimeMs: stat.mtimeMs, meta };
        next.set(id, { id, ...meta, size: stat.size, addedAt: Math.round(stat.birthtimeMs || stat.mtimeMs) });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    if (Object.keys(this.cache).length !== Object.keys(nextCache).length) changed = true;
    this.tracks = new Map([...next.entries()].sort(([a], [b]) => a.localeCompare(b)));
    this.cache = nextCache;
    if (changed) await fs.writeFile(this.cacheFile, JSON.stringify(this.cache));
  }

  async #readMeta(full) {
    const fallbackTitle = titleFromFilename(full);
    let title = fallbackTitle;
    let artist = '';
    let album = '';
    let duration = 0;
    let cover = null;
    try {
      const { common, format } = await parseFile(full, { duration: false });
      title = common.title?.trim() || fallbackTitle;
      artist = (common.artists?.length ? common.artists.join(', ') : common.artist)?.trim() || '';
      album = common.album?.trim() || '';
      duration = format.duration ?? 0;
      if (!duration) {
        // Some containers (e.g. Ogg/Opus without an index) need a full read for the length.
        duration = (await parseFile(full, { duration: true, skipCovers: true })).format.duration ?? 0;
      }
      const pic = common.picture?.[0];
      if (pic?.data?.length) cover = await this.#saveCover(pic);
    } catch {
      // Unreadable tags: fall back to the filename.
    }
    // "Dave - Sprinter (Official Video)" by "DaveVEVO" → "Sprinter" by "Dave" (display only).
    ({ title, artist } = cleanSong(title, artist));
    if (!album) album = path.basename(path.dirname(full)) === path.basename(this.musicDir) ? '' : path.basename(path.dirname(full));
    return { title, artist, album, duration, cover };
  }

  async #saveCover(pic) {
    const ext = /png/i.test(pic.format) ? '.png' : /webp/i.test(pic.format) ? '.webp' : '.jpg';
    const name = crypto.createHash('sha1').update(pic.data).digest('hex').slice(0, 20) + ext;
    const out = path.join(this.coversDir, name);
    try {
      await fs.access(out);
    } catch {
      await fs.writeFile(out, pic.data);
    }
    return name;
  }
}
