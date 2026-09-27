import crypto from 'node:crypto';

export const PLAYBACK_SESSION_COOKIE = 'sorabox_playback_session';
export const PLAYBACK_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Public Guest Access Note:
 * SoraBox preserves public browsing and streaming for published releases.
 * Guest viewing uses signed, expiring HttpOnly cookies with CSRF defenses
 * (Sec-Fetch-Site and Origin verification) and bounded IP/session rate limits.
 * Note that public guest access cannot stop someone visiting the site and
 * automating a guest session; however, upstream player grants are strictly
 * video-specific, short-lived (60s), and gated by catalog verification.
 */

export function normalizeChannelId(id) {
  if (id === null || id === undefined) return '';
  const clean = String(id).trim();
  if (!clean) return '';
  const digits = clean.replace(/^-100/, '').replace(/^-/, '');
  return digits ? `-100${digits}` : '';
}

export function bareChannelId(id) {
  if (id === null || id === undefined) return '';
  const clean = String(id).trim();
  return clean.replace(/^-100/, '').replace(/^-/, '');
}

/**
 * Check whether a target channel is among the configured allowed database storage channels.
 * Supports multiple channels (TELEGRAM_CHANNEL_IDS) in both -100... and bare digits forms.
 */
export function isChannelAllowed(channelCandidate, allowedChannelIds = []) {
  if (!channelCandidate) return false;
  const targetNorm = normalizeChannelId(channelCandidate);
  const targetBare = bareChannelId(channelCandidate);
  if (!targetNorm && !targetBare) return false;

  const allowedList = Array.isArray(allowedChannelIds)
    ? allowedChannelIds
    : String(allowedChannelIds || '').split(',').map((item) => item.trim()).filter(Boolean);

  return allowedList.some((allowed) => {
    const allowedNorm = normalizeChannelId(allowed);
    const allowedBare = bareChannelId(allowed);
    return (targetNorm && targetNorm === allowedNorm) || (targetBare && targetBare === allowedBare);
  });
}

/**
 * Parse and validate the incoming target from the request body.
 * Enforces exactly one of `url` or `id`.
 * Rejects missing, empty, unknown, malformed, or ambiguous payloads.
 */
export function parseAndValidatePlaybackTarget(body, allowedChannelIds = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, status: 400, error: 'Invalid request body. Expected a JSON object.' };
  }

  const hasUrl = Object.prototype.hasOwnProperty.call(body, 'url');
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id');

  if ((hasUrl && hasId) || (!hasUrl && !hasId)) {
    return { valid: false, status: 400, error: 'Request body must specify exactly one target: url or id.' };
  }

  // Reject any unexpected extra target properties
  const allowedKeys = new Set(['url', 'id']);
  const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    return { valid: false, status: 400, error: `Unexpected properties in payload: ${unknownKeys.join(', ')}` };
  }

  if (hasUrl) {
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return { valid: false, status: 400, error: 'Target url must be a non-empty string.' };
    }
    const rawUrl = body.url.trim();
    if (rawUrl.length > 1000) {
      return { valid: false, status: 400, error: 'Target url exceeds maximum length of 1000 characters.' };
    }

    // Match Telegram channel post URLs:
    // https://t.me/c/<channel>/<messageId>
    // https://telegram.me/c/<channel>/<messageId>
    // tg://privatepost?channel=<channel>&post=<messageId>
    const match = rawUrl.match(/(?:t(?:elegram)?\.me\/c\/|tg:\/\/privatepost\?channel=)([1-9]\d{0,15})(?:\/|&post=)([1-9]\d{0,9})/i);
    if (!match) {
      return {
        valid: false,
        status: 400,
        error: 'Target url must be a valid Telegram channel post link (e.g. https://t.me/c/<channel>/<messageId>).'
      };
    }

    const channelNumber = match[1];
    const messageId = Number.parseInt(match[2], 10);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      return { valid: false, status: 400, error: 'Invalid message ID in Telegram URL.' };
    }

    const canonicalUrl = `https://t.me/c/${channelNumber}/${messageId}`;
    const channelId = `-100${channelNumber}`;

    if (!isChannelAllowed(channelNumber, allowedChannelIds)) {
      return {
        valid: false,
        status: 403,
        error: `Telegram channel "${channelNumber}" is not an authorized storage channel.`
      };
    }

    return {
      valid: true,
      type: 'url',
      canonicalUrl,
      channelNumber,
      channelId,
      messageId,
      approvedTarget: { url: canonicalUrl }
    };
  }

  if (hasId) {
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return { valid: false, status: 400, error: 'Target id must be a non-empty string.' };
    }
    const id = body.id.trim();
    if (id.length > 100 || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
      return {
        valid: false,
        status: 400,
        error: 'Target id must be 1-100 alphanumeric characters, hyphens, or underscores.'
      };
    }

    return {
      valid: true,
      type: 'id',
      id,
      approvedTarget: { id }
    };
  }

  return { valid: false, status: 400, error: 'Invalid target.' };
}

