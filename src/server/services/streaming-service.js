import { cleanText } from '../lib/strings.js';

// This feature deliberately imports only a small publisher-supplied manifest.
// It never downloads, buffers, transcodes, or relays video through Koyeb.
// SeekStreaming exports iframe URLs from embedseek.com. Dailymotion and Rumble
// are included as manual, publisher-supplied alternatives; more approved hosts
// can be added with STREAMING_ALLOWED_HOSTS without changing source code.
export const DEFAULT_STREAMING_HOSTS = [
  'seekstreaming.com',
  'embedseek.com',
  'dailymotion.com',
  'dai.ly',
  'rumble.com'
];
export const MAX_STREAM_MANIFEST_ROWS = 1_000;
export const MAX_STREAM_ENTRIES_PER_POST = 500;

const POST_ID_PATTERN = /^SB-[A-F0-9]{10}$/;

function compactColumnName(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function valuesByColumn(row) {
  const values = new Map();
  for (const [key, value] of Object.entries(asObject(row) || {})) {
    const normalized = compactColumnName(key);
    if (normalized && !values.has(normalized)) values.set(normalized, value);
  }
  return values;
}

function firstValue(columns, names) {
  for (const name of names) {
    const value = columns.get(compactColumnName(name));
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function safeHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Normalize optional STREAMING_ALLOWED_HOSTS values while retaining SeekStreaming. */
export function normalizeStreamingHosts(value = []) {
  const supplied = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set([...DEFAULT_STREAMING_HOSTS, ...supplied]
    .map(safeHost)
    .filter(Boolean))];
}

function allowedHost(hostname, hosts) {
  const host = String(hostname || '').toLowerCase();
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

/**
 * Restrict provider links to HTTPS and an explicit allow-list. This protects
 * the public iframe from javascript/data URLs and prevents a manifest from
 * turning the catalog into an arbitrary embedding surface.
 */
export function extractStreamingUrl(value) {
  const raw = String(value || '').trim()
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
  if (!raw || raw.length > 8_000) return '';
  // SeekStreaming's dashboard can export either a naked player URL or a full
  // iframe snippet. Accept both forms, but persist only the URL—not arbitrary
  // markup—so it can never inject HTML into a public catalog page.
  const iframeMatch = raw.match(/<iframe\b[^>]*\bsrc\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
  const iframeSource = iframeMatch?.[2] || iframeMatch?.[3];
  return String(iframeSource || raw).trim();
}

export function safeStreamingUrl(value, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  const raw = extractStreamingUrl(value);
  if (!raw || raw.length > 2_000) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hosts = normalizeStreamingHosts(allowedHosts);
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHost(url.hostname, hosts)) return null;
  return url.toString();
}

export function streamingFrameSources(streaming = {}) {
  return normalizeStreamingHosts(streaming.allowedHosts).flatMap((host) => [`https://${host}`, `https://*.${host}`]);
}

function positiveEpisode(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 999 ? parsed : null;
}

function episodeLabel(start, end) {
  const first = String(start).padStart(2, '0');
  const last = String(end).padStart(2, '0');
  return start === end ? `Episode ${first}` : `Episodes ${first}–${last}`;
}

function parseEpisode(columns) {
  const explicitStart = positiveEpisode(firstValue(columns, ['episodeStart', 'start']));
  const explicitEnd = positiveEpisode(firstValue(columns, ['episodeEnd', 'end']));
  const raw = cleanText(firstValue(columns, ['episode', 'ep', 'episodeNumber', 'episodeRange']), 80);
  let start = explicitStart;
  let end = explicitEnd;
  if (!start && raw) {
    // A dedicated Episode column may safely contain a bare number/range.
    const match = raw.match(/(?:episode|ep)?\s*(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?/i);
    if (match) {
      start = positiveEpisode(match[1]);
      end = positiveEpisode(match[2]) || start;
    }
  }
  if (!start) {
    // SeekStreaming exports a Title but no dedicated Episode field. Infer only
    // explicit markers (Episode 01, EP 01, S01E01), never a sequel/year number
    // from an ordinary movie title such as “Cocktail 2”.
    const title = cleanText(firstValue(columns, ['episodeTitle', 'videoTitle', 'video_title', 'title', 'name']), 180);
    const match = title.match(/\b(?:episode|ep)\s*0*(\d{1,3})(?:\s*(?:-|–|to)\s*0*(\d{1,3}))?\b|\bs\d{1,2}e0*(\d{1,3})(?:\s*(?:-|–|to|[- ]?e)\s*0*(\d{1,3}))?\b/i);
    if (match) {
      start = positiveEpisode(match[1] || match[3]);
      end = positiveEpisode(match[2] || match[4]) || start;
    }
  }
  if (!start) return null;
  if (!end) end = start;
  if (end < start) return null;
  const label = cleanText(firstValue(columns, ['episodeLabel', 'episodeTitle']), 60) || episodeLabel(start, end);
  return { start, end, label };
}

function streamEntryIdentity(entry) {
  let host = 'provider';
  try {
    host = new URL(entry?.embedUrl || entry?.watchUrl || '').hostname.toLowerCase() || host;
  } catch {
    // A stored entry is normalized before this point; retain a stable fallback.
  }
  const labelKey = cleanText(entry?.videoId || entry?.label, 100)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'main';
  // Keep alternate providers for the same episode instead of overwriting them.
  // Re-importing the same host + episode replaces just that player URL. For
  // provider exports with no episode column, a VideoID/title also keeps every
  // separately exported video rather than retaining only the last row.
  if (entry?.episode?.start) return `episode:${entry.episode.start}-${entry.episode.end || entry.episode.start}:${host}`;
  return `default:${host}:${labelKey}`;
}

function compareStreamEntries(first, second) {
  const firstEpisode = first?.episode?.start || Number.MAX_SAFE_INTEGER;
  const secondEpisode = second?.episode?.start || Number.MAX_SAFE_INTEGER;
  if (firstEpisode !== secondEpisode) return firstEpisode - secondEpisode;
  return streamEntryIdentity(first).localeCompare(streamEntryIdentity(second));
}

function manifestCategory(value) {
  const raw = cleanText(value, 40).toLowerCase().replace(/[\s_]+/g, '-');
  if (raw === 'series' || raw === 'webseries') return 'web-series';
  if (raw === 'k-drama' || raw === 'korean-drama') return 'kdrama';
  return ['anime', 'cartoon', 'donghua', 'kdrama', 'movie', 'web-series'].includes(raw) ? raw : null;
}

function normalizedStreamFields(row, { allowedHosts = DEFAULT_STREAMING_HOSTS, requirePostId = false, allowMissingTarget = false } = {}) {
  const object = asObject(row);
  if (!object) return { error: 'must be an object with column names' };
  const columns = valuesByColumn(object);
  const suppliedPostId = cleanText(firstValue(columns, ['postId', 'post_id', 'adminId', 'admin_id', 'post']), 40).toUpperCase();
  const postId = POST_ID_PATTERN.test(suppliedPostId) ? suppliedPostId : null;
  const sourceTitle = cleanText(firstValue(columns, ['releaseTitle', 'release_title', 'contentTitle', 'content_title', 'soraboxTitle', 'sorabox_title', 'postTitle', 'post_title', 'catalogTitle', 'catalog_title', 'title']), 180);
  if (suppliedPostId && !postId) {
    return { error: 'contains an invalid SoraBox Post ID; use a value such as SB-0123ABCDEF' };
  }
  if (requirePostId && !postId) {
    return { error: 'requires a valid SoraBox Post ID such as SB-0123ABCDEF' };
  }
  if (!postId && !sourceTitle && !allowMissingTarget) {
    return { error: 'requires a postId/adminId, or a Title that exactly matches one existing catalog release' };
  }
  // SeekStreaming's export uses “Embed Link” and “Embed Code”. A naked URL,
  // an iframe snippet, or a CSV/JSON value under either name is accepted.
  const genericUrl = firstValue(columns, ['url', 'videoUrl', 'video_url']);
  const embedUrl = safeStreamingUrl(
    firstValue(columns, ['embedUrl', 'embed_url', 'embedLink', 'embed_link', 'embedCode', 'embed_code', 'embed', 'playerUrl', 'player_url', 'player', 'iframeUrl', 'iframe_url']) || genericUrl,
    { allowedHosts }
  );
  const watchUrl = safeStreamingUrl(
    firstValue(columns, ['watchUrl', 'watch_url', 'watch', 'link', 'externalUrl', 'external_url']) || genericUrl,
    { allowedHosts }
  );
  if (!embedUrl && !watchUrl) {
    return { error: 'requires an HTTPS player/embed or watch URL from an allowed streaming host' };
  }
  const episode = parseEpisode(columns);
  const label = cleanText(firstValue(columns, ['label', 'videoTitle', 'video_title', 'name', 'title']), 100)
    || episode?.label
    || 'Main player';
  return {
    postId,
    sourceTitle: sourceTitle || null,
    category: manifestCategory(firstValue(columns, ['category', 'collection'])),
    entry: {
      label,
      episode,
      videoId: cleanText(firstValue(columns, ['videoId', 'video_id', 'id']), 100) || null,
      provider: cleanText(firstValue(columns, ['provider', 'host']), 60) || 'SeekStreaming',
      embedUrl,
      watchUrl
    }
  };
}

function csvRows(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted value.');
  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => cleanText(value, 80));
  if (!headers.some((value) => compactColumnName(value))) {
    throw new Error('The CSV header is empty.');
  }
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function jsonRows(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The JSON could not be read. Send an array of stream-link entries.');
  }
  if (Array.isArray(parsed)) return parsed;
  if (asObject(parsed)) {
    for (const key of ['entries', 'items', 'rows', 'videos', 'data']) {
      if (Array.isArray(parsed[key])) return parsed[key];
      if (asObject(parsed[key])) return [parsed[key]];
    }
    return [parsed];
  }
  throw new Error('The JSON must be an entry object or an array of entries.');
}

export function inferStreamManifestFormat(document = {}) {
  const filename = String(document?.file_name || document?.fileName || '').toLowerCase();
  const mimeType = String(document?.mime_type || document?.mimeType || '').toLowerCase();
  if (filename.endsWith('.csv') || /(?:text\/csv|application\/csv)/.test(mimeType)) return 'csv';
  if (filename.endsWith('.json') || /(?:application\/json|text\/json)/.test(mimeType)) return 'json';
  return null;
}

/** Parse a compact JSON/CSV publisher manifest into validated stream links. */
export function parseStreamingManifest(input, { format, allowedHosts = DEFAULT_STREAMING_HOSTS, requirePostId = false, allowMissingTarget = false } = {}) {
  const selectedFormat = format === 'csv' || format === 'json' ? format : null;
  if (!selectedFormat) throw new Error('Send a .json or .csv streaming manifest.');
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const rows = selectedFormat === 'csv' ? csvRows(text) : jsonRows(text);
  const entries = [];
  const rejected = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (index >= MAX_STREAM_MANIFEST_ROWS) {
      rejected.push({ row: index + 1, error: `exceeds the ${MAX_STREAM_MANIFEST_ROWS}-row safety limit` });
      continue;
    }
    const parsed = normalizedStreamFields(rows[index], { allowedHosts, requirePostId, allowMissingTarget });
    if (parsed.error) rejected.push({ row: index + 1, error: parsed.error });
    else entries.push({ row: index + 1, ...parsed });
  }
  return { format: selectedFormat, totalRows: rows.length, entries, rejected };
}

function normalizedStoredEntry(entry, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  const object = asObject(entry);
  if (!object) return null;
  const columns = valuesByColumn(object);
  const genericUrl = firstValue(columns, ['url', 'videoUrl', 'video_url']);
  const embedUrl = safeStreamingUrl(
    firstValue(columns, ['embedUrl', 'embed_url', 'embed', 'playerUrl', 'player_url', 'player', 'iframeUrl', 'iframe_url']) || genericUrl,
    { allowedHosts }
  );
  const watchUrl = safeStreamingUrl(
    firstValue(columns, ['watchUrl', 'watch_url', 'watch', 'link', 'externalUrl', 'external_url']) || genericUrl,
    { allowedHosts }
  );
  if (!embedUrl && !watchUrl) return null;
  let episode = null;
  if (asObject(object.episode)) {
    const start = positiveEpisode(object.episode.start);
    const end = positiveEpisode(object.episode.end) || start;
    if (start && end >= start) {
      episode = {
        start,
        end,
        label: cleanText(object.episode.label, 60) || episodeLabel(start, end)
      };
    }
  } else {
    episode = parseEpisode(columns);
  }
  return {
    label: cleanText(object.label, 100) || episode?.label || 'Main player',
    episode,
    videoId: cleanText(object.videoId, 100) || null,
    provider: cleanText(object.provider, 60) || 'SeekStreaming',
    embedUrl,
    watchUrl
  };
}

/**
 * Replace an existing player's same episode/default entry and retain the rest.
 * That makes re-importing a corrected CSV/JSON idempotent without deleting
 * other episode links attached to the release.
 */
export function mergeStreamingEntries(existingStream, incomingEntries, { allowedHosts = DEFAULT_STREAMING_HOSTS, updatedAt = new Date().toISOString() } = {}) {
  const merged = new Map();
  for (const existing of Array.isArray(existingStream?.entries) ? existingStream.entries : []) {
    const safe = normalizedStoredEntry(existing, { allowedHosts });
    if (safe) merged.set(streamEntryIdentity(safe), safe);
  }
  for (const candidate of Array.isArray(incomingEntries) ? incomingEntries : []) {
    const safe = normalizedStoredEntry(candidate?.entry || candidate, { allowedHosts });
    if (safe) merged.set(streamEntryIdentity(safe), safe);
  }
  const entries = [...merged.values()].sort(compareStreamEntries).slice(0, MAX_STREAM_ENTRIES_PER_POST);
  if (!entries.length) return null;
  return {
    provider: cleanText(existingStream?.provider, 60) || entries[0].provider || 'SeekStreaming',
    entries,
    updatedAt: new Date(updatedAt).toString() === 'Invalid Date' ? new Date().toISOString() : new Date(updatedAt).toISOString()
  };
}

/** Return only safe, public player fields; database/post IDs never travel here. */
export function publicStreamingData(stream, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  const entries = (Array.isArray(stream?.entries) ? stream.entries : [])
    .map((entry) => normalizedStoredEntry(entry, { allowedHosts }))
    .filter(Boolean)
    .sort(compareStreamEntries)
    .slice(0, MAX_STREAM_ENTRIES_PER_POST)
    .map((entry) => ({
      id: streamEntryIdentity(entry),
      label: entry.label,
      episode: entry.episode,
      provider: entry.provider,
      embedUrl: entry.embedUrl || null,
      watchUrl: entry.watchUrl || null
    }));
  return {
    available: entries.length > 0,
    provider: cleanText(stream?.provider, 60) || entries[0]?.provider || null,
    entries,
    updatedAt: stream?.updatedAt && !Number.isNaN(new Date(stream.updatedAt).getTime()) ? new Date(stream.updatedAt).toISOString() : null
  };
}
