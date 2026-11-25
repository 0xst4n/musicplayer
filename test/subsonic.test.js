// Subsonic API (for native apps like Amperfy), against a running server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { startServer, writeSongs, exists } from './helpers.js';

const PASSWORD = 'sub-pass';

describe('Subsonic API', () => {
  let s;
  /** Call a Subsonic method the way apps do: token auth (md5(password + salt)) and JSON. */
  const call = async (method, params = {}, { auth = 'token', format = 'json' } = {}) => {
    const q = new URLSearchParams({ u: 'music', v: '1.16.1', c: 'test', ...(format === 'json' ? { f: 'json' } : {}) });
    if (auth === 'token') {
      const salt = crypto.randomBytes(6).toString('hex');
      q.set('t', crypto.createHash('md5').update(PASSWORD + salt).digest('hex'));
      q.set('s', salt);
    } else if (auth === 'plain') q.set('p', PASSWORD);
    else if (auth === 'enc') q.set('p', `enc:${Buffer.from(PASSWORD).toString('hex')}`);
    else if (auth === 'wrong') q.set('p', 'nope');
    for (const [k, v] of Object.entries(params)) for (const item of [].concat(v)) q.append(k, item);
    const r = await s.req(`/rest/${method}.view?${q}`);
    return format === 'json' ? { ...r, body: r.json?.['subsonic-response'] } : r;
  };
  const ok = (r) => {
    assert.equal(r.body?.status, 'ok', JSON.stringify(r.body?.error));
    return r.body;
  };

  before(async () => {
    s = await startServer({
      password: PASSWORD,
      prepare: ({ musicDir }) =>
        writeSongs(musicDir, {
          'Imports/drive/01 - Rowan, Kai Marlow - Night Runner.wav': { title: 'Night Runner', artist: 'Rowan, Kai Marlow', album: 'Midnight Drive', cover: true, tone: 300 },
          'Imports/drive/02 - The Weeknd - Blinding Lights.wav': { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', tone: 350 },
          'Imports/chill/01 - Rowan - Low Tide.wav': { title: 'Low Tide', artist: 'Rowan', album: 'Afterglow', tone: 400 },
        }),
    });
    await s.settle();
  });
  after(() => s.stop());

  test('accepts token, plain and hex-encoded passwords; rejects wrong ones', async () => {
    for (const auth of ['token', 'plain', 'enc']) ok(await call('ping', {}, { auth }));
    const wrong = await call('ping', {}, { auth: 'wrong' });
    assert.equal(wrong.body.status, 'failed');
    assert.equal(wrong.body.error.code, 40);
    const noUser = await s.req('/rest/ping.view?f=json&p=x');
    assert.equal(noUser.json['subsonic-response'].error.code, 10, 'missing username');
  });

  test('answers in Subsonic XML by default', async () => {
    const r = await call('ping', {}, { format: 'xml' });
    assert.match(r.headers['content-type'], /text\/xml/);
    assert.match(r.text, /^<\?xml version="1.0" encoding="UTF-8"\?><subsonic-response xmlns="http:\/\/subsonic.org\/restapi" status="ok" version="1.16.1"/);
    const folders = await call('getMusicFolders', {}, { format: 'xml' });
    assert.match(folders.text, /<musicFolders><musicFolder id="1" name="Music"\/><\/musicFolders>/);
  });

  test('also works without ".view" and with form-encoded POST', async () => {
    const salt = 'abc123';
    const t = crypto.createHash('md5').update(PASSWORD + salt).digest('hex');
    const r = await s.req('/rest/ping', {
      method: 'POST',
      body: `u=music&t=${t}&s=${salt}&v=1.16.1&c=test&f=json`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(r.json['subsonic-response'].status, 'ok');
  });

  test('playlists are the Musicplayer playlists, in order', async () => {
    const lists = ok(await call('getPlaylists')).playlists.playlist;
    assert.deepEqual(lists.map((p) => [p.name, p.songCount]).sort(), [['chill', 1], ['drive', 2]]);
    const drive = lists.find((p) => p.name === 'drive');
    const full = ok(await call('getPlaylist', { id: drive.id })).playlist;
    assert.deepEqual(full.entry.map((e) => e.title), ['Night Runner', 'Blinding Lights']);
  });

  test('songs carry what apps need to play and download them', async () => {
    const drive = ok(await call('getPlaylists')).playlists.playlist.find((p) => p.name === 'drive');
    const song = ok(await call('getPlaylist', { id: drive.id })).playlist.entry[0];
    assert.equal(song.title, 'Night Runner');
    assert.equal(song.artist, 'Rowan, Kai Marlow');
    assert.equal(song.album, 'Midnight Drive');
    assert.equal(song.suffix, 'wav');
    assert.equal(song.contentType, 'audio/wav');
    assert.equal(song.duration, 1);
    assert.ok(song.size > 0);
    assert.ok(song.coverArt?.startsWith('co-'));
    assert.deepEqual(ok(await call('getSong', { id: song.id })).song.id, song.id);
  });

  test('artists and albums come from the tags ("The" ignored when indexing)', async () => {
    const index = ok(await call('getArtists')).artists.index;
    const letters = Object.fromEntries(index.map((i) => [i.name, i.artist.map((a) => a.name)]));
    assert.deepEqual(letters, { R: ['Rowan'], W: ['The Weeknd'] });
    const rowan = index.find((i) => i.name === 'R').artist[0];
    const albums = ok(await call('getArtist', { id: rowan.id })).artist.album;
    assert.deepEqual(albums.map((a) => a.name), ['Afterglow', 'Midnight Drive']);
    const album = ok(await call('getAlbum', { id: albums[1].id })).album;
    assert.equal(album.song.length, 1);
    assert.equal(album.song[0].title, 'Night Runner');
    const newest = ok(await call('getAlbumList2', { type: 'newest', size: 10 })).albumList2.album;
    assert.equal(newest.length, 3);
    const dir = ok(await call('getMusicDirectory', { id: rowan.id })).directory;
    assert.equal(dir.child.length, 2);
  });

  test('search3 finds songs; an empty query returns the whole library (app sync)', async () => {
    const hit = ok(await call('search3', { query: 'blinding' })).searchResult3;
    assert.deepEqual(hit.song.map((x) => x.title), ['Blinding Lights']);
    const all = ok(await call('search3', { query: '""', songCount: 500 })).searchResult3;
    assert.equal(all.song.length, 3);
    const paged = ok(await call('search3', { query: '', songCount: 2, songOffset: 2 })).searchResult3;
    assert.equal(paged.song.length, 1);
  });

  test('streaming with seeking, downloading and cover art', async () => {
    const song = ok(await call('search3', { query: 'runner' })).searchResult3.song[0];
    const st = await call('stream', { id: song.id }, { format: 'raw' });
    assert.equal(st.status, 200);
    assert.equal(st.headers['content-type'], 'audio/wav');
    const q = new URLSearchParams({ u: 'music', p: PASSWORD, v: '1.16.1', c: 'test', id: song.id });
    const part = await s.req(`/rest/stream.view?${q}`, { headers: { range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal((await call('download', { id: song.id }, { format: 'raw' })).status, 200);
    const art = await call('getCoverArt', { id: song.coverArt }, { format: 'raw' });
    assert.equal(art.status, 200);
    assert.equal(art.headers['content-type'], 'image/png');
    const albumArt = await call('getCoverArt', { id: song.albumId }, { format: 'raw' });
    assert.equal(albumArt.headers['content-type'], 'image/png', 'cover by album id');
  });

  test('unknown ids and ids outside the library are "not found" (no file access)', async () => {
    for (const id of ['tr-' + Buffer.from('../data/secret.key').toString('base64url'), 'tr-%%%', 'nope']) {
      const r = await call('stream', { id }, { format: 'json' });
      assert.equal(r.body?.status, 'failed', id);
      assert.equal(r.body.error.code, 70, id);
    }
    const art = await call('getCoverArt', { id: 'co-../../secret.key' });
    assert.equal(art.body.error.code, 70);
  });

  test('apps can create, change and delete playlists; files are never deleted', async () => {
    const all = ok(await call('search3', { query: '', songCount: 10 })).searchResult3.song;
    const created = ok(await call('createPlaylist', { name: 'From the app', songId: [all[0].id, all[1].id] })).playlist;
    assert.equal(created.songCount, 2);
    ok(await call('updatePlaylist', { playlistId: created.id, name: 'Renamed in app', songIdToAdd: all[2].id, songIndexToRemove: 0 }));
    const changed = ok(await call('getPlaylist', { id: created.id })).playlist;
    assert.equal(changed.name, 'Renamed in app');
    assert.deepEqual(changed.entry.map((e) => e.id), [all[1].id, all[2].id]);
    ok(await call('deletePlaylist', { id: created.id }));
    assert.equal(ok(await call('getPlaylists')).playlists.playlist.some((p) => p.id === created.id), false);
    for (const song of all) assert.ok(await exists(path.join(s.musicDir, ...song.path.split('/'))), `file kept: ${song.path}`);
  });

  test('features Musicplayer lacks answer with empty lists, unknown methods with an error', async () => {
    assert.deepEqual(ok(await call('getStarred2')).starred2, { artist: [], album: [], song: [] });
    assert.deepEqual(ok(await call('getPodcasts')).podcasts, { channel: [] });
    ok(await call('scrobble', { id: 'x' }));
    assert.equal(ok(await call('getLicense')).license.valid, true);
    const r = await call('doSomethingWeird');
    assert.equal(r.body.status, 'failed');
  });

  test('wrong passwords are rate limited like the web login', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await call('ping', {}, { auth: 'wrong' })).body.error.message);
    assert.match(codes[5], /Too many/);
  });
});
