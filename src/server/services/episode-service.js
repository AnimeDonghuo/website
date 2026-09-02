import { cleanText } from '../lib/strings.js';

const MAX_EPISODE = 999;
const MAX_RANGE_WIDTH = 300;

// These are intentionally display labels rather than a generic "Multi" tag.
// Upload captions such as "Multi (Hindi + Malayalam)" should tell visitors
// exactly which languages are included on the actual release.
const LANGUAGE_PATTERNS = [
  ['Hindi', /\b(?:hindi|hin)\b/i],
  ['Malayalam', /\b(?:malayalam|mal)\b/i],
  ['Tamil', /\b(?:tamil|tam)\b/i],
  ['Telugu', /\b(?:telugu|tel)\b/i],
  ['Kannada', /\b(?:kannada|kan)\b/i],
  ['Bengali', /\b(?:bengali|bangla)\b/i],
  ['Marathi', /\bmarathi\b/i],
  ['Punjabi', /\bpunjabi\b/i],
  ['Gujarati', /\bgujarati\b/i],
  ['Urdu', /\burdu\b/i],
  ['English', /\b(?:english|eng)\b/i],
  ['Japanese', /\b(?:japanese|jpn)\b/i],
  ['Korean', /\b(?:korean|kor)\b/i],
  ['Chinese', /\b(?:chinese|mandarin|cantonese)\b/i],
  ['Indonesian', /\b(?:indonesian|indo)\b/i],
  ['Thai', /\bthai\b/i],
  ['Vietnamese', /\bvietnamese\b/i],
  ['Spanish', /\bspanish\b/i],
  ['French', /\bfrench\b/i],
  ['German', /\bgerman\b/i],
  ['Portuguese', /\bportuguese\b/i],
  ['Arabic', /\barabic\b/i],
  ['Russian', /\brussian\b/i],
  ['Nepali', /\bnepali\b/i],
  ['Odia', /\b(?:odia|oriya)\b/i],
  ['Assamese', /\bassamese\b/i],
  ['Italian', /\bitalian\b/i],
  ['Turkish', /\bturkish\b/i],
  ['Polish', /\bpolish\b/i],
  ['Ukrainian', /\bukrainian\b/i],
  ['Dutch', /\bdutch\b/i],
  ['Persian', /\b(?:persian|farsi)\b/i],
  ['Malay', /\bmalay\b/i],
  ['Filipino', /\b(?:filipino|tagalog)\b/i],
  ['Lithuanian', /\blithuanian\b/i]
];

const LANGUAGE_CODES = new Map([
  ['en', 'English'], ['eng', 'English'],
  ['hi', 'Hindi'], ['hin', 'Hindi'],
  ['ml', 'Malayalam'], ['mal', 'Malayalam'],
  ['ta', 'Tamil'], ['tam', 'Tamil'],
  ['te', 'Telugu'], ['tel', 'Telugu'],
  ['kn', 'Kannada'], ['kan', 'Kannada'],
  ['bn', 'Bengali'], ['ben', 'Bengali'], ['bang', 'Bengali'],
  ['mr', 'Marathi'], ['mar', 'Marathi'],
  ['pa', 'Punjabi'], ['pan', 'Punjabi'],
  ['gu', 'Gujarati'], ['guj', 'Gujarati'],
  ['ur', 'Urdu'], ['urd', 'Urdu'],
  ['ja', 'Japanese'], ['jpn', 'Japanese'],
  ['ko', 'Korean'], ['kor', 'Korean'],
  ['zh', 'Chinese'], ['zho', 'Chinese'], ['chi', 'Chinese'], ['cmn', 'Chinese'], ['yue', 'Chinese'],
  ['id', 'Indonesian'], ['ind', 'Indonesian'], ['indo', 'Indonesian'],
  ['th', 'Thai'], ['tha', 'Thai'],
  ['vi', 'Vietnamese'], ['vie', 'Vietnamese'],
  ['es', 'Spanish'], ['spa', 'Spanish'],
  ['fr', 'French'], ['fra', 'French'], ['fre', 'French'],
  ['de', 'German'], ['deu', 'German'], ['ger', 'German'],
  ['pt', 'Portuguese'], ['por', 'Portuguese'],
  ['ar', 'Arabic'], ['ara', 'Arabic'],
  ['ru', 'Russian'], ['rus', 'Russian'],
  ['ne', 'Nepali'], ['nep', 'Nepali'],
  ['or', 'Odia'], ['ori', 'Odia'],
  ['as', 'Assamese'], ['asm', 'Assamese'],
  ['it', 'Italian'], ['ita', 'Italian'],
  ['tr', 'Turkish'], ['tur', 'Turkish'],
  ['pl', 'Polish'], ['pol', 'Polish'],
  ['uk', 'Ukrainian'], ['ukr', 'Ukrainian'],
  ['nl', 'Dutch'], ['nld', 'Dutch'], ['dut', 'Dutch'],
  ['fa', 'Persian'], ['fas', 'Persian'], ['per', 'Persian'],
  ['ms', 'Malay'], ['msa', 'Malay'], ['may', 'Malay'],
  ['fil', 'Filipino'], ['tl', 'Filipino'], ['tgl', 'Filipino'],
  ['lt', 'Lithuanian'], ['lit', 'Lithuanian']
]);

