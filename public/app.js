// Musicplayer front end. No framework, no build step, nothing loaded from the internet.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const audio = $('#audio');
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const canDownload = 'caches' in window && 'serviceWorker' in navigator && window.isSecureContext;
const AUDIO_CACHE = 'mp-audio-v1';
const COVER_CACHE = 'mp-covers-v1';

const ls = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem('mp.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => localStorage.setItem('mp.' + k, JSON.stringify(v)),
};

const state = {
  tracks: new Map(),
  playlists: [],
  jobs: [],
  tools: null,
  musicDir: '',
  scanning: false,
  offline: false,
  serverDown: false,
  cached: new Set(), // track ids stored on this device
  downloaded: new Set(ls.get('downloaded', [])), // playlist ids marked for download
  dlProgress: new Map(),
  selection: new Set(),
  anchor: null,
  route: { name: 'library' },
  openLogs: new Set(),
  viewFilter: '', // text in the playlist filter box (cleared when you leave the playlist)
};

const player = {
  ctx: null, // { type: 'playlist', id, name, ids: [] }
  order: [],
  pos: -1,
  current: null,
  shuffle: ls.get('shuffle', false),
  repeat: ls.get('repeat', 'off'), // off | all | one
};

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = 'i') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
function fmtTotal(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} hr ${m} min`;
  return `${m} min ${sec % 60} sec`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    setOffline(true);
    throw new Error(OFFLINE_MSG);
  }
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const OFFLINE_MSG = "Can't reach the Musicplayer server. Changes need a connection.";
function setOffline(on) {
  if (state.offline === on) return;
  state.offline = on;
  $('#offline-banner').hidden = !on;
  render();
}

function guardOnline() {
  if (state.offline) {
    toast(OFFLINE_MSG);
    return false;
  }
  return true;
}

// ---------- audio format support ----------
const EXT_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  opus: 'audio/ogg; codecs="opus"', ogg: 'audio/ogg; codecs="vorbis"', oga: 'audio/ogg; codecs="vorbis"',
  flac: 'audio/flac', wav: 'audio/wav', webm: 'audio/webm; codecs="opus"', weba: 'audio/webm; codecs="opus"',
};
const unplayable = new Set(ls.get('unplayable', []));
const playable = {};
function streamUrl(id) {
  const ext = id.split('.').pop().toLowerCase();
  playable[ext] ??= !unplayable.has(ext) && audio.canPlayType(EXT_TYPES[ext] || '') !== '';
  return `/api/stream?id=${encodeURIComponent(id)}${playable[ext] ? '' : '&fmt=aac'}`;
}

// ---------- data ----------
/**
 * fresh = ask the server now (live updates, reconnect). Without it the service worker answers
 * instantly from its cache and refreshes in the background, so the app opens immediately.
 */
const fetchData = (path, fresh) => fetch(path, fresh ? { cache: 'no-store' } : undefined);
const timeoutSignal = (ms) => (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

async function loadLibrary(fresh = false) {
  const res = await fetchData('/api/library', fresh);
  if (res.status === 401) location.replace('/login');
  if (!res.ok) throw new Error('Library unavailable');
  if (fresh) state.offline = res.headers.get('X-Musicplayer-Offline') === '1';
  const data = await res.json();
  state.tracks = new Map(data.tracks.map((t) => [t.id, t]));
  state.scanning = data.scanning;
  state.musicDir = data.musicDir;
  state.authEnabled = !!data.authEnabled;
  $('#offline-banner').hidden = !state.offline;
}
async function loadPlaylists(fresh = false) {
  const res = await fetchData('/api/playlists', fresh);
  if (!res.ok) throw new Error('Playlists unavailable');
  state.playlists = (await res.json()).playlists;
}
async function loadJobs() {
  if (state.offline) return;
  try {
    state.jobs = (await api('/api/jobs')).jobs;
  } catch {
    /* ignore */
  }
}
const getPlaylist = (id) => state.playlists.find((p) => p.id === id);
const playlistIds = (p) => p.trackIds.filter((id) => state.tracks.has(id));
const available = (id) => state.tracks.has(id) && (!state.offline || state.cached.has(id));

// ---------- covers & tints ----------
function coverHtml(cover, cls = '') {
  return cover
    ? `<div class="cover ${cls}"><img src="/covers/${cover}" alt="" loading="lazy" decoding="async"></div>`
    : `<div class="cover empty ${cls}">${icon('note')}</div>`;
}
/** Spotify-style playlist art: 2x2 mosaic of the first four different covers, else the first cover. */
function coversOf(ids) {
  const out = [];
  for (const id of ids) {
    const c = state.tracks.get(id)?.cover;
    if (c && !out.includes(c)) out.push(c);
    if (out.length === 4) break;
  }
  return out;
}
function mosaicHtml(ids, cls = '') {
  const covers = coversOf(ids);
  if (covers.length === 4) return `<div class="cover mosaic ${cls}">${covers.map((c) => `<img src="/covers/${c}" alt="" loading="lazy">`).join('')}</div>`;
  return coverHtml(covers[0], cls);
}

const tintCache = new Map();
function tintFor(cover) {
  if (!cover) return Promise.resolve(null);
  if (!tintCache.has(cover)) {
    tintCache.set(cover, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 10;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(img, 0, 0, 10, 10);
          const d = x.getImageData(0, 0, 10, 10).data;
          // Weighted average favouring saturated pixels.
          let r = 0, g = 0, b = 0, w = 0;
          for (let i = 0; i < d.length; i += 4) {
            const mx = Math.max(d[i], d[i + 1], d[i + 2]);
            const mn = Math.min(d[i], d[i + 1], d[i + 2]);
            const wt = 1 + (mx - mn) / 32;
            r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
          }
          const rgb = [r / w, g / w, b / w];
          const k = 150 / Math.max(60, ...rgb);
          resolve(rgb.map((v) => Math.round(Math.min(255, v * k))));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = '/covers/' + cover;
    }));
  }
  return tintCache.get(cover);
}
const rgb = (c, k = 1) => `rgb(${c.map((v) => Math.round(v * k)).join(',')})`;

// ---------- routing & rendering ----------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  if (name === 'playlist' && rest[0]) return { name: 'playlist', id: decodeURIComponent(rest.join('/')) };
  if (name === 'import') return { name };
  return { name: 'library' };
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSidebar();
    renderView();
    renderBadge();
  });
}

function renderSidebar() {
  $('#side-playlists').innerHTML = playlistListHtml();
  for (const a of $$('[data-nav]')) a.classList.toggle('active', a.dataset.nav === state.route.name);
}

function playlistListHtml() {
  if (!state.playlists.length) return `<div class="empty-hint" style="padding:12px">Create a playlist with <b>+</b>, or import one.</div>`;
  return state.playlists
    .map((p) => {
      const ids = playlistIds(p);
      const active = state.route.name === 'playlist' && state.route.id === p.id;
      const playing = player.ctx?.type === 'playlist' && player.ctx.id === p.id;
      const dl = state.downloaded.has(p.id);
      return `<div class="pl-item ${active ? 'active' : ''} ${playing ? 'playing' : ''}" data-playlist="${esc(p.id)}">
        ${mosaicHtml(ids)}
        <div class="pl-item-text">
          <div class="pl-item-name">${esc(p.name)}</div>
          <div class="pl-item-sub">${dl ? icon('downloaded') : ''}Playlist · ${plural(ids.length, 'song')}</div>
        </div>
      </div>`;
    })
    .join('');
}

function renderBadge() {
  const n = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const b = $('#import-badge');
  b.hidden = !n;
  b.textContent = n;
}

function renderView() {
  const view = $('#view');
  const r = state.route;
  if (state.serverDown) {
    view.innerHTML = `<div class="empty-hint" style="padding-top:80px"><h3>Can't reach Musicplayer</h3>
      Start the server on your PC (<code>npm start</code>) and reload. Downloaded songs only work after the app has loaded once.</div>`;
    return;
  }
  if (r.name === 'import') {
    if (!$('#import-form')) view.innerHTML = importHtml();
    renderJobs();
    renderTools();
    return;
  }
  if (r.name === 'library') {
    view.innerHTML = `<div class="lib-head"><h1><img src="/icons/icon-192.png" alt="">Your Library</h1>
        <span style="display:flex;gap:4px">${state.authEnabled ? `<button class="icon-btn" data-action="sign-out" title="Sign out">${icon('close')}</button>` : ''}<button class="icon-btn" data-action="new-playlist" aria-label="Create playlist">${icon('plus')}</button></span></div>
      ${canDownload ? `<div class="lib-offline">${icon('downloaded')}${state.cached.size ? `${plural(state.cached.size, 'song')} stored on this device for offline use` : 'No songs stored on this device yet. Tap the download arrow on a playlist.'}</div>` : ''}
      <div class="lib-list">
        ${state.playlists.length ? playlistListHtml() : `<div class="empty-hint"><h3>No playlists yet</h3>
          Create one and add songs from your music folder, or import a playlist from YouTube or Spotify.
          <div style="display:flex;gap:12px;margin-top:16px;flex-wrap:wrap">
            <button class="btn" data-action="new-playlist">${icon('plus')}Create playlist</button>
            <a class="btn ghost" href="#/import">${icon('import')}Import</a></div></div>`}
      </div>`;
    return;
  }

  const p = getPlaylist(r.id);
  if (!p) {
    view.innerHTML = `<div class="empty-hint" style="padding-top:80px"><h3>Playlist not found</h3>It may have been deleted. <a href="#/library"><b>Back to your library</b></a></div>`;
    return;
  }
  const ids = playlistIds(p);
  const ctx = { type: 'playlist', id: p.id, name: p.name };
  const total = ids.reduce((s, id) => s + (state.tracks.get(id)?.duration || 0), 0);
  const sub = `<b>${plural(ids.length, 'song')}</b>${ids.length ? ', ' + fmtTotal(total) : ''}`;
  const ctxPlaying = isCtx(ctx) && !audio.paused;
  const dl = state.downloaded.has(p.id);
  const prog = state.dlProgress.get(p.id);
  // A live update can redraw the page while you type in the filter: keep focus and cursor.
  const typing = document.activeElement?.id === 'pl-filter' ? document.activeElement.selectionStart : null;

  view.innerHTML = `
    <button class="icon-btn back-btn" data-action="back" aria-label="Back">${icon('back')}</button>
    <header class="view-head" id="view-head">
      ${mosaicHtml(ids)}
      <div class="view-head-text">
        <div class="eyebrow">Playlist</div>
        <h1 class="view-title editable" data-action="rename-playlist" title="Rename">${esc(p.name)}</h1>
        <div class="view-sub">${sub}</div>
      </div>
    </header>
    <div class="view-body">
      <div class="actions">
        <button class="play-btn accent" data-action="play-view" aria-label="Play">${icon(ctxPlaying ? 'pause' : 'play')}</button>
        <button class="icon-btn toggle ${player.shuffle ? 'on' : ''}" data-action="shuffle" title="Shuffle">${icon('shuffle')}</button>
        <button class="icon-btn ${dl ? 'is-downloaded' : ''}" data-action="download-toggle" title="${dl ? 'Downloaded · tap to remove' : 'Download to this device'}" aria-label="${dl ? 'Downloaded, remove download' : 'Download to this device'}">${icon(dl ? 'downloaded' : 'download')}</button>
        <button class="icon-btn" data-action="add-menu" title="Add songs">${icon('plus')}</button>
        <button class="icon-btn" data-action="playlist-menu" title="More options">${icon('more')}</button>
        <span class="dl-progress">${prog ? `Downloading ${prog.done}/${prog.total}` : ''}</span>
        ${ids.length ? `<div class="view-tools">
          <label class="pl-filter">${icon('search')}<input id="pl-filter" type="search" placeholder="Filter" value="${esc(state.viewFilter)}" autocomplete="off" aria-label="Filter songs in this playlist"></label>
          <select id="pl-sort" class="sort-select" aria-label="Sort songs">${Object.entries(SORTS)
            .map(([k, label]) => `<option value="${k}" ${getSort(p.id) === k ? 'selected' : ''}>${label}</option>`)
            .join('')}</select>
        </div>` : ''}
      </div>
      <div class="pl-jobs" id="pl-jobs"></div>
      ${ids.length ? `<div id="track-list">${tracksHtml(p, displayIds(p))}</div>` : `<div class="empty-hint"><h3>This playlist is empty</h3>
        Search for a song, paste a YouTube, Spotify or SoundCloud link, or upload files.
        <div style="display:flex;gap:12px;margin-top:16px;flex-wrap:wrap">
          <button class="btn" data-action="search-songs">${icon('search')}Search for a song</button>
          <button class="btn ghost" data-action="add-link">${icon('import')}Add from link</button>
          <button class="btn ghost" data-action="upload">${icon('plus')}Upload files</button>
          <button class="btn ghost" data-action="add-songs">${icon('note')}From music folder</button></div></div>`}
    </div>`;

  // Header tint from the first cover, like Spotify.
  const head = $('#view-head');
  tintFor(coversOf(ids)[0]).then((c) => {
    if (!c || !head.isConnected) return;
    head.style.setProperty('--tint', rgb(c));
    head.style.setProperty('--tint-2', rgb(c, 0.45));
  });
  if (typing !== null) {
    const input = $('#pl-filter');
    input?.focus();
    input?.setSelectionRange(typing, typing);
  }
  renderPlaylistJobs();
  markPlaying();
}

/** The only place songs outside playlists are listed: a picker to add them to this playlist. */
async function addSongsPicker(pid) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  const inPlaylist = new Set(p.trackIds);
  const pool = [...state.tracks.values()]
    .filter((t) => !inPlaylist.has(t.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!pool.length) {
    return toast(state.tracks.size ? 'Every song in your music folder is already in this playlist.' : 'Your music folder is empty. Copy files into it or use Import.');
  }
  const chosen = new Set();
  const ids = await modal(
    `<h2>Add songs to ${esc(p.name)}</h2>
     <input class="input" data-filter placeholder="Filter by title, artist or album">
     <div class="picker" data-list></div>
     <div class="btns"><button class="btn ghost" data-x>Cancel</button><button class="btn" data-ok disabled>Add</button></div>`,
    (el, done) => {
      const list = $('[data-list]', el);
      const ok = $('[data-ok]', el);
      const filter = $('[data-filter]', el);
      const draw = () => {
        const q = filter.value.trim().toLowerCase();
        const rows = pool.filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)).slice(0, 500);
        list.innerHTML = rows
          .map((t) => `<label class="pick" data-id="${esc(t.id)}"><input type="checkbox" ${chosen.has(t.id) ? 'checked' : ''}>${coverHtml(t.cover)}
            <span class="t-text"><span class="t-title">${esc(t.title)}</span><span class="t-artist">${esc(t.artist || 'Unknown artist')}</span></span></label>`)
          .join('') || '<div class="empty-hint">No matches</div>';
      };
      list.addEventListener('change', (e) => {
        const id = e.target.closest('.pick').dataset.id;
        e.target.checked ? chosen.add(id) : chosen.delete(id);
        ok.disabled = !chosen.size;
        ok.textContent = chosen.size ? `Add ${plural(chosen.size, 'song')}` : 'Add';
      });
      filter.addEventListener('input', draw);
      draw();
      if (!isMobile()) filter.focus();
      $('[data-x]', el).onclick = () => done(null);
      ok.onclick = () => done([...chosen]);
    },
  );
  if (ids?.length) addToPlaylist(pid, ids);
}

function trackTableHtml(ids) {
  // Rows stay draggable onto sidebar playlists even when sorted; reordering is checked on drop.
  const drag = !isMobile();
  const rows = ids.map((id, i) => {
    const t = state.tracks.get(id);
    const cls = [
      state.selection.has(id) ? 'selected' : '',
      available(id) ? '' : 'unavailable',
    ].join(' ');
    return `<div class="tr ${cls}" data-id="${esc(id)}" draggable="${drag}">
      <div class="t-num"><span>${i + 1}</span>${icon('play', 'i play')}<div class="eq"><i></i><i></i><i></i></div></div>
      <div class="t-main">${coverHtml(t.cover)}<div class="t-text"><div class="t-title">${esc(t.title)}</div><div class="t-artist">${state.cached.has(id) ? icon('downloaded', 't-dl') : ''}${esc(t.artist || 'Unknown artist')}</div></div></div>
      <div class="t-album">${esc(t.album)}</div>
      <div class="t-dur">${fmtTime(t.duration)}</div>
      <button class="icon-btn t-more" data-action="track-menu" aria-label="More options">${icon('more')}</button>
    </div>`;
  });
  return `<div class="tracks" data-playlist-view="${esc(state.route.id)}">
    <div class="tr head"><div class="t-num">#</div><div>Title</div><div class="t-album">Album</div><div class="t-dur">${icon('clock')}</div><div></div></div>
    ${rows.join('')}
  </div>`;
}

// ---------- filter & sort within a playlist ----------
const SORTS = {
  custom: 'Custom order',
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  added: 'Recently added',
  duration: 'Length',
};
const getSort = (pid) => ls.get('sort', {})[pid] || 'custom';
function setSort(pid, key) {
  const all = ls.get('sort', {});
  if (key === 'custom') delete all[pid];
  else all[pid] = key;
  ls.set('sort', all);
}
const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** The songs of a playlist as shown: filtered by the search box and in the chosen order. */
function displayIds(p) {
  let ids = playlistIds(p);
  const q = state.viewFilter.trim().toLowerCase();
  if (q) {
    ids = ids.filter((id) => {
      const t = state.tracks.get(id);
      return `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q);
    });
  }
  const key = getSort(p.id);
  if (key === 'custom') return ids;
  const t = (id) => state.tracks.get(id);
  const cmp = {
    title: (a, b) => byText(t(a).title, t(b).title),
    artist: (a, b) => byText(t(a).artist || '￿', t(b).artist || '￿') || byText(t(a).title, t(b).title),
    album: (a, b) => byText(t(a).album || '￿', t(b).album || '￿') || byText(t(a).title, t(b).title),
    added: (a, b) => (t(b).addedAt || 0) - (t(a).addedAt || 0),
    duration: (a, b) => (t(a).duration || 0) - (t(b).duration || 0),
  }[key];
  return [...ids].sort(cmp);
}
/** Drag-to-reorder only makes sense in the playlist's own order without a filter. */
const canReorder = (pid) => getSort(pid) === 'custom' && !state.viewFilter.trim();

