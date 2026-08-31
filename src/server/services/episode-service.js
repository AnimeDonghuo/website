import { cleanText } from '../lib/strings.js';

const MAX_EPISODE = 999;
const MAX_RANGE_WIDTH = 300;

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
      .replace(/(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/[A-Za-z0-9_+\-/]+/gi, ' ')
      .replace(/@[A-Za-z][A-Za-z0-9_]{2,}/g, ' ')
      .replace(/[\[\]{}]/g, ' ')
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
    .replace(/\.(mkv|mp4|avi|webm|mov|m4v|zip|rar|7z|srt|ass|mka|mp3|flac)$/i, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\b(?:360|480|576|720|1080|1440|2160|4k|8k)\s*p?\b/gi, ' ')
    .replace(/\b(?:web[- ]?dl|webrip|bluray|brrip|hdrip|x264|x265|hevc|aac|ddp|10bit)\b/gi, ' ')
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
