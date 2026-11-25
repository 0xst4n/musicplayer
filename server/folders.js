import path from 'node:path';
import crypto from 'node:crypto';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const folderOf = (id) => {
  const d = path.posix.dirname(id);
  return d === '.' ? '' : d;
};

/**
 * Every folder that directly contains songs becomes a playlist named after the folder.
 * New files in a folder are appended to its playlist; files removed by hand from the
 * playlist stay removed. Paused while an import is moving files in, so the import can
 * keep the source's track order.
 */
export class FolderSync {
  constructor({ library, playlists, musicDir }) {
    this.library = library;
    this.playlists = playlists;
    this.rootName = path.basename(musicDir) || 'Music';
    this.paused = 0;
    this.running = Promise.resolve();
  }

  pause() {
    this.paused++;
  }

  resume() {
    this.paused = Math.max(0, this.paused - 1);
    return this.sync();
  }

  sync() {
    this.running = this.running.then(() => this.#sync()).catch((err) => console.error('Folder sync failed:', err));
    return this.running;
  }

  async #sync() {
    if (this.paused) return;
    const byFolder = new Map();
    for (const t of this.library.list()) {
      const f = folderOf(t.id);
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f).push(t.id);
    }
    await this.playlists.batch(async () => {
      let changed = false;
      for (const [folder, ids] of [...byFolder].sort(([a], [b]) => collator.compare(a, b))) {
        if (this.playlists.ignoredFolders.has(folder)) continue;
        ids.sort((a, b) => collator.compare(path.posix.basename(a), path.posix.basename(b)));
        const p = this.playlists.byFolder(folder);
        if (!p) {
          const name = folder ? path.posix.basename(folder) : this.rootName;
          this.playlists.items.push({
            id: crypto.randomUUID(),
            name,
            trackIds: ids,
            source: null,
            folder,
            createdAt: Date.now(),
            known: [...ids],
          });
          changed = true;
          continue;
        }
        const known = new Set(p.known);
        const fresh = ids.filter((id) => !known.has(id));
        if (fresh.length) {
          await this.playlists.addTracks(p.id, fresh, { save: false });
          changed = true;
        }
      }
      return changed;
    });
  }
}