function tracksHtml(p, shown) {
  if (shown.length) return trackTableHtml(shown);
  return `<div class="empty-hint">No songs match “${esc(state.viewFilter.trim())}”.</div>`;
}

function currentViewIds() {
  if (state.route.name === 'playlist') {
    const p = getPlaylist(state.route.id);
    return p ? displayIds(p) : [];
  }
  return [];
}
function currentViewCtx() {
  if (state.route.name === 'playlist') {
    const p = getPlaylist(state.route.id);
    return p && { type: 'playlist', id: p.id, name: p.name, ids: displayIds(p) };
  }
  return null;
}
const isCtx = (c) => player.ctx && c && player.ctx.type === c.type && player.ctx.id === c.id;

function markPlaying() {
  const playing = !audio.paused;
  for (const row of $$('.tr[data-id]')) {
    const on = row.dataset.id === player.current;
    row.classList.toggle('playing', on);
    row.classList.toggle('is-playing', on && playing);
  }
  const btn = $('[data-action="play-view"]');
  if (btn) btn.innerHTML = icon(isCtx(currentViewCtx()) && playing ? 'pause' : 'play');
  for (const el of $$('.pl-item[data-playlist]')) {
    el.classList.toggle('playing', player.ctx?.type === 'playlist' && player.ctx.id === el.dataset.playlist);
  }
}