/**
 * CSRF defense verification using Sec-Fetch-* metadata and Origin header.
 * Note: These are CSRF defenses, NOT viewer authentication.
 */
export function verifyPlaybackCsrf(request, config = {}) {
  // 1. Fetch Metadata defense: Sec-Fetch-Site
  const secFetchSite = request.headers['sec-fetch-site'];
  if (secFetchSite && secFetchSite.toLowerCase() === 'cross-site') {
    return { valid: false, error: 'Cross-site playback token requests are forbidden.' };
  }

  // 2. Sec-Fetch-Mode check (if present, must not be direct browser top-level navigation)
  const secFetchMode = request.headers['sec-fetch-mode'];
  if (secFetchMode && secFetchMode.toLowerCase() === 'navigate') {
    return { valid: false, error: 'Direct navigation requests are forbidden.' };
  }

  // 3. Origin check (if present)
  const origin = request.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { valid: false, error: 'Malformed Origin header.' };
    }

    const allowedHosts = new Set();
    if (request.headers.host) {
      allowedHosts.add(request.headers.host.toLowerCase());
    }
    if (config?.siteUrl) {
      try {
        allowedHosts.add(new URL(config.siteUrl).host.toLowerCase());
      } catch { /* ignore */ }
    }
    allowedHosts.add('youngest-corabella-platinum0-23c07cdf.koyeb.app');

    const isAllowed = allowedHosts.has(originHost) ||
      originHost.endsWith('.koyeb.app') ||
      originHost.endsWith('.e2b.app') ||
      originHost === 'localhost' ||
      originHost.startsWith('localhost:') ||
      originHost === '127.0.0.1' ||
      originHost.startsWith('127.0.0.1:');

    if (!isAllowed) {
      return { valid: false, error: `Playback token request from origin "${origin}" is not permitted.` };
    }
  }

  return { valid: true };
}

/**
 * Extract client IP safely for rate limiting without blindly trusting untrusted forwarding headers.
 */
export function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0].trim();
    if (/^[0-9a-f.:]+$/i.test(first)) return first;
  }
  return request.ip || request.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Bounded in-memory sliding/fixed window rate limiter.
 * Caps memory consumption at `maxKeys` entries to resist DDoS.
 */
export class BoundedRateLimiter {
  constructor({ maxRequests = 60, windowMs = 60_000, maxKeys = 5_000 } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  isAllowed(key) {
    const now = Date.now();
    // Prune stale entries if map is over half capacity
    if (this.hits.size > this.maxKeys / 2) {
      for (const [k, entry] of this.hits.entries()) {
        if (entry.resetAt <= now) this.hits.delete(k);
      }
    }

    // Evict oldest entry if maximum keys limit reached
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey) this.hits.delete(oldestKey);
    }

    const current = this.hits.get(key);
    if (!current || current.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + this.windowMs };
    }

    if (current.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: current.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: this.maxRequests - current.count,
      resetAt: current.resetAt
    };
  }

  reset() {
    this.hits.clear();
  }
}

/**
 * HMAC-SHA256 signed expiring guest session token:
 * format: <visitorId>.<timestamp>.<hmacSignature>
 */
