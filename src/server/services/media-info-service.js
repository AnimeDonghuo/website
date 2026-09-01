import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { needsMediaTrackInspection, normalizeLanguageLabel } from './episode-service.js';

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_FILES = 500;
const MEDIA_EXTENSIONS = new Set([
  '3gp', 'aac', 'ac3', 'aiff', 'avi', 'flac', 'm2ts', 'm4a', 'm4v', 'mka', 'mkv',
  'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'oga', 'ogg', 'ogv', 'opus', 'ts', 'wav',
  'webm', 'wmv'
]);

function positiveInteger(value, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function safeMediaInfoOptions(options = {}) {
  return {
    enabled: options.enabled !== false,
    executable: String(options.executable || 'mediainfo').trim() || 'mediainfo',
    maxDownloadBytes: positiveInteger(options.maxDownloadBytes, DEFAULT_MAX_DOWNLOAD_BYTES, {
      minimum: 1_024,
      maximum: 2_000 * 1024 * 1024
    }),
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, { minimum: 1_000, maximum: 10 * 60_000 }),
    maxFiles: positiveInteger(options.maxFiles, DEFAULT_MAX_FILES, { minimum: 1, maximum: 2_000 })
  };
}

function uniqueLanguages(values = [], { allowUnknown = true } = {}) {
  const seen = new Set();
  const labels = [];
  for (const value of values) {
    const label = normalizeLanguageLabel(value, { allowUnknown });
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
    if (labels.length === 8) break;
  }
  return labels;
}

function valuesAt(track, keys) {
  const values = [];
  for (const key of keys) {
    const value = track?.[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value !== undefined && value !== null) values.push(value);
  }
  return values;
}

function languageLabelsFromTrack(track) {
  const labels = [];
  for (const rawValue of valuesAt(track, [
    'Language', 'Language_String', 'Language/String', 'Language_String1', 'Language/String1',
    'Language_String2', 'Language/String2', 'Language_Code', 'Language_Code3'
  ])) {
    // MediaInfo commonly writes a single ISO label, but split values such as
    // "Hindi / English" too. BCP-47 values (for example en-US) are preserved.
    for (const value of String(rawValue).split(/\s*[,;|/]\s*/)) {
      const label = normalizeLanguageLabel(value, { allowUnknown: true });
      if (label) labels.push(label);
    }
  }
  return uniqueLanguages(labels);
}

/** Parse a MediaInfo JSON document into privacy-safe display language labels. */
export function parseMediaInfoTracks(input) {
  let parsed = input;
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString('utf8');
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // Some packaged builds prepend a harmless diagnostic line. Recover the
      // JSON object when possible instead of falsely marking a real media file
      // as having no tracks.
      const start = parsed.indexOf('{');
      const end = parsed.lastIndexOf('}');
      try {
        parsed = start >= 0 && end > start ? JSON.parse(parsed.slice(start, end + 1)) : null;
      } catch {
        return { audioLanguages: [], subtitleLanguages: [], tracksFound: false };
      }
    }
  }
  const tracks = Array.isArray(parsed?.media?.track) ? parsed.media.track : [];
  const audio = [];
  const subtitles = [];
  let tracksFound = false;
  for (const track of tracks) {
    const type = String(track?.['@type'] || track?.Type || '').toLowerCase();
    if (type !== 'audio' && type !== 'text') continue;
    tracksFound = true;
    const labels = languageLabelsFromTrack(track);
    if (type === 'audio') audio.push(...labels);
    else subtitles.push(...labels);
  }
  return {
    audioLanguages: uniqueLanguages(audio),
    subtitleLanguages: uniqueLanguages(subtitles),
    tracksFound
  };
}