// Accept compact release labels such as `ESubs` as well as normal `English
// Subtitles` wording. Keep `English Subtitles` split into its language and
// marker so the nearby-language parser can identify English rather than an
// unrelated earlier audio language.
const SUBTITLE_MARKER = /\b(?:sub(?:title)?s?|(?:e|eng)[- ]?sub(?:title)?s?|cc|closed\s*captions?|softsub|hardsub)\b/i;
const ENGLISH_SUBTITLE_TAG = /^(?:(?:e|eng)[- ]?sub(?:title)?s?|english\s+sub(?:title)?s?)$/i;
const RELEASE_SUBTITLE_TAG = /\b(?:e(?:ng(?:lish)?)?[- ]?sub(?:title)?s?|softsub|hardsub|closed\s*captions?)\b/gi;
const NEARBY_SUBTITLE_TAGS = ['sub', 'subs', 'subtitle', 'subtitles', 'e-sub', 'e-subs', 'esub', 'esubs', 'eng-sub', 'eng-subs', 'engsub', 'engsubs', 'cc', 'closed captions', 'softsub', 'hardsub'];

function validEpisode(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_EPISODE;
}

function paddedEpisode(value) {
  return value < 100 ? String(value).padStart(2, '0') : String(value);
}

export function formatEpisodeLabel(start, end = start) {
  if (!validEpisode(start) || !validEpisode(end)) return null;
  return start === end
    ? `Episode ${paddedEpisode(start)}`
    : `Episodes ${paddedEpisode(start)}–${paddedEpisode(end)}`;
}

export function formatRangeLabel(start, end = start) {
  return `EP ${paddedEpisode(start)}${start === end ? '' : `–${paddedEpisode(end)}`}`;
}

/* ---------------------------------------------------------------------------
 * Quality ordering
 * ------------------------------------------------------------------------- */

// Names are far more useful to a visitor when every quality of one release is
// listed from the smallest file to the largest, instead of upload order.
const QUALITY_HEIGHTS = new Map([
  ['hd', 720],
  ['fhd', 1080],
  ['qhd', 1440],
  ['uhd', 2160],
  ['sd', 480]
]);
const K_RESOLUTION_HEIGHTS = new Map([[2, 1440], [4, 2160], [5, 2880], [6, 3840], [8, 4320]]);

/** `1080p`, `1080`, `FHD` and `4K` all collapse into one comparable label. */
export function normalizeQualityLabel(value) {
  const raw = cleanText(value, 24).toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  const pixels = raw.match(/^(\d{3,4})P?$/);
  if (pixels) return `${pixels[1]}P`;
  const k = raw.match(/^(\d{1,2})K$/);
  if (k) return `${k[1]}K`;
  return raw;
}

/** Vertical resolution estimate used only for ordering; null when unknown. */
export function qualityHeight(value) {
  const label = normalizeQualityLabel(value);
  if (!label) return null;
  const pixels = label.match(/^(\d{3,4})P$/);
  if (pixels) return Number(pixels[1]);
  const k = label.match(/^(\d{1,2})K$/);
  if (k) {
    const known = K_RESOLUTION_HEIGHTS.get(Number(k[1]));
    return Number.isInteger(known) ? known : Number(k[1]) * 540;
  }
  return QUALITY_HEIGHTS.get(label.toLowerCase()) || null;
}

