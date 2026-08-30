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

export function loadConfig(env = process.env) {
  const telegramMode = (env.TELEGRAM_MODE || 'polling').trim().toLowerCase();

  return {
    environment: env.NODE_ENV || 'development',
    port: asPort(env.PORT),
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

export function getTelegramDeliveryUrl(config, shareCode) {
  if (!config.telegram.botUsername || !shareCode) return null;
  return `https://t.me/${config.telegram.botUsername}?start=get-${shareCode}`;
}
