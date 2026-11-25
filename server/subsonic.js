// Subsonic / OpenSubsonic API, so native apps (Amperfy, play:Sub, substreamer, …) can browse,
// stream and download the library. Spec: http://www.subsonic.org/pages/api.jsp and
// https://opensubsonic.netlify.app. Only what music apps use is implemented; features
// Musicplayer doesn't have (podcasts, radio, shares, ratings) answer with empty lists.
//
// Removing songs through the API only takes them out of the playlist; files are never deleted
// from here (that stays in the web app, which moves them to the trash).
import path from 'node:path';
import crypto from 'node:crypto';

const API_VERSION = '1.16.1';
const SERVER_NAME = 'musicplayer';
// Formats the iOS/Android apps play natively; anything else is converted to AAC on the fly.
const NATIVE = new Set(['.mp3', '.m4a', '.mp4', '.aac', '.flac', '.wav']);
const ARTICLES = 'The El La Los Las Le Les';

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = (s) => {
  try {
    return Buffer.from(String(s), 'base64url').toString('utf8');
  } catch {
    return null;
  }
};
const iso = (ms) => new Date(ms || 0).toISOString();
const mainArtist = (a) => String(a || '').split(/,|&|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+/i)[0].trim() || 'Unknown artist';
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const notFound = (what) => new ApiError(70, `${what} not found`);

// ---------- XML / JSON responses ----------
const escXml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** Subsonic XML: plain values become attributes, objects child elements, arrays repeated elements. */
function toXml(name, obj) {
  let attrs = '';
  let children = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) children += item !== null && typeof item === 'object' ? toXml(k, item) : `<${k}>${escXml(item)}</${k}>`;
    } else if (typeof v === 'object') children += toXml(k, v);
    else attrs += ` ${k}="${escXml(v)}"`;
  }
  return children ? `<${name}${attrs}>${children}</${name}>` : `<${name}${attrs}/>`;
}
const stripUndefined = (o) => JSON.parse(JSON.stringify(o));