export function signPlaybackSession(visitorId, secret, timestamp = Date.now()) {
  const data = `${visitorId}.${timestamp}`;
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${hmac}`;
}

export function verifyPlaybackSession(token, secret, maxAgeMs = PLAYBACK_SESSION_MAX_AGE_MS) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [visitorId, timestampStr, signature] = parts;
  const timestamp = Number(timestampStr);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
  const now = Date.now();
  if (now < timestamp - 60_000 || now - timestamp > maxAgeMs) return null;

  const expectedSignature = crypto.createHmac('sha256', secret).update(`${visitorId}.${timestampStr}`).digest('base64url');
  if (signature.length !== expectedSignature.length) return null;
  try {
    const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    if (!valid) return null;
  } catch {
    return null;
  }

  return { visitorId, timestamp };
}

function parseCookie(request, cookieName) {
  const cookieHeader = String(request.headers.cookie || '');
  const prefix = `${cookieName}=`;
  for (const item of cookieHeader.split(';')) {
    const trimmed = item.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(trimmed.slice(prefix.length));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve existing verified guest session or issue a new signed guest session cookie.
 */
export function resolveOrCreatePlaybackSession(request, response, config) {
  const secret = config.playback?.sessionSecret || config.adminLoginCode || 'sorabox-playback-session-secret';
  const existingCookie = parseCookie(request, PLAYBACK_SESSION_COOKIE);
  const verified = verifyPlaybackSession(existingCookie, secret);

  if (verified) {
    return { visitorId: verified.visitorId, isNew: false };
  }

  // Issue new guest session
  const visitorId = crypto.randomBytes(16).toString('base64url');
  const sessionToken = signPlaybackSession(visitorId, secret);

  if (response && typeof response.cookie === 'function') {
    response.cookie(PLAYBACK_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: config.environment === 'production',
      sameSite: 'lax',
      maxAge: PLAYBACK_SESSION_MAX_AGE_MS,
      path: '/'
    });
  }

  return { visitorId, isNew: true };
}

/**
 * Resolve target to an existing, published catalog item and verify its access classification.
 */
export async function resolveCatalogContent({ target, repository, allowedChannelIds = [] }) {
  let content = null;

  if (target.type === 'url') {
    // 1. Storage message matching in files
    if (typeof repository.findContentByStorageMessageId === 'function') {
      content = await repository.findContentByStorageMessageId(target.messageId, target.channelId);
      if (!content) {
        content = await repository.findContentByStorageMessageId(target.messageId, target.channelNumber);
      }
      if (!content) {
        content = await repository.findContentByStorageMessageId(target.messageId);
      }
    }

    // 2. Stream target matching
    if (!content && typeof repository.findContentByStreamTarget === 'function') {
      content = await repository.findContentByStreamTarget(target);
    }

    // 3. Fallback scan if repository holds in-memory contents
    if (!content && repository?.contents instanceof Map) {
      for (const item of repository.contents.values()) {
        const streamEntries = Array.isArray(item.stream?.entries) ? item.stream.entries : [];
        if (streamEntries.some((e) => e.embedUrl === target.canonicalUrl || e.watchUrl === target.canonicalUrl || e.telegramUrl === target.canonicalUrl)) {
          content = item;
          break;
        }
      }
    }
  } else if (target.type === 'id') {
    if (typeof repository.findContentBySlug === 'function') {
      content = await repository.findContentBySlug(target.id);
    }
    if (!content && typeof repository.findContentById === 'function') {
      content = await repository.findContentById(target.id);
    }
    if (!content && typeof repository.findContentByShareCode === 'function') {
      content = await repository.findContentByShareCode(target.id);
    }
    if (!content && typeof repository.findContentByAdminId === 'function') {
      content = await repository.findContentByAdminId(target.id);
    }
    if (!content && typeof repository.findContentByStreamTarget === 'function') {
      content = await repository.findContentByStreamTarget(target);
    }
    if (!content && repository?.contents instanceof Map) {
      for (const item of repository.contents.values()) {
        const streamEntries = Array.isArray(item.stream?.entries) ? item.stream.entries : [];
        if (streamEntries.some((e) => e.id === target.id || e.watchId === target.id || e.videoId === target.id)) {
          content = item;
          break;
        }
      }
    }
  }

  if (!content) {
    return { found: false, status: 404, error: 'Video was not found in the published catalog.' };
  }

  if (content.published === false) {
    return { found: false, status: 404, error: 'Video is unlisted or no longer available.' };
  }

  const isAdult = content.category === 'adult';
  return {
    found: true,
    content,
    isAdult
  };
}

/**
 * Request video playback grant from upstream player service:
 * POST {WATCH_PLAYER_ORIGIN}/api/playback/grant
 * Authorization: Bearer {PLAYBACK_ISSUER_KEY}
 */
export async function requestPlaybackGrant({ target, config, fetchImpl = globalThis.fetch }) {
  const playbackConfig = config.playback || {};
  const issuerKey = playbackConfig.issuerKey;
  if (!issuerKey) {
    return {
      success: false,
      status: 503,
      error: 'Playback token service is not configured with an issuer key.'
    };
  }

  const playerOrigin = playbackConfig.playerOrigin || 'https://v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3.koyeb.app';
  const grantUrl = `${playerOrigin.replace(/\/+$/, '')}/api/playback/grant`;
  const timeoutMs = playbackConfig.tokenTimeoutMs || 8_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(grantUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${issuerKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(target.approvedTarget),
      signal: controller.signal
    });

    clearTimeout(timer);

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok || !body?.token) {
      return {
        success: false,
        status: res.status >= 500 ? 502 : res.status,
        error: 'Playback service was unable to grant a playback token.'
      };
    }

    return {
      success: true,
      data: {
        token: String(body.token),
        resource: body.resource || (target.approvedTarget.url || target.approvedTarget.id),
        expiresAt: body.expiresAt || (Date.now() + 60_000)
      }
    };
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      return {
        success: false,
        status: 504,
        error: 'Playback service request timed out.'
      };
    }
    return {
      success: false,
      status: 502,
      error: 'Playback service is unreachable.'
    };
  }
}
