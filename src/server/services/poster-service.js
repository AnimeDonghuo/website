import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { slugify } from '../lib/strings.js';

const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// ImgBB answers a burst of uploads with "Rate limit reached", and a bulk publish (a /batch that
// split into 89 releases, say) is exactly such a burst. So uploads are paced, a limit is waited
// out inside one call, and identical artwork is hosted once. Every knob is an env because the
// honest number depends on the plan behind IMGBB_API_KEY.
function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
const IMGBB_UPLOAD_SPACING_MS = boundedIntegerEnv('IMGBB_UPLOAD_SPACING_MS', 1_600, 0, 60_000);
const IMGBB_RATE_LIMIT_ATTEMPTS = boundedIntegerEnv('IMGBB_RATE_LIMIT_ATTEMPTS', 3, 1, 8);
const IMGBB_RATE_LIMIT_BACKOFF_MS = boundedIntegerEnv('IMGBB_RATE_LIMIT_BACKOFF_MS', 20_000, 1_000, 15 * 60_000);
// One key is paced at the full interval, because a burst is what gets a key throttled. With a pool
// the same risk is spread over several quotas, so the pace relaxes — that is the point of
// configuring more than one key: a 117-card publish should take a couple of minutes, not five.
const IMGBB_POOL_SPACING_MS = boundedIntegerEnv('IMGBB_POOL_SPACING_MS', 900, 150, 60_000);
// A short wait is cheaper to sit out here than to hand to the retry queue. Anything longer belongs
// to the queue's timer, because a publisher should never wait on an image host for minutes.
const IMGBB_KEY_PATIENCE_MS = boundedIntegerEnv('IMGBB_KEY_PATIENCE_MS', 15_000, 0, 5 * 60_000);
const IMGBB_POOL_SIZE = 4;
const POSTER_UPLOAD_CACHE_LIMIT = 400;

export class PosterHostingError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PosterHostingError';
  }
}

/**
 * The one hosting failure a release should survive: the image is fine, the host is simply busy.
 * Everything else (a broken URL, an oversized file, a rejected key) still stops a publish, because
 * a card with no artwork at all is a different problem that the publisher has to see.
 */
export class PosterRateLimitError extends PosterHostingError {
  constructor(message = 'ImgBB is rate limiting this server.', options = {}) {
    super(message, options);
    this.name = 'PosterRateLimitError';
    this.retryAfterMs = Number(options.retryAfterMs) || null;
  }
}

export function isPosterRateLimit(error) {
  if (!error) return false;
  if (error.name === 'PosterRateLimitError' || error.status === 429 || error.statusCode === 429) return true;
  return /rate limit|too many requests|try again later|quota|429|limit exceeded/i.test(String(error.message || error.description || ''));
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
// Test seam and an operator seam: the pace, the wait used between attempts, and the clock.
const posterUploadOptions = {
  spacingMs: IMGBB_UPLOAD_SPACING_MS,
  attempts: IMGBB_RATE_LIMIT_ATTEMPTS,
  backoffMs: IMGBB_RATE_LIMIT_BACKOFF_MS,
  wait: pause,
  now: () => Date.now()
};
export function configurePosterUploadOptions(next = {}) {
  for (const key of ['spacingMs', 'attempts', 'backoffMs']) {
    if (next[key] !== undefined) posterUploadOptions[key] = Math.max(0, Number(next[key]) || 0);
  }
  if (typeof next.wait === 'function') posterUploadOptions.wait = next.wait;
  if (typeof next.now === 'function') posterUploadOptions.now = next.now;
  return { ...posterUploadOptions, wait: undefined, now: undefined };
}

/* -- the key pool -------------------------------------------------------------
 * One ImgBB key is one quota, and a bulk publish is a burst against it. `IMGBB_API_KEYS` accepts up
 * to 20 keys (comma, space, or newline separated; `IMGBB_API_KEY`, `IMGBB_API_KEY_2` … work too for
 * hosts that prefer one secret per line). Uploads then rotate across the pool: each key is paced on
 * its own clock, a key that answers 429 is cooled down and skipped while the rest keep working, and
 * an upload is never fired back at the key that just refused.
 */
const IMGBB_KEY_POOL_LIMIT = 20;
const IMGBB_KEY_COOLDOWN_MS = boundedIntegerEnv('IMGBB_KEY_COOLDOWN_MS', 60_000, 5_000, 30 * 60_000);

export function parseImgBBKeys(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/))
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  return [...new Set(list)].slice(0, IMGBB_KEY_POOL_LIMIT);
}