// ---------- import view ----------
function importHtml() {
  return `<div class="import-view">
    <h1>Import</h1>
    <p>Paste a link to a playlist, album or song from YouTube, YouTube Music, Spotify, SoundCloud, Bandcamp or any other site yt-dlp supports. Each import becomes a new playlist (single songs go to "Singles"), downloaded into your music folder so it keeps working without internet.</p>
    <form class="import-form" id="import-form" autocomplete="off">
      <div class="field"><label for="imp-url">Link</label>
        <input class="input" id="imp-url" name="url" type="url" inputmode="url" placeholder="https://www.youtube.com/playlist?list=…" required></div>
      <button class="btn" type="submit" style="align-self:end">${icon('import')}Import</button>
    </form>
    <div class="sources" id="tools"></div>
    <div class="jobs" id="jobs"></div>
    <div class="help">
      <h3>Your own files</h3>
      Copy music into <code>${esc(state.musicDir)}</code> (subfolders are fine). Musicplayer picks up changes automatically.
      <div style="margin-top:10px"><button class="btn ghost" data-action="rescan">${icon('refresh')}Rescan now</button></div>
    </div>
  </div>`;
}

async function renderTools() {
  const el = $('#tools');
  if (!el) return;
  if (!state.tools && !state.offline) {
    try {
      state.tools = await api('/api/tools');
    } catch {
      return;
    }
  }
  const t = state.tools || {};
  const chip = (name, v, hint) => `<span class="chip ${v ? 'ok' : 'bad'}" title="${esc(v || hint)}">${name} ${v ? '✓' : '✗ missing'}</span>`;
  const u = t.update;
  const updated = u?.lastCheck
    ? `<span class="chip ${u.ok ? '' : 'bad'}" title="Checked daily">${esc(u.message)} · ${new Date(u.lastCheck).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>`
    : u ? `<span class="chip" title="Checked daily">${esc(u.message)}</span>` : '';
  el.innerHTML = chip('yt-dlp', t.ytdlp, 'Needed for YouTube & co.') + chip('spotDL', t.spotdl, 'Needed for Spotify') + chip('ffmpeg', t.ffmpeg, 'Needed for all imports') + updated;
}

// ---------- duplicate detection (same rules as server/titles.js sameSong) ----------
const songKey = (s) =>
  String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const mainArtistKey = (a) => songKey(String(a ?? '').split(/,|&|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+with\s+/i)[0]);
const youtubeIdOf = (trackId) => /\[([\w-]{11})\]\.\w+$/.exec(String(trackId))?.[1] ?? null;
/** YouTube video id in a link: watch?v=…, youtu.be/…, shorts/…, music.youtube.com/watch?v=… */
const youtubeIdOfUrl = (url) => /(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/.exec(String(url))?.[1] ?? null;

/** A song already in the library: same YouTube video, or same title by the same main artist. */
function findInLibrary({ youtubeId, title, artist }) {
  if (youtubeId) {
    for (const t of state.tracks.values()) if (youtubeIdOf(t.id) === youtubeId) return t;
  }
  const tk = songKey(title);
  if (!tk) return null;
  const x = mainArtistKey(artist);
  for (const t of state.tracks.values()) {
    if (songKey(t.title) !== tk) continue;
    const y = mainArtistKey(t.artist);
    if (!x || !y ? !x && !y : x.includes(y) || y.includes(x)) return t;
  }
  return null;
}
const playlistNamesWith = (trackId) => state.playlists.filter((p) => p.trackIds.includes(trackId)).map((p) => p.name);
const quoteList = (names) => names.map((n) => `“${n}”`).join(', ');

/** Dialog with several choices; resolves to the chosen value, or null when closed. */
function choiceModal({ title, text, choices }) {
  return modal(
    `<h2>${esc(title)}</h2><p>${esc(text)}</p>
     <div class="btns">${choices
       .map((c, i) => `<button class="btn ${c.primary ? '' : 'ghost'}" data-choice="${i}">${esc(c.label)}</button>`)
       .join('')}</div>`,
    (el, done) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-choice]');
        if (b) done(choices[b.dataset.choice].value);
      });
      el.querySelector('.btn:not(.ghost)')?.focus();
    },
  );
}

// ---------- adding songs: search, link, upload ----------
/** Search online for a song and add it to the playlist (downloaded like "Add from link"). */
async function searchSongs(pid) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  await modal(
    `<h2>Add songs to ${esc(p.name)}</h2>
     <form class="search-form"><input class="input" name="q" maxlength="200" placeholder="Song, artist…" autocomplete="off" enterkeyhint="search">
       <button class="btn" type="submit">${icon('search')}Search</button></form>
     <div class="search-results" data-results><div class="search-hint">Search YouTube Music for a song, then add it.</div></div>
     <div class="btns"><button class="btn ghost" data-x>Done</button></div>`,
    (el, done) => {
      const box = $('[data-results]', el);
      const input = $('input', el);
      let results = [];
      // In this playlist, somewhere else in the library (then Add reuses that copy), or being added.
      const status = (r) => {
        const match = findInLibrary({ youtubeId: r.id, title: r.title, artist: r.artist });
        if (match && getPlaylist(pid)?.trackIds.includes(match.id)) return { s: 'in', match };
        if (state.jobs.some((j) => j.target === pid && j.url === r.url && (j.status === 'queued' || j.status === 'running'))) return { s: 'adding' };
        if (match) return { s: 'library', match };
        return { s: '' };
      };
      const draw = () => {
        box.innerHTML = results.length
          ? results.map((r, i) => {
              const { s, match } = status(r);
              const where = s === 'library' ? playlistNamesWith(match.id) : [];
              const note = s === 'library'
                ? `<div class="t-dup">Already in your library${where.length ? ` · in ${esc(quoteList(where))}` : ''}: adds that copy</div>`
                : '';
              return `<div class="search-row">
                <div class="cover"><img src="https://i.ytimg.com/vi/${esc(r.id)}/mqdefault.jpg" alt="" loading="lazy"></div>
                <div class="t-text"><div class="t-title">${esc(r.title)}</div><div class="t-artist">${esc(r.artist || 'Unknown artist')}${r.duration ? ` · ${fmtTime(r.duration)}` : ''}</div>${note}</div>
                <button class="btn ${s === 'in' || s === 'adding' ? 'ghost' : ''}" data-add="${i}" ${s === 'in' || s === 'adding' ? 'disabled' : ''}>${s === 'in' ? 'In playlist' : s === 'adding' ? 'Adding…' : 'Add'}</button>
              </div>`;
            }).join('')
          : '<div class="search-hint">No songs found.</div>';
      };
      $('form', el).onsubmit = async (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        box.innerHTML = '<div class="search-hint">Searching…</div>';
        try {
          results = (await api(`/api/search?q=${encodeURIComponent(q)}`)).results;
          draw();
        } catch (err) {
          box.innerHTML = `<div class="search-hint">${esc(err.message)}</div>`;
        }
      };
      box.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-add]');
        if (!b) return;
        const r = results[b.dataset.add];
        b.disabled = true;
        b.textContent = 'Adding…';
        const { s, match } = status(r);
        if (s === 'library') {
          // Already downloaded for another playlist: reuse that file, no second download.
          await addToPlaylist(pid, [match.id]);
          draw();
          return;
        }
        try {
          await api('/api/import', { method: 'POST', body: { url: r.url, target: pid, single: true } });
          await loadJobs();
          renderPlaylistJobs();
          renderBadge();
        } catch (err) {
          toast(err.message);
        }
        draw();
      });
      $('[data-x]', el).onclick = () => done(null);
      if (!isMobile()) input.focus();
    },
  );
}