export function compareQualityAscending(first, second) {
  const firstHeight = qualityHeight(first);
  const secondHeight = qualityHeight(second);
  // An unknown quality is not "small"; it belongs after every known one so a
  // reader still sees the real 480p → 720p → 1080p ladder in sequence.
  if (firstHeight === null && secondHeight === null) return 0;
  if (firstHeight === null) return 1;
  if (secondHeight === null) return -1;
  return firstHeight - secondHeight;
}

/* ---------------------------------------------------------------------------
 * Season detection
 * ------------------------------------------------------------------------- */

export const MAX_SEASON = 99;

function validSeason(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_SEASON;
}

export function formatSeasonLabel(season) {
  return validSeason(season) ? `Season ${season}` : null;
}

/**
 * Recognise `S01E05`, `Season 1`, `S2`, `1x05`, and a season word inside a
 * caption. Years and quality labels are explicitly excluded, so `2024` or
 * `1080p` can never be read as a season number.
 */
export function extractSeasonNumber(value) {
  const text = stripTelegramAttribution(value)
    .replace(/[_.]/g, ' ')
    .replace(/\s+/g, ' ');
  if (!text) return null;

  const explicit = text.match(/\b(?:SEASON|S)[\s-]*0*(\d{1,2})\b/i);
  if (explicit && validSeason(Number.parseInt(explicit[1], 10))) return Number.parseInt(explicit[1], 10);

  // A compact package marker such as `S01E05`, `S01 1080p`, or `S2`. The token
  // must not continue into another word, so `Soul`, `1080p`, and `8bit` can
  // never be mistaken for a season.
  const compact = text.match(/\bS[\s-]*0*(\d{1,2})(?!\d)(?![a-df-z])/i);
  if (compact && validSeason(Number.parseInt(compact[1], 10))) return Number.parseInt(compact[1], 10);

  const classic = text.match(/\b(\d{1,2})\s*x\s*\d{1,3}\b/);
  if (classic && validSeason(Number.parseInt(classic[1], 10))) return Number.parseInt(classic[1], 10);

  return null;
}

export function detectUploadSeason({ caption, filename } = {}) {
  const captionSeason = extractSeasonNumber(caption);
  if (captionSeason) return { season: captionSeason, source: 'caption' };
  const filenameSeason = extractSeasonNumber(filename);
  if (filenameSeason) return { season: filenameSeason, source: 'filename' };
  return { season: null, source: null };
}

// Captions are checked first because uploaders often put the clean title and
// episode range there. Telegram handles and t.me links are removed before any
// parsing, so @channel names never become part of a release/episode label.
export function stripTelegramAttribution(value, maxLength = 500) {
  return cleanText(
    String(value || '')
      // Publisher captions frequently append a Markdown attribution such as
      // [t.is](http://t.is). It is metadata, not part of the release name.
      .replace(/\[[^\]\n]{1,120}\]\(\s*(?:https?:\/\/|www\.)[^)\s]+\s*\)/gi, ' ')
      .replace(/(?:https?:\/\/|www\.)[^\s<>()]+/gi, ' ')
      .replace(/(?:t\.me|telegram\.me)\/[A-Za-z0-9_+\-/]+/gi, ' ')
      .replace(/@[A-Za-z][A-Za-z0-9_]{2,}/g, ' ')
      // Keep square brackets until cleanMediaName can remove an entire release
      // label such as [C_B], rather than leaving its inner letters behind.
      .replace(/[{}]/g, ' ')
      .replace(/\s{2,}/g, ' '),
    maxLength
  );
}

function parseRange(startValue, endValue) {
  const start = Number.parseInt(startValue, 10);
  const end = Number.parseInt(endValue, 10);
  if (!validEpisode(start) || !validEpisode(end) || end < start || end - start > MAX_RANGE_WIDTH) return null;
  return { start, end, label: formatEpisodeLabel(start, end) };
}

