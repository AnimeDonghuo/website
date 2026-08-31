import 'dotenv/config';

const DEFAULT_PORT = 8000;

function asPort(value) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function asHours(value, fallback = 24) {
  const hours = Number.parseInt(value, 10);
  return Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : fallback;
}

function csvNumbers(value) {
  return new Set(
    (value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => /^-?\d+$/.test(entry))
  );
}

function normalizeBotUsername(value) {
  return (value || '').trim().replace(/^@/, '').replace(/\s+/g, '');
}

function normalizeSiteUrl(value) {
  let candidate = (value || '').trim().replace(/^['"]|['"]$/g, '').trim().replace(/\/+$/, '');
  if (!candidate) return '';

  // Koyeb's dashboard values are sometimes pasted without a scheme. Treat a
  // plain hostname as HTTPS so both `catalog.koyeb.app` and the full URL work.
  if (!/^https?:\/\//i.test(candidate) && /^[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) return '';
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

function resolveSiteUrl(env) {
  // PUBLIC_SITE_URL is the documented variable. The aliases make a deployment
  // resilient to common Koyeb/dashboard names and let a valid alias win if a
  // stale primary value was left blank or malformed.
  for (const candidate of [
    env.PUBLIC_SITE_URL,
    env.WEBSITE_URL,
    env.SITE_URL,
    env.APP_URL,
    env.PUBLIC_URL,
    env.VITE_PUBLIC_SITE_URL,
    env.KOYEB_PUBLIC_DOMAIN
  ]) {
    const url = normalizeSiteUrl(candidate);
    if (url) return url;
  }
  return '';
}

export function loadConfig(env = process.env) {
  const telegramMode = (env.TELEGRAM_MODE || 'polling').trim().toLowerCase();

  return {
    environment: env.NODE_ENV || 'development',
    port: asPort(env.PORT),
    // PUBLIC_SITE_URL is required for announcement buttons to open the catalog
    // page first instead of sending visitors straight to the Telegram deep link.
    siteUrl: resolveSiteUrl(env),
    mongodbUri: (env.MONGODB_URI || '').trim(),
    mongodbDb: (env.MONGODB_DB || 'sorabox').trim(),
    imgbbApiKey: (env.IMGBB_API_KEY || '').trim(),
    tmdbApiKey: (env.TMDB_API_KEY || '').trim(),
    tmdbReadAccessToken: (env.TMDB_READ_ACCESS_TOKEN || '').trim(),
    omdbApiKey: (env.OMDB_API_KEY || '').trim(),
    adminLoginCode: (env.ADMIN_LOGIN_CODE || '').trim(),
    adminSessionHours: asHours(env.ADMIN_SESSION_HOURS),
    telegram: {
      botToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
      botUsername: normalizeBotUsername(env.TELEGRAM_BOT_USERNAME),
      storageChannelId: (env.TELEGRAM_STORAGE_CHANNEL_ID || '').trim(),
      requestChannelId: (env.TELEGRAM_REQUEST_CHANNEL_ID || '').trim(),
      adminIds: csvNumbers(env.TELEGRAM_ADMIN_IDS),
      mode: telegramMode === 'polling' ? 'polling' : 'disabled'
    }
  };
}

// If an ID allowlist is provided, the login passcode is only valid for those IDs.
// Leaving it empty intentionally permits any holder of ADMIN_LOGIN_CODE to log in.
export function isTelegramAdmin(config, telegramUserId) {
  return config.telegram.adminIds.size === 0 || config.telegram.adminIds.has(String(telegramUserId));
}

function isShareCode(value) {
  return /^[A-Za-z0-9_-]{6,48}$/.test(String(value || ''));
}

export function getDeliveryRedirectPath(shareCode, filePosition = null) {
  if (!isShareCode(shareCode)) return null;
  if (filePosition === null || filePosition === undefined) return `/deliver/${shareCode}`;
  const index = Number(filePosition);
  // Six digits leaves room within Telegram's 64-character start payload even
  // for a much longer legacy share code, while covering every practical release.
  if (!Number.isInteger(index) || index < 1 || index > 999999) return null;
  return `/deliver/${shareCode}/file/${index}`;
}

export function getTelegramDeliveryUrl(config, shareCode) {
  if (!config.telegram.botUsername || !getDeliveryRedirectPath(shareCode)) return null;
  return `https://t.me/${config.telegram.botUsername}?start=get-${shareCode}`;
}

export function getTelegramFileDeliveryUrl(config, shareCode, filePosition) {
  const index = Number(filePosition);
  const redirectPath = getDeliveryRedirectPath(shareCode, index);
  if (!config.telegram.botUsername || !redirectPath) return null;
  // `file-` is deliberately a separate deep-link payload from `get-` so a
  // base64url share code containing hyphens can never be parsed ambiguously.
  return `https://t.me/${config.telegram.botUsername}?start=file-${shareCode}-${index}`;
}

export function getContentPageUrl(config, content) {
  if (!config.siteUrl || !content?.category || !content?.slug) return null;
  return `${config.siteUrl}/${encodeURIComponent(content.category)}/${encodeURIComponent(content.slug)}`;
}