/** Add one song from a YouTube / Spotify / SoundCloud / … link to a playlist. */
async function addFromLink(pid) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  const url = await promptModal({
    title: `Add a song to ${p.name}`,
    ok: 'Add',
    placeholder: 'https://youtu.be/… · open.spotify.com/track/… · soundcloud.com/…',
  });
  if (!url) return;
  // A YouTube link we already downloaded: offer the existing copy instead of a second download.
  const match = findInLibrary({ youtubeId: youtubeIdOfUrl(url) });
  if (match) {
    if (p.trackIds.includes(match.id)) return toast(`“${match.title}” is already in this playlist`);
    const where = playlistNamesWith(match.id);
    const choice = await choiceModal({
      title: 'Already in your library',
      text: `“${match.title}”${match.artist ? ` by ${match.artist}` : ''} is already downloaded${where.length ? `, in ${quoteList(where)}` : ''}. Add that copy instead of downloading it again?`,
      choices: [
        { label: 'Cancel', value: null },
        { label: 'Download again', value: 'download' },
        { label: 'Add existing', value: 'existing', primary: true },
      ],
    });
    if (!choice) return;
    if (choice === 'existing') return addToPlaylist(pid, [match.id]);
  }
  try {
    await api('/api/import', { method: 'POST', body: { url, target: pid, single: true } });
    toast('Downloading… it will appear in this playlist');
    await loadJobs();
    renderPlaylistJobs();
    renderBadge();
  } catch (err) {
    toast(err.message);
  }
}

function pickUpload(pid) {
  if (!guardOnline()) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'audio/*,.mp3,.m4a,.aac,.flac,.opus,.ogg,.oga,.wav,.webm';
  input.onchange = () => uploadFiles(pid, [...input.files]);
  input.click();
}

const AUDIO_EXTS = /\.(mp3|m4a|mp4|aac|flac|opus|ogg|oga|wav|webm|weba)$/i;
async function uploadFiles(pid, files) {
  if (!guardOnline()) return;
  files = files.filter((f) => AUDIO_EXTS.test(f.name));
  if (!files.length) return toast('No audio files selected');
  let failed = 0;
  const dups = []; // { id (the new upload), title, duplicateOf: { id, title, artist } }
  for (let i = 0; i < files.length; i++) {
    toast(`Uploading ${i + 1} of ${files.length}: ${files[i].name}`);
    try {
      const res = await fetch(`/api/playlists/${pid}/upload?name=${encodeURIComponent(files[i].name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: files[i],
      });
      if (res.status === 401) return location.replace('/login');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      if (body.duplicateOf) dups.push(body);
    } catch (err) {
      failed++;
      console.warn('Upload failed', files[i].name, err);
    }
  }
  toast(failed ? `${plural(files.length - failed, 'song')} uploaded, ${failed} failed` : `${plural(files.length, 'song')} uploaded`);
  if (dups.length) await resolveUploadDuplicates(pid, dups);
}

/** Uploaded songs that were already in the library: keep both copies, or use the existing ones. */
async function resolveUploadDuplicates(pid, dups) {
  await loadPlaylists(true).catch(() => {});
  const one = dups[0];
  const where = playlistNamesWith(one.duplicateOf.id).filter((n) => n !== getPlaylist(pid)?.name);
  const text =
    dups.length === 1
      ? `“${one.duplicateOf.title}”${one.duplicateOf.artist ? ` by ${one.duplicateOf.artist}` : ''} was already in your library${where.length ? `, in ${quoteList(where)}` : ''}. Keep both copies, or use the existing one?`
      : `These were already in your library: ${dups.slice(0, 5).map((d) => `“${d.duplicateOf.title}”`).join(', ')}${dups.length > 5 ? ` and ${dups.length - 5} more` : ''}. Keep both copies, or use the existing ones?`;
  const choice = await choiceModal({
    title: dups.length === 1 ? 'Already in your library' : `${dups.length} songs were already in your library`,
    text,
    choices: [
      { label: 'Keep both', value: 'both' },
      { label: dups.length === 1 ? 'Use existing' : 'Use existing ones', value: 'existing', primary: true },
    ],
  });
  if (choice !== 'existing') return;
  try {
    // Put the existing copies in this playlist, then take the new uploads out (they go to the trash).
    const p = getPlaylist(pid);
    const existing = [...new Set(dups.map((d) => d.duplicateOf.id))].filter((id) => !p.trackIds.includes(id));
    if (existing.length) await api(`/api/playlists/${pid}/tracks`, { method: 'POST', body: { trackIds: existing } });
    await api(`/api/playlists/${pid}/remove`, { method: 'POST', body: { trackIds: dups.map((d) => d.id) } });
    await loadPlaylists(true);
    render();
    toast(dups.length === 1 ? 'Using the existing copy · upload moved to trash' : `Using the existing copies · ${dups.length} uploads moved to trash`);
  } catch (err) {
    toast(err.message);
  }
}

/** "already in your library (in “chill”)" / "3 songs were already in your library" */
function duplicateText(dups) {
  if (dups.length === 1) {
    const where = playlistNamesWith(dups[0].existing).filter((n) => n !== getPlaylist(state.route.id)?.name);
    return `was already in your library${where.length ? ` (in ${esc(quoteList(where))})` : ''}`;
  }
  return `${dups.length} songs were already in your library`;
}

/** Progress of downloads going into the open playlist. */
function renderPlaylistJobs() {
  const el = $('#pl-jobs');
  if (!el || state.route.name !== 'playlist') return;
  // Finished jobs stay visible when something needs your attention: an error or a duplicate.
  const jobs = state.jobs.filter(
    (j) => j.target === state.route.id && j.status !== 'cancelled' && !(j.status === 'done' && !j.error && !j.duplicates?.length),
  );
  el.innerHTML = jobs
    .map((j) => {
      const active = j.status === 'running' || j.status === 'queued';
      const pct = j.total ? Math.min(100, ((j.done + (j.itemProgress || 0)) / j.total) * 100) : 0;
      const what = j.title ? `“${esc(j.title)}”` : j.source === 'spotify' ? 'song from Spotify' : 'song';
      const text = active
        ? `${j.status === 'queued' ? 'Waiting to add' : 'Adding'} ${what}${pct ? ` · ${Math.round(pct)}%` : '…'}`
        : j.status === 'error'
          ? `Couldn't add ${what}: ${esc(j.error)}`
          : j.duplicates?.length
            ? `Added ${what} · ${duplicateText(j.duplicates)}`
            : `Added ${what} (${esc(j.error)})`;
      return `<div class="pl-job ${j.status}">
        <div class="pl-job-text">${text}</div>
        ${active ? `<div class="bar ${pct ? '' : 'indeterminate'}"><div style="width:${pct}%"></div></div>` : ''}
        <button class="icon-btn" data-action="${active ? 'job-cancel' : 'pl-job-dismiss'}" data-job="${j.id}" title="${active ? 'Cancel' : 'Dismiss'}">${icon('close')}</button>
      </div>`;
    })
    .join('');
}

/** Drag audio files from your computer onto a playlist to upload them. */
function setupFileDrop() {
  const main = $('#main');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  main.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || state.route.name !== 'playlist') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    main.classList.add('file-drop');
  });
  main.addEventListener('dragleave', (e) => {
    if (!main.contains(e.relatedTarget)) main.classList.remove('file-drop');
  });
  main.addEventListener('drop', (e) => {
    main.classList.remove('file-drop');
    if (!hasFiles(e) || state.route.name !== 'playlist') return;
    e.preventDefault();
    uploadFiles(state.route.id, [...e.dataTransfer.files]);
  });
}