export function extractEpisodeRange(value) {
  const text = stripTelegramAttribution(value)
    .replace(/[_.]/g, ' ')
    .replace(/\s+/g, ' ');
  if (!text) return null;

  // S01E01, S1 E01, and a range such as S01E01-E05.
  const seasonEpisode = text.match(/\bS(?:EASON)?\s*\d{1,2}\s*[- ]?E(?:P(?:ISODE)?)?\s*0*(\d{1,3})(?:\s*(?:-|–|—|~|\bTO\b|\bTHROUGH\b)\s*(?:E(?:P(?:ISODE)?)?\s*)?0*(\d{1,3}))?\b/i);
  if (seasonEpisode) return parseRange(seasonEpisode[1], seasonEpisode[2] || seasonEpisode[1]);

  // Explicit forms: Episode 1, EP 01, E5, Ep 1 To 5, Episodes 01-05.
  const explicit = text.match(/\b(?:EPISODES?|EPS?|EP|E)\s*0*(\d{1,3})(?:\s*(?:-|–|—|~|\bTO\b|\bTHROUGH\b)\s*(?:(?:EPISODES?|EPS?|EP|E)\s*)?0*(\d{1,3}))?\b/i);
  if (explicit) return parseRange(explicit[1], explicit[2] || explicit[1]);

  // A clean title caption sometimes only says "1 to 5". This intentionally
  // avoids 4-digit values, so years and common 1080p/2160p quality labels are ignored.
  const looseRange = text.match(/(?:^|\s)0*(\d{1,3})\s*(?:-|–|—|~|\bTO\b|\bTHROUGH\b)\s*0*(\d{1,3})(?:\s|$)/i);
  if (looseRange) return parseRange(looseRange[1], looseRange[2]);

  return null;
}

export function cleanMediaName(value) {
  const withoutAttribution = stripTelegramAttribution(value)
    // Release extensions and bracketed group/source labels do not identify a title.
    .replace(/\.(mkv|mp4|avi|webm|mov|m4v|ts|zip|rar|7z|srt|ass|mka|mp3|flac)$/i, '')
    .replace(/[\[\(][^\]\)]{0,160}[\]\)]/g, ' ')
    .replace(/[._~|]+/g, ' ')
    // A year belongs in metadata. Keeping it in the inferred title causes every
    // re-encode of one film to be treated as a new catalog entry.
    .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
    // Remove only a standalone season package label. The negative lookahead
    // deliberately keeps S01E03 / Season 1 Episode 3 for episode detection.
    .replace(/\bS(?:EASON)?\s*0*\d{1,2}(?!\s*[- ]?E(?:P(?:ISODE)?)?\s*\d{1,3})\b/gi, ' ')
    .replace(/\b(?:360|480|576|720|1080|1440|2160|4320)\s*p?\b/gi, ' ')
    .replace(/\b(?:4k|8k|uhd|fhd|hd)\b/gi, ' ')
    .replace(/\b(?:web[- ]?(?:dl|rip)?|blu[- ]?ray|brrip|hdrip|dvdrip|remux|cam|hdcam|predvd|proper|repack|uncut|extended|unrated)\b/gi, ' ')
    .replace(/\b(?:x\s*26[45]|h\s*26[45]|hevc|av1|avc|vp9|10bit|8bit)\b/gi, ' ')
    .replace(/\b(?:ddp?|eac3|ac3|truehd|dts(?:[- ]?hd)?|aac|opus|flac|mp3)\s*\d+(?:\s+\d+)?\b/gi, ' ')
    .replace(/\b(?:atmos|dolby[- ]?vision|hdr10(?:\+)?|sdr)\b/gi, ' ')
    // Common providers/release labels found in direct Telegram uploads.
    .replace(/\b(?:nf|netflix|amzn|amazon|prime(?:video)?|zee\s*5?|jiocinema|jiohotstar|hotstar|sonyliv|sony\s*liv|mx(?:player)?|altbalaji|aha|hoichoi|voot|hulu|hbo(?:max)?|max|atvp|apple\s*tv\+?|disney\+?|youtube|tubi|crunchyroll|bilibili|wetv|iqiyi)\b/gi, ' ')
    .replace(/\b(?:dubbed|subbed|dual[- ]?audio|multi[- ]?audio|original[- ]?audio)\b/gi, ' ')
    .replace(RELEASE_SUBTITLE_TAG, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleanText(withoutAttribution, 180);
}

