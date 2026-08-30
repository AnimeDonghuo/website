import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { slugify } from '../lib/strings.js';

const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class PosterHostingError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PosterHostingError';
  }
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
  'web-series': [[40, 112, 231], [123, 190, 255], [13, 31, 82]]
};

function blend(first, second, factor) {
  return Math.max(0, Math.min(255, Math.round(first + (second - first) * factor)));
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

export async function uploadImageToImgBB({ buffer, title, apiKey }) {
  if (!apiKey) {
    throw new PosterHostingError('IMGBB_API_KEY is not configured. Add it as a server-side Koyeb secret before publishing.');
  }

  const form = new FormData();
  form.set('key', apiKey);
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

  let body;
  try {
    body = await response.json();
  } catch {
    throw new PosterHostingError('ImgBB returned an unexpected response.');
  }

  if (!response.ok || !body?.success || !body?.data?.url) {
    throw new PosterHostingError(body?.error?.message || 'ImgBB did not accept the poster.');
  }

  return {
    url: body.data.display_url || body.data.url,
    providerId: body.data.id || null
  };
}

export async function mirrorPosterToImgBB({ sourceUrl, sourceIsManual = false, title, category, config }) {
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

  const hosted = await uploadImageToImgBB({
    buffer: image.buffer,
    title,
    apiKey: config.imgbbApiKey
  });

  return {
    ...hosted,
    originalUrl,
    source: usedFallback ? 'generated-fallback' : 'remote-mirror',
    contentType: image.contentType
  };
}