export class Subsonic {
  /**
   * deps: library, playlists, auth, transcode(full) → path, sendFile(req, res, file, type, cache),
   * audioMime ({ '.m4a': 'audio/mp4', … }), coversDir.
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.model = null;
    this.modelFor = null;
  }

  // ---------- library model: albums and artists derived from the tags ----------
  #build() {
    if (this.modelFor === this.library.tracks) return this.model;
    const albums = new Map();
    const artists = new Map();
    const albumOfTrack = new Map();
    for (const t of this.library.list()) {
      const artistName = mainArtist(t.artist);
      const albumName = t.album || 'Unknown album';
      const key = `${albumName.toLowerCase()}\u0000${artistName.toLowerCase()}`;
      let al = albums.get(key);
      if (!al) {
        al = { id: `al-${b64(key)}`, name: albumName, artist: artistName, artistId: `ar-${b64(artistName.toLowerCase())}`, tracks: [], created: Infinity };
        albums.set(key, al);
      }
      al.tracks.push(t);
      al.created = Math.min(al.created, t.addedAt || 0);
      albumOfTrack.set(t.id, al);
      let ar = artists.get(al.artistId);
      if (!ar) {
        ar = { id: al.artistId, name: artistName, albums: new Set() };
        artists.set(ar.id, ar);
      }
      ar.albums.add(al);
    }
    for (const al of albums.values()) {
      al.tracks.sort((a, b) => byName(a.id, b.id));
      al.cover = al.tracks.find((t) => t.cover)?.cover ?? null;
      al.duration = Math.round(al.tracks.reduce((s, t) => s + (t.duration || 0), 0));
    }
    this.model = {
      albums: new Map([...albums.values()].map((a) => [a.id, a])),
      artists,
      albumOfTrack,
    };
    this.modelFor = this.library.tracks;
    return this.model;
  }

  // ---------- object shapes ----------
  #song(t) {
    const m = this.#build();
    const al = m.albumOfTrack.get(t.id);
    const ext = path.extname(t.id).toLowerCase();
    const duration = Math.round(t.duration || 0);
    const song = {
      id: `tr-${b64(t.id)}`,
      parent: al?.id,
      isDir: false,
      title: t.title,
      album: t.album || 'Unknown album',
      artist: t.artist || 'Unknown artist',
      albumId: al?.id,
      artistId: al?.artistId,
      coverArt: t.cover ? `co-${t.cover}` : undefined,
      size: t.size || 0,
      contentType: this.audioMime[ext] || 'application/octet-stream',
      suffix: ext.slice(1),
      duration,
      bitRate: duration && t.size ? Math.round((t.size * 8) / duration / 1000) : 0,
      path: t.id,
      isVideo: false,
      type: 'music',
      mediaType: 'song',
      created: iso(t.addedAt),
    };
    if (!NATIVE.has(ext)) Object.assign(song, { transcodedSuffix: 'm4a', transcodedContentType: 'audio/mp4' });
    return song;
  }

  #album(al, withSongs = false) {
    const a = {
      id: al.id,
      parent: al.artistId,
      isDir: true,
      title: al.name,
      name: al.name,
      album: al.name,
      artist: al.artist,
      artistId: al.artistId,
      coverArt: al.cover ? `co-${al.cover}` : undefined,
      songCount: al.tracks.length,
      duration: al.duration,
      created: iso(al.created),
    };
    if (withSongs) a.song = al.tracks.map((t) => this.#song(t));
    return a;
  }

  #artist(ar) {
    const cover = [...ar.albums].find((al) => al.cover)?.cover;
    return { id: ar.id, name: ar.name, albumCount: ar.albums.size, coverArt: cover ? `co-${cover}` : undefined };
  }

  #playlistTracks(p) {
    return p.trackIds.map((id) => this.library.tracks.get(id)).filter(Boolean);
  }

  #playlist(p, user, withEntries = false) {
    const tracks = this.#playlistTracks(p);
    const out = {
      id: p.id,
      name: p.name,
      owner: user,
      public: false,
      songCount: tracks.length,
      duration: Math.round(tracks.reduce((s, t) => s + (t.duration || 0), 0)),
      created: iso(p.createdAt),
      changed: iso(p.createdAt),
      coverArt: `pl-${p.id}`,
    };
    if (withEntries) out.entry = tracks.map((t) => this.#song(t));
    return out;
  }

  /** Artists grouped by first letter (articles like "The" ignored), as getIndexes/getArtists expect. */
  #index(mapArtist) {
    const groups = new Map();
    const sortName = (n) => n.replace(new RegExp(`^(${ARTICLES.split(' ').join('|')})\\s+`, 'i'), '');
    for (const ar of [...this.#build().artists.values()].sort((a, b) => byName(sortName(a.name), sortName(b.name)))) {
      const first = sortName(ar.name).charAt(0).toUpperCase();
      const letter = /\p{L}/u.test(first) ? first : '#';
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(mapArtist(ar));
    }
    return [...groups].map(([name, artist]) => ({ name, artist }));
  }