// `sticky` is the key currently in favour. Uploads stay on one key until it says it is full, which
// is what an operator wants: one connection, one pace, and a switch only when it is forced.
const posterKeyPool = { list: null, sticky: -1, state: new Map() };

function resolvePosterKeys() {
  if (Array.isArray(posterKeyPool.list)) return posterKeyPool.list;
  const sources = [];
  if (process.env.IMGBB_API_KEY) sources.push(process.env.IMGBB_API_KEY);
  if (process.env.IMGBB_API_KEYS) sources.push(process.env.IMGBB_API_KEYS);
  for (let index = 1; index < IMGBB_KEY_POOL_LIMIT; index += 1) {
    const value = process.env[`IMGBB_API_KEY_${index + 1}`];
    if (value) sources.push(value);
  }
  posterKeyPool.list = parseImgBBKeys(sources.join(','));
  return posterKeyPool.list;
}

function posterKeyState(key) {
  let state = posterKeyPool.state.get(key);
  if (!state) {
    state = { lastUsedAt: 0, cooldownUntil: 0, refusals: 0 };
    posterKeyPool.state.set(key, state);
  }
  return state;
}

/** Replace the pool: null re-reads the environment, an array pins it (a test seam, or a caller with its own list). */
export function configurePosterKeys(keys) {
  posterKeyPool.list = keys === null || keys === undefined ? null : parseImgBBKeys(keys);
  posterKeyPool.sticky = -1;
  posterKeyPool.state.clear();
  return posterKeyPool.list ? posterKeyPool.list.length : resolvePosterKeys().length;
}

export function posterKeyPoolStatus() {
  const list = resolvePosterKeys();
  const at = posterUploadOptions.now();
  const cooling = list.filter((key) => posterKeyState(key).cooldownUntil > at);
  const soonest = list.length ? Math.min(...list.map((key) => posterKeyState(key).cooldownUntil)) : 0;
  return {
    configured: list.length,
    limit: IMGBB_KEY_POOL_LIMIT,
    cooling: cooling.length,
    free: list.length - cooling.length,
    sticky: posterKeyPool.sticky >= 0 ? list[posterKeyPool.sticky] || null : null,
    waitingMs: cooling.length ? Math.max(0, soonest - at) : 0,
    cooldownMs: IMGBB_KEY_COOLDOWN_MS,
    spacingMs: posterUploadOptions.spacingMs
  };
}

function pickPosterKey(keys, at) {
  if (!keys.length) return null;
  const sticky = posterKeyPool.sticky;
  // Stay on the key in favour while it will still take an upload. Switching keys per upload buys
  // nothing and costs a fresh quota's worth of waiting for no reason.
  if (sticky >= 0 && sticky < keys.length && posterKeyState(keys[sticky]).cooldownUntil <= at) return { key: keys[sticky], index: sticky };
  // With no key in favour the first one is offered; after a refusal the search starts just past the
  // key that refused, so a burst walks the pool once and then settles on whatever works.
  const start = sticky >= 0 ? (sticky + 1) % keys.length : 0;
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length;
    if (posterKeyState(keys[index]).cooldownUntil <= at) {
      posterKeyPool.sticky = index;
      return { key: keys[index], index };
    }
  }
  return null;
}

function coolPosterKey(key, ms) {
  const state = posterKeyState(key);
  state.refusals += 1;
  // A key that keeps refusing rests proportionally longer, so a tired pool is walked around rather
  // than hammered at the same speed by the next card.
  const coolFor = Math.max(1_000, Number(ms) || 0) * Math.min(6, state.refusals);
  state.cooldownUntil = Math.max(state.cooldownUntil, posterUploadOptions.now() + coolFor);
  // The refused key stops being the favoured one, so the next upload in this call picks another.
  posterKeyPool.sticky = -1;
  return coolFor;
}

