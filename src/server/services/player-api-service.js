import { normalizeQualityLabel } from './episode-service.js';

export const MAX_PLAYER_API_QUALITY_ENTRIES = 40;
export const MAX_PLAYER_API_BASE_URL_LENGTH = 300;

/** Normalize a resolution key the same way uploaded media qualities are labeled. */
export function normalizePlayerApiQuality(value) {
  const quality = normalizeQualityLabel(value);
  if (!quality || quality.length > 24 || !/^[A-Z0-9][A-Z0-9._ -]*$/.test(quality)) return null;
  return quality;
}

/**
 * Accept a public HTTP(S) endpoint prefix, not an arbitrary URL with credentials,
 * a query, or a fragment. The player service receives the Telegram post URL as
 * path text after this normalized prefix.
 */
export function normalizePlayerApiBaseUrl(value) {
  const candidate = String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
  if (!candidate || candidate.length > MAX_PLAYER_API_BASE_URL_LENGTH) return null;

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path === '/' ? '' : path}`;
  } catch {
    return null;
  }
}

/** Return a clean quality -> endpoint map, ignoring invalid persisted values. */
export function normalizePlayerApiSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? (value.apis && typeof value.apis === 'object' && !Array.isArray(value.apis) ? value.apis : value)
    : {};
  const entries = Object.entries(source)
    .map(([rawQuality, rawUrl]) => [normalizePlayerApiQuality(rawQuality), normalizePlayerApiBaseUrl(rawUrl)])
    .filter(([quality, url]) => quality && url);
  return Object.fromEntries(entries.slice(0, MAX_PLAYER_API_QUALITY_ENTRIES));
}

function normalizeTelegramPostUrl(value) {
  const candidate = String(value || '').trim();
  const match = candidate.match(/^https?:\/\/(?:t\.me|telegram\.me)\/c\/([1-9]\d{0,15})\/([1-9]\d{0,9})$/i);
  if (!match) return null;
  return `https://t.me/c/${match[1]}/${match[2]}`;
}

/**
 * Build the path-style player URL used by the external player API, e.g.
 * https://player.example/https://t.me/c/2617067511/25962.
 */
export function buildTelegramPlayerApiUrl(playerApis, quality, telegramPostUrl) {
  const key = normalizePlayerApiQuality(quality);
  const postUrl = normalizeTelegramPostUrl(telegramPostUrl);
  if (!key || !postUrl) return null;
  const baseUrl = normalizePlayerApiSettings(playerApis)[key];
  if (!baseUrl) return null;
  return `${baseUrl}/${postUrl}`;
}

/** Exact origins allowed to host configured player API iframes. */
export function playerApiFrameSources(playerApis) {
  const origins = new Set();
  for (const baseUrl of Object.values(normalizePlayerApiSettings(playerApis))) {
    try {
      origins.add(new URL(baseUrl).origin);
    } catch {
      // normalizePlayerApiSettings already rejected invalid endpoints.
    }
  }
  return [...origins];
}
