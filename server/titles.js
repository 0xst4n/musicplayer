// Tidy up song titles and artist names that come from YouTube, so the library reads like a
// music service: "Dave - Sprinter (Official Video) [4K]" by "DaveVEVO" → "Sprinter" by "Dave".
// Used for display only; the audio files and their tags are never changed.

// Bracketed noise: (Official Video), [Lyrics], (Official Music Video) [4K], (Audio), (Visualizer)…
// Informative parts like (feat. X), (Live at …), (Remastered 2011) or (Acoustic) are kept.
const NOISE_WORDS = String.raw`official|lyrics?|lyric video|visuali[sz]er|audio|video|music video|m\/?v|hd|hq|4k|8k|uhd`;
const BRACKETED = new RegExp(String.raw`\s*[\(\[【](?:\s*(?:${NOISE_WORDS})\b[^\)\]】]*|[^\)\]】]*\b(?:${NOISE_WORDS})\s*)[\)\]】]`, 'gi');
// Trailing " | Official Video", " - Official Audio", " // Lyrics"
const TRAILING = new RegExp(String.raw`\s+(?:\||\/\/|-|–|—)\s*(?:${NOISE_WORDS})(?:\s+(?:${NOISE_WORDS}))*\s*$`, 'i');

export function cleanArtist(artist) {
  return String(artist ?? '')
    .replace(/\s*-\s*Topic$/i, '') // YouTube auto-generated "Artist - Topic" channels
    .replace(/VEVO$/, '') // "DaveVEVO"
    .trim();
}

export function cleanTitle(title) {
  let t = String(title ?? '');
  for (let i = 0; i < 3; i++) {
    const next = t.replace(BRACKETED, '').replace(TRAILING, '');
    if (next === t) break;
    t = next;
  }
  return t.replace(/\s{2,}/g, ' ').trim() || String(title ?? '').trim();
}

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// ---------- duplicate detection ----------
/** Lowercase, no accents, no punctuation/spaces: "Lost Cause!" → "lostcause". */
export const songKey = (s) =>
  String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
/** First credited artist: "Dave, Central Cee" / "Dave feat. X" / "Dave x Y" → "dave". */
export const mainArtistKey = (a) => songKey(String(a ?? '').split(/,|&|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+with\s+/i)[0]);
/** The video id yt-dlp puts in file names: "Song [dQw4w9WgXcQ].m4a". */
export const youtubeIdOf = (trackId) => /\[([\w-]{11})\]\.\w+$/.exec(String(trackId))?.[1] ?? null;

/**
 * Same song? Same YouTube video, or the same title by the same main artist ("Santan Dave"
 * matches "Dave"). Without an artist on either side only the title has to match.
 */
export function sameSong(a, b) {
  const ya = youtubeIdOf(a.id);
  if (ya && ya === youtubeIdOf(b.id)) return true;
  const ta = songKey(a.title);
  if (!ta || ta !== songKey(b.title)) return false;
  const x = mainArtistKey(a.artist);
  const y = mainArtistKey(b.artist);
  if (!x || !y) return !x && !y;
  return x.includes(y) || y.includes(x);
}

/**
 * Clean a title/artist pair. "Artist - Title" titles are split when there is no artist yet,
 * or when the part before the dash is (part of) the known artist / channel name.
 */
export function cleanSong(title, artist) {
  let a = cleanArtist(artist);
  let t = cleanTitle(title);
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    const left = norm(m[1]);
    const known = norm(a);
    if (!a || (left && known && (known.includes(left) || left.includes(known)))) {
      if (!a) a = m[1].trim();
      t = m[2].trim();
    }
  }
  return { title: t, artist: a };
}