/**
 * Same bytes, one upload. A mixed release split into several cards, or a re-run after a failure,
 * used to send the identical poster to ImgBB again for no reason at all.
 */
const posterUploadCache = new Map();
function cachePosterUpload(key, value) {
  if (!key) return;
  posterUploadCache.set(key, value);
  if (posterUploadCache.size > POSTER_UPLOAD_CACHE_LIMIT) posterUploadCache.delete(posterUploadCache.keys().next().value);
}
export function clearPosterUploadCache() {
  const size = posterUploadCache.size;
  posterUploadCache.clear();
  return size;
}

/** Forget every key's pacing and cooldown, and let the next upload start on the first key. */
export function resetPosterUploadPace() {
  posterKeyPool.state.clear();
  posterKeyPool.sticky = -1;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:')) return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (normalized.startsWith('::ffff:')) return !isPrivateIpv4(normalized.slice(7));
  return true;
}

async function assertPublicImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PosterHostingError('The poster URL is not a valid URL.');
  }

  if (url.protocol !== 'https:') {
    throw new PosterHostingError('Poster URLs must use HTTPS.');
  }
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
    throw new PosterHostingError('That poster host is not allowed.');
  }

  const literalIp = net.isIP(url.hostname);
  if (literalIp) {
    if (!isPublicIp(url.hostname)) throw new PosterHostingError('Private poster hosts are not allowed.');
    return url;
  }

  let addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new PosterHostingError('The poster host could not be resolved.');
  }

  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new PosterHostingError('The poster host is not a public image host.');
  }
  return url;
}

async function readResponseBody(response) {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new PosterHostingError('The poster is larger than the 8 MB upload limit.');
  }

  if (!response.body) throw new PosterHostingError('The poster response did not contain an image.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new PosterHostingError('The poster is larger than the 8 MB upload limit.');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

export async function downloadPosterImage(sourceUrl) {
  let currentUrl = sourceUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const safeUrl = await assertPublicImageUrl(currentUrl);
    let response;
    try {
      response = await fetch(safeUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'User-Agent': 'SoraBoxPosterMirror/1.0'
        }
      });
    } catch (error) {
      throw new PosterHostingError('The poster could not be downloaded.', { cause: error });
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new PosterHostingError('The poster host sent an invalid redirect.');
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new PosterHostingError(`The poster host responded with ${response.status}.`);
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new PosterHostingError('The poster URL did not return an image.');
    }
    return { buffer: await readResponseBody(response), contentType, sourceUrl: currentUrl };
  }

  throw new PosterHostingError('The poster redirected too many times.');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function titleSeed(title) {
  let result = 2166136261;
  for (const character of String(title || 'SoraBox')) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

const PALETTES = {
  anime: [[72, 51, 166], [202, 130, 255], [23, 18, 63]],
  cartoon: [[222, 82, 44], [255, 195, 84], [67, 22, 16]],
  donghua: [[8, 147, 152], [106, 233, 205], [4, 42, 58]],
  kdrama: [[209, 56, 119], [255, 160, 190], [68, 16, 52]],
  movie: [[161, 193, 35], [230, 255, 119], [26, 39, 18]],
  'web-series': [[40, 112, 231], [123, 190, 255], [13, 31, 82]],
  tv: [[176, 108, 12], [255, 196, 107], [46, 24, 6]],
  adult: [[173, 39, 65], [255, 150, 166], [48, 11, 20]]
};

function blend(first, second, factor) {
  return Math.max(0, Math.min(255, Math.round(first + (second - first) * factor)));
}

// Small built-in display font. Keeping it here avoids adding a native canvas
// dependency just to make generated fallback artwork useful on Koyeb.
const POSTER_FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '&': ['01010', '10100', '10100', '01000', '10101', '10010', '01101'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  ',': ['00000', '00000', '00000', '00000', '00110', '00110', '00100'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

function pixelOffset(width, x, y) {
  return y * (width * 4 + 1) + 1 + x * 4;
}

function paintPixel(raw, width, height, x, y, color, opacity = 1) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = pixelOffset(width, x, y);
  raw[offset] = blend(raw[offset], color[0], opacity);
  raw[offset + 1] = blend(raw[offset + 1], color[1], opacity);
  raw[offset + 2] = blend(raw[offset + 2], color[2], opacity);
}

function paintRect(raw, width, height, x, y, rectWidth, rectHeight, color, opacity = 1) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) paintPixel(raw, width, height, px, py, color, opacity);
  }
}