function renderJobs() {
  const el = $('#jobs');
  if (!el) return;
  if (!state.jobs.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = '<h2>Imports</h2>' + state.jobs.map((j) => {
    const pct = j.total ? Math.min(100, ((j.done + (j.itemProgress || 0)) / j.total) * 100) : 0;
    const statusText = {
      queued: 'Waiting…',
      running: j.total ? `Downloading ${Math.min(j.done + 1, j.total)} of ${j.total}` : 'Starting…',
      done: `Done · ${plural(j.imported, 'song')}`,
      error: 'Failed',
      cancelled: 'Cancelled',
    }[j.status];
    const active = j.status === 'running' || j.status === 'queued';
    const link = j.playlistIds?.[0] ? `<a class="btn ghost" style="height:32px;padding:0 14px" href="#/playlist/${encodeURIComponent(j.playlistIds[0])}">Open</a>` : '';
    return `<div class="job" data-job="${j.id}">
      <div class="job-top">
        <div class="job-title">${esc(j.title || (j.source === 'spotify' ? 'Spotify import' : 'Import'))}</div>
        <span class="job-status ${j.status}">${statusText}</span>
        ${link}
        <button class="icon-btn" data-action="${active ? 'job-cancel' : 'job-dismiss'}" title="${active ? 'Cancel' : 'Dismiss'}">${icon('close')}</button>
      </div>
      <div class="job-url">${esc(j.url)}</div>
      ${active ? `<div class="bar ${j.total ? '' : 'indeterminate'}"><div style="width:${pct}%"></div></div>` : ''}
      ${j.error ? `<div class="job-error">${esc(j.error)}</div>` : ''}
      ${j.duplicates?.length ? `<div class="job-dup">${j.duplicates.length === 1 ? '1 song was' : `${j.duplicates.length} songs were`} already in your library${j.duplicates.length <= 5 ? `: ${j.duplicates.map((d) => `“${esc(d.title)}”`).join(', ')}` : ''}</div>` : ''}
      ${j.log?.length ? `<details ${state.openLogs.has(j.id) ? 'open' : ''}><summary>Log</summary><pre>${esc(j.log.join('\n'))}</pre></details>` : ''}
    </div>`;
  }).join('');
}

// ---------- playback ----------
function shuffled(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildOrder(startId) {
  const ids = player.ctx.ids;
  let idx = startId != null ? ids.indexOf(startId) : -1;
  if (player.shuffle) {
    const rest = shuffled(ids.map((_, i) => i).filter((i) => i !== idx));
    player.order = idx >= 0 ? [idx, ...rest] : rest;
    player.pos = 0;
  } else {
    player.order = ids.map((_, i) => i);
    player.pos = Math.max(0, idx);
  }
}

function playContext(ctx, startId) {
  if (!ctx?.ids.length) return;
  player.ctx = ctx;
  buildOrder(startId);
  let id = ctx.ids[player.order[player.pos]];
  if (!available(id)) {
    const next = findPlayable(1);
    if (next == null) return toast('Nothing here is available offline.');
    player.pos = next;
    id = ctx.ids[player.order[next]];
  }
  load(id, true);
}

/** Position of the next playable track in direction dir, honouring repeat-all; null if none. */
function findPlayable(dir, wrap = player.repeat === 'all') {
  const n = player.order.length;
  let p = player.pos;
  for (let k = 0; k < n; k++) {
    p += dir;
    if (p >= n || p < 0) {
      if (!wrap) return null;
      p = (p + n) % n;
    }
    if (available(player.ctx.ids[player.order[p]])) return p;
  }
  return null;
}

function step(dir, auto = false) {
  if (!player.ctx) return;
  if (auto && player.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let p = findPlayable(dir);
  if (p == null) {
    // End of the list: go back to the first track, paused (manual "next" wraps too).
    if (dir > 0) {
      const first = player.order.findIndex((i) => available(player.ctx.ids[i]));
      if (first < 0) return;
      player.pos = first;
      load(player.ctx.ids[player.order[first]], !auto);
    } else {
      audio.currentTime = 0;
    }
    return;
  }
  player.pos = p;
  load(player.ctx.ids[player.order[p]], true);
}

function prev() {
  if (audio.currentTime > 3 || !player.ctx) {
    audio.currentTime = 0;
    return;
  }
  step(-1);
}

let pendingSeek = 0;
let blobUrl = null;
function load(id, autoplay, startAt = 0) {
  const t = state.tracks.get(id);
  if (!t) return;
  player.current = id;
  pendingSeek = startAt;
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
  audio.src = streamUrl(id);
  if (autoplay) audio.play().catch(() => {});
  updateNowPlaying();
  saveSession();
}

function togglePlay() {
  if (!player.current) {
    const ctx = currentViewCtx();
    if (!ctx) return toast('Open a playlist to start playing.');
    return playContext(ctx);
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function toggleShuffle() {
  player.shuffle = !player.shuffle;
  ls.set('shuffle', player.shuffle);
  if (player.ctx) buildOrder(player.current);
  updateButtons();
  toast(player.shuffle ? 'Shuffle on' : 'Shuffle off');
}

function cycleRepeat() {
  player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  ls.set('repeat', player.repeat);
  updateButtons();
  toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[player.repeat]);
}

function updateButtons() {
  const playing = !audio.paused;
  for (const b of $$('[data-action="toggle"]')) b.innerHTML = icon(playing ? 'pause' : 'play');
  for (const b of $$('[data-action="shuffle"]')) b.classList.toggle('on', player.shuffle);
  for (const b of $$('[data-action="repeat"]')) {
    b.classList.toggle('on', player.repeat !== 'off');
    b.innerHTML = icon(player.repeat === 'one' ? 'repeat-one' : 'repeat');
  }
  const muteBtn = $('[data-action="mute"]');
  if (muteBtn) muteBtn.innerHTML = icon(audio.muted || audio.volume === 0 ? 'mute' : 'volume');
  markPlaying();
}

function updateNowPlaying() {
  const t = state.tracks.get(player.current);
  $('#player').classList.toggle('empty', !t);
  if (!t) return;
  $('#np-cover').outerHTML = coverHtml(t.cover, 'np-cover').replace('<div', '<div id="np-cover"');
  $('#np-title').textContent = t.title;
  $('#np-artist').textContent = t.artist || 'Unknown artist';
  $('#fs-cover').outerHTML = coverHtml(t.cover, 'fs-cover').replace('<div', '<div id="fs-cover"');
  $('#fs-title').textContent = t.title;
  $('#fs-artist').textContent = t.artist || 'Unknown artist';
  $('#fs-context').textContent = player.ctx ? player.ctx.name : '';
  document.title = `${t.title}${t.artist ? ' · ' + t.artist : ''} – Musicplayer`;
  tintFor(t.cover).then((c) => {
    if (player.current !== t.id) return;
    $('#player').style.setProperty('--mini-bg', c ? rgb(c, 0.55) : '#3a3a3a');
    $('#fs-bg').style.setProperty('--tint', c ? rgb(c, 0.8) : '#444');
  });
  if ('mediaSession' in navigator) {
    const art = t.cover
      ? [{ src: new URL('/covers/' + t.cover, location.href).href, sizes: '512x512', type: t.cover.endsWith('.png') ? 'image/png' : 'image/jpeg' }]
      : [{ src: new URL('/icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art });
  }
  markPlaying();
}

let seeking = false;
/** Song length in seconds. Safari can report Infinity/NaN while streaming; fall back to the scanned length. */
function trackDuration() {
  const d = audio.duration;
  return Number.isFinite(d) && d > 0 ? d : state.tracks.get(player.current)?.duration || 0;
}
function updateTime() {
  const d = trackDuration();
  const c = audio.currentTime || 0;
  const pct = d ? (c / d) * 100 : 0;
  if (!seeking) {
    for (const s of [$('#seek'), $('#fs-seek')]) {
      s.value = Math.round(pct * 10);
      s.style.setProperty('--pct', pct + '%');
    }
    $('#t-cur').textContent = $('#fs-cur').textContent = fmtTime(c);
  }
  $('#t-dur').textContent = $('#fs-dur').textContent = fmtTime(d);
  $('#mini-progress-fill').style.width = pct + '%';
}

function saveSession() {
  if (!player.current) return;
  ls.set('session', {
    ctx: player.ctx && { type: player.ctx.type, id: player.ctx.id, name: player.ctx.name, ids: player.ctx.ids },
    current: player.current,
    time: Math.floor(audio.currentTime || pendingSeek || 0),
  });
}

function restoreSession() {
  const vol = ls.get('volume', 0.8);
  audio.volume = vol;
  setVolumeUi(vol);
  const s = ls.get('session', null);
  if (!s || !state.tracks.has(s.current)) return;
  if (s.ctx) {
    player.ctx = { ...s.ctx, ids: s.ctx.ids.filter((id) => state.tracks.has(id)) };
    buildOrder(s.current);
  }
  load(s.current, false, s.time || 0);
}

function setVolumeUi(v) {
  const el = $('#volume');
  el.value = Math.round(v * 100);
  el.style.setProperty('--pct', v * 100 + '%');
}

function setupPlayer() {
  audio.addEventListener('play', updateButtons);
  audio.addEventListener('pause', () => {
    updateButtons();
    saveSession();
  });
  audio.addEventListener('ended', () => step(1, true));
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek) {
      audio.currentTime = Math.min(pendingSeek, Math.max(0, trackDuration() - 1));
      pendingSeek = 0;
    }
    updateTime();
  });
  let lastSave = 0;
  audio.addEventListener('timeupdate', () => {
    updateTime();
    const now = Date.now();
    if (now - lastSave > 5000) {
      lastSave = now;
      saveSession();
      const dur = trackDuration();
      if ('mediaSession' in navigator && dur) {
        try {
          navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(audio.currentTime, dur), playbackRate: audio.playbackRate || 1 });
        } catch {
          /* ignore */
        }
      }
    }
  });
  audio.addEventListener('error', async () => {
    if (!player.current) return;
    const src = audio.getAttribute('src') || '';
    const ext = player.current.split('.').pop().toLowerCase();
    // Offline and downloaded: some iOS versions load audio outside the service worker,
    // so play the stored copy directly from the device instead.
    if (!src.startsWith('blob:') && state.cached.has(player.current) && (state.offline || !navigator.onLine)) {
      if (await playFromStorage(player.current)) return;
    }
    // The browser claimed it could play this format but couldn't: fall back to server-side AAC.
    if (!src.includes('fmt=aac') && !state.offline) {
      unplayable.add(ext);
      ls.set('unplayable', [...unplayable]);
      playable[ext] = false;
      const t = audio.currentTime;
      load(player.current, true, t);
      return;
    }
    toast(`Can't play "${state.tracks.get(player.current)?.title}"`);
    setTimeout(() => step(1, true), 800);
  });
  window.addEventListener('pagehide', saveSession);

  for (const s of [$('#seek'), $('#fs-seek')]) {
    s.addEventListener('input', () => {
      seeking = true;
      s.style.setProperty('--pct', s.value / 10 + '%');
      $('#t-cur').textContent = $('#fs-cur').textContent = fmtTime((s.value / 1000) * trackDuration());
    });
    const commit = () => {
      if (!seeking) return;
      const d = trackDuration();
      if (d) audio.currentTime = (s.value / 1000) * d;
      seeking = false;
      updateTime();
    };
    s.addEventListener('change', commit);
    // iOS sometimes skips 'change' after a swipe; without this the bar would stay frozen.
    for (const ev of ['pointerup', 'touchend', 'touchcancel']) s.addEventListener(ev, commit);
  }
  $('#volume').addEventListener('input', (e) => {
    const v = e.target.value / 100;
    audio.volume = v;
    audio.muted = false;
    setVolumeUi(v);
    ls.set('volume', v);
    updateButtons();
  });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const h = (a, fn) => {
      try {
        ms.setActionHandler(a, fn);
      } catch {
        /* unsupported */
      }
    };
    h('play', () => audio.play());
    h('pause', () => audio.pause());
    h('previoustrack', prev);
    h('nexttrack', () => step(1));
    h('seekto', (d) => {
      audio.currentTime = d.seekTime;
      updateTime();
    });
    // No seekbackward/seekforward: on iOS they replace the lock-screen next/previous buttons.
  }
  updateButtons();
}

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, [contenteditable]') || $('.modal')) return;
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (mod) step(1);
        else audio.currentTime = Math.min(trackDuration() - 0.5, audio.currentTime + 5);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (mod) prev();
        else audio.currentTime = Math.max(0, audio.currentTime - 5);
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!mod && !e.shiftKey && document.activeElement?.closest('#main')) return; // allow scrolling
        e.preventDefault();
        const v = Math.min(1, Math.max(0, audio.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
        audio.volume = v;
        setVolumeUi(v);
        ls.set('volume', v);
        updateButtons();
        break;
      }
      case 'm':
      case 'M':
        audio.muted = !audio.muted;
        updateButtons();
        break;
      case 's':
      case 'S':
        if (!mod) toggleShuffle();
        break;
      case 'r':
      case 'R':
        if (!mod) cycleRepeat();
        break;
      case 'Escape':
        closeMenu();
        $('#nowplaying').hidden = true;
        state.selection.clear();
        $$('.tr.selected').forEach((r) => r.classList.remove('selected'));
        break;
      case 'a':
        if (mod && currentViewIds().length) {
          e.preventDefault();
          currentViewIds().forEach((id) => state.selection.add(id));
          $$('.tr[data-id]').forEach((r) => r.classList.add('selected'));
        }
        break;
    }
  });
}

