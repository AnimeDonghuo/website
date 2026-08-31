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
  ['Russian', /\brussian\b/i]
];

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

// Captions are checked first because uploaders often put the clean title and
// episode range there. Telegram handles and t.me links are removed before any
// parsing, so @channel names never become part of a release/episode label.
export function stripTelegramAttribution(value) {
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
    500
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
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleanText(withoutAttribution, 180);
}

export function detectMediaQuality({ caption, filename }) {
  const candidates = [stripTelegramAttribution(caption), stripTelegramAttribution(filename)].filter(Boolean);
  for (const candidate of candidates) {
    const match = candidate.match(/\b(8k|4k|2160p|1440p|1080p|720p|576p|480p|360p)\b/i);
    if (match) return match[1].toUpperCase();
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

// Captions are more intentional than filenames. If a caption names languages,
// use only that set; otherwise inspect the filename as a fallback. In
// particular, the word "Multi" alone is never emitted as a public language.
export function detectUploadLanguages({ caption, filename }) {
  const captionLanguages = detectedLanguagesIn(caption);
  if (captionLanguages.length) return captionLanguages;
  return detectedLanguagesIn(filename);
}

export function summarizeUploadLanguages(files = []) {
  const languages = [];
  const seen = new Set();
  for (const file of files) {
    const savedLanguages = Array.isArray(file?.languages)
      ? file.languages
        .map((language) => cleanText(language, 40))
        .filter((language) => language && !/^(?:multi(?:\s+language)?|dual\s+audio)$/i.test(language))
      : [];
    const detected = savedLanguages.length
      ? savedLanguages
      : detectUploadLanguages({ caption: file?.displayName, filename: file?.name });
    for (const language of detected) {
      const cleanLanguage = cleanText(language, 40);
      const key = cleanLanguage.toLowerCase();
      if (!cleanLanguage || /^(?:multi(?:\s+language)?|dual\s+audio)$/i.test(cleanLanguage) || seen.has(key)) continue;
      seen.add(key);
      languages.push(cleanLanguage);
      if (languages.length === 8) return languages;
    }
  }
  return languages;
}

export function detectUploadEpisode({ caption, filename }) {
  const captionText = stripTelegramAttribution(caption);
  const captionEpisode = extractEpisodeRange(captionText);
  if (captionEpisode) {
    return { ...captionEpisode, source: 'caption', displayName: cleanMediaName(captionText) || captionEpisode.label };
  }

  const filenameText = cleanMediaName(filename);
  const filenameEpisode = extractEpisodeRange(filenameText);
  if (filenameEpisode) {
    return { ...filenameEpisode, source: 'filename', displayName: filenameText || filenameEpisode.label };
  }

  return {
    start: null,
    end: null,
    label: null,
    source: null,
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