function titleLines(title, maxCharacters) {
  const words = String(title || 'Untitled release')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 78)
    .split(' ')
    .filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === 2) break;
  }
  if (line && lines.length < 3) lines.push(line);
  if (!lines.length) lines.push('UNTITLED RELEASE');
  return lines.map((lineText, index) => index === 2 && lineText.length > maxCharacters
    ? `${lineText.slice(0, Math.max(1, maxCharacters - 1))}…`
    : lineText);
}

function drawGlyph(raw, width, height, character, x, y, scale, color) {
  const glyph = POSTER_FONT[character] || POSTER_FONT['?'];
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      if (glyph[row][column] !== '1') continue;
      paintRect(raw, width, height, x + column * scale, y + row * scale, scale, scale, color);
    }
  }
}

function drawFallbackPosterTitle(raw, width, height, title, category, accent) {
  const availableWidth = width - 76;
  const lines = titleLines(title, 22);
  const longest = Math.max(...lines.map((line) => line.length));
  const scale = Math.max(4, Math.min(8, Math.floor(availableWidth / Math.max(1, longest * 6))));
  const lineHeight = 9 * scale;
  const panelHeight = lines.length * lineHeight + 72;
  const panelY = height - panelHeight - 44;

  paintRect(raw, width, height, 24, panelY - 18, width - 48, panelHeight + 36, [7, 10, 22], 0.76);
  paintRect(raw, width, height, 48, panelY, 8, lines.length * lineHeight + 10, accent, 0.96);
  paintRect(raw, width, height, 76, panelY - 29, 104, 4, accent, 0.9);

  const label = String(category || 'SoraBox').replace(/-/g, ' ').toUpperCase();
  for (let index = 0; index < Math.min(label.length, 20); index += 1) {
    drawGlyph(raw, width, height, label[index], 77 + index * 14, panelY - 18, 2, [229, 235, 255]);
  }

  lines.forEach((line, row) => {
    const text = line.toUpperCase();
    const textWidth = text.length * 6 * scale - scale;
    const x = Math.max(68, Math.round((width + 60 - textWidth) / 2));
    const y = panelY + row * lineHeight;
    for (let index = 0; index < text.length; index += 1) {
      drawGlyph(raw, width, height, text[index], x + index * 6 * scale, y, scale, [249, 251, 255]);
    }
  });
}

// A compact original PNG fallback means a title can still receive an ImgBB-hosted
// poster when TMDB does not have a matching artwork. It avoids storing images on Koyeb.
export function createFallbackPosterPng(title, category) {
  const width = 480;
  const height = 720;
  const seed = titleSeed(title);
  const [base, accent, ink] = PALETTES[category] || PALETTES.anime;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const focalX = width * (0.25 + ((seed >>> 4) % 45) / 100);
  const focalY = height * (0.18 + ((seed >>> 10) % 34) / 100);
  const focalX2 = width * (0.35 + ((seed >>> 16) % 42) / 100);
  const focalY2 = height * (0.55 + ((seed >>> 22) % 26) / 100);

  for (let y = 0; y < height; y += 1) {
    let offset = y * (width * 4 + 1);
    raw[offset] = 0;
    offset += 1;
    const vertical = y / (height - 1);

    for (let x = 0; x < width; x += 1) {
      const dx = (x - focalX) / width;
      const dy = (y - focalY) / height;
      const dx2 = (x - focalX2) / width;
      const dy2 = (y - focalY2) / height;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx * 3.1 + dy * dy * 1.6) * 2.3);
      const glow2 = Math.max(0, 1 - Math.sqrt(dx2 * dx2 * 1.7 + dy2 * dy2 * 3.8) * 2.4);
      const diagonal = ((x * 0.7 + y * 0.33 + seed % 160) % 150) / 150;
      const accentMix = Math.min(1, glow * 0.75 + glow2 * 0.42 + diagonal * 0.08);
      const shadowMix = Math.min(0.72, vertical * 0.46 + (1 - glow) * 0.18);

      raw[offset] = blend(blend(base[0], accent[0], accentMix), ink[0], shadowMix);
      raw[offset + 1] = blend(blend(base[1], accent[1], accentMix), ink[1], shadowMix);
      raw[offset + 2] = blend(blend(base[2], accent[2], accentMix), ink[2], shadowMix);
      raw[offset + 3] = 255;
      offset += 4;
    }
  }

  // A fallback must still be recognizable in the catalog: render the release
  // title on top of the category-colored artwork rather than returning only a
  // decorative gradient.
  drawFallbackPosterTitle(raw, width, height, title, category, accent);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit depth
  header[9] = 6; // RGBA
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 8 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Fetch (or generate) the artwork that is about to be hosted. Kept apart from the upload so a
 * rate-limited host can be retried later with the same image in hand, without asking the publisher
 * to re-send anything.
 */
