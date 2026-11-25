// Library, playlists, uploads (incl. duplicates) and removing songs, against a running server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, writeSongs, makeWav, exists } from './helpers.js';

const today = () => new Date().toISOString().slice(0, 10);

describe('library and playlists', () => {
  let s;
  const playlists = async () => (await s.req('/api/playlists')).json.playlists;
  const byName = async (name) => (await playlists()).find((p) => p.name === name);
  const tracks = async () => (await s.req('/api/library')).json.tracks;
  const upload = (pid, name, buf) =>
    s.req(`/api/playlists/${pid}/upload?name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: buf,
      headers: { 'content-type': 'application/octet-stream' },
    });

  before(async () => {
    s = await startServer({
      password: 'pw',
      prepare: async ({ musicDir, dataDir }) => {
        await writeSongs(musicDir, {
          'Album A/01 one.wav': { title: 'Rowan - Night Runner (Official Video) [4K]', artist: 'RowanVEVO', tone: 300 },
          'Album A/02 two.wav': { title: 'Blue Hour', artist: 'The Testers', tone: 350 },
          'Album A/03 three.wav': { title: 'Third Song', artist: 'The Testers', tone: 400 },
        });
        // Old trash (older than 30 days) must be emptied at start; today's must stay.
        await fs.mkdir(path.join(dataDir, 'trash', '2020-01-01', 'Old'), { recursive: true });
        await fs.writeFile(path.join(dataDir, 'trash', '2020-01-01', 'Old', 'ancient.wav'), 'x');
      },
    });
    await s.login();
    await s.settle();
  });
  after(() => s.stop());

  test('every folder with songs becomes a playlist, in file order', async () => {
    const a = await byName('Album A');
    assert.ok(a, 'playlist "Album A" exists');
    assert.equal(a.folder, 'Album A');
    assert.deepEqual(a.trackIds, ['Album A/01 one.wav', 'Album A/02 two.wav', 'Album A/03 three.wav']);
  });

  test('titles and artists are tidied for display', async () => {
    const t = (await tracks()).find((x) => x.id === 'Album A/01 one.wav');
    assert.equal(t.title, 'Night Runner');
    assert.equal(t.artist, 'Rowan');
  });

  test('streaming works, with byte ranges for seeking', async () => {
    const id = encodeURIComponent('Album A/02 two.wav');
    const full = await s.req(`/api/stream?id=${id}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers['content-type'], 'audio/wav');
    const part = await s.req(`/api/stream?id=${id}`, { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.match(part.headers['content-range'], /^bytes 0-99\/\d+$/);
  });

  test('creating a playlist only accepts name and songs (no folder or source)', async () => {
    const r = await s.req('/api/playlists', {
      method: 'POST',
      json: { name: 'Mix', folder: '../../escape', source: { evil: true }, trackIds: ['Album A/02 two.wav'] },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.folder, undefined);
    assert.equal(r.json.source, null);
    assert.deepEqual(r.json.trackIds, ['Album A/02 two.wav']);
  });

  test('uploads land in the playlist folder; non-audio is refused', async () => {
    const mix = await byName('Mix');
    assert.equal((await upload(mix.id, 'evil.exe', Buffer.from('MZ'))).status, 415);
    const r = await upload(mix.id, 'Fresh Tune.wav', makeWav({ title: 'Fresh Tune', artist: 'Newcomer', tone: 500 }));
    assert.equal(r.status, 201);
    assert.equal(r.json.id, 'Uploads/Mix/Fresh Tune.wav');
    assert.equal(r.json.duplicateOf, null);
    assert.ok(await exists(path.join(s.musicDir, 'Uploads', 'Mix', 'Fresh Tune.wav')));
    assert.ok((await byName('Mix')).trackIds.includes('Uploads/Mix/Fresh Tune.wav'));
  });

  test('uploading a song you already have reports the existing copy', async () => {
    const mix = await byName('Mix');
    // Different file and name, same song: "Third Song" by "The Testers" is in Album A.
    const r = await upload(mix.id, 'my copy.wav', makeWav({ title: 'Third Song', artist: 'The Testers', tone: 999 }));
    assert.equal(r.status, 201);
    assert.equal(r.json.duplicateOf?.id, 'Album A/03 three.wav');
    // Re-uploading the very same file reuses it: not a new copy, so no warning.
    const again = await upload(mix.id, 'Fresh Tune.wav', makeWav({ title: 'Fresh Tune', artist: 'Newcomer', tone: 500 }));
    assert.equal(again.json.id, 'Uploads/Mix/Fresh Tune.wav');
    assert.equal(again.json.duplicateOf, null);
  });

  test('removing a song that is only in this playlist moves its file to the trash', async () => {
    const mix = await byName('Mix');
    const r = await s.req(`/api/playlists/${mix.id}/remove`, { method: 'POST', json: { trackIds: ['Uploads/Mix/my copy.wav'] } });
    assert.deepEqual(r.json, { removed: 1, trashed: 1, kept: 0 });
    assert.ok(!(await exists(path.join(s.musicDir, 'Uploads', 'Mix', 'my copy.wav'))));
    assert.ok(await exists(path.join(s.dataDir, 'trash', today(), 'Uploads', 'Mix', 'my copy.wav')));
  });

  test('a song that is also in another playlist keeps its file', async () => {
    const a = await byName('Album A');
    const r = await s.req(`/api/playlists/${a.id}/remove`, { method: 'POST', json: { trackIds: ['Album A/02 two.wav'] } });
    assert.deepEqual(r.json, { removed: 1, trashed: 0, kept: 1 }, '"Blue Hour" is still in Mix');
    assert.ok(await exists(path.join(s.musicDir, 'Album A', '02 two.wav')));
  });

  test('songs removed by hand are not added back by folder sync', async () => {
    await s.req('/api/rescan', { method: 'POST' });
    await s.settle();
    assert.ok(!(await byName('Album A')).trackIds.includes('Album A/02 two.wav'));
  });

  test('removing the last song of a folder also removes the empty folder', async () => {
    const mix = await byName('Mix');
    await s.req(`/api/playlists/${mix.id}/remove`, { method: 'POST', json: { trackIds: ['Uploads/Mix/Fresh Tune.wav'] } });
    assert.ok(!(await exists(path.join(s.musicDir, 'Uploads', 'Mix'))), 'empty Uploads/Mix removed');
    assert.ok(await exists(s.musicDir), 'music folder itself kept');
  });

  test('ids pointing outside the music folder are ignored', async () => {
    const mix = await byName('Mix');
    const r = await s.req(`/api/playlists/${mix.id}/remove`, {
      method: 'POST',
      json: { trackIds: ['../data/secret.key', 'Album A/../../data/playlists.json'] },
    });
    assert.equal(r.json.trashed, 0);
    assert.ok(await exists(path.join(s.dataDir, 'secret.key')));
    assert.ok(await exists(path.join(s.dataDir, 'playlists.json')));
  });

  test('trash older than 30 days is emptied at start', async () => {
    assert.ok(!(await exists(path.join(s.dataDir, 'trash', '2020-01-01'))));
    assert.ok(await exists(path.join(s.dataDir, 'trash', today())));
  });
});

describe('song search (needs internet; run with MUSICPLAYER_NETWORK_TESTS=1)', { skip: process.env.MUSICPLAYER_NETWORK_TESTS !== '1' }, () => {
  let s;
  before(async () => {
    s = await startServer({ password: 'pw' });
    await s.login();
  });
  after(() => s?.stop());

  test('YouTube Music search returns tidy songs', { timeout: 60000 }, async () => {
    const r = await s.req('/api/search?q=blinding%20lights');
    assert.equal(r.status, 200);
    assert.ok(r.json.results.length > 0);
    const first = r.json.results[0];
    assert.match(first.id, /^[\w-]{11}$/);
    assert.doesNotMatch(first.title, /official|lyrics/i);
  });
});
