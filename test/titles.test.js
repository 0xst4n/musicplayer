import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSong, sameSong, youtubeIdOf } from '../server/titles.js';

test('cleanSong tidies YouTube titles and keeps real information', () => {
  const cases = [
    ['Rowan - Night Runner (Official Video)', 'RowanVEVO', 'Night Runner', 'Rowan'],
    ['Night Runner', 'Young Rowan - Topic', 'Night Runner', 'Young Rowan'],
    ['Kai Marlow - Static (Official Music Video) [4K]', 'Kai Marlow', 'Static', 'Kai Marlow'],
    ['Blinding Lights (Official Audio)', 'The Weeknd', 'Blinding Lights', 'The Weeknd'],
    ['Song Name [Lyrics]', 'Some Channel', 'Song Name', 'Some Channel'],
    ['Song Name | Official Video', 'Artist', 'Song Name', 'Artist'],
    ['Hey Jude (Remastered 2015)', 'The Beatles - Topic', 'Hey Jude (Remastered 2015)', 'The Beatles'],
    ['Paper Moon (feat. Ivy Lane)', 'Rowan', 'Paper Moon (feat. Ivy Lane)', 'Rowan'],
    ['Wonderwall (Live at Knebworth)', 'Oasis', 'Wonderwall (Live at Knebworth)', 'Oasis'],
    ['Some Artist - Untagged Song', '', 'Untagged Song', 'Some Artist'],
    ['Me - Myself & I', 'G-Eazy', 'Me - Myself & I', 'G-Eazy'],
    ['Video Games', 'Lana Del Rey', 'Video Games', 'Lana Del Rey'],
    ['Audio (feat. Sia)', 'LSD', 'Audio (feat. Sia)', 'LSD'],
    ['Rowan - Low Tide (Visualiser)', 'Rowan', 'Low Tide', 'Rowan'],
    [
      'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
      'Blender',
      'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
      'Blender',
    ],
  ];
  for (const [title, artist, wantTitle, wantArtist] of cases) {
    assert.deepEqual(cleanSong(title, artist), { title: wantTitle, artist: wantArtist }, `${title} / ${artist}`);
  }
});

test('sameSong recognises duplicates without false alarms', () => {
  const T = (id, title, artist) => ({ id, title, artist });
  assert.ok(sameSong(T('a/Song [dQw4w9WgXcQ].m4a', 'X', ''), T('b/Other [dQw4w9WgXcQ].m4a', 'Y', 'Z')), 'same YouTube video');
  assert.ok(sameSong(T('drive/12 - Rowan - Night Runner.m4a', 'Night Runner', 'Rowan, Kai Marlow'), T('?', 'Night Runner', 'Young Rowan')), 'Spotify vs YouTube Music');
  assert.ok(sameSong(T('a', "Don't Stop Me Now", 'Queen'), T('b', 'dont stop me now!', 'QUEEN')), 'case and punctuation');
  assert.ok(sameSong(T('a', 'Paper Moon', 'Rowan feat. Ivy Lane'), T('b', 'Paper Moon', 'Rowan')), 'featured artist');
  assert.ok(!sameSong(T('a', 'Night Runner', 'Rowan'), T('b', 'Night Runner', 'Marlo Vance')), 'same title, other artist');
  assert.ok(!sameSong(T('a', 'Blinding Lights', 'The Weeknd'), T('b', 'Blinding Lights (Remix)', 'The Weeknd')), 'remix');
  assert.ok(!sameSong(T('a', 'Intro', ''), T('b', 'Intro', 'Some Band')), 'generic title, one side without artist');
});

test('youtubeIdOf reads the id yt-dlp puts in file names', () => {
  assert.equal(youtubeIdOf('Imports/war/PIXY - LEGACY (Lyrics) [D114_VZiOsA].m4a'), 'D114_VZiOsA');
  assert.equal(youtubeIdOf('Imports/drive/12 - Rowan - Night Runner.m4a'), null);
});