/**
 * A delivery option needs a readable file label, not the catalog-title merge
 * key. Unlike `cleanMediaName`, keep a useful standalone season marker (for
 * example `The Gentlemen Season 1`) while removing codecs, providers, quality,
 * language brackets, and subtitle release tags such as `ESubs`.
 */
export function cleanDeliveryFileName(value) {
  const label = stripTelegramAttribution(value)
    .replace(/\.(mkv|mp4|avi|webm|mov|m4v|ts|zip|rar|7z|srt|ass|mka|mp3|flac)$/i, '')
    .replace(/[\[\(][^\]\)]{0,160}[\]\)]/g, ' ')
    .replace(/[._~|]+/g, ' ')
    .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\b(?:360|480|576|720|1080|1440|2160|4320)\s*p?\b/gi, ' ')
    .replace(/\b(?:4k|8k|uhd|fhd|hd)\b/gi, ' ')
    .replace(/\b(?:web[- ]?(?:dl|rip)?|blu[- ]?ray|brrip|hdrip|dvdrip|remux|cam|hdcam|predvd|proper|repack|uncut|extended|unrated)\b/gi, ' ')
    .replace(/\b(?:x\s*26[45]|h\s*26[45]|hevc|av1|avc|vp9|10bit|8bit)\b/gi, ' ')
    .replace(/\b(?:ddp?|eac3|ac3|truehd|dts(?:[- ]?hd)?|aac|opus|flac|mp3)\s*\d+(?:\s+\d+)?\b/gi, ' ')
    .replace(/\b(?:atmos|dolby[- ]?vision|hdr10(?:\+)?|sdr)\b/gi, ' ')
    .replace(/\b(?:nf|netflix|amzn|amazon|prime(?:video)?|zee\s*5?|jiocinema|jiohotstar|hotstar|sonyliv|sony\s*liv|mx(?:player)?|altbalaji|aha|hoichoi|voot|hulu|hbo(?:max)?|max|atvp|apple\s*tv\+?|disney\+?|youtube|tubi|crunchyroll|bilibili|wetv|iqiyi)\b/gi, ' ')
    .replace(/\b(?:dubbed|subbed|dual[- ]?audio|multi[- ]?audio|original[- ]?audio)\b/gi, ' ')
    .replace(RELEASE_SUBTITLE_TAG, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleanText(label, 180);
}