  // ---------- id lookups ----------
  #track(id) {
    const tid = String(id || '').startsWith('tr-') ? unb64(String(id).slice(3)) : null;
    const t = tid && this.library.tracks.get(tid);
    if (!t) throw notFound('Song');
    return t;
  }
  #albumById(id) {
    const al = this.#build().albums.get(String(id || ''));
    if (!al) throw notFound('Album');
    return al;
  }
  #artistById(id) {
    const ar = this.#build().artists.get(String(id || ''));
    if (!ar) throw notFound('Artist');
    return ar;
  }
  #playlistById(id) {
    const p = this.playlists.get(String(id || ''));
    if (!p) throw notFound('Playlist');
    return p;
  }
  /** Song ids from the app → library track ids (unknown ones are skipped). */
  #trackIds(ids) {
    return ids.map((id) => (String(id).startsWith('tr-') ? unb64(String(id).slice(3)) : null)).filter((tid) => tid && this.library.tracks.has(tid));
  }

  // ---------- request handling ----------
  async handle(req, res, url) {
    const params = await readParams(req, url);
    const one = (k) => params.get(k) ?? undefined;
    const format = one('f') === 'json' || one('f') === 'jsonp' ? 'json' : 'xml';
    const method = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
    const user = one('u') || 'music';
    const send = (payload) => this.#send(res, format, { status: 'ok', ...payload });
    try {
      if (!one('u')) throw new ApiError(10, 'Required parameter is missing: u');
      const check = this.auth.checkSubsonic(req, { p: one('p'), t: one('t'), s: one('s') });
      if (check === 'limited') throw new ApiError(40, 'Too many wrong attempts. Wait a minute and try again.');
      if (check !== 'ok') throw new ApiError(40, 'Wrong username or password');

      // Binary responses
      if (method === 'stream' || method === 'download') return await this.#stream(req, res, this.#track(one('id')), method === 'download' || one('format') === 'raw');
      if (method === 'getCoverArt') return await this.#cover(req, res, one('id'));

      const handler = this.#methods()[method];
      if (!handler) throw new ApiError(0, `Unknown or unsupported method: ${method}`);
      return send(await handler(params, user));
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('[subsonic]', err);
      const code = err instanceof ApiError ? err.code : 0;
      return this.#send(res, format, { status: 'failed', error: { code, message: err.message } });
    }
  }

  #send(res, format, payload) {
    const base = { version: API_VERSION, type: SERVER_NAME, serverVersion: '1.0.0', openSubsonic: true };
    if (format === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ 'subsonic-response': stripUndefined({ ...payload, ...base }) }));
    }
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' });
    const { status, ...rest } = payload;
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>${toXml('subsonic-response', { xmlns: 'http://subsonic.org/restapi', status, ...base, ...rest })}`);
  }

  async #stream(req, res, t, raw) {
    const full = this.library.resolve(t.id);
    if (!full) throw notFound('Song');
    const ext = path.extname(full).toLowerCase();
    if (!raw && !NATIVE.has(ext)) {
      return this.sendFile(req, res, await this.transcode(full), 'audio/mp4', 'private, max-age=31536000, immutable');
    }
    return this.sendFile(req, res, full, this.audioMime[ext] || 'application/octet-stream', 'private, no-cache');
  }

  async #cover(req, res, rawId) {
    const id = String(rawId || '');
    const m = this.#build();
    let cover = null;
    if (id.startsWith('co-')) cover = id.slice(3);
    else if (id.startsWith('tr-')) cover = this.library.tracks.get(unb64(id.slice(3)))?.cover;
    else if (id.startsWith('al-')) cover = m.albums.get(id)?.cover;
    else if (id.startsWith('ar-')) cover = [...(m.artists.get(id)?.albums ?? [])].find((al) => al.cover)?.cover;
    else {
      const p = this.playlists.get(id.startsWith('pl-') ? id.slice(3) : id);
      if (p) cover = this.#playlistTracks(p).find((t) => t.cover)?.cover;
    }
    if (!cover || !/^[a-f0-9]{20}\.(jpg|png|webp)$/.test(cover)) throw notFound('Cover art');
    const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(cover)];
    return this.sendFile(req, res, path.join(this.coversDir, cover), type, 'private, max-age=31536000, immutable');
  }

  #methods() {
    const m = () => this.#build();
    const int = (params, k, def, max = 500) => Math.max(0, Math.min(max, parseInt(params.get(k) ?? def, 10) || 0));
    const empty = (key, inner) => () => ({ [key]: inner });
    const albumList = (params) => {
      const all = [...m().albums.values()];
      const type = params.get('type') || 'alphabeticalByName';
      let list;
      if (type === 'random') list = shuffle(all);
      else if (type === 'alphabeticalByArtist') list = all.sort((a, b) => byName(a.artist, b.artist) || byName(a.name, b.name));
      else if (type === 'byYear' || type === 'byGenre' || type === 'starred' || type === 'highest') list = [];
      else if (type === 'alphabeticalByName') list = all.sort((a, b) => byName(a.name, b.name));
      else list = all.sort((a, b) => b.created - a.created); // newest, recent, frequent
      const offset = int(params, 'offset', 0, 1e9);
      return list.slice(offset, offset + int(params, 'size', 10));
    };
    const search = (params) => {
      const q = String(params.get('query') ?? '').replace(/^"+|"+$/g, '').trim().toLowerCase();
      const hit = (...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));
      const page = (arr, prefix, def) => {
        const off = int(params, `${prefix}Offset`, 0, 1e9);
        return arr.slice(off, off + int(params, `${prefix}Count`, def, 10000));
      };
      return {
        artist: page([...m().artists.values()].filter((a) => hit(a.name)).sort((a, b) => byName(a.name, b.name)), 'artist', 20),
        album: page([...m().albums.values()].filter((a) => hit(a.name, a.artist)).sort((a, b) => byName(a.name, b.name)), 'album', 20),
        song: page(this.library.list().filter((t) => hit(t.title, t.artist, t.album)), 'song', 20),
      };
    };

    return {
      ping: () => ({}),
      getLicense: () => ({ license: { valid: true } }),
      getOpenSubsonicExtensions: () => ({ openSubsonicExtensions: [] }),
      getMusicFolders: () => ({ musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] } }),
      getUser: (params, user) => ({
        user: {
          username: params.get('username') || user,
          scrobblingEnabled: false,
          adminRole: false,
          settingsRole: false,
          downloadRole: true,
          uploadRole: false,
          playlistRole: true,
          coverArtRole: true,
          commentRole: false,
          podcastRole: false,
          streamRole: true,
          jukeboxRole: false,
          shareRole: false,
          videoConversionRole: false,
          folder: [1],
        },
      }),

      // Browsing (ID3 tags)
      getArtists: () => ({ artists: { ignoredArticles: ARTICLES, index: this.#index((ar) => this.#artist(ar)) } }),
      getArtist: (params) => {
        const ar = this.#artistById(params.get('id'));
        return { artist: { ...this.#artist(ar), album: [...ar.albums].sort((a, b) => byName(a.name, b.name)).map((al) => this.#album(al)) } };
      },
      getAlbum: (params) => ({ album: this.#album(this.#albumById(params.get('id')), true) }),
      getSong: (params) => ({ song: this.#song(this.#track(params.get('id'))) }),
      getAlbumList2: (params) => ({ albumList2: { album: albumList(params).map((al) => this.#album(al)) } }),
      getAlbumList: (params) => ({ albumList: { album: albumList(params).map((al) => this.#album(al)) } }),
      getRandomSongs: (params) => ({ randomSongs: { song: shuffle(this.library.list()).slice(0, int(params, 'size', 10)).map((t) => this.#song(t)) } }),

      // Browsing (folders): artist → albums → songs
      getIndexes: () => ({ indexes: { lastModified: Date.now(), ignoredArticles: ARTICLES, index: this.#index((ar) => ({ id: ar.id, name: ar.name })) } }),
      getMusicDirectory: (params) => {
        const id = String(params.get('id') || '');
        if (id.startsWith('ar-')) {
          const ar = this.#artistById(id);
          return { directory: { id: ar.id, name: ar.name, child: [...ar.albums].sort((a, b) => byName(a.name, b.name)).map((al) => this.#album(al)) } };
        }
        const al = this.#albumById(id);
        return { directory: { id: al.id, parent: al.artistId, name: al.name, child: al.tracks.map((t) => this.#song(t)) } };
      },

      // Search ("" returns everything, which apps use to sync the whole library page by page)
      search3: (params) => {
        const r = search(params);
        return { searchResult3: { artist: r.artist.map((a) => this.#artist(a)), album: r.album.map((a) => this.#album(a)), song: r.song.map((t) => this.#song(t)) } };
      },
      search2: (params) => {
        const r = search(params);
        return { searchResult2: { artist: r.artist.map((a) => ({ id: a.id, name: a.name })), album: r.album.map((a) => this.#album(a)), song: r.song.map((t) => this.#song(t)) } };
      },

      // Playlists (the same ones as in the web app)
      getPlaylists: (params, user) => ({ playlists: { playlist: this.playlists.list().map((p) => this.#playlist(p, user)) } }),
      getPlaylist: (params, user) => ({ playlist: this.#playlist(this.#playlistById(params.get('id')), user, true) }),
      createPlaylist: async (params, user) => {
        const ids = this.#trackIds(params.getAll('songId'));
        let p;
        if (params.get('playlistId')) {
          p = this.#playlistById(params.get('playlistId'));
          await this.playlists.update(p.id, { trackIds: ids });
        } else {
          if (!params.get('name')) throw new ApiError(10, 'Required parameter is missing: name');
          p = await this.playlists.create({ name: params.get('name'), trackIds: ids });
        }
        return { playlist: this.#playlist(this.playlists.get(p.id), user, true) };
      },
      updatePlaylist: async (params) => {
        const p = this.#playlistById(params.get('playlistId'));
        if (params.get('name')) await this.playlists.update(p.id, { name: params.get('name') });
        // Indexes refer to the songs as the app sees them (missing files left out).
        const shown = this.#playlistTracks(p).map((t) => t.id);
        const drop = new Set(params.getAll('songIndexToRemove').map((i) => shown[parseInt(i, 10)]).filter(Boolean));
        if (drop.size) await this.playlists.removeTracks(p.id, [...drop]); // playlist only, files stay
        const add = this.#trackIds(params.getAll('songIdToAdd'));
        if (add.length) await this.playlists.addTracks(p.id, add);
        return {};
      },
      deletePlaylist: async (params) => {
        await this.playlists.remove(this.#playlistById(params.get('id')).id); // files stay
        return {};
      },

      // Library scan
      getScanStatus: () => ({ scanStatus: { scanning: !!this.library.scanning, count: this.library.tracks.size } }),
      startScan: () => {
        this.library.scan();
        return { scanStatus: { scanning: true, count: this.library.tracks.size } };
      },

      // Features Musicplayer doesn't have: harmless empty answers so apps don't show errors.
      scrobble: () => ({}),
      star: () => ({}),
      unstar: () => ({}),
      setRating: () => ({}),
      getStarred: empty('starred', { artist: [], album: [], song: [] }),
      getStarred2: empty('starred2', { artist: [], album: [], song: [] }),
      getGenres: empty('genres', { genre: [] }),
      getSongsByGenre: empty('songsByGenre', { song: [] }),
      getNowPlaying: empty('nowPlaying', { entry: [] }),
      getArtistInfo: empty('artistInfo', {}),
      getArtistInfo2: empty('artistInfo2', {}),
      getAlbumInfo: empty('albumInfo', {}),
      getAlbumInfo2: empty('albumInfo', {}),
      getSimilarSongs: empty('similarSongs', { song: [] }),
      getSimilarSongs2: empty('similarSongs2', { song: [] }),
      getTopSongs: empty('topSongs', { song: [] }),
      getLyrics: empty('lyrics', {}),
      getLyricsBySongId: empty('lyricsList', { structuredLyrics: [] }),
      getPodcasts: empty('podcasts', { channel: [] }),
      getNewestPodcasts: empty('newestPodcasts', { episode: [] }),
      getInternetRadioStations: empty('internetRadioStations', { internetRadioStation: [] }),
      getBookmarks: empty('bookmarks', { bookmark: [] }),
      getShares: empty('shares', { share: [] }),
      getPlayQueue: () => ({}),
      savePlayQueue: () => ({}),
    };
  }
}

/** Query string plus (for POST) a form-encoded body, as OpenSubsonic clients may send. */
async function readParams(req, url) {
  const params = new URLSearchParams(url.search);
  if (req.method === 'POST' && /^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100_000) break;
    }
    for (const [k, v] of new URLSearchParams(body)) params.append(k, v);
  }
  return params;
}