function fileExtension(file) {
  const name = String(file?.name || '').toLowerCase();
  const extension = path.extname(name).replace(/^\./, '');
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

/** Documents may carry video MIME types, while MKV uploads often do not. */
export function isInspectableMediaFile(file) {
  const mimeType = String(file?.mimeType || '').toLowerCase();
  const kind = String(file?.kind || '').toLowerCase();
  return mimeType.startsWith('video/')
    || mimeType.startsWith('audio/')
    || kind === 'video'
    || kind === 'audio'
    || MEDIA_EXTENSIONS.has(fileExtension(file));
}

function statusPatch(file, status, details = {}) {
  return {
    ...file,
    mediaInfo: {
      ...(file?.mediaInfo || {}),
      status,
      checkedAt: details.checkedAt || new Date().toISOString(),
      ...(details.reason ? { reason: String(details.reason).slice(0, 220) } : {}),
      ...(Number.isFinite(details.bytes) ? { bytes: details.bytes } : {}),
      ...(details.audioLanguages ? { audioLanguages: details.audioLanguages } : {}),
      ...(details.subtitleLanguages ? { subtitleLanguages: details.subtitleLanguages } : {})
    }
  };
}

function successPatch(file, result, { checkedAt, bytes }) {
  const existingAudio = Array.isArray(file?.audioLanguages) && file.audioLanguages.length
    ? file.audioLanguages
    : Array.isArray(file?.languages) ? file.languages : [];
  const existingSubtitles = Array.isArray(file?.subtitleLanguages) ? file.subtitleLanguages : [];
  const audioLanguages = result.audioLanguages.length ? result.audioLanguages : uniqueLanguages(existingAudio);
  const subtitleLanguages = result.subtitleLanguages.length ? result.subtitleLanguages : uniqueLanguages(existingSubtitles);
  return {
    ...file,
    // Keep the legacy field in sync: it is the public audio-language field in
    // existing cards and historical backups.
    languages: audioLanguages,
    audioLanguages,
    subtitleLanguages,
    mediaInfo: {
      ...(file?.mediaInfo || {}),
      status: result.tracksFound ? 'verified' : 'not-media',
      checkedAt,
      bytes,
      audioLanguages: result.audioLanguages,
      subtitleLanguages: result.subtitleLanguages
    }
  };
}

async function defaultRunMediaInfo(filePath, { executable, timeoutMs }) {
  const { stdout } = await execFile(executable, ['--Output=JSON', filePath], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

async function canRunMediaInfo({ executable, timeoutMs, runMediaInfo }) {
  // Tests and alternative runtimes can provide a runner without a host binary.
  if (typeof runMediaInfo === 'function') return true;
  try {
    await execFile(executable, ['--Version'], {
      timeout: Math.min(timeoutMs, 10_000),
      maxBuffer: 64 * 1024,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

async function downloadTelegramFile({ file, telegram, fetchImpl, maxDownloadBytes, timeoutMs, downloadFile }) {
  const fileId = String(file?.telegramFileId || '');
  if (!fileId) throw new Error('No reusable Telegram file ID was saved for this file.');
  if (typeof downloadFile === 'function') {
    const downloaded = await downloadFile(file);
    const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded || '');
    if (buffer.length > maxDownloadBytes) throw new Error(`The downloaded file is larger than the ${maxDownloadBytes}-byte inspection cap.`);
    return buffer;
  }
  if (!telegram?.getFileLink || typeof fetchImpl !== 'function') {
    throw new Error('Telegram file downloads are unavailable in this bot runtime.');
  }

  const link = await telegram.getFileLink(fileId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(String(link), { signal: controller.signal });
    if (!response?.ok) throw new Error(`Telegram download returned HTTP ${response?.status || 'unknown'}.`);
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxDownloadBytes) {
      throw new Error(`Telegram reports ${declaredLength} bytes, above the ${maxDownloadBytes}-byte inspection cap.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxDownloadBytes) throw new Error(`The downloaded file is larger than the ${maxDownloadBytes}-byte inspection cap.`);
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

function knownSize(file) {
  const size = Number(file?.size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

async function resolveKnownSize(file, telegram) {
  const saved = knownSize(file);
  if (saved || !telegram?.getFile || !file?.telegramFileId) return saved;
  const remote = await telegram.getFile(file.telegramFileId);
  const size = Number(remote?.file_size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Inspect only deferred candidates in order, after a draft/release has finished
 * collecting. It deliberately never throws: publication keeps filename/caption
 * labels if Telegram downloads or the host MediaInfo binary are unavailable.
 */
export async function inspectDeferredMediaTracks({
  files = [],
  telegram = null,
  mediaInfo = {},
  fetchImpl = globalThis.fetch,
  downloadFile = null,
  runMediaInfo = null,
  now = () => new Date().toISOString()
} = {}) {
  const options = safeMediaInfoOptions(mediaInfo);
  const sourceFiles = Array.isArray(files) ? files : [];
  const candidates = sourceFiles
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => isInspectableMediaFile(file) && needsMediaTrackInspection(file));
  if (!candidates.length) {
    return { files: sourceFiles, scanned: 0, skipped: 0, unavailable: 0, failed: 0 };
  }
  const checkedAt = now();
  const output = [...sourceFiles];
  let skipped = 0;
  // Check a saved Telegram size before even probing/download-processing the
  // candidate. Oversize files remain safely labelled and never touch disk.
  const runnable = [];
  for (const candidate of candidates) {
    const size = knownSize(candidate.file);
    if (size > options.maxDownloadBytes) {
      output[candidate.index] = statusPatch(candidate.file, 'skipped-size', {
        reason: `File size ${size} exceeds the ${options.maxDownloadBytes}-byte MediaInfo download cap.`,
        checkedAt,
        bytes: size
      });
      skipped += 1;
    } else {
      runnable.push(candidate);
    }
  }
  if (!runnable.length) return { files: output, scanned: 0, skipped, unavailable: 0, failed: 0 };
  const markUnavailable = (reason) => {
    for (const { file, index } of runnable) output[index] = statusPatch(file, 'unavailable', { reason, checkedAt });
    return { files: output, scanned: 0, skipped, unavailable: runnable.length, failed: 0 };
  };
  if (!options.enabled) return markUnavailable('MediaInfo inspection is disabled by configuration.');
  if (!(await canRunMediaInfo({ ...options, runMediaInfo }))) {
    return markUnavailable('MediaInfo is not installed in this runtime.');
  }

  let scanned = 0;
  let unavailable = 0;
  let failed = 0;
  for (let position = 0; position < runnable.length; position += 1) {
    const { file, index } = runnable[position];
    if (position >= options.maxFiles) {
      output[index] = statusPatch(file, 'skipped-limit', {
        reason: `This release exceeded the ${options.maxFiles}-file MediaInfo inspection limit.`,
        checkedAt
      });
      skipped += 1;
      continue;
    }
    try {
      const remoteSize = await resolveKnownSize(file, telegram);
      if (remoteSize > options.maxDownloadBytes) {
        output[index] = statusPatch(file, 'skipped-size', {
          reason: `Telegram reports ${remoteSize} bytes, above the ${options.maxDownloadBytes}-byte MediaInfo download cap.`,
          checkedAt,
          bytes: remoteSize
        });
        skipped += 1;
        continue;
      }
    } catch (error) {
      // A getFile metadata lookup is helpful but not essential; getFileLink
      // may still succeed in runtimes that do not expose file_size here.
      console.warn('[mediainfo] could not read Telegram file size before download:', String(error?.message || error));
    }

    let temporaryDirectory;
    try {
      // Each file is downloaded, parsed, and removed before the next begins.
      // This keeps a 448-message batch bounded in memory and disk usage.
      const buffer = await downloadTelegramFile({
        file,
        telegram,
        fetchImpl,
        maxDownloadBytes: options.maxDownloadBytes,
        timeoutMs: options.timeoutMs,
        downloadFile
      });
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'sorabox-mediainfo-'));
      const filePath = path.join(temporaryDirectory, `input.${fileExtension(file) || 'media'}`);
      await writeFile(filePath, buffer, { mode: 0o600 });
      const raw = await (runMediaInfo || defaultRunMediaInfo)(filePath, options);
      const result = parseMediaInfoTracks(raw);
      output[index] = successPatch(file, result, { checkedAt, bytes: buffer.length });
      scanned += 1;
    } catch (error) {
      const message = String(error?.message || error || 'MediaInfo track inspection failed.');
      const unavailableState = /telegram file downloads are unavailable|no reusable telegram file id/i.test(message);
      output[index] = statusPatch(file, unavailableState ? 'unavailable' : 'failed', { reason: message, checkedAt });
      if (unavailableState) unavailable += 1;
      else failed += 1;
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { files: output, scanned, skipped, unavailable, failed };
}
