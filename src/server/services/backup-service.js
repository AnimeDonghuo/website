import crypto from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BSON } from 'mongodb';
import { Input } from 'telegraf';

const BACKUP_FORMAT = 'sorabox-application-backup';
const BACKUP_VERSION = 1;
const DEFAULT_MAX_ARCHIVE_BYTES = 19 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const INDIA_TIME_ZONE = 'Asia/Kolkata';

function positiveInteger(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function cleanTextLabel(value) {
  return String(value || 'document').replace(/[^a-z0-9 -]/gi, '').trim().slice(0, 60) || 'document';
}

function backupOptions(options = {}) {
  return {
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_ARCHIVE_BYTES, {
      minimum: 1_024,
      maximum: 50 * 1024 * 1024
    }),
    maxUncompressedBytes: positiveInteger(options.maxUncompressedBytes, DEFAULT_MAX_UNCOMPRESSED_BYTES, {
      minimum: 16 * 1024,
      maximum: 500 * 1024 * 1024
    }),
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS, {
      minimum: 1_000,
      maximum: 10 * 60_000
    })
  };
}

function requireSigningSecret(secret) {
  const value = String(secret || '');
  if (!value) {
    throw new Error('Set BACKUP_SIGNING_SECRET before backups can be created or recovered (or configure ADMIN_LOGIN_CODE for the compatibility fallback).');
  }
  return value;
}

function signatureFor(payload, secret) {
  return crypto.createHmac('sha256', requireSigningSecret(secret)).update(payload).digest('base64url');
}

function equalSignature(candidate, expected) {
  const candidateBytes = Buffer.from(String(candidate || ''));
  const expectedBytes = Buffer.from(String(expected || ''));
  return candidateBytes.length === expectedBytes.length && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function isGzip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function archiveText(buffer, maxUncompressedBytes) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!input.length) throw new Error('The backup file is empty.');
  const output = isGzip(input)
    ? gunzipSync(input, { maxOutputLength: maxUncompressedBytes })
    : input;
  if (output.length > maxUncompressedBytes) {
    throw new Error('The backup expands beyond the configured safe recovery limit.');
  }
  return output.toString('utf8');
}

function backupPayload(data, createdAt) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    // Extended JSON preserves Mongo ObjectIds/Dates without embedding a live
    // Mongo URI, bot token, environment variable, or other deployment secret.
    data: BSON.EJSON.serialize(data, { relaxed: false })
  };
}

export function backupFilename(createdAt = new Date().toISOString()) {
  const stamp = String(createdAt).replace(/[:.]/g, '-').replace(/[^0-9TZ-]/g, '').slice(0, 32);
  return `sorabox-backup-${stamp || 'export'}.json.gz`;
}

/** Create a signed, gzip-compressed portable snapshot of app collections. */
export function createSignedBackupArchive({ data, signingSecret, createdAt = new Date().toISOString() } = {}) {
  const payload = JSON.stringify(backupPayload(data, createdAt));
  const envelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    payload,
    signature: signatureFor(payload, signingSecret)
  };
  return gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'), { level: 9 });
}

/** Verify a backup before returning its Extended-JSON application data. */
export function readSignedBackupArchive({ archive, signingSecret, options = {} } = {}) {
  const limits = backupOptions(options);
  const bytes = Buffer.isBuffer(archive) ? archive : Buffer.from(archive || '');
  if (bytes.length > limits.maxBytes) throw new Error('The backup file exceeds the configured safe archive limit.');
  let envelope;
  try {
    envelope = JSON.parse(archiveText(bytes, limits.maxUncompressedBytes));
  } catch (error) {
    if (error?.message?.startsWith('The backup')) throw error;
    throw new Error('The selected file is not a readable SoraBox backup archive.');
  }
  if (envelope?.format !== BACKUP_FORMAT || envelope?.version !== BACKUP_VERSION || typeof envelope.payload !== 'string') {
    throw new Error('The selected file is not a supported SoraBox backup archive.');
  }
  if (!equalSignature(envelope.signature, signatureFor(envelope.payload, signingSecret))) {
    throw new Error('Backup signature verification failed. Use an unmodified backup made with this BACKUP_SIGNING_SECRET.');
  }
  let payload;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    throw new Error('The signed backup payload is invalid.');
  }
  if (payload?.format !== BACKUP_FORMAT || payload?.version !== BACKUP_VERSION || !payload?.data) {
    throw new Error('The signed backup payload has an unsupported format.');
  }
  return {
    createdAt: String(payload.createdAt || ''),
    data: BSON.EJSON.deserialize(payload.data, { relaxed: false })
  };
}

