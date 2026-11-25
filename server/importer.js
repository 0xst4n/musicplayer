import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { isAudio, titleFromFilename, dirInside } from './library.js';
import { cleanSong, sameSong } from './titles.js';

const exe = (name) => (process.platform === 'win32' ? name + '.exe' : name);

/** Prefer the tools installed in ./tools/venv, fall back to PATH. */
export function findTool(rootDir, name) {
  const venvBin = path.join(rootDir, 'tools', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', exe(name));
  return fssync.existsSync(venvBin) ? venvBin : name;
}

export function toolVersion(cmd, args = ['--version']) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.toString().split(/\r?\n/)[0].trim() || 'installed');
    });
  });
}

export const isSpotifyUrl = (url) => /^https?:\/\/(open|play)\.spotify\.com\//i.test(url);

/**
 * Imports run one at a time. Each job downloads into data/incoming/<job>/<playlist name>/,
 * then the files are moved into music/Imports/<playlist name>/ and a playlist is created
 * in source order.
 */
export class Importer {
  constructor({ rootDir, dataDir, library, playlists, folders, onChange }) {
    this.rootDir = rootDir;
    this.incomingDir = path.join(dataDir, 'incoming');
    this.library = library;
    this.playlists = playlists;
    this.folders = folders;
    this.onChange = onChange ?? (() => {});
    this.jobs = [];
    this.running = false;
    this.hold = false; // set by the tool updater while pip replaces yt-dlp / spotDL
    this.ytdlp = findTool(rootDir, 'yt-dlp');
    this.spotdl = findTool(rootDir, 'spotdl');
  }

  /** An import is running or waiting. */
  get busy() {
    return this.running || this.jobs.some((j) => j.status === 'queued');
  }

  /** Start waiting imports (after the updater released its hold). */
  kick() {
    this.#pump();
  }

  async init() {
    // Leftovers from a crash or an interrupted import.
    await fs.rm(this.incomingDir, { recursive: true, force: true });
    await fs.mkdir(this.incomingDir, { recursive: true });
  }

  list() {
    return this.jobs.map(({ proc, ...job }) => job);
  }

  /** single: add just this one song, even if the link also points into a playlist (watch?v=…&list=…). */
  add({ url, target = 'new', single = false }) {
    url = String(url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Paste a full http(s) link to a playlist, album or track.');
    const source = isSpotifyUrl(url) ? 'spotify' : 'yt-dlp';
    if (single && source === 'spotify' && !/\/track\//.test(url)) {
      throw new Error('That Spotify link is a playlist or album. Paste a link to one song, or use Import for the whole list.');
    }
    if (target !== 'new' && !this.playlists.get(target)) throw new Error('That playlist no longer exists.');
    const job = {
      id: crypto.randomUUID().slice(0, 8),
      url,
      source,
      single: !!single,
      target,
      status: 'queued',
      title: '',
      done: 0,
      total: 0,
      itemProgress: 0,
      log: [],
      imported: 0,
      duplicates: [], // imported songs that were already in the library as another file
      playlistIds: [],
      error: null,
      createdAt: Date.now(),
    };
    this.jobs.unshift(job);
    this.onChange();
    this.#lookupTitle(job);
    this.#pump();
    return job;
  }

  /**
   * Search for songs (metadata only, nothing is downloaded). YouTube Music's "Songs" results
   * first: official tracks instead of live versions, covers and long videos. Plain YouTube is
   * the fallback when that returns nothing.
   */
  async search(query) {
    let results = [];
    try {
      results = await this.#searchYouTubeMusic(query);
    } catch {
      // fall through to plain YouTube
    }
    if (!results.length) results = await this.#searchYouTube(query);
    return results;
  }

  async #searchYouTubeMusic(query) {
    const entries = await this.#flatList(`https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`, '1:10');
    const songs = entries.filter((e) => /^[\w-]{11}$/.test(e?.id ?? ''));
    // The quick listing has titles only; the public oEmbed endpoint adds the artist (~150 ms each, in parallel).
    return Promise.all(
      songs.map(async (e) => {
        let author = '';
        try {
          const r = await fetch(
            `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${e.id}`)}`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (r.ok) author = (await r.json()).author_name ?? '';
        } catch {
          // artist stays empty
        }
        return { id: e.id, ...cleanSong(e.title, author), duration: 0, url: `https://www.youtube.com/watch?v=${e.id}` };
      }),
    );
  }