// ---------- menus & modals ----------
function openMenu(items, x, y) {
  const m = $('#menu');
  m.innerHTML = items
    .map((it, i) => {
      if (it.sep) return '<hr>';
      if (it.header) return `<div class="menu-label">${esc(it.header)}</div>`;
      return `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`;
    })
    .join('');
  m.hidden = false;
  m.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[b.dataset.i].run();
  };
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
function closeMenu() {
  $('#menu').hidden = true;
}

function modal(html, onMount) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const done = (v) => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('modal-backdrop')) done(null);
    });
    onMount(root.querySelector('.modal'), done);
  });
}
function promptModal({ title, value = '', ok = 'Save', placeholder = '' }) {
  return modal(
    `<h2>${esc(title)}</h2><form><input class="input" maxlength="200" value="${esc(value)}" placeholder="${esc(placeholder)}">
     <div class="btns"><button type="button" class="btn ghost" data-x>Cancel</button><button class="btn">${esc(ok)}</button></div></form>`,
    (el, done) => {
      const input = $('input', el);
      input.focus();
      input.select();
      $('[data-x]', el).onclick = () => done(null);
      $('form', el).onsubmit = (e) => {
        e.preventDefault();
        done(input.value.trim() || null);
      };
    },
  );
}
function confirmModal({ title, text, ok = 'OK', danger = false }) {
  return modal(
    `<h2>${esc(title)}</h2><p>${esc(text)}</p>
     <div class="btns"><button class="btn ghost" data-x>Cancel</button><button class="btn ${danger ? 'danger' : ''}" data-ok>${esc(ok)}</button></div>`,
    (el, done) => {
      $('[data-x]', el).onclick = () => done(false);
      $('[data-ok]', el).onclick = () => done(true);
      $('[data-ok]', el).focus();
    },
  );
}

// ---------- playlist actions ----------
async function createPlaylist(trackIds = []) {
  if (!guardOnline()) return;
  const name = await promptModal({ title: 'Create playlist', ok: 'Create', placeholder: 'Playlist name', value: `My Playlist #${state.playlists.length + 1}` });
  if (!name) return;
  try {
    const p = await api('/api/playlists', { method: 'POST', body: { name, trackIds } });
    state.playlists.push(p);
    if (trackIds.length) toast(`Added to ${p.name}`);
    else location.hash = '#/playlist/' + encodeURIComponent(p.id);
    render();
  } catch (e) {
    toast(e.message);
  }
}

async function addToPlaylist(pid, ids) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  const fresh = ids.filter((id) => !p.trackIds.includes(id));
  if (!fresh.length) return toast(`Already in ${p.name}`);
  p.trackIds.push(...fresh);
  render();
  try {
    await api(`/api/playlists/${pid}/tracks`, { method: 'POST', body: { trackIds: fresh } });
    toast(`Added ${fresh.length > 1 ? plural(fresh.length, 'song') + ' ' : ''}to ${p.name}`);
  } catch (e) {
    toast(e.message);
    await loadPlaylists();
    render();
  }
}

async function setPlaylistTracks(pid, trackIds) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  p.trackIds = trackIds;
  render();
  try {
    await api(`/api/playlists/${pid}`, { method: 'PATCH', body: { trackIds } });
  } catch (e) {
    toast(e.message);
    await loadPlaylists();
    render();
  }
}

/**
 * Remove songs from a playlist. The server also moves a song's file to the trash (kept 30 days)
 * when no other playlist contains it.
 */
async function removeFromPlaylist(pid, ids) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  const rm = new Set(ids);
  p.trackIds = p.trackIds.filter((t) => !rm.has(t)); // update the screen right away
  state.selection.clear();
  render();
  try {
    const r = await api(`/api/playlists/${pid}/remove`, { method: 'POST', body: { trackIds: ids } });
    const parts = [];
    if (r.trashed) parts.push(`${r.trashed > 1 ? plural(r.trashed, 'file') : 'file'} moved to trash (kept 30 days)`);
    if (r.kept) parts.push(`${r.kept > 1 ? `${r.kept} songs are` : 'it is'} still in another playlist`);
    toast(`Removed${parts.length ? ' · ' + parts.join(' · ') : ''}`);
  } catch (err) {
    toast(err.message);
    await loadPlaylists(true).catch(() => {});
    render();
  }
}

async function renamePlaylist(pid) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  const name = await promptModal({ title: 'Rename playlist', value: p.name });
  if (!name || name === p.name) return;
  p.name = name;
  render();
  try {
    await api(`/api/playlists/${pid}`, { method: 'PATCH', body: { name } });
  } catch (e) {
    toast(e.message);
  }
}

