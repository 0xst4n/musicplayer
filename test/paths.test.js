import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { dirInside, titleFromFilename, isAudio } from '../server/library.js';
import { safeName } from '../server/importer.js';

const base = path.join(os.tmpdir(), 'music');

test('dirInside keeps playlist folders inside the music folder', () => {
  assert.equal(dirInside(base, 'Imports/x'), path.join(base, 'Imports', 'x'));
  assert.equal(dirInside(base, ''), base);
  assert.equal(dirInside(base, 'Album One/CD 1'), path.join(base, 'Album One', 'CD 1'));
  for (const evil of ['../../etc', 'Uploads/../../../x', '..', '../music-evil']) {
    assert.equal(dirInside(base, evil), null, evil);
  }
  if (process.platform === 'win32') assert.equal(dirInside(base, '..\\..\\x'), null, 'Windows backslashes');
});

test('safeName makes one harmless path segment', () => {
  assert.equal(safeName('AC/DC'), 'AC_DC');
  assert.equal(safeName('..'), 'Untitled');
  assert.equal(safeName('What? <Why>: "Yes"|*'), 'What_ _Why__ _Yes___');
  assert.ok(!safeName('a/../b').includes('/'));
});

test('titleFromFilename strips track numbers and video ids', () => {
  assert.equal(titleFromFilename('00012 - Song name [dQw4w9WgXcQ].opus'), 'Song name');
  assert.equal(titleFromFilename('03 Bonus Track.mp3'), '03 Bonus Track');
  assert.equal(titleFromFilename('01 - Intro.flac'), 'Intro');
});

test('isAudio only accepts playable audio extensions', () => {
  for (const ok of ['a.mp3', 'b.M4A', 'c.opus', 'd.flac', 'e.wav']) assert.ok(isAudio(ok), ok);
  for (const bad of ['evil.exe', 'x.mp3.js', 'cover.jpg', 'noext']) assert.ok(!isAudio(bad), bad);
});