  async #searchYouTube(query) {
    const entries = await this.#flatList(`ytsearch10:${query}`);
    return entries
      .filter((e) => /^[\w-]{11}$/.test(e?.id ?? '') && e.duration) // skip live streams and odd entries
      .map((e) => ({
        id: e.id,
        ...cleanSong(e.title, e.channel ?? e.uploader),
        duration: Number(e.duration) || 0,
        url: `https://www.youtube.com/watch?v=${e.id}`,
      }));
  }

  /** yt-dlp listing without downloading. The target is passed after '--' so it is never read as an option. */
  #flatList(target, items) {
    const args = [
      '--flat-playlist', '-J', '--no-warnings',
      '--js-runtimes', `node:${process.execPath}`,
      ...(items ? ['--playlist-items', items] : []),
      '--', target,
    ];
    return new Promise((resolve, reject) => {
      execFile(
        this.ytdlp,
        args,
        { timeout: 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } },
        (err, stdout) => {
          if (err) return reject(new Error(err.code === 'ENOENT' ? 'yt-dlp is not installed.' : 'Search failed. Try again.'));
          try {
            resolve(JSON.parse(stdout).entries ?? []);
          } catch {
            reject(new Error('Search failed. Try again.'));
          }
        },
      );
    });
  }

  /**
   * Newly imported songs that were already in the library (as another file): same YouTube
   * video, or same title by the same main artist. Re-imports of the very same file don't count.
   */
  #findDuplicates(newIds, before) {
    const existing = new Set(before.map((t) => t.id));
    const dups = [];
    for (const id of new Set(newIds)) {
      if (existing.has(id)) continue; // same file as before (re-import): not a new copy
      const track = this.library.tracks.get(id);
      if (!track) continue;
      const match = before.find((b) => sameSong(track, b));
      if (match) dups.push({ id, title: track.title, artist: track.artist, existing: match.id });
    }
    return dups;
  }

  /** Fill in the playlist/track name right away, so queued imports show it before they start. */
  #lookupTitle(job) {
    const done = (title) => {
      if (!title || job.title) return;
      job.title = String(title).trim().slice(0, 200);
      this.onChange();
    };
    if (job.source === 'spotify') {
      // Public oEmbed endpoint: name only, no spotDL run and no Spotify API rate limit.
      fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(job.url)}`, { signal: AbortSignal.timeout(15000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => done(d?.title))
        .catch(() => {});
      return;
    }
    // Metadata only: the playlist title plus at most one entry, nothing is downloaded.
    const args = [
      '--flat-playlist', '-J', '--playlist-items', '1', '--no-warnings',
      '--js-runtimes', `node:${process.execPath}`,
      ...(job.single ? ['--no-playlist'] : []),
      '--', job.url,
    ];
    execFile(
      this.ytdlp,
      args,
      { timeout: 60000, maxBuffer: 20 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } },
      (err, stdout) => {
        if (err) return;
        try {
          done(JSON.parse(stdout).title);
        } catch {
          // Not JSON (tool missing or unsupported URL): the name appears once the import runs.
        }
      },
    );
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
    } else if (job.status === 'running' && job.proc) {
      job.cancelled = true;
      killTree(job.proc);
    }
    this.onChange();
    return true;
  }

  dismiss(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status === 'running' || job.status === 'queued') return false;
    this.jobs = this.jobs.filter((j) => j !== job);
    this.onChange();
    return true;
  }

  async #pump() {
    if (this.running || this.hold) return;
    const job = [...this.jobs].reverse().find((j) => j.status === 'queued');
    if (!job) return;
    this.running = true;
    try {
      await this.#run(job);
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
    } finally {
      delete job.proc;
      this.running = false;
      this.onChange();
      this.#pump();
    }
  }

  async #run(job) {
    job.status = 'running';
    this.onChange();
    const workDir = path.join(this.incomingDir, job.id);
    await fs.mkdir(workDir, { recursive: true });

    const { cmd, args, parse } = job.source === 'spotify' ? this.#spotdlCommand(job, workDir) : this.#ytdlpCommand(job, workDir);
    const code = await this.#spawn(job, cmd, args, workDir, parse);

    if (job.cancelled) {
      job.status = 'cancelled';
      await fs.rm(workDir, { recursive: true, force: true });
      return;
    }

    // Folder sync waits until this import has put its songs in order.
    this.folders.pause();
    try {
      // The library as it was before this import, to spot songs you already had.
      const before = this.library.list();
      const groups = await this.#collect(job, workDir);
      await fs.rm(workDir, { recursive: true, force: true });
      const fileCount = groups.reduce((n, g) => n + g.files.length, 0);
      if (fileCount === 0) {
        job.status = 'error';
        job.error = code === 'ENOENT'
          ? `${path.basename(cmd)} is not installed.`
          : lastErrorLine(job.log) || 'Nothing was downloaded.';
        return;
      }

      await this.library.scan();
      const known = new Set(this.library.list().map((t) => t.id));
      for (const g of groups) {
        const ids = g.files.filter((id) => known.has(id));
        job.imported += ids.length;
        // Every import lands in a playlist: the chosen one, or the playlist of its folder.
        let p = (g.playlistId && this.playlists.get(g.playlistId)) || this.playlists.byFolder(g.folder);
        if (p) await this.playlists.addTracks(p.id, ids);
        else p = await this.playlists.create({ name: g.name, trackIds: ids, source: job.url, folder: g.folder });
        if (!job.playlistIds.includes(p.id)) job.playlistIds.push(p.id);
      }
      job.duplicates = this.#findDuplicates(groups.flatMap((g) => g.files), before);
    } finally {
      await this.folders.resume();
    }
    job.done = job.total = Math.max(job.total, job.imported);
    job.status = 'done';
    // A non-zero exit with files means some items failed (private/removed videos, no match).
    if (code !== 0) job.error = 'Some tracks could not be downloaded. See the log.';
  }

  #ytdlpCommand(job, workDir) {
    const out = path.join(workDir, '%(playlist_title,playlist|' + SINGLES + ')s', '%(playlist_index|0)05d - %(title)s [%(id)s].%(ext)s');
    const args = [
      // Prefer the original AAC/M4A stream (plays everywhere incl. iPhone); otherwise best audio as-is.
      '-f', 'bestaudio[ext=m4a][audio_channels<=2]/bestaudio[ext=m4a]/bestaudio/best',
      '-x', // Extract audio without re-encoding (container remux only).
      '--embed-metadata',
      '--embed-thumbnail',
      '--convert-thumbnails', 'jpg',
      // Crop 16:9 video thumbnails to a square cover.
      '--ppa', `ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -qmin 1 -qscale:v 2 -vf crop="'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'"`,
      // YouTube needs a JavaScript runtime for signature solving; use the Node running this server.
      '--js-runtimes', `node:${process.execPath}`,
      ...(job.single ? ['--no-playlist'] : []),
      '--ignore-errors',
      '--no-overwrites',
      '--newline',
      '--color', 'never',
      '-o', out,
      '--', job.url,
    ];
    const parse = (line) => {
      let m;
      if ((m = line.match(/Downloading playlist: (.+)$/))) job.title = m[1].trim();
      else if ((m = line.match(/Downloading item (\d+) of (\d+)/))) {
        job.done = Number(m[1]) - 1;
        job.total = Number(m[2]);
        job.itemProgress = 0;
      } else if ((m = line.match(/^\[download\]\s+([\d.]+)%/))) job.itemProgress = Number(m[1]) / 100;
      else if (!job.title && (m = line.match(/^\[download\] Destination: .*[\\/]\d+ - (.+?) \[[\w-]+\]\.\w+$/))) job.title = m[1];
    };
    return { cmd: this.ytdlp, args, parse };
  }

  #spotdlCommand(job, workDir) {
    const out = path.join(workDir, '{list-name}', '{list-position} - {artists} - {title}.{output-ext}');
    const args = [
      'download', job.url,
      '--output', out,
      '--format', 'm4a',
      '--bitrate', 'disable',
      // Ask YouTube Music for the original AAC stream so no re-encode is needed.
      '--yt-dlp-args', `-f bestaudio[ext=m4a][audio_channels<=2]/bestaudio[ext=m4a]/bestaudio --js-runtimes 'node:${process.execPath}'`, // parsed with shlex
      '--simple-tui',
      '--print-errors',
      '--overwrite', 'skip',
    ];
    const parse = (line) => {
      let m;
      if ((m = line.match(/Found (\d+) songs? in (.+?) \((Playlist|Album|Artist|Saved)/i))) {
        job.total = Number(m[1]);
        job.title = m[2].trim();
      } else if (/^(Downloaded|Skipping) /i.test(line)) job.done = Math.min(job.done + 1, job.total || Infinity);
      else if (/^(LookupError|AudioProviderError|DownloaderError)/.test(line)) job.done = Math.min(job.done + 1, job.total || Infinity);
    };
    return { cmd: this.spotdl, args, parse };
  }

  #spawn(job, cmd, args, cwd, parse) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(cmd, args, {
          cwd,
          windowsHide: true,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
        });
      } catch {
        return resolve('ENOENT');
      }
      job.proc = proc;
      let tick = 0;
      const onData = (buf) => {
        for (const raw of buf.toString('utf8').split(/\r?\n|\r/)) {
          const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (!line) continue;
          parse(line);
          if (!/^\[download\]\s+[\d.]+%/.test(line)) {
            job.log.push(line);
            if (job.log.length > 60) job.log.shift();
          }
        }
        const now = Date.now();
        if (now - tick > 400) {
          tick = now;
          this.onChange();
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (err) => resolve(err.code === 'ENOENT' ? 'ENOENT' : 1));
      proc.on('close', (code) => resolve(code ?? 1));
    });
  }

  /** Move downloaded files into the library; returns [{name, folder, playlistId, files: [trackId in order]}]. */
  async #collect(job, workDir) {
    const groups = [];
    const target = job.target !== 'new' ? this.playlists.get(job.target) : null;
    for (const dirent of await fs.readdir(workDir, { withFileTypes: true }).catch(() => [])) {
      if (!dirent.isDirectory()) continue;
      const rawName = dirent.name.trim();
      const single = !rawName || rawName === SINGLES || /^NA$/.test(rawName);
      const name = single ? 'Singles' : rawName;
      const srcDir = path.join(workDir, dirent.name);
      const files = (await fs.readdir(srcDir)).filter(isAudio);
      files.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b));
      // Files go into the target playlist's folder, or Imports/<name> (which becomes that playlist's folder).
      let folder = `Imports/${safeName(name)}`;
      if (target) {
        if (typeof target.folder === 'string') folder = target.folder;
        else {
          folder = `Imports/${safeName(target.name)}`;
          await this.playlists.linkFolder(target.id, folder);
        }
      }
      const destDir = dirInside(this.library.musicDir, folder);
      if (!destDir) throw new Error('The target playlist has an invalid folder.');
      await fs.mkdir(destDir, { recursive: true });
      const ids = [];
      for (const f of files) {
        const ext = path.extname(f);
        const base = path.basename(f, ext).replace(/^\d{1,5}\s*-\s*/, '') || titleFromFilename(f);
        let dest = path.join(destDir, safeName(base) + ext);
        const src = path.join(srcDir, f);
        const srcSize = (await fs.stat(src)).size;
        for (let n = 2; ; n++) {
          const existing = await fs.stat(dest).catch(() => null);
          if (!existing) {
            await move(src, dest);
            break;
          }
          if (existing.size === srcSize) break; // Same file already imported earlier.
          dest = path.join(destDir, `${safeName(base)} (${n})${ext}`);
        }
        ids.push(path.relative(this.library.musicDir, dest).split(path.sep).join('/'));
      }
      if (ids.length) groups.push({ name, folder, playlistId: target?.id ?? null, files: ids });
    }
    return groups;
  }
}

const SINGLES = '__singles__';

export const safeName = (s) =>
  s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'Untitled';

async function move(src, dest) {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

function killTree(proc) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
}

function lastErrorLine(log) {
  return [...log].reverse().find((l) => /error/i.test(l)) ?? null;
}