async function deletePlaylist(pid) {
  if (!guardOnline()) return;
  const p = getPlaylist(pid);
  const ok = await confirmModal({ title: 'Delete playlist?', text: typeof p.folder === 'string'
      ? `"${p.name}" will be deleted. The songs stay in the folder "${p.folder || 'music'}", which won't be turned into a playlist again.`
      : `"${p.name}" will be deleted. The song files stay in your music folder.`, ok: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/api/playlists/${pid}`, { method: 'DELETE' });
    state.playlists = state.playlists.filter((x) => x.id !== pid);
    if (state.downloaded.has(pid)) await removeDownload(pid);
    if (state.route.name === 'playlist' && state.route.id === pid) location.hash = '#/library';
    render();
  } catch (e) {
    toast(e.message);
  }
}

function playlistMenu(pid, x, y) {
  const dl = state.downloaded.has(pid);
  openMenu(
    [
      { label: 'Play', icon: 'play', run: () => { const p = getPlaylist(pid); playContext({ type: 'playlist', id: pid, name: p.name, ids: playlistIds(p) }); } },
      { label: 'Search for a song…', icon: 'search', run: () => searchSongs(pid) },
      { label: 'Add from link…', icon: 'import', run: () => addFromLink(pid) },
      { label: 'Upload files…', icon: 'plus', run: () => pickUpload(pid) },
      { label: 'Add from music folder…', icon: 'note', run: () => addSongsPicker(pid) },
      { label: 'Rename', icon: 'edit', run: () => renamePlaylist(pid) },
      { label: dl ? 'Remove download' : 'Download to this device', icon: dl ? 'downloaded' : 'download', run: () => toggleDownload(pid) },
      { sep: true },
      { label: 'Delete playlist', icon: 'trash', danger: true, run: () => deletePlaylist(pid) },
    ],
    x,
    y,
  );
}

function trackMenu(id, x, y) {
  const ids = state.selection.has(id) && state.selection.size > 1 ? currentViewIds().filter((t) => state.selection.has(t)) : [id];
  const inPlaylist = state.route.name === 'playlist' ? getPlaylist(state.route.id) : null;
  const n = ids.length;
  const items = [];
  if (n === 1) items.push({ label: 'Play', icon: 'play', run: () => playFromView(id) });
  items.push({ header: n > 1 ? `Add ${n} songs to playlist` : 'Add to playlist' });
  items.push({ label: 'New playlist…', icon: 'plus', run: () => createPlaylist(ids) });
  for (const p of state.playlists) {
    if (p.id === inPlaylist?.id) continue;
    items.push({ label: p.name, run: () => addToPlaylist(p.id, ids) });
  }
  if (inPlaylist) {
    items.push({ sep: true });
    items.push({
      label: n > 1 ? `Remove ${n} songs from this playlist` : 'Remove from this playlist',
      icon: 'trash',
      danger: true,
      run: () => removeFromPlaylist(inPlaylist.id, ids),
    });
  }
  openMenu(items, x, y);
}

function playFromView(id) {
  if (!available(id)) return toast('Not downloaded to this device.');
  const ctx = currentViewCtx();
  if (ctx) playContext(ctx, id);
}

// ---------- offline downloads ----------
async function refreshCached() {
  if (!canDownload) return;
  const keys = await (await caches.open(AUDIO_CACHE)).keys();
  state.cached = new Set(keys.map((r) => new URL(r.url).searchParams.get('id')));
}

async function toggleDownload(pid) {
  if (!canDownload) {
    return toast('Downloads need the app opened over HTTPS (see the README: HTTPS).');
  }
  if (state.downloaded.has(pid)) {
    await removeDownload(pid);
    toast('Download removed');
  } else {
    if (!guardOnline()) return;
    state.downloaded.add(pid);
    ls.set('downloaded', [...state.downloaded]);
    navigator.storage?.persist?.().catch(() => {});
    render();
    syncDownloads();
  }
}

async function removeDownload(pid) {
  state.downloaded.delete(pid);
  ls.set('downloaded', [...state.downloaded]);
  state.dlProgress.delete(pid);
  await pruneCache();
  render();
}

/** Delete cached songs that no downloaded playlist needs any more. */
async function pruneCache() {
  if (!canDownload || state.offline) return;
  const keep = new Set();
  for (const pid of state.downloaded) {
    const p = getPlaylist(pid);
    if (p) p.trackIds.forEach((id) => keep.add(id));
  }
  const cache = await caches.open(AUDIO_CACHE);
  for (const req of await cache.keys()) {
    const id = new URL(req.url).searchParams.get('id');
    if (!keep.has(id)) {
      await cache.delete(req);
      state.cached.delete(id);
    }
  }
}

let syncing = false;
let syncAgain = false;
async function syncDownloads() {
  if (!canDownload || state.offline) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const covers = await caches.open(COVER_CACHE);
    for (const pid of [...state.downloaded]) {
      const p = getPlaylist(pid);
      if (!p) continue;
      const ids = playlistIds(p);
      const missing = ids.filter((id) => !state.cached.has(id));
      if (!missing.length) continue;
      let done = ids.length - missing.length;
      let failed = 0;
      state.dlProgress.set(pid, { done, total: ids.length });
      renderDlProgress(pid);
      for (const id of missing) {
        if (!state.downloaded.has(pid) || state.offline) break;
        try {
          const url = streamUrl(id);
          const res = await fetch(url);
          if (!res.ok) throw new Error(res.status);
          await cache.put(url, res);
          state.cached.add(id);
          const c = state.tracks.get(id)?.cover;
          if (c && !(await covers.match('/covers/' + c))) {
            const cr = await fetch('/covers/' + c);
            if (cr.ok) await covers.put('/covers/' + c, cr);
          }
        } catch (err) {
          failed++;
          console.warn('Download failed', id, err);
        }
        state.dlProgress.set(pid, { done: ++done, total: ids.length });
        renderDlProgress(pid);
      }
      state.dlProgress.delete(pid);
      if (failed) toast(`${plural(failed, 'song')} in ${p.name} failed to download`);
    }
    await pruneCache();
  } finally {
    syncing = false;
    render();
    refreshOfflineShell(); // store the latest library/playlists next to the downloaded songs
    if (syncAgain) {
      syncAgain = false;
      syncDownloads();
    }
  }
}

function renderDlProgress(pid) {
  if (state.route.name !== 'playlist' || state.route.id !== pid) return;
  const el = $('.dl-progress');
  const prog = state.dlProgress.get(pid);
  if (el) el.textContent = prog ? `Downloading ${prog.done}/${prog.total}` : '';
}

// ---------- events ----------
function setupEvents() {
  window.addEventListener('hashchange', () => {
    state.route = parseRoute();
    state.selection.clear();
    state.viewFilter = '';
    $('#view').innerHTML = '';
    $('#main').scrollTop = 0;
    closeMenu();
    render();
  });

  // Global buttons (player bar, full-screen player, view actions).
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('#menu')) closeMenu();
    const nav = e.target.closest('[data-nav-to]');
    if (nav) return (location.hash = nav.dataset.navTo);
    const pl = e.target.closest('.pl-item[data-playlist]');
    if (pl) return (location.hash = '#/playlist/' + encodeURIComponent(pl.dataset.playlist));

    const btn = e.target.closest('[data-action]');
    if (btn) {
      const a = btn.dataset.action;
      const rect = btn.getBoundingClientRect();
      switch (a) {
        case 'toggle': return togglePlay();
        case 'next': return step(1);
        case 'prev': return prev();
        case 'shuffle': return toggleShuffle();
        case 'repeat': return cycleRepeat();
        case 'mute':
          audio.muted = !audio.muted;
          return updateButtons();
        case 'open-nowplaying':
          if (isMobile() && player.current && !e.target.closest('.mini-play')) $('#nowplaying').hidden = false;
          return;
        case 'close-nowplaying':
          $('#nowplaying').hidden = true;
          return;
        case 'back':
          return history.length > 1 ? history.back() : (location.hash = '#/library');
        case 'new-playlist': return createPlaylist();
        case 'rescan':
          if (!guardOnline()) return;
          await api('/api/rescan', { method: 'POST' }).catch((err) => toast(err.message));
          return toast('Rescanning music folder…');
        case 'play-view': {
          const ctx = currentViewCtx();
          if (isCtx(ctx) && player.current) return togglePlay();
          return playContext(ctx);
        }
        case 'rename-playlist': return renamePlaylist(state.route.id);
        case 'add-songs': return addSongsPicker(state.route.id);
        case 'add-link': return addFromLink(state.route.id);
        case 'upload': return pickUpload(state.route.id);
        case 'search-songs': return searchSongs(state.route.id);
        case 'add-menu':
          return openMenu([
            { label: 'Search for a song', icon: 'search', run: () => searchSongs(state.route.id) },
            { label: 'Add from link (YouTube, Spotify, SoundCloud…)', icon: 'import', run: () => addFromLink(state.route.id) },
            { label: 'Upload files', icon: 'plus', run: () => pickUpload(state.route.id) },
            { label: 'From your music folder', icon: 'note', run: () => addSongsPicker(state.route.id) },
          ], rect.left, rect.bottom + 4);
        case 'sign-out':
          await fetch('/api/logout', { method: 'POST' }).catch(() => {});
          return location.replace('/login');
        case 'pl-job-dismiss':
          return api(`/api/jobs/${btn.dataset.job}`, { method: 'DELETE' }).catch((err) => toast(err.message));
        case 'playlist-menu': return playlistMenu(state.route.id, rect.left, rect.bottom + 4);
        case 'download-toggle': return toggleDownload(state.route.id);
        case 'track-menu': {
          e.stopPropagation();
          const row = btn.closest('.tr');
          return trackMenu(row.dataset.id, rect.right - 220, rect.bottom + 4);
        }
        case 'job-cancel':
          return api(`/api/jobs/${(btn.dataset.job ? btn : btn.closest('[data-job]')).dataset.job}/cancel`, { method: 'POST' }).catch((err) => toast(err.message));
        case 'job-dismiss':
          return api(`/api/jobs/${btn.closest('[data-job]').dataset.job}`, { method: 'DELETE' }).catch((err) => toast(err.message));
      }
    }
  });

  const view = $('#view');
  // Track rows: desktop = click selects / double-click plays; mobile = tap plays.
  view.addEventListener('click', (e) => {
    const row = e.target.closest('.tr[data-id]');
    if (!row || e.target.closest('[data-action]')) return;
    const id = row.dataset.id;
    if (isMobile() || e.target.closest('.t-num')) return playFromView(id);
    const ids = currentViewIds();
    if (e.shiftKey && state.anchor) {
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(id);
      state.selection = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) {
      state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id);
      state.anchor = id;
    } else {
      state.selection = new Set([id]);
      state.anchor = id;
    }
    for (const r of $$('.tr[data-id]')) r.classList.toggle('selected', state.selection.has(r.dataset.id));
  });
  view.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tr[data-id]');
    if (row && !isMobile()) playFromView(row.dataset.id);
  });
  view.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tr[data-id]');
    if (!row) return;
    e.preventDefault();
    if (!state.selection.has(row.dataset.id)) {
      state.selection = new Set([row.dataset.id]);
      state.anchor = row.dataset.id;
      for (const r of $$('.tr[data-id]')) r.classList.toggle('selected', state.selection.has(r.dataset.id));
    }
    trackMenu(row.dataset.id, e.clientX, e.clientY);
  });
  $('#sidebar').addEventListener('contextmenu', (e) => {
    const pl = e.target.closest('.pl-item[data-playlist]');
    if (!pl) return;
    e.preventDefault();
    playlistMenu(pl.dataset.playlist, e.clientX, e.clientY);
  });
  $('#main').addEventListener('scroll', closeMenu, { passive: true });

  // Import form + keep log <details> open across re-renders.
  view.addEventListener('submit', async (e) => {
    if (e.target.id !== 'import-form') return;
    e.preventDefault();
    if (!guardOnline()) return;
    const f = new FormData(e.target);
    try {
      await api('/api/import', { method: 'POST', body: { url: f.get('url'), target: 'new' } });
      e.target.reset();
      toast('Import started');
      await loadJobs();
      renderJobs();
      renderBadge();
    } catch (err) {
      toast(err.message);
    }
  });
  // Playlist filter and sort: only the song list is redrawn, so the filter box keeps focus.
  const redrawTracks = () => {
    const p = getPlaylist(state.route.id);
    const list = $('#track-list');
    if (!p || !list) return;
    state.selection.clear();
    list.innerHTML = tracksHtml(p, displayIds(p));
    markPlaying();
  };
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'pl-filter') return;
    state.viewFilter = e.target.value;
    redrawTracks();
  });
  view.addEventListener('change', (e) => {
    if (e.target.id !== 'pl-sort') return;
    setSort(state.route.id, e.target.value);
    redrawTracks();
    // Playing from this playlist: continue in the new order (like Spotify), from the current song.
    const ctx = currentViewCtx();
    if (isCtx(ctx) && player.current) {
      player.ctx.ids = ctx.ids;
      buildOrder(player.current);
      saveSession();
    }
  });
  view.addEventListener('keydown', (e) => {
    if (e.target.id === 'pl-filter' && e.key === 'Escape' && e.target.value) {
      e.stopPropagation();
      e.target.value = '';
      state.viewFilter = '';
      redrawTracks();
    }
  });

  view.addEventListener('toggle', (e) => {
    const job = e.target.closest?.('[data-job]');
    if (!job) return;
    e.target.open ? state.openLogs.add(job.dataset.job) : state.openLogs.delete(job.dataset.job);
  }, true);

  setupDragAndDrop();
  setupFileDrop();
}

let drag = null;
function setupDragAndDrop() {
  const view = $('#view');
  view.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.tr[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    if (!state.selection.has(id)) {
      state.selection = new Set([id]);
      for (const r of $$('.tr[data-id]')) r.classList.toggle('selected', r.dataset.id === id);
    }
    const ids = currentViewIds().filter((t) => state.selection.has(t));
    drag = { ids, from: state.route.name === 'playlist' ? state.route.id : null };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', ids.map((t) => state.tracks.get(t)?.title).join('\n'));
    const ghost = document.createElement('div');
    ghost.textContent = ids.length > 1 ? plural(ids.length, 'song') : state.tracks.get(id)?.title;
    ghost.style.cssText = 'position:fixed;top:-100px;padding:6px 12px;background:#282828;color:#fff;border-radius:4px;font:600 14px sans-serif';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => ghost.remove());
  });
  document.addEventListener('dragend', () => {
    drag = null;
    $$('.drop-target, .drag-over-top, .drag-over-bottom').forEach((el) => el.classList.remove('drop-target', 'drag-over-top', 'drag-over-bottom'));
  });

  // Drop on a sidebar playlist = add.
  const side = $('#side-playlists');
  side.addEventListener('dragover', (e) => {
    const pl = e.target.closest('.pl-item[data-playlist]');
    if (!drag || !pl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $$('.pl-item.drop-target').forEach((el) => el !== pl && el.classList.remove('drop-target'));
    pl.classList.add('drop-target');
  });
  side.addEventListener('dragleave', (e) => e.target.closest?.('.pl-item')?.classList.remove('drop-target'));
  side.addEventListener('drop', (e) => {
    const pl = e.target.closest('.pl-item[data-playlist]');
    if (!drag || !pl) return;
    e.preventDefault();
    pl.classList.remove('drop-target');
    addToPlaylist(pl.dataset.playlist, drag.ids);
  });

  // Drop within the same playlist = reorder.
  const target = (e) => {
    if (!drag?.from || state.route.name !== 'playlist' || state.route.id !== drag.from) return null;
    if (!canReorder(drag.from)) return null; // sorted or filtered view: no manual reordering
    const row = e.target.closest('.tr[data-id]');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { row, after: e.clientY > r.top + r.height / 2 };
  };
  view.addEventListener('dragover', (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.drag-over-top, .drag-over-bottom').forEach((el) => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    t.row.classList.add(t.after ? 'drag-over-bottom' : 'drag-over-top');
  });
  view.addEventListener('drop', (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    const moving = new Set(drag.ids);
    const targetId = t.row.dataset.id;
    if (moving.has(targetId)) return;
    const p = getPlaylist(drag.from);
    const rest = p.trackIds.filter((id) => !moving.has(id));
    let idx = rest.indexOf(targetId) + (t.after ? 1 : 0);
    rest.splice(idx, 0, ...drag.ids);
    setPlaylistTracks(p.id, rest);
  });
}

function connectLive() {
  if (!('EventSource' in window)) return;
  let wasDown = false;
  const es = new EventSource('/api/events');
  es.onopen = async () => {
    if (wasDown || state.offline) {
      wasDown = false;
      await reloadAll();
    }
  };
  es.onerror = async () => {
    wasDown = true;
    // Find out why the live connection dropped: server gone (go offline) or signed out.
    await checkServer();
  };
  es.addEventListener('library', async () => {
    await loadLibrary(true).catch(() => {});
    render();
  });
  es.addEventListener('playlists', async () => {
    await loadPlaylists(true).catch(() => {});
    render();
    syncDownloads();
  });
  es.addEventListener('jobs', async () => {
    await loadJobs();
    renderBadge();
    renderJobs();
    renderPlaylistJobs();
  });
}

/** Play a downloaded song straight from device storage (fallback when the normal URL fails offline). */
async function playFromStorage(id) {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const res = await cache.match(new URL(streamUrl(id), location.href).href, { ignoreVary: true });
    if (!res) return false;
    const at = pendingSeek || audio.currentTime || 0;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(await res.blob());
    pendingSeek = at;
    audio.src = blobUrl;
    audio.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** After loading while signed in and online, let the service worker store fresh copies of the app files. */
function refreshOfflineShell() {
  if (!canDownload || state.offline || state.serverDown) return;
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage('refresh-shell')).catch(() => {});
}

/** Is the server reachable? Never waits longer than 4 s (a phone away from home can hang much longer). */
async function checkServer({ refresh = false } = {}) {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store', signal: timeoutSignal(4000) });
    if (r.status === 401) return location.replace('/login');
    // Reachable: at startup replace the cached data with fresh data; after an outage hide the banner.
    if (refresh || state.offline) await reloadAll();
  } catch {
    setOffline(true);
  }
}

async function reloadAll() {
  try {
    await Promise.all([loadLibrary(true), loadPlaylists(true)]);
    state.serverDown = false;
    refreshOfflineShell();
    await loadJobs();
  } catch {
    if (!state.tracks.size) state.serverDown = true;
  }
  render();
  syncDownloads();
}

// ---------- boot ----------
async function init() {
  // Listen before anything is loaded: the service worker may report newer library/playlist data
  // (after answering from its cache) while the page is still starting; later it would be missed.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data === 'data-updated') reloadAll();
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker failed', err));
  }
  state.route = parseRoute();
  setupPlayer();
  setupKeyboard();
  setupEvents();
  try {
    await Promise.all([loadLibrary(), loadPlaylists()]);
  } catch {
    state.serverDown = true;
  }
  await refreshCached().catch(() => {});
  if (!state.serverDown) restoreSession();
  updateNowPlaying();
  render(); // show the (cached) library right away; everything below runs in the background
  checkServer({ refresh: true });
  refreshOfflineShell();
  loadJobs().then(() => {
    renderBadge();
    renderJobs();
  });
  connectLive();
  syncDownloads();
  window.addEventListener('online', reloadAll);
}

init();
