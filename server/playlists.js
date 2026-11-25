import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Playlists live in data/playlists.json. Track ids are paths relative to the music folder.
 *
 * A playlist can be linked to a folder (`folder`, relative path, '' = music folder root):
 * new files in that folder are appended automatically. `known` remembers every id that was
 * ever in the playlist, so songs you removed by hand are not added back. Deleting a folder
 * playlist puts its folder on `ignoredFolders` so it is not recreated.
 */
export class Playlists {
  constructor({ dataDir, onChange }) {
    this.file = path.join(dataDir, 'playlists.json');
    this.onChange = onChange ?? (() => {});
    this.items = [];
    this.ignoredFolders = new Set();
    this.writing = Promise.resolve();
  }

  async init() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      // v1 stored a bare array.
      this.items = Array.isArray(data) ? data : data.playlists ?? [];
      this.ignoredFolders = new Set(Array.isArray(data) ? [] : data.ignoredFolders ?? []);
    } catch {
      this.items = [];
    }
    for (const p of this.items) p.known ??= [...p.trackIds];
  }

  /** Playlists as sent to the browser (without bookkeeping fields). */
  list() {
    return this.items.map(({ known, ...p }) => p);
  }

  get(id) {
    return this.items.find((p) => p.id === id) ?? null;
  }

  byFolder(folder) {
    return this.items.find((p) => p.folder === folder) ?? null;
  }

  async create({ name, trackIds = [], source = null, folder }) {
    const ids = uniqueStrings(trackIds);
    const p = {
      id: crypto.randomUUID(),
      name: cleanName(name) || `My Playlist #${this.items.length + 1}`,
      trackIds: ids,
      source,
      createdAt: Date.now(),
      known: [...ids],
    };
    if (typeof folder === 'string') {
      p.folder = folder;
      this.ignoredFolders.delete(folder);
    }
    this.items.push(p);
    await this.#save();
    return p;
  }

  async update(id, { name, trackIds }) {
    const p = this.get(id);
    if (!p) return null;
    if (name !== undefined) p.name = cleanName(name) || p.name;
    if (trackIds !== undefined) {
      p.trackIds = uniqueStrings(trackIds);
      p.known = uniqueStrings([...p.known, ...p.trackIds]);
    }
    await this.#save();
    return p;
  }

  async addTracks(id, trackIds, { save = true } = {}) {
    const p = this.get(id);
    if (!p) return null;
    p.trackIds = uniqueStrings([...p.trackIds, ...trackIds]);
    p.known = uniqueStrings([...p.known, ...trackIds]);
    if (save) await this.#save();
    return p;
  }

  /** Take songs out of one playlist (they stay in `known`, so folder sync won't add them back). */
  async removeTracks(id, trackIds) {
    const p = this.get(id);
    if (!p) return null;
    const gone = new Set(trackIds);
    p.trackIds = p.trackIds.filter((t) => !gone.has(t));
    await this.#save();
    return p;
  }

  /** Is this song in any playlist? */
  isUsed(trackId) {
    return this.items.some((p) => p.trackIds.includes(trackId));
  }

  async linkFolder(id, folder) {
    const p = this.get(id);
    if (!p || this.byFolder(folder)) return;
    p.folder = folder;
    this.ignoredFolders.delete(folder);
    await this.#save();
  }

  async remove(id) {
    const p = this.get(id);
    if (!p) return false;
    this.items = this.items.filter((x) => x !== p);
    if (typeof p.folder === 'string') this.ignoredFolders.add(p.folder);
    await this.#save();
    return true;
  }

  /** Apply many changes and write once (used by folder sync). */
  async batch(fn) {
    const changed = await fn();
    if (changed) await this.#save();
  }

  #save() {
    this.writing = this.writing.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify({ playlists: this.items, ignoredFolders: [...this.ignoredFolders] }, null, 2));
      await fs.rename(tmp, this.file);
    });
    this.onChange();
    return this.writing;
  }
}

const cleanName = (n) => (typeof n === 'string' ? n.trim().slice(0, 200) : '');
const uniqueStrings = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter((x) => typeof x === 'string'))];