export function indiaMonthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return /^\d{4}$/.test(year || '') && /^\d{2}$/.test(month || '') ? `${year}-${month}` : null;
}

export function backupCollectionCounts(data) {
  return Object.fromEntries(Object.entries(data?.collections || {})
    .filter(([, rows]) => Array.isArray(rows))
    .map(([name, rows]) => [name, rows.length]));
}

/** Download a Telegram document only after applying a known-size safety cap. */
export async function downloadTelegramDocument({
  document,
  telegram,
  options = {},
  // Reused for the small /cmd manifest import. Keeping the label explicit
  // preserves accurate publisher-facing errors without changing backup logic.
  label = 'backup',
  fetchImpl = globalThis.fetch,
  downloadFile = null
} = {}) {
  const limits = backupOptions(options);
  const documentLabel = cleanTextLabel(label);
  const knownSize = Number(document?.file_size || document?.fileSize || 0);
  if (Number.isFinite(knownSize) && knownSize > limits.maxBytes) {
    throw new Error(`The selected ${documentLabel} is ${knownSize} bytes, above the ${limits.maxBytes}-byte safe limit.`);
  }
  if (typeof downloadFile === 'function') {
    const downloaded = await downloadFile(document);
    const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded || '');
    if (buffer.length > limits.maxBytes) throw new Error(`The selected ${documentLabel} exceeds the configured safe limit.`);
    return buffer;
  }
  const fileId = String(document?.file_id || document?.fileId || '');
  if (!fileId || !telegram?.getFileLink || typeof fetchImpl !== 'function') {
    throw new Error(`Telegram could not download this ${documentLabel} document.`);
  }
  const link = await telegram.getFileLink(fileId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(String(link), { signal: controller.signal });
    if (!response?.ok) throw new Error(`Telegram ${documentLabel} download returned HTTP ${response?.status || 'unknown'}.`);
    const headerSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(headerSize) && headerSize > limits.maxBytes) {
      throw new Error(`Telegram reports a ${documentLabel} larger than the configured safe limit.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limits.maxBytes) throw new Error(`The selected ${documentLabel} exceeds the configured safe limit.`);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/** Build, sign, and privately send a backup document to the storage channel. */
export async function createAndSendBackup({
  repository,
  telegram,
  storageChannelId,
  signingSecret,
  options = {},
  createdAt = new Date().toISOString()
} = {}) {
  if (!repository?.exportBackupData) throw new Error('The catalog repository cannot export application data.');
  if (!storageChannelId) throw new Error('TELEGRAM_STORAGE_CHANNEL_ID is required to send a private backup.');
  if (!telegram?.sendDocument) throw new Error('Telegram document delivery is unavailable.');
  const limits = backupOptions(options);
  const data = await repository.exportBackupData();
  const archive = createSignedBackupArchive({ data, signingSecret, createdAt });
  if (archive.length > limits.maxBytes) {
    throw new Error(`The compressed backup is ${archive.length} bytes, above the ${limits.maxBytes}-byte Telegram recovery cap.`);
  }
  const counts = backupCollectionCounts(data);
  const document = await telegram.sendDocument(
    storageChannelId,
    Input.fromBuffer(archive, backupFilename(createdAt)),
    {
      caption: `SoraBox signed application backup · ${createdAt}\nKeep this file private. Restore only with /recover in an authorized publisher chat.`,
      disable_notification: true
    }
  );
  return { archive, data, counts, document, createdAt, filename: backupFilename(createdAt) };
}
