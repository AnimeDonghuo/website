import { cleanText } from '../lib/strings.js';

/**
 * Collections: the parts of a franchise, grouped without anyone maintaining a list.
 *
 * A publisher does not tag "Iron Man 2" as belonging to Iron Man, and a list someone has to
 * remember to edit is a list that goes stale the day it is written. So membership is derived from
 * the title itself: strip the part marker off the end, and whatever remains is the group. A card
 * only appears in a collection when at least two *different* titles share that group, which is what
 * keeps a single release from being called a franchise and keeps an accidental duplicate card from
 * looking like one too.
 *
 * The tail is trimmed until a pass changes nothing, because a caption carries more than one kind of
 * tail: a part number, a year, an upload tag, a signed group handle, the emoji left over from the
 * post. And a name set by hand with /collection wins over the derivation — a hand-cleared card stays
 * out of any group until someone sets it again, because a publisher's "no" is not a mistake to fix.
 */

// Sequel and part markers, at the end of a name where they describe the entry rather than the work.
const TRAILING_PART_MARKER = /[\s:._-]+(?:part|chapter|volume|vol|section|episode|ep|movie|film)\.?\s*(?:[0-9]{1,3}|[ivxlcdm]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten)\b[\s:._-]*$/i;
const TRAILING_NUMBER = /[\s:._-]+[0-9]{1,3}[\s:._-]*$/;
// Roman numerals are written in capitals, so the letters alone are not enough to call something a
// part number: "Civic" is spelled with roman-numeral letters and is a word. A tail of those letters
// only cuts when it is a well-formed numeral.
const TRAILING_ROMAN = /[\s:._-]+([IVXLCDM]{1,7})[\s:._-]*$/;
// A handle an uploader signs a caption with ("-KyoGo", "@GroupName"), and the punctuation or emoji
// left at the end of the line. Neither names the work, and both sit at the tail, so they go first.
const TRAILING_HANDLE = /\s+[-_@~#+.][^\s]*$/;
// An article stranded at the end of a name by the cuts above ("Shin the Movie" → "Shin the") is
// dropped while the title is still several words long, never when it would leave a fragment.
const STRANDED_ARTICLES = new Set(['the', 'a', 'an', 'of', 'and', 'with']);
const ROMAN_NUMERAL = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
// A release year at the end is packaging, not a second title in a series.
const TRAILING_YEAR = /[\s(]+(?:19|20)\d{2}[)\s]*$/;
const COLON_SUFFIX = /\s*:\s*[^:]{0,80}$/;
// A base made only of these words is not a franchise name, whatever was cut off the title.
const NON_COLLECTION_WORDS = new Set([
  'movie', 'movies', 'film', 'films', 'series', 'season', 'part', 'episode', 'episodes', 'the',
  'and', 'with', 'a', 'an', 'of', 'full', 'hd', '4k', '8k', 'dubbed', 'subbed', 'hindi', 'english',
  'official', 'trailer', 'tamil', 'telugu', 'malayalam', 'kannada', 'bengali', 'japanese', 'chinese',
  'korean', 'multi', 'dual', 'eng', 'tam', 'tel', 'kan', '1080p', '720p', '480p', '2160p', 'cam',
  'hdcam', 'ts', 'dvdrip', 'webrip', 'x264', 'x265', 'hevc', 'aac', 'mkv', 'mp4', 'imax', '3d',
  'uncut', 'extended', 'version', 'watch', 'online', 'download', 'free'
]);
// What an uploader pastes onto the end of a title rather than what the work is called. Only a tail
// of these is ever removed, and the same cut runs over every title, so two cards that differ only by
// their packaging still land in one group.
const PACKAGING_WORDS = new Set([...NON_COLLECTION_WORDS].filter((word) => ![
  'the', 'and', 'with', 'a', 'an', 'of', 'part', 'chapter', 'section'
].includes(word)));

function slugKey(value) {
  return cleanText(value, 120)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

/**
 * The group a title belongs to, or null when its own name is the whole work.
 *
 * "Iron Man 3" and "Iron Man: The Final Cut" both reduce to "Iron Man"; "In the Grey" reduces to
 * nothing, because stripping its last word would claim it is a part of a franchise called "In the".
 * A colon subtitle is only dropped when something recognisable is left in front of it.
 */
export function collectionBaseTitle(value) {
  const title = cleanText(value, 180).replace(/\s+/g, ' ').trim();
  if (!title) return null;
  let base = title;
  // One rule at a time would leave a tail it cannot see ("Dhoom 2 (2006) HD"), so the tail is
  // trimmed until a pass changes nothing. Six passes is generous for any real caption and finite
  // for a pathological one.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = base;
    base = base
      .replace(TRAILING_HANDLE, ' ')
      .replace(TRAILING_YEAR, ' ')
      .replace(TRAILING_PART_MARKER, ' ')
      .replace(TRAILING_NUMBER, ' ')
      .replace(TRAILING_ROMAN, (match, numerals) => (ROMAN_NUMERAL.test(numerals) ? ' ' : match))
      .replace(/\s+(?:[^\p{L}\p{N}]+)+$/gu, ' ')
      .replace(/[.,;:!?'"\u2019()\[\]{}|_/\\-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A numbered subtitle and a colon subtitle are the same franchise: "Minions 2" and
    // "Minions: The Rise of Gru" both reduce to "Minions", so long as what is left in front of the
    // colon still names something a viewer would search for.
    if (base.includes(':')) {
      const front = base.replace(COLON_SUFFIX, '').replace(/[.\s]+$/, '').trim();
      if (front.length >= 4 && front.replace(/[^a-z]/gi, '').length >= 3) base = front;
    }
    const parts = base.split(/\s+/).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    if (parts.length > 1 && PACKAGING_WORDS.has(last)) {
      base = parts.slice(0, -1).join(' ').replace(/[.\s]+$/, '').trim();
    } else if (parts.length > 3 && STRANDED_ARTICLES.has(last)) {
      base = parts.slice(0, -1).join(' ').replace(/[.\s]+$/, '').trim();
    }
    if (base === before) break;
  }
  // A short base is not automatically junk: "Dhoom" and "KGF" are franchises someone will search
  // for. What has to be refused is a base that names nothing — a leftover digit, one letter, a
  // packaging tag, or a year wearing the shape of a title.
  const words = base.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (base.length < 3) return null;
  if (base.replace(/[^a-z]/gi, '').length < 3) return null;
  if (words.every((word) => NON_COLLECTION_WORDS.has(word.toLowerCase().replace(/[^a-z0-9]/g, '')))) return null;
  if (/^(?:19|20)\d{2}$/.test(base)) return null;
  return base;
}

/**
 * The collection a card should carry, derived from its title.
 *
 * Returns null when the title is already the group name *and* the caller cannot prove a second
 * entry exists — the repository decides that from the data, this only says what group it would join.
 */
export function deriveCollection(value) {
  const base = collectionBaseTitle(value);
  if (!base) return null;
  const key = slugKey(base);
  if (!key) return null;
  return { name: base, key, source: 'derived' };
}

/** Read what a publisher typed into /collection as the canonical shape. */
export function manualCollection(value) {
  const text = cleanText(value, 120).replace(/\s+/g, ' ').trim();
  if (!text || /^(?:none|clear|remove|unset|off|-|no collection)$/i.test(text)) return { name: null, key: null, source: 'manual', cleared: true };
  const name = text;
  const key = slugKey(name);
  if (!key) return { name: null, key: null, source: 'manual', cleared: true };
  return { name, key, source: 'manual' };
}

/** A stored collection record, normalised, or null when the card is not in one. */
export function normalizeCollection(value) {
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return manualCollection(value);
    return null;
  }
  const name = cleanText(value.name, 120) || null;
  const key = cleanText(value.key, 90) || (name ? slugKey(name) : null);
  if (!name || !key) return null;
  return { name, key, source: value.source === 'manual' ? 'manual' : 'derived' };
}

export function collectionKeyOf(value) {
  const normalized = normalizeCollection(value);
  return normalized?.key || null;
}

/**
 * What a card should carry: a hand-set collection always wins, and a derived one follows the title
 * so that a later /title correction moves the card to the group its real name describes.
 */
export function resolveCollection({ title = null, stored = null, requested = undefined, locked = false } = {}) {
  if (requested !== undefined) {
    const manual = manualCollection(requested);
    return manual.cleared ? { collection: null, collectionManual: true } : { collection: manual, collectionManual: true };
  }
  const normalizedStored = normalizeCollection(stored);
  if (locked || normalizedStored?.source === 'manual') {
    return { collection: normalizedStored, collectionManual: true };
  }
  return { collection: deriveCollection(title), collectionManual: Boolean(locked) };
}