export function detectMediaQuality({ caption, filename }) {
  const candidates = [stripTelegramAttribution(caption), stripTelegramAttribution(filename)].filter(Boolean);
  for (const candidate of candidates) {
    const match = candidate.match(/\b(8k|4k|2160p|1440p|1080p|720p|576p|480p|360p)\b/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/**
 * A delivery row must tell the visitor what they are actually receiving, so
 * this keeps every useful word of the uploader's own caption/filename and only
 * removes Telegram promotion, the container extension, and separator noise.
 * Unlike `cleanMediaName` it never strips quality, episode, season, language,
 * or source labels — those are exactly what distinguishes one file from the
 * next when a release has several uploads to choose from.
 */
export function publicFileDisplayName(value) {
  const name = stripTelegramAttribution(value, 320)
    .replace(/\.(mkv|mp4|avi|webm|mov|m4v|ts|zip|rar|7z|srt|ass|mka|mp3|flac)$/i, '')
    .replace(/[{}]/g, ' ')
    .replace(/[_~|]+/g, ' ')
    .replace(/\.(?=\S)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleanText(name, 260);
}

/**
 * Two files describe the same delivery slot when a later upload should replace
 * the earlier one. Episode ranges ignore quality on purpose: re-uploading a
 * corrected Episode 1 should refresh every older Episode 1 variant instead of
 * leaving the release half old and half new. Files without an episode (typically
 * a feature film) only collide when the cleaned title, audio languages, and
 * quality all match, so adding a new quality of the same movie is preserved.
 */
export function fileReplacementKey(file) {
  if (!file || typeof file !== 'object') return null;
  const start = Number(file?.episode?.start);
  const end = Number(file?.episode?.end ?? file?.episode?.start);
  const languages = uniqueLanguageLabels(
    Array.isArray(file?.audioLanguages) && file.audioLanguages.length
      ? file.audioLanguages
      : Array.isArray(file?.languages) ? file.languages : []
  ).map((language) => language.toLowerCase()).sort().join('+');

  if (validEpisode(start) && validEpisode(end) && end >= start) {
    return { key: `ep:${start}-${end}`, languages };
  }

  const quality = normalizeQualityLabel(file?.quality);
  if (!quality) return null;
  const titleKey = cleanMediaName(file?.displayName || file?.sourceLabel || file?.name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!titleKey) return null;
  return { key: `name:${titleKey}|${quality.toLowerCase()}`, languages };
}

/**
 * Split one upload batch into per-season file groups so different seasons can
 * never share a catalog post. Episodes restart at 1 in every season, so an
 * unmarked file is attributed by upload position — it joins the season block it
 * was sent inside, or the first season when nothing precedes it.
 */
export function groupFilesBySeason(files = []) {
  const entries = (Array.isArray(files) ? files : []).map((file) => {
    const stored = Number(file?.season);
    return {
      file,
      season: validSeason(stored)
        ? stored
        : (detectUploadSeason({ caption: file?.displayName || file?.sourceLabel, filename: file?.name }).season ?? null)
    };
  });
  const seasons = [...new Set(entries.map((entry) => entry.season).filter(Boolean))].sort((first, second) => first - second);
  if (seasons.length <= 1) return [];

  const groups = new Map(seasons.map((season) => [season, []]));
  let currentSeason = null;
  for (const entry of entries) {
    const season = entry.season || currentSeason || seasons[0];
    groups.get(season).push(entry.file);
    currentSeason = season;
  }

  return seasons
    .filter((season) => groups.get(season).length)
    .map((season) => ({
      season,
      label: formatSeasonLabel(season),
      files: groups.get(season)
    }));
}


function uniqueLanguageLabels(values = [], maximum = 8) {
  const labels = [];
  const seen = new Set();
  for (const value of values) {
    const label = normalizeLanguageLabel(value);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
    if (labels.length === maximum) break;
  }
  return labels;
}

/** Normalize MediaInfo ISO codes and common human labels into catalog labels. */
export function normalizeLanguageLabel(value, { allowUnknown = false } = {}) {
  const raw = cleanText(value, 80);
  if (!raw) return null;
  const compact = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (LANGUAGE_CODES.has(compact)) return LANGUAGE_CODES.get(compact);
  // MediaInfo may return BCP-47 language tags such as en-US or hi-IN.
  const tag = raw.toLowerCase().match(/^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})+$/i);
  if (tag && LANGUAGE_CODES.has(tag[1])) return LANGUAGE_CODES.get(tag[1]);
  const direct = LANGUAGE_PATTERNS.find(([, pattern]) => pattern.test(raw));
  if (direct) return direct[0];
  // Do not publish MediaInfo's und/mul placeholders or unexplained ISO codes,
  // but retain a readable language name not yet in our mapping (for example
  // Lithuanian) rather than silently losing an accurately tagged track.
  if (!allowUnknown || /^(?:und|unknown|undetermined|none|n\/a|mul|multiple|multi(?:ple)?\s+languages?)$/i.test(raw)) return null;
  if (/^[a-z]{2,3}$/i.test(raw)) return null;
  if (/^[A-Za-z][A-Za-z -]{1,60}$/.test(raw)) {
    return raw.replace(/\b\w/g, (character) => character.toUpperCase());
  }
  return null;
}

function detectedLanguagesIn(value) {
  const text = stripTelegramAttribution(value).replace(/[_.+/]+/g, ' ');
  if (!text) return [];
  return LANGUAGE_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}

function startsNearbySubtitleTag(value) {
  const text = String(value || '').toLowerCase().trimStart().replace(/^[-:+|]+\s*/, '');
  return NEARBY_SUBTITLE_TAGS.some((tag) => text.startsWith(tag) && !/[a-z]/.test(text[tag.length] || ''));
}

function endsNearbySubtitleTag(value) {
  const text = String(value || '').toLowerCase().replace(/[-:+|\s]+$/, '');
  return NEARBY_SUBTITLE_TAGS.some((tag) => {
    const start = text.length - tag.length;
    return start >= 0 && text.endsWith(tag) && !/[a-z]/.test(text[start - 1] || '');
  });
}

function languageIsAttachedToSubtitleTag(text, language) {
  const source = String(text || '');
  const canonical = String(language || '').toLowerCase();
  // `Eng-Subs` is another common compact English-only subtitle label.
  const needles = canonical === 'english' ? ['english', 'eng'] : [canonical];
  for (const needle of needles) {
    if (!needle) continue;
    let position = source.toLowerCase().indexOf(needle);
    while (position >= 0) {
      const beforeCharacter = source[position - 1] || '';
      const afterCharacter = source[position + needle.length] || '';
      // Match whole words only: `Englishman` is not an English track label.
      if (!/[A-Za-z]/.test(beforeCharacter) && !/[A-Za-z]/.test(afterCharacter)) {
        const after = source.slice(position + needle.length, position + needle.length + 18);
        const before = source.slice(Math.max(0, position - 18), position);
        // The subtitle marker must be immediately next to the language. A later
        // `ESubs` tag should not erase English from `[Hindi-English]` audio.
        if (startsNearbySubtitleTag(after) || endsNearbySubtitleTag(before)) return true;
      }
      position = source.toLowerCase().indexOf(needle, position + needle.length);
    }
  }
  return false;
}

function audioLanguagesIn(value) {
  const labels = detectedLanguagesIn(value);
  const subtitleLabels = subtitleLanguagesIn(value);
  if (!subtitleLabels.length) return labels;
  const text = stripTelegramAttribution(value).replace(/[_.+/]+/g, ' ');
  return labels.filter((label) => !subtitleLabels.some((subtitle) => (
    subtitle.toLowerCase() === label.toLowerCase() && languageIsAttachedToSubtitleTag(text, label)
  )));
}

function subtitleLanguagesIn(value) {
  const text = stripTelegramAttribution(value).replace(/[_.+/]+/g, ' ');
  if (!text || !SUBTITLE_MARKER.test(text)) return [];
  const labels = [];
  for (const marker of text.matchAll(new RegExp(SUBTITLE_MARKER.source, 'gi'))) {
    const index = marker.index || 0;
    const keyword = marker[0].toLowerCase();
    // Take the directly adjacent word(s), rather than every language elsewhere
    // in a Dual Audio caption. "Hindi + English Subtitles" therefore records
    // English subtitles without incorrectly treating Hindi audio as text.
    const before = text.slice(Math.max(0, index - 24), index).match(/([A-Za-z-]{2,20})\s*$/)?.[1];
    const after = text.slice(index + marker[0].length, index + marker[0].length + 24).match(/^\s*[:\-–—]?\s*([A-Za-z-]{2,20})/)?.[1];
    const beforeLabel = normalizeLanguageLabel(before);
    const afterLabel = normalizeLanguageLabel(after);
    if (beforeLabel && !/^(?:closed|soft|hard)$/i.test(before || '')) labels.push(beforeLabel);
    // "English Subtitles Hindi Dub" still means English subtitles. Use the
    // after-marker form only when there is no explicit language immediately
    // before it, as in "Subtitles: English".
    else if (afterLabel) labels.push(afterLabel);
    if (ENGLISH_SUBTITLE_TAG.test(keyword)) labels.push('English');
  }
  return uniqueLanguageLabels(labels);
}

// Captions are more intentional than filenames. If a caption names languages,
// use only that set; otherwise inspect the filename as a fallback. In
// particular, the word "Multi" alone is never emitted as a public language.
export function detectUploadLanguages({ caption, filename }) {
  const captionLanguages = audioLanguagesIn(caption);
  if (captionLanguages.length) return captionLanguages;
  return audioLanguagesIn(filename);
}

/** Best-effort subtitle labels from captions/filenames before MediaInfo runs. */
export function detectUploadSubtitleLanguages({ caption, filename }) {
  const captionLanguages = subtitleLanguagesIn(caption);
  if (captionLanguages.length) return captionLanguages;
  return subtitleLanguagesIn(filename);
}

/** Files labelled Dual/Multi or without a concrete audio language are deferred for MediaInfo. */
export function needsMediaTrackInspection(file) {
  if (file?.mediaInfo?.status === 'verified' || file?.mediaInfo?.status === 'not-media') return false;
  // fileFromMessage preserves this decision from the original raw caption,
  // whose cleaned display name may intentionally remove "Dual Audio".
  if (file?.mediaInfo?.needsInspection === true) return true;
  const labels = Array.isArray(file?.audioLanguages) && file.audioLanguages.length
    ? file.audioLanguages
    : Array.isArray(file?.languages) ? file.languages : [];
  const source = [file?.displayName, file?.name].filter(Boolean).join(' ');
  return !uniqueLanguageLabels(labels).length || /\b(?:dual|multi)(?:\s+audio)?\b/i.test(source);
}

export function summarizeUploadLanguages(files = []) {
  const languages = [];
  const seen = new Set();
  for (const file of files) {
    const savedLanguages = Array.isArray(file?.audioLanguages) && file.audioLanguages.length
      ? file.audioLanguages
      : Array.isArray(file?.languages) ? file.languages : [];
    const detected = savedLanguages.length
      ? savedLanguages
      : detectUploadLanguages({ caption: file?.displayName, filename: file?.name });
    for (const language of uniqueLanguageLabels(detected)) {
      const key = language.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      languages.push(language);
      if (languages.length === 8) return languages;
    }
  }
  return languages;
}

export function summarizeSubtitleLanguages(files = []) {
  const languages = [];
  const seen = new Set();
  for (const file of files) {
    const savedLanguages = Array.isArray(file?.subtitleLanguages) ? file.subtitleLanguages : [];
    const detected = savedLanguages.length
      ? savedLanguages
      : detectUploadSubtitleLanguages({ caption: file?.displayName, filename: file?.name });
    for (const language of uniqueLanguageLabels(detected)) {
      const key = language.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      languages.push(language);
      if (languages.length === 8) return languages;
    }
  }
  return languages;
}

export function detectUploadEpisode({ caption, filename }) {
  const captionText = stripTelegramAttribution(caption);
  const captionEpisode = extractEpisodeRange(captionText);
  const season = detectUploadSeason({ caption, filename });
  if (captionEpisode) {
    return {
      ...captionEpisode,
      source: 'caption',
      season: season.season,
      seasonSource: season.source,
      displayName: cleanMediaName(captionText) || captionEpisode.label
    };
  }

  const filenameText = cleanMediaName(filename);
  const filenameEpisode = extractEpisodeRange(filenameText);
  if (filenameEpisode) {
    return {
      ...filenameEpisode,
      source: 'filename',
      season: season.season,
      seasonSource: season.source,
      displayName: filenameText || filenameEpisode.label
    };
  }

  return {
    start: null,
    end: null,
    label: null,
    source: null,
    season: season.season,
    seasonSource: season.source,
    displayName: cleanMediaName(captionText || filenameText) || 'Delivery file'
  };
}

export function summarizeEpisodes(files = []) {
  const groups = new Map();
  const episodeNumbers = new Set();
  let detectedFiles = 0;

  for (const file of files) {
    const start = Number(file?.episode?.start);
    const end = Number(file?.episode?.end ?? file?.episode?.start);
    if (!validEpisode(start) || !validEpisode(end) || end < start || end - start > MAX_RANGE_WIDTH) continue;
    detectedFiles += 1;
    const key = `${start}-${end}`;
    const current = groups.get(key) || {
      start,
      end,
      label: formatEpisodeLabel(start, end),
      // A range covering more than one episode is a combined pack. The website
      // lists those in their own block instead of mixing them into the single
      // episode rows they overlap.
      combined: end !== start,
      fileCount: 0
    };
    current.fileCount += 1;
    groups.set(key, current);
    for (let episode = start; episode <= end; episode += 1) episodeNumbers.add(episode);
  }

  const publicGroups = [...groups.values()].sort((first, second) => first.start - second.start || first.end - second.end);
  const count = episodeNumbers.size;
  const releaseLabel = count
    ? publicGroups.length === 1 && publicGroups[0].start !== publicGroups[0].end
      ? publicGroups[0].label
      : `${count} episode${count === 1 ? '' : 's'}`
    : null;

  return { groups: publicGroups, count, detectedFiles, releaseLabel };
}