export async function preparePosterImage({ sourceUrl = null, sourceIsManual = false, title, category } = {}) {
  let image = null;
  let originalUrl = null;
  let usedFallback = false;

  if (sourceUrl) {
    try {
      image = await downloadPosterImage(sourceUrl);
      originalUrl = image.sourceUrl;
    } catch (error) {
      if (sourceIsManual) throw error;
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (!image) {
    image = {
      buffer: createFallbackPosterPng(title, category),
      contentType: 'image/png',
      sourceUrl: null
    };
  }

  return {
    buffer: image.buffer,
    contentType: image.contentType,
    sourceUrl: originalUrl,
    usedFallback
  };
}

/** One upload with one key. A limit is an outcome, any other refusal is an error. */
async function postPosterToImgBB({ buffer, title, key }) {
  const form = new FormData();
  form.set('key', key);
  form.set('name', `${slugify(title).slice(0, 56)}-poster`);
  form.set('image', buffer.toString('base64'));

  let response;
  try {
    response = await fetch(IMGBB_UPLOAD_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new PosterHostingError('ImgBB could not be reached. Please try publishing again.', { cause: error });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const detail = String(body?.error?.message || '');
  if (response.ok && body?.success && body?.data?.url) {
    return { ok: true, url: body.data.display_url || body.data.url, providerId: body.data.id || null };
  }
  if (!(response.status === 429 || isPosterRateLimit({ message: detail }))) {
    throw new PosterHostingError(detail || 'ImgBB did not accept the poster.');
  }
  const retryAfterSeconds = Number(response.headers?.get?.('retry-after')) || Number(body?.error?.retry_after) || 0;
  return { ok: false, limited: true, detail, retryAfterMs: retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0 };
}

/**
 * Host one image, spread across the configured ImgBB keys.
 *
 * `attempts` is how many uploads one poster may spend — each one goes to the next free key, so a
 * pool turns one key's throttle into a round-robin instead of a stalled publish. When every key is
 * cooling, a short remaining wait is taken inside this call; anything longer is reported as a rate
 * limit, which is what lets the caller publish the card and re-host the artwork later.
 */
export async function uploadImageToImgBB({ buffer, title, apiKey = null, apiKeys = null } = {}) {
  const configured = Array.isArray(apiKeys) && apiKeys.length ? parseImgBBKeys(apiKeys) : [];
  const keys = configured.length ? configured : (apiKey ? [apiKey] : resolvePosterKeys());
  if (!keys.length) {
    throw new PosterHostingError('IMGBB_API_KEY is not configured. Add it as a server-side Koyeb secret before publishing. Up to 20 keys can be pooled with IMGBB_API_KEYS so one quota never throttles a bulk publish.');
  }
  if (!buffer) throw new PosterHostingError('There was no poster image to upload.');

  const cacheKey = createHash('sha1').update(buffer).digest('hex');
  const cached = posterUploadCache.get(cacheKey);
  if (cached) {
    posterUploadCache.delete(cacheKey);
    posterUploadCache.set(cacheKey, cached);
    return { ...cached, cached: true };
  }

  const { spacingMs, attempts, backoffMs, wait, now } = posterUploadOptions;
  const paceMs = keys.length >= IMGBB_POOL_SIZE ? Math.min(spacingMs, IMGBB_POOL_SPACING_MS) : spacingMs;
  let lastRateLimit = null;
  let restsTaken = 0;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const picked = pickPosterKey(keys, now());
    if (!picked) {
      // Every key in the pool has said it is full. The wait is reported, not sat through: the retry
      // queue's timer is what an "all keys are down" hour needs, not a stalled publish.
      const soonest = Math.min(...keys.map((entry) => posterKeyState(entry).cooldownUntil));
      const restMs = Math.max(0, soonest - now());
      const pooled = new PosterRateLimitError('Every configured ImgBB key is rate limited.', { retryAfterMs: restMs });
      pooled.allKeysCooling = true;
      pooled.poolSize = keys.length;
      pooled.nextFreeInMs = restMs;
      lastRateLimit = lastRateLimit || pooled;
      // A short Retry-After on the only key is cheaper to wait out here than to queue around.
      if (restMs > IMGBB_KEY_PATIENCE_MS || keys.length > 1 || restsTaken >= 2) break;
      const resting = keys.filter((entry) => posterKeyState(entry).cooldownUntil <= soonest + 1);
      restsTaken += 1;
      await wait(restMs);
      for (const entry of resting) posterKeyState(entry).cooldownUntil = 0;
      attempt -= 1;
      continue;
    }
    const state = posterKeyState(picked.key);
    if (paceMs > 0 && state.lastUsedAt) {
      const since = now() - state.lastUsedAt;
      if (since < paceMs) await wait(paceMs - since);
    }
    // The gap is measured per key, so ten keys carry ten uploads per window without any single
    // quota seeing more than one image per spacing interval.
    state.lastUsedAt = now();

    let outcome = null;
    try {
      outcome = await postPosterToImgBB({ buffer, title, key: picked.key });
    } catch (error) {
      if (!isPosterRateLimit(error)) throw error;
      coolPosterKey(picked.key, backoffMs * attempt);
      lastRateLimit = new PosterRateLimitError(error.message, { retryAfterMs: backoffMs * attempt });
      continue;
    }

    if (outcome.ok) {
      // Success keeps this key in favour: the next poster goes to the same quota, one pace later.
      posterKeyPool.sticky = picked.index;
      const hosted = { url: outcome.url, providerId: outcome.providerId };
      cachePosterUpload(cacheKey, hosted);
      return hosted;
    }
    const coolMs = outcome.retryAfterMs || Math.min(IMGBB_KEY_COOLDOWN_MS, backoffMs * attempt);
    coolPosterKey(picked.key, coolMs);
    lastRateLimit = new PosterRateLimitError(outcome.detail || 'ImgBB is rate limiting this server.', { retryAfterMs: coolMs });
  }

  throw lastRateLimit || new PosterHostingError('ImgBB did not accept the poster.');
}

/**
 * Host an already-prepared image. Split out of `mirrorPosterToImgBB` so a publish that must not be
 * lost can keep the artwork it already has and hand this call to a retry queue instead.
 */
export async function hostPosterImage({ image, title, config } = {}) {
  if (!image?.buffer) throw new PosterHostingError('There was no poster image to upload.');
  const hosted = await uploadImageToImgBB({
    buffer: image.buffer,
    title,
    apiKey: config?.imgbbApiKey,
    apiKeys: config?.imgbbApiKeys
  });
  return {
    ...hosted,
    originalUrl: image.sourceUrl || null,
    source: image.usedFallback ? 'generated-fallback' : 'remote-mirror',
    contentType: image.contentType
  };
}

export async function mirrorPosterToImgBB({ sourceUrl, sourceIsManual = false, title, category, config }) {
  const image = await preparePosterImage({ sourceUrl, sourceIsManual, title, category });
  return hostPosterImage({ image, title, config });
}
