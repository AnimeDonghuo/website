import crypto from 'node:crypto';
import { Markup, Telegraf } from 'telegraf';
import { getContentPageUrl, getTelegramDeliveryUrl, isTelegramAdmin } from '../config.js';
import { categoryDetails, cleanMultilineText, cleanText, formatBytes, parseCommandArgument, parseMultilineCommandArgument, slugify } from '../lib/strings.js';
import { attributeUploadSeasons, cleanMediaName, hasEpisodeRange, stripTelegramAttribution, summarizeEpisodes, summarizeSubtitleLanguages, summarizeUploadLanguages, detectMediaQuality, detectUploadEpisode, detectUploadLanguages, detectUploadSubtitleLanguages, detectUploadSeason, formatSeasonLabel, groupFilesBySeason, needsMediaTrackInspection } from './episode-service.js';
import { findMetadata, searchPosterCandidates } from './metadata-service.js';
import { PosterHostingError, mirrorPosterToImgBB } from './poster-service.js';
import { inspectDeferredMediaTracks, isInspectableMediaFile } from './media-info-service.js';
import { createAndSendBackup, downloadTelegramDocument, indiaMonthKey, readSignedBackupArchive } from './backup-service.js';
import { extractStreamingUrl, inferStreamManifestFormat, mergeStreamingEntries, parseStreamingManifest, publicStreamingData, removeStreamingEntries, safeStreamingLink, streamServerName } from './streaming-service.js';

const PUBLISH_CATEGORIES = ['anime', 'cartoon', 'donghua', 'kdrama', 'movie', 'web-series', 'adult'];
const ADULT_CATEGORY = 'adult';
const BATCH_PROGRESS_INTERVAL = 25;
const BATCH_MAX_FORWARD_RETRIES = 8;
// Storage channel uploads can arrive as a burst of hundreds of separate
// channel posts. Persist a quiet-period deadline, rather than publishing each
// event immediately, so one release becomes one catalog record.
const AUTO_PUBLISH_OWNER_PREFIX = 'auto-storage-group-';
const AUTO_PUBLISH_LATE_OWNER_PREFIX = 'auto-storage-late-';
const AUTO_COLLECTION_IDLE_MS = 90_000;
const AUTO_COLLECTION_MAX_WAIT_MS = 15 * 60_000;
const AUTO_QUEUE_INTERVAL_MS = 15_000;
// Telegram lets a bot remove the messages it created in a private chat. Keep
// delivered copies brief by default, while making the limitation explicit: a
// bot cannot recall a file someone has already saved or forwarded elsewhere.
export const DELIVERY_FILE_DELETE_AFTER_MS = 5 * 60_000;
const DELIVERY_FILE_DELETE_SPACING_MS = 80;
let deliveryDeletionQueue = Promise.resolve();

function userId(ctx) {
  return ctx.from?.id;
}

function chatId(ctx) {
  return ctx.chat?.id;
}

function categoryCommandLabel(category) {
  if (category === 'web-series') return 'series';
  // Telegram command menus use a conservative letter-first command for the
  // adult category. The requested /18db alias is registered separately below.
  if (category === ADULT_CATEGORY) return 'adultdb';
  return category;
}

function isAdultCategory(category) {
  return category === ADULT_CATEGORY;
}

function storageChannelForCategory(config, category) {
  return isAdultCategory(category)
    ? config?.telegram?.adultStorageChannelId || ''
    : config?.telegram?.storageChannelId || '';
}

function hasDedicatedAdultStorage(config) {
  const adultStorage = String(config?.telegram?.adultStorageChannelId || '').trim();
  const normalStorage = String(config?.telegram?.storageChannelId || '').trim();
  return Boolean(adultStorage) && adultStorage !== normalStorage;
}

function adultStorageConfigurationHint(config) {
  if (!storageChannelForCategory(config, ADULT_CATEGORY)) {
    return 'TELEGRAM_ADULT_STORAGE_CHANNEL_ID is required. Add the bot as an admin in a separate private 18+ database channel and configure its numeric -100… ID.';
  }
  return 'TELEGRAM_ADULT_STORAGE_CHANNEL_ID must be different from TELEGRAM_STORAGE_CHANNEL_ID so 18+ files remain isolated.';
}

function storageEnvironmentName(category) {
  return isAdultCategory(category) ? 'TELEGRAM_ADULT_STORAGE_CHANNEL_ID' : 'TELEGRAM_STORAGE_CHANNEL_ID';
}

function storageChannelDescription(category) {
  return isAdultCategory(category) ? 'private 18+ database channel' : 'private database channel';
}

function emptyPrivateCategoryMetadata(title) {
  return {
    matched: false,
    title: cleanText(title, 180),
    year: null,
    languages: [],
    genres: [],
    description: '',
    status: 'New release',
    releaseLabel: null,
    posterOriginalUrl: null,
    provider: 'private',
    metadataKey: null,
    tmdbId: null
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hasAllowedPublisherId(ctx, config) {
  return Boolean(userId(ctx) && isTelegramAdmin(config, userId(ctx)));
}

async function isPublisher(ctx, repository, config) {
  if (!hasAllowedPublisherId(ctx, config) || !config.adminLoginCode) return false;
  return Boolean(await repository.findAdminSession(chatId(ctx), userId(ctx)));
}

function sameSecret(candidate, expected) {
  if (!candidate || !expected) return false;
  const candidateBytes = Buffer.from(String(candidate));
  const expectedBytes = Buffer.from(String(expected));
  return candidateBytes.length === expectedBytes.length && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

// Delivery URLs are generated at request time rather than stored in MongoDB.
// Resolving the username from the active token means rotating a token — or
// switching to a replacement bot — updates every catalog-page link at once.
export function synchronizeDeliveryBotUsername(config, botInfo) {
  const username = cleanText(botInfo?.username, 64).replace(/^@/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(username)) {
    return { username: config.telegram.botUsername || null, previousUsername: config.telegram.botUsername || null, changed: false };
  }

  const previousUsername = config.telegram.botUsername || null;
  config.telegram.botUsername = username;
  return {
    username,
    previousUsername,
    changed: Boolean(previousUsername && previousUsername.toLowerCase() !== username.toLowerCase())
  };
}

function panelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✦ Anime', 'new:anime'),
      Markup.button.callback('☻ Cartoon', 'new:cartoon'),
      Markup.button.callback('◇ Donghua', 'new:donghua')
    ],
    [
      Markup.button.callback('♡ K-Drama', 'new:kdrama'),
      Markup.button.callback('▶ Movie', 'new:movie'),
      Markup.button.callback('▣ Web series', 'new:web-series')
    ],
    [Markup.button.callback('🔞 18+ private', 'new:adult')],
    [Markup.button.callback('Draft status', 'draft:status'), Markup.button.callback('Discard draft', 'draft:cancel')]
  ]);
}

function uploadKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Draft status', 'draft:status'), Markup.button.callback('Publish now', 'draft:done')],
    [Markup.button.callback('Discard draft', 'draft:cancel')]
  ]);
}

function deliveryKeyboard(url) {
  return url
    ? Markup.inlineKeyboard([[Markup.button.url('Open Telegram delivery', url)]])
    : undefined;
}

function publicationKeyboard(websiteUrl, deliveryUrl) {
  if (!websiteUrl) return deliveryKeyboard(deliveryUrl);
  const rows = [[Markup.button.url('✨ VIEW CATALOG PAGE', websiteUrl)]];
  if (deliveryUrl) rows.push([Markup.button.url('Open all files in Telegram', deliveryUrl)]);
  return Markup.inlineKeyboard(rows);
}

const VISITOR_COMMANDS = [
  { command: 'request', description: 'Request a title for the catalog' },
  { command: 'login', description: 'Unlock publisher controls' },
  { command: 'help', description: 'Get bot help' }
];

export const PUBLISHER_COMMANDS = [
  ...VISITOR_COMMANDS,
  { command: 'panel', description: 'Open the publisher panel' },
  { command: 'movie', description: 'New movie draft' },
  { command: 'anime', description: 'New anime draft' },
  { command: 'cartoon', description: 'New cartoon draft' },
  { command: 'donghua', description: 'New donghua draft' },
  { command: 'kdrama', description: 'New K-Drama draft' },
  { command: 'series', description: 'New web series draft' },
  { command: 'adultdb', description: 'New private 18+ draft (/18db also works)' },
  { command: 'batch', description: 'Import a private storage range' },
  { command: 'auto', description: 'Control storage auto-publish' },
  { command: 'title', description: 'Set draft or post title' },
  { command: 'lang', description: 'Set audio languages: draft, post, or many posts' },
  { command: 'lan', description: 'Alias for /lang' },
  { command: 'lam', description: 'Alias for /lang' },
  { command: 'subtitles', description: 'Set subtitle languages: draft, post, or many posts' },
  { command: 'subs', description: 'Alias for /subtitles' },
  { command: 'year', description: 'Set year on one or many posts' },
  { command: 'genres', description: 'Set genres on one or many posts' },
  { command: 'description', description: 'Set draft or post synopsis' },
  { command: 'poster', description: 'Set artwork: old link style or search & pick' },
  { command: 'p', description: 'Short alias for /poster' },
  { command: 'imgdd', description: 'Add artwork with the same old/new poster flow' },
  { command: 'category', description: 'Set the category of one or many posts' },
  { command: 'release', description: 'Set a release label on one or many posts' },
  { command: 'done', description: 'Publish current draft' },
  { command: 'status', description: 'Show current draft, or set post status' },
  { command: 'teststorage', description: 'Check the storage channel connection' },
  { command: 'cancel', description: 'Discard current upload draft' },
  { command: 'delete', description: 'Delete one or more post IDs' },
  { command: 'merge', description: 'Absorb cards into one post, or drop a season/episodes' },
  { command: 'posts', description: 'List recent post IDs for deletion' },
  { command: 'postid', description: 'Find uploaded post IDs by time' },
  { command: 'stats', description: 'View publisher analytics' },
  { command: 'cmd', description: 'Add an episode player or import JSON/CSV links' },
  { command: 'players', description: 'List or remove attached players' },
  { command: 'backup', description: 'Send a signed private data backup' },
  { command: 'recover', description: 'Restore a signed backup file' },
  { command: 'addchannel', description: 'Add an announcement channel' },
  { command: 'channels', description: 'List announcement channels' },
  { command: 'removechannel', description: 'Remove an announcement channel' },
  { command: 'requests', description: 'Manage catalog requests' },
  { command: 'logout', description: 'Lock publisher controls' }
];

async function setPublisherCommands(bot, ctx) {
  try {
    await bot.telegram.setMyCommands(PUBLISHER_COMMANDS, {
      scope: { type: 'chat', chat_id: chatId(ctx) }
    });
  } catch (error) {
    console.warn('[telegram] Could not set publisher command scope:', error?.message || 'Unknown error');
  }
}

async function setConfiguredPublisherCommandScopes(bot, config, repository) {
  const chatIds = new Set([...(config?.telegram?.adminIds || [])].map(String));
  if (typeof repository?.listActiveAdminSessions === 'function') {
    try {
      const sessions = await repository.listActiveAdminSessions();
      for (const session of sessions) {
        if (session?.chatId) chatIds.add(String(session.chatId));
      }
    } catch (error) {
      console.warn('[telegram] Could not read active publisher command scopes:', error?.message || 'Unknown error');
    }
  }
  await Promise.all([...chatIds].map(async (id) => {
    try {
      // In a private Telegram chat the chat ID is the owner user ID. Restoring
      // this per-chat scope at startup avoids Telegram menu-cache gaps after a
      // Koyeb/bot restart for publishers who still have an active login.
      await bot.telegram.setMyCommands(PUBLISHER_COMMANDS, {
        scope: { type: 'chat', chat_id: id }
      });
    } catch (error) {
      console.warn('[telegram] Could not set configured publisher command scope:', error?.message || 'Unknown error');
    }
  }));
}

function publisherWelcomeText() {
  return [
    'SoraBox publisher unlocked.',
    '',
    'Start with a category below or send /movie Title. Upload files to this private chat and finish with /done.',
    'Artwork is matched from AniList, TMDB, or OMDb when available, then mirrored to ImgBB. Files are copied into the private storage channel.'
  ].join('\n');
}

function visitorWelcomeText(canLogIn) {
  const lines = [
    'Welcome to SoraBox.',
    '',
    'Open a catalog delivery link to receive its available files here.',
    'Looking for something? Send /request followed by the title, series, movie, or other item you would like to see.'
  ];
  if (canLogIn) lines.push('', 'Publisher access is available with /login followed by your private passcode.');
  return lines.join('\n');
}

function draftSeasonSummary(files = []) {
  const seasons = new Set();
  for (const file of files) {
    const season = detectUploadSeasonForFile(file);
    if (season) seasons.add(season);
  }
  if (!seasons.size) return 'No season marker detected';
  const labels = [...seasons].sort((first, second) => first - second).map((season) => formatSeasonLabel(season));
  if (labels.length === 1) return `${labels[0]} · every file matches this season`;
  return `${labels.length} seasons detected (${labels.join(', ')}) — /done publishes one post per season`;
}

function displayDraft(session) {
  const category = categoryDetails(session.category).label;
  const title = session.title || 'Waiting for title';
  const files = session.files?.length || 0;
  const matched = session.metadata?.matched ? `${String(session.metadata.provider || 'metadata').toUpperCase()} match ready` : 'Fallback artwork ready';
  const detectedLanguages = summarizeUploadLanguages(session.files || []);
  const detectedSubtitles = summarizeSubtitleLanguages(session.files || []);
  const language = session.overrides?.languages?.length
    ? `${session.overrides.languages.join(', ')} (manual)`
    : detectedLanguages.length
      ? `${detectedLanguages.join(', ')} (from uploaded file details)`
      : (session.metadata?.languages || []).filter((item) => !/^multi(?:\s+language)?$/i.test(String(item || ''))).join(', ') || 'Not set';
  const episodeSummary = summarizeEpisodes(session.files || []);

  return [
    `Draft · ${category}`,
    `Mode: ${session.workflow === 'batch' ? 'Batch import' : session.workflow === 'automation' ? 'Storage auto-publish' : 'Manual upload'}`,
    `Title: ${title}`,
    `Files: ${files}`,
    `Episodes: ${episodeSummary.releaseLabel || 'No episode labels detected yet'}`,
    `Seasons: ${draftSeasonSummary(session.files || [])}`,
    `Poster: ${session.posterOriginalUrl ? 'Manual poster selected' : matched}`,
    `Audio: ${language}`,
    `Subtitles: ${session.overrides?.subtitleLanguages?.length ? `${session.overrides.subtitleLanguages.join(', ')} (manual)` : detectedSubtitles.length ? `${detectedSubtitles.join(', ')} (from uploaded file details)` : 'Not set'}`,
    '',
    'Caption episode labels are checked before filenames. Telegram @channel names are removed automatically.',
    session.workflow === 'batch'
      ? `Batch stage: ${session.batch?.stage || 'waiting'}. Send the required private storage link, or use /cancel.`
      : 'Upload more files, then use /done to publish.'
  ].join('\n');
}

function mediaDescriptor(message) {
  const kind = message.document
    ? 'document'
    : message.video
      ? 'video'
      : message.audio
        ? 'audio'
        : message.animation
          ? 'animation'
          : message.photo
            ? 'photo'
            : 'file';
  const source = message.document || message.video || message.audio || message.animation || message.photo?.at(-1);
  return { kind, source };
}

// Use the same attribution cleaner for parsing, catalog metadata, and the
// caption written into Telegram storage. Keeping one boundary prevents a raw
// @channel promotion from surviving in a copied message while its public label
// looks clean.
export function cleanStorageCaption(value) {
  return cleanText(stripTelegramAttribution(value, 1_024), 1_024);
}

export function fileFromMessage(message, storedMessageId, storageMethod = 'copy', storageChannelId = null) {
  const { kind, source } = mediaDescriptor(message);
  const filename = source?.file_name || `${kind}-${message.message_id}`;
  const caption = cleanStorageCaption(message.caption);
  const episode = detectUploadEpisode({ caption, filename });
  const quality = detectMediaQuality({ caption, filename });
  const audioLanguages = detectUploadLanguages({ caption, filename });
  const subtitleLanguages = detectUploadSubtitleLanguages({ caption, filename });
  const file = {
    storageMessageId: storedMessageId,
    // Message IDs are unique only within a channel. Persist the source channel
    // so the normal and isolated 18+ stores can safely use the same ID.
    storageChannelId: cleanText(storageChannelId, 80) || null,
    storageMethod,
    telegramFileId: source?.file_id || null,
    name: cleanText(filename, 180),
    // Native Telegram video uploads may have no file_name, so retain a useful
    // sanitized caption as the display source. Raw Telegram promotion handles
    // are never persisted in a catalog file record.
    sourceLabel: cleanText(caption || filename, 500),
    displayName: episode.displayName,
    quality,
    // `languages` stays as a compatibility alias for existing catalog records.
    languages: audioLanguages,
    audioLanguages,
    subtitleLanguages,
    mimeType: cleanText(source?.mime_type || '', 80),
    size: Number(source?.file_size) || 0,
    kind,
    episode: episode.start ? {
      start: episode.start,
      end: episode.end,
      label: episode.label,
      source: episode.source
    } : null,
    // A season number is stored separately from the episode so a multi-season
    // upload can be split into one catalog post per season later.
    season: Number.isInteger(episode.season) && episode.season >= 1 ? episode.season : null,
    seasonSource: episode.seasonSource || null,
    addedAt: new Date().toISOString()
  };
  const trackCapable = isInspectableMediaFile(file);
  const needsInspection = trackCapable && needsMediaTrackInspection({
    ...file,
    // This is sanitized too. The detector still sees useful Dual/Multi,
    // quality, language, season, and episode labels without source promotion.
    displayName: caption || filename
  });
  return {
    ...file,
    mediaInfo: {
      status: trackCapable ? (needsInspection ? 'pending' : 'filename') : 'not-media',
      needsInspection
    }
  };
}

function isBackupArchiveMessage(message) {
  const document = message?.document;
  if (!document) return false;
  const filename = String(document.file_name || '').toLowerCase();
  const mimeType = String(document.mime_type || '').toLowerCase();
  return /\.json(?:\.gz)?$/.test(filename) || /(?:application\/json|application\/(?:x-)?gzip)/.test(mimeType);
}

function isMediaMessage(message) {
  // A signed backup is sent into the same private storage channel as media.
  // Never let its document update turn into an accidental auto-publish card.
  if (isBackupArchiveMessage(message)) return false;
  return Boolean(message?.document || message?.video || message?.audio || message?.animation || message?.photo?.length);
}

function telegramErrorText(error) {
  return String(error?.description || error?.response?.description || error?.message || '').toLowerCase();
}

export function storageErrorHint(error) {
  const details = [error, error?.copyError, error?.fallbackError]
    .map(telegramErrorText)
    .filter(Boolean)
    .join(' | ');

  if (/chat not found|peer_id_invalid/.test(details)) {
    return 'Telegram cannot find the storage channel. Use its numeric -100… channel ID, not an invite link, and restart the service after changing the Koyeb variable.';
  }
  if (/not enough rights|not allowed|administrator|write access|forbidden/.test(details)) {
    return 'The bot can see the channel but cannot post there. In the channel admin settings enable Post Messages, then retry.';
  }
  if (/protected content|can.t be copied|can.t be forwarded|message can.t be copied/.test(details)) {
    return 'Telegram marked the source as protected. Upload the original file directly to this bot instead of forwarding it from a protected channel.';
  }
  if (/file is too big|file.*too large|request entity too large/.test(details)) {
    return 'Telegram rejected this file size for the bot API. Send a smaller file or use a Telegram-compatible size/account configuration.';
  }
  return 'Telegram could not store this item. Check that the configured channel ID is correct and that the bot has Post Messages permission.';
}

async function sendByFileId(telegram, destinationChatId, message) {
  const { kind, source } = mediaDescriptor(message);
  if (!source?.file_id) throw new Error('The received message did not include a reusable Telegram file ID.');
  const extra = { disable_notification: true };
  // A file-id resend creates a fresh Telegram message, so omitting an empty
  // sanitized caption is enough to remove an attribution-only original.
  if (message.caption) {
    const caption = cleanStorageCaption(message.caption);
    if (caption) extra.caption = caption;
  }

  if (kind === 'document') return telegram.sendDocument(destinationChatId, source.file_id, extra);
  if (kind === 'video') return telegram.sendVideo(destinationChatId, source.file_id, extra);
  if (kind === 'audio') return telegram.sendAudio(destinationChatId, source.file_id, extra);
  if (kind === 'animation') return telegram.sendAnimation(destinationChatId, source.file_id, extra);
  if (kind === 'photo') return telegram.sendPhoto(destinationChatId, source.file_id, extra);
  throw new Error('This Telegram media type is not supported by the storage fallback.');
}

function copiedCaptionOptions(message) {
  const originalCaption = typeof message?.caption === 'string' ? message.caption : '';
  if (!originalCaption) return { disable_notification: true };
  const original = cleanText(originalCaption, 1_024);
  const caption = cleanStorageCaption(originalCaption);
  // `copyMessage` otherwise retains the original caption. Explicitly pass an
  // empty string too, so a caption containing only @promotion data is scrubbed
  // rather than silently copied into the private database channel.
  return caption === original
    ? { disable_notification: true }
    : { disable_notification: true, caption };
}

// copyMessage is fastest and preserves the original message. Some forwarded or
// protected-origin items cannot be copied, however. In that case Telegram often
// still lets a bot re-send the file it received by its file_id, so we attempt a
// type-safe fallback before reporting a storage failure to the publisher.
export async function storeMediaInChannel(telegram, destinationChatId, sourceChatId, message) {
  try {
    const copied = await telegram.copyMessage(
      destinationChatId,
      sourceChatId,
      message.message_id,
      copiedCaptionOptions(message)
    );
    return { storageMessageId: copied.message_id, storageChannelId: String(destinationChatId), method: 'copy' };
  } catch (copyError) {
    try {
      const sent = await sendByFileId(telegram, destinationChatId, message);
      return { storageMessageId: sent.message_id, storageChannelId: String(destinationChatId), method: 'file-id-fallback' };
    } catch (fallbackError) {
      const error = new Error('Telegram could not persist the uploaded media.');
      error.copyError = copyError;
      error.fallbackError = fallbackError;
      throw error;
    }
  }
}

function parseDelimitedList(value) {
  return cleanText(value, 300)
    .split(/[,|]/)
    .map((entry) => cleanText(entry, 40))
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Parse `/field SB-ABC… value` without confusing an active-draft value, and the
 * many-at-once form `/field SB-ABC…, SB-DEF… value`. Only a leading run of post
 * IDs is consumed, so a value that itself contains commas ("Hindi, English") or
 * a word that merely starts with SB- stays part of the value.
 */
export function parsePublishedPostEdit(value) {
  const text = String(value || '').trim();
  const ids = [];
  let rest = text;
  const leadingId = /^\s*[,;:]?\s*(SB-[A-F0-9]{10})(?=$|[\s,;:])\s*[,;:]?\s*/i;
  let match = rest.match(leadingId);
  while (match && ids.length < 1_000) {
    const adminId = match[1].toUpperCase();
    if (!ids.includes(adminId)) ids.push(adminId);
    rest = rest.slice(match[0].length);
    match = rest.match(leadingId);
  }
  if (!ids.length) return null;
  return {
    adminId: ids[0],
    adminIds: ids,
    value: cleanText(rest, 1_600)
  };
}

/**
 * Fields that describe how a release is labelled can be set across posts at
 * once; a title or synopsis is unique to one release, so those stay singular.
 */
const MULTI_POST_EDITABLE_FIELDS = new Set([
  'category', 'languages', 'subtitleLanguages', 'genres', 'status', 'releaseLabel', 'year'
]);

/**
 * Apply one metadata edit to every post the publisher named. A correction that
 * spans several releases (a wrong category, a missing subtitle language) used
 * to mean repeating the command once per post ID and re-editing each
 * announcement; now it is one line, and each affected announcement is still
 * updated in place.
 *
 * `guard(content)` may refuse one targeted post (the 18+ storage boundary)
 * without blocking the rest of the batch.
 */
export async function updatePublishedPost({ ctx, repository, argument, field, value, fieldLabel, guard = null }) {
  const target = parsePublishedPostEdit(argument);
  if (!target) return null;
  const multi = MULTI_POST_EDITABLE_FIELDS.has(field);
  if (target.adminIds.length > 1 && !multi) {
    await ctx.reply(`${fieldLabel} is set one post at a time, because every release needs its own ${fieldLabel.toLowerCase()}. Send /${field} ${target.adminIds[0]} …`);
    return { handled: true, content: null };
  }
  if (!target.value && value === undefined) {
    await ctx.reply(multi
      ? `Add a ${fieldLabel} after the post ID${target.adminIds.length > 1 ? 's' : ''}. Example: /${field} ${target.adminIds[0]}${multi ? ', SB-SECONDID' : ''} value`
      : `Add a ${fieldLabel} after the post ID. Example: /${field} ${target.adminId} value`);
    return { handled: true, content: null };
  }
  if (typeof repository.updateContentByAdminId !== 'function') {
    await ctx.reply('Published-post editing is not available in this catalog store.');
    return { handled: true, content: null };
  }
  const patchValue = value === undefined ? target.value : value;
  const contents = [];
  const missing = [];
  const blocked = [];
  const sync = { updated: 0, unchanged: 0, failed: 0, dropped: 0, channels: 0 };
  for (const adminId of target.adminIds) {
    if (guard) {
      const existing = await repository.findContentByAdminId?.(adminId);
      if (!existing) {
        missing.push(adminId);
        continue;
      }
      const refusal = guard(existing);
      if (refusal) {
        blocked.push({ adminId, title: existing.title, reason: refusal });
        continue;
      }
    }
    const updated = await repository.updateContentByAdminId(adminId, { [field]: patchValue });
    if (!updated) {
      missing.push(adminId);
      continue;
    }
    contents.push(updated);
    // Anything the announcement channel shows must stay in sync, so the same
    // edit is applied to the posted message instead of leaving it stale.
    const postSync = await syncPublishedAnnouncements({ telegram: ctx.telegram, repository, content: updated });
    for (const key of Object.keys(sync)) sync[key] += postSync?.[key] || 0;
  }
  if (!contents.length) {
    if (missing.length) {
      await ctx.reply(`No published catalog post was found for ${missing.join(', ')}. Use /posts or /postid to find an ID.`);
    } else if (blocked.length) {
      await ctx.reply(`No post was changed. ${blocked[0].reason}.`);
    }
    return { handled: true, content: null };
  }
  const lines = contents.length === 1
    ? [`${fieldLabel} updated for ${contents[0].adminId} · ${contents[0].title}.`]
    : [
      `${fieldLabel} updated for ${contents.length} posts:`,
      ...contents.map((content) => `▪ ${content.adminId} · ${cleanText(content.title, 70)}`)
    ];
  if (blocked.length) {
    lines.push(`${blocked.length} post${blocked.length === 1 ? ' was' : 's were'} left alone: ${blocked.map((entry) => `${entry.adminId} (${entry.reason})`).join('; ')}`);
  }
  if (missing.length) {
    lines.push(`Not found and skipped: ${missing.join(', ')}.`);
  }
  lines.push(announcementSyncNote(sync));
  await ctx.reply(lines.join('\n'));
  return { handled: true, content: contents[0], contents, announcementSync: sync };
}

/* ---------------------------------------------------------------------------
 * Publisher artwork commands (/poster, /p, /imgdd)
 * ------------------------------------------------------------------------- */

/**
 * Acknowledge an inline-keyboard tap. Telegraf exposes `answerCbQuery(text,
 * extra)`; other Bot API wrappers expose `answerCallbackQuery({ text })`. The
 * acknowledgement is only cosmetic, so a missing method, an already-answered
 * callback, or a 400 from Telegram must never abort the action behind the tap.
 */
async function acknowledgeTap(ctx, text, { alert = false } = {}) {
  const note = cleanText(text, 190);
  try {
    if (typeof ctx.answerCbQuery === 'function') {
      await ctx.answerCbQuery(note || undefined, { show_alert: alert });
      return;
    }
    if (typeof ctx.answerCallbackQuery === 'function') {
      await ctx.answerCallbackQuery({ text: note, show_alert: alert });
    }
  } catch {
    // The chat reply is what the publisher actually needs; tap feedback is not
    // worth losing it over, and Telegram rejects an expired callback anyway.
  }
}

const POSTER_COMMAND_USAGE = [
  'Poster commands accept both styles:',
  '',
  '• Old style — /poster SB-0123ABCDEF https://public-image-host.example/poster.jpg',
  '• New style — /poster SB-0123ABCDEF Exact Title, then tap the artwork you want',
  '• Draft — /poster https://public-image-host.example/poster.jpg',
  '',
  'Send /poster on its own and I will ask which style you want. /p and /imgdd do exactly the same thing.'
].join('\n');

export function posterStyleKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Old style · ID + image link', 'poster:style:old')],
    [Markup.button.callback('✨ New style · search & pick artwork', 'poster:style:new')],
    [Markup.button.callback('Cancel', 'poster:cancel')]
  ]);
}

export function posterCancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'poster:cancel')]]);
}

// Publishers recognise the service people actually quote, not the raw API id.
const POSTER_PROVIDER_LABELS = { anilist: 'AniList', tmdb: 'TMDB', omdb: 'IMDb', imdb: 'IMDb' };

export function posterProviderLabel(provider) {
  const key = cleanText(provider, 20).toLowerCase();
  return POSTER_PROVIDER_LABELS[key] || (key ? key.toUpperCase() : '');
}

/** Telegram measures a button label in UTF-8 bytes, not JavaScript characters. */
function telegramButtonText(value, maxBytes = 62) {
  const text = cleanText(value, 160);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let truncated = text;
  while (truncated.length && Buffer.byteLength(`${truncated}…`, 'utf8') > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated.replace(/[\s.,:-]+$/, '')}…`;
}

export function posterCandidateKeyboard(candidates = []) {
  const rows = [];
  for (let index = 0; index < Math.min(candidates.length, 10); index += 2) {
    rows.push(candidates.slice(index, index + 2).map((candidate, offset) => {
      const title = cleanText(candidate.title, 60) || 'Untitled';
      const year = Number.isInteger(Number(candidate.year)) ? ` (${candidate.year})` : '';
      const provider = posterProviderLabel(candidate.provider);
      // The provider tag leads the label because a truncated "· TM" explains
      // nothing, while a shortened title is still recognisable at a glance.
      return Markup.button.callback(
        telegramButtonText(`${index + offset + 1}.${provider ? ` ${provider} \u00b7` : ''} ${title}${year}`),
        `poster:pick:${index + offset}`
      );
    }));
  }
  rows.push([Markup.button.callback('Search again', 'poster:retry'), Markup.button.callback('Cancel', 'poster:cancel')]);
  return Markup.inlineKeyboard(rows);
}

/** Validate, mirror, and store one replacement poster for a published card. */
export async function mirrorPosterForPublishedPost({ ctx, repository, adminId, sourceUrl, config }) {
  const existing = await repository.findContentByAdminId(adminId);
  if (!existing) {
    await ctx.reply(`No published catalog post was found for ${adminId}. Use /posts or /postid to find an ID.`);
    return null;
  }
  const posterResult = await mirrorPosterToImgBB({
    sourceUrl,
    // A manual pick must fail loudly rather than quietly falling back to a
    // generated poster the publisher never chose.
    sourceIsManual: true,
    title: existing.title,
    category: existing.category,
    config
  });
  const updated = await repository.updateContentByAdminId(adminId, {
    posterUrl: posterResult.url,
    backdropUrl: posterResult.url,
    poster: {
      provider: 'imgbb',
      providerId: posterResult.providerId,
      originalUrl: posterResult.originalUrl,
      source: posterResult.source,
      mirroredAt: new Date().toISOString()
    }
  });
  // The artwork is the announcement, so replace the photo in every channel this
  // post was announced to. A poster nobody chose manually is still a real change.
  const announcementSync = updated
    ? await syncPublishedAnnouncements({ telegram: ctx.telegram, repository, content: updated, config })
    : null;
  return { existing, posterResult, updated, announcementSync };
}

export async function presentPosterCandidates({ ctx, repository, config, adminId, query }) {
  const target = adminId ? await repository.findContentByAdminId(adminId) : null;
  if (adminId && !target) {
    await repository.deletePosterFlow?.(chatId(ctx), userId(ctx));
    await ctx.reply(`No published catalog post was found for ${adminId}. Use /posts or /postid to find an ID.`);
    return false;
  }
  const searchTitle = cleanText(query, 180) || target?.title || '';
  if (!searchTitle) {
    await repository.deletePosterFlow?.(chatId(ctx), userId(ctx));
    await ctx.reply('Send the release name to search artwork for. Example: /poster SB-0123ABCDEF Cocktail 2');
    return false;
  }
  const category = target?.category || 'movie';
  await ctx.reply(`Searching AniList, TMDB, and OMDb artwork for “${searchTitle}”…`);
  let candidates = [];
  try {
    candidates = await searchPosterCandidates(searchTitle, category, config, { limit: 10 });
  } catch (error) {
    console.error('[telegram] poster candidate search failed:', error?.message || 'Unknown error');
  }
  if (!candidates.length) {
    // Nothing was chosen, so the conversation is closed instead of being left
    // waiting for another title the publisher may never send.
    await repository.deletePosterFlow?.(chatId(ctx), userId(ctx));
    await ctx.reply(
      `No provider artwork matched “${searchTitle}”. ${adminId ? `Send a direct link instead: /poster ${adminId} https://…` : 'Send a direct link instead: /poster https://…'}`,
      adminId ? posterCancelKeyboard() : undefined
    );
    return false;
  }
  await repository.startPosterFlow?.({
    chatId: chatId(ctx),
    ownerId: userId(ctx),
    style: 'new',
    targetAdminId: adminId || null,
    stage: 'pick',
    query: searchTitle,
    candidates
  });
  await ctx.reply(
    `Found ${candidates.length} match${candidates.length === 1 ? '' : 'es'} for ${adminId || 'this draft'}. Tap the artwork to mirror it to ImgBB and use it on the card.`,
    posterCandidateKeyboard(candidates)
  );
  return true;
}

/** Answers a `poster:*` button. Returns false when the payload is unknown. */
export async function handlePosterAction(ctx, repository, config, action) {
  if (typeof repository.findPosterFlow !== 'function') return false;
  const key = cleanText(action, 40);
  if (key === 'poster:cancel') {
    await repository.deletePosterFlow?.(chatId(ctx), userId(ctx));
    await acknowledgeTap(ctx, 'Cancelled');
    await ctx.reply('Poster selection cancelled.');
    return true;
  }
  const flow = await repository.findPosterFlow(chatId(ctx), userId(ctx));
  if (!flow) {
    await acknowledgeTap(ctx, 'This poster menu expired. Send /poster again.', { alert: true });
    return true;
  }
  if (key === 'poster:style:old' || key === 'poster:style:new') {
    const style = key.endsWith(':old') ? 'old' : 'new';
    await repository.updatePosterFlow?.(chatId(ctx), userId(ctx), { style, stage: 'post-id', candidates: [], query: '' });
    await acknowledgeTap(ctx);
    await ctx.reply(
      style === 'old'
        ? 'Old style: send the Post ID, for example SB-0123ABCDEF. Find it with /posts or /postid.'
        : 'New style: send the Post ID first, for example SB-0123ABCDEF. I will then ask for the title and show you the artwork I can find.',
      posterCancelKeyboard()
    );
    return true;
  }
  if (key === 'poster:retry') {
    // Answer the tap first: a provider search can outlive Telegram's short
    // callback window, and an unacknowledged tap makes the button look broken.
    await acknowledgeTap(ctx, 'Searching artwork again\u2026');
    await presentPosterCandidates({ ctx, repository, config, adminId: flow.targetAdminId, query: flow.query });
    return true;
  }
  const pick = key.match(/^poster:pick:(\d{1,2})$/);
  if (pick) {
    const candidate = (flow.candidates || [])[Number.parseInt(pick[1], 10)];
    if (!candidate?.posterUrl) {
      await acknowledgeTap(ctx, 'That artwork is no longer available. Search again.', { alert: true });
      return true;
    }
    await acknowledgeTap(ctx, `Mirroring ${cleanText(candidate.title, 60) || 'poster'}…`);
    if (!flow.targetAdminId) {
      const session = await repository.findSession(chatId(ctx), userId(ctx));
      if (!session) {
        await ctx.reply('That draft is no longer active, so the artwork has nowhere to go. Start one with /panel, or edit a published post with /poster SB-… <name>.');
        return true;
      }
      await repository.updateSession(chatId(ctx), userId(ctx), { posterOriginalUrl: candidate.posterUrl });
      await repository.deletePosterFlow?.(chatId(ctx), userId(ctx));
      await ctx.reply(`Draft artwork selected: ${cleanText(candidate.title, 80)}${Number.isInteger(Number(candidate.year)) ? ` (${candidate.year})` : ''}. Publish with /done to mirror it to ImgBB.`);
      return true;
    }
    try {
      const result = await mirrorPosterForPublishedPost({ ctx, repository, adminId: flow.targetAdminId, sourceUrl: candidate.posterUrl, config });
      if (!result) return true;
      await repository.deletePosterFlow?.(chatId(ctx), userId(ctx));
      await ctx.reply(result.updated
        ? `Poster updated for ${result.updated.adminId} · ${result.updated.title} using the ${posterProviderLabel(candidate.provider) || 'chosen'} artwork.`
        : `The poster was mirrored, but ${flow.targetAdminId} is no longer available.`);
      try {
        await ctx.replyWithPhoto(result.posterResult.url, { caption: 'New catalog artwork preview' });
      } catch {
        // A preview is a convenience; the catalog card is already updated.
      }
    } catch (error) {
      const message = error instanceof PosterHostingError ? error.message : 'The chosen poster could not be mirrored to ImgBB. The existing poster is unchanged.';
      console.error('[telegram] poster selection failed:', error?.message || 'Unknown error');
      await ctx.reply(`Poster was not changed. ${message}`);
    }
    return true;
  }
  return false;
}

/**
 * Continues an armed /poster conversation: Post ID → image link (old style) or
 * Post ID → title → artwork buttons (new style).
 */
export async function handlePosterFlowMessage(ctx, repository, config) {
  if (typeof repository.findPosterFlow !== 'function') return false;
  const flow = await repository.findPosterFlow(chatId(ctx), userId(ctx));
  if (!flow) return false;
  const text = cleanText(ctx.message?.text, 2_000);
  if (!text) return false;

  if (flow.stage === 'post-id') {
    const trimmed = text.trim();
    const target = /^SB-[A-F0-9]{10}$/i.test(trimmed)
      ? trimmed.toUpperCase()
      : parsePublishedPostEdit(trimmed)?.adminId || null;
    if (!target) {
      await ctx.reply('Send the post ID only, for example SB-0123ABCDEF. Use /posts or /postid to find it, or /poster cancel to stop.');
      return true;
    }
    await repository.updatePosterFlow(chatId(ctx), userId(ctx), { targetAdminId: target, stage: flow.style === 'old' ? 'image-url' : 'search-title' });
    await ctx.reply(
      flow.style === 'old'
        ? `Editing ${target}. Now send the HTTPS image link for the new poster.`
        : `Editing ${target}. Now send the exact movie/series name (add a year if it helps) and I will show the artwork I can find.`,
      posterCancelKeyboard()
    );
    return true;
  }

  if (flow.stage === 'image-url') {
    const match = text.match(/https:\/\/\S+/i);
    if (!match) {
      await ctx.reply('That is not an HTTPS image link. Send a URL such as https://example.com/poster.jpg, or use /poster cancel.');
      return true;
    }
    try {
      const result = await mirrorPosterForPublishedPost({ ctx, repository, adminId: flow.targetAdminId, sourceUrl: match[0], config });
      if (!result) return true;
      await repository.deletePosterFlow(chatId(ctx), userId(ctx));
      await ctx.reply(result.updated
        ? `Poster updated for ${result.updated.adminId} · ${result.updated.title}.`
        : `The poster was mirrored, but ${flow.targetAdminId} is no longer available.`);
    } catch (error) {
      const message = error instanceof PosterHostingError ? error.message : 'The new poster could not be mirrored to ImgBB. The existing poster is unchanged.';
      console.error('[telegram] poster flow mirror failed:', error?.message || 'Unknown error');
      await ctx.reply(`Poster was not changed. ${message}\nThe prompt is still open — send another link or use /poster cancel.`);
    }
    return true;
  }

  if (flow.stage === 'search-title') {
    // A failed search closes the flow itself, so nothing has to be cleaned up here.
    await presentPosterCandidates({ ctx, repository, config, adminId: flow.targetAdminId, query: text });
    return true;
  }

  return false;
}

// A t.me/c link contains Telegram's private-channel internal ID, rather than
// the normal -100… chat ID used by the Bot API. Keeping this parser narrow
// avoids accidentally importing a public link or a link from another channel.
export function parsePrivateStorageMessageLink(value) {
  const match = String(value || '').match(/(?:https?:\/\/)?(?:www\.)?t\.me\/c\/(\d{5,20})\/(\d{1,12})(?:[/?#][^\s)]*)?/i);
  if (!match) return null;

  const messageId = Number(match[2]);
  if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
  return {
    channelId: `-100${match[1]}`,
    messageId,
    url: `https://t.me/c/${match[1]}/${messageId}`
  };
}

function parseBatchArgument(value) {
  const supplied = cleanText(value, 180);
  if (!supplied) return { title: '', category: null };

  // An optional category prefix lets a publisher override automatic detection
  // without adding a separate, more fragile batch command syntax.
  const prefixed = supplied.match(/^(anime|cartoon|donghua|k(?:-|\s)?drama|movie|web(?:-|\s)?series|adult|18\+?)\s*(?:\||:)\s*(.+)$/i);
  if (!prefixed) return { title: supplied, category: null };

  const rawCategory = prefixed[1].toLowerCase().replace(/[\s-]/g, '');
  const category = rawCategory === 'kdrama'
    ? 'kdrama'
    : rawCategory === 'webseries'
      ? 'web-series'
      : rawCategory === 'adult' || rawCategory === '18+' || rawCategory === '18'
        ? ADULT_CATEGORY
        : rawCategory;
  return {
    title: cleanText(prefixed[2], 180),
    category: PUBLISH_CATEGORIES.includes(category) ? category : null
  };
}

export function inferBatchTitle(files = []) {
  for (const file of files) {
    // A caption may contain only an episode label while the filename carries
    // the actual title, so try each independently instead of treating the
    // caption as an unconditional replacement for the filename.
    for (const value of [file?.displayName, file?.name]) {
      const source = cleanText(value, 180);
      if (!source) continue;

      const candidate = cleanMediaName(source)
        .replace(/\bS(?:EASON)?\s*\d{1,2}\s*[- ]?E(?:P(?:ISODE)?)?\s*\d{1,3}(?:\s*(?:-|–|—|~|TO|THROUGH)\s*(?:E(?:P(?:ISODE)?)?\s*)?\d{1,3})?\b/gi, ' ')
        .replace(/\b(?:EPISODES?|EPS?|EP|E)\.?\s*\d{1,3}(?:\s*(?:-|–|—|~|TO|THROUGH)\s*(?:(?:EPISODES?|EPS?|EP|E)\.?\s*)?\d{1,3})?\b/gi, ' ')
        // Keep sequel numbers (Cocktail 2), but remove a standalone season
        // marker because it describes packaging rather than the series title.
        .replace(/\b(?:S(?:EASON)?\s*0*\d{1,2})\b/gi, ' ')
        .replace(/\b(?:multi(?:\s+audio)?|dual\s+audio|audio|dub(?:bed)?|sub(?:title)?s?|engsub|eng|indo|cc)\b/gi, ' ')
        .replace(/\b(?:hindi|malayalam|tamil|telugu|kannada|bengali|bangla|marathi|punjabi|gujarati|urdu|english|japanese|korean|chinese|mandarin|cantonese|indonesian|thai|vietnamese|spanish|french|german|portuguese|arabic|russian)\b/gi, ' ')
        .replace(/\b(?:360|480|576|720|1080|1440|2160|4k|8k)\s*p?\b/gi, ' ')
        .replace(/[+]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-–—|:/.]+|[\s\-–—|:/.]+$/g, '')
        .trim();

      if (candidate.length >= 2 && /[a-z]/i.test(candidate) && !/^(?:document|video|file|upload)(?:\s+\d+)?$/i.test(candidate)) {
        return cleanText(candidate, 180);
      }
    }
  }
  return '';
}

export function inferBatchCategory({ title = '', files = [] } = {}) {
  const signals = [title, ...files.flatMap((file) => [file?.displayName, file?.name])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\b(?:donghua|manhua|xianxia|cultivation|chinese\s+anime)\b/.test(signals)) return 'donghua';
  if (/\b(?:k[\s-]?drama|korean\s+drama)\b/.test(signals)) return 'kdrama';
  if (/\b(?:cartoon|animated\s+(?:series|show)|kids\s+animation)\b/.test(signals)) return 'cartoon';
  if (/\b(?:anime|japanese\s+anime)\b/.test(signals)) return 'anime';
  if (/\b(?:web[\s-]?series|webseries)\b/.test(signals)) return 'web-series';

  // Season packaging is episodic by definition: `Fullmetal Alchemist S1` has no
  // episode numbers in the filenames, and used to be filed as a movie.
  const hasSeasonMarkers = files.some((file) => Boolean(detectUploadSeasonForFile(file)));
  if (summarizeEpisodes(files).count || hasSeasonMarkers) {
    if (/\b(?:chinese|mandarin|cantonese)\b/.test(signals)) return 'donghua';
    if (/\b(?:japanese|jpn)\b/.test(signals)) return 'anime';
    if (/\b(?:korean|kor)\b/.test(signals)) return 'kdrama';
    return 'web-series';
  }
  return 'movie';
}

function autoPublishKeyboard(enabled) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Auto-publish: ${enabled ? 'ON' : 'OFF'}`, 'auto:status')],
    [Markup.button.callback('Turn ON', 'auto:on'), Markup.button.callback('Turn OFF', 'auto:off')]
  ]);
}

function autoPublishStatusText(settings, config) {
  const enabled = Boolean(settings?.enabled);
  return [
    `Storage-channel auto-publish is ${enabled ? 'ON' : 'OFF'}.`,
    '',
    enabled
      ? 'New supported media posted directly in the configured database channel is collected by cleaned release name. After 90 seconds with no matching upload (or 15 minutes maximum), one combined post is classified, matched with metadata, mirrored to ImgBB, and published.'
      : 'Nothing posted in the database channel will be published automatically while this is OFF.',
    '',
    config.telegram.storageChannelId
      ? `Database channel: ${config.telegram.storageChannelId}`
      : 'TELEGRAM_STORAGE_CHANNEL_ID is not configured. Set it before turning automation on.',
    'Bot-originated storage copies, active-draft files, and already-published storage messages are ignored to prevent loops and duplicates.',
    settings?.notifyChatId || settings?.updatedBy
      ? 'Completion and error diagnostics are sent to the authorized publisher, never into the database channel.'
      : 'Turn the setting ON from your private publisher chat to receive completion and error diagnostics.',
    'Use /batch to publish an existing inclusive range of storage-channel files.'
  ].join('\n');
}

function parseStartPayload(ctx) {
  const text = ctx.message?.text || '';
  const [, payload] = text.split(/\s+/, 2);
  return payload || '';
}

export function parseDeliveryPayload(payload) {
  const safePayload = String(payload || '').trim();
  if (safePayload.startsWith('get-')) {
    const shareCode = safePayload.slice(4);
    return /^[A-Za-z0-9_-]{6,48}$/.test(shareCode) ? { shareCode, filePosition: null } : null;
  }

  // The final numeric segment is the 1-based file position. The share code can
  // contain hyphens, so matching from the right avoids ambiguous split logic.
  const singleFile = safePayload.match(/^file-([A-Za-z0-9_-]{6,48})-([1-9]\d{0,5})$/);
  if (!singleFile) return null;
  return { shareCode: singleFile[1], filePosition: Number.parseInt(singleFile[2], 10) };
}

function normalizeChannelId(value) {
  const parsed = cleanText(value, 80);
  if (/^-?\d+$/.test(parsed)) return parsed;
  if (/^@[A-Za-z][A-Za-z0-9_]{4,}$/i.test(parsed)) return parsed;
  return null;
}

// A metadata edit can name as many posts as fit in one Telegram message, so the
// argument is read at nearly the full 4 096-character limit instead of the
// default 180. `parsePublishedPostEdit` and `postIdsFromCommand` deliberately
// impose no batch cap of their own.
export const POST_EDIT_ARGUMENT_LIMIT = 3_800;

function postIdsFromCommand(value) {
  return [...new Set(
    [...String(value || '').toUpperCase().matchAll(/\bSB-[A-F0-9]{10}\b/g)].map((match) => match[0])
  )].slice(0, 1_000);
}

function episodeUploadNote(file, { episodic = false } = {}) {
  if (file.episode?.label) return ` · ${file.episode.label} detected from ${file.episode.source}`;
  // A file with no episode number never reaches the episode index. Saying so in
  // the upload reply is the only moment the caption can still be fixed.
  return episodic
    ? ' · no episode number was found in this file’s name or caption, so it stays out of the episode index — send it again with a caption like “Ep 12”'
    : '';
}

async function updateTitleAndMetadata({ ctx, repository, config, title }) {
  const current = await repository.findSession(chatId(ctx), userId(ctx));
  if (!current) return null;
  // Adult titles remain in the publisher/private storage flow and are not sent
  // to external metadata search providers as part of title entry.
  const metadata = isAdultCategory(current.category)
    ? emptyPrivateCategoryMetadata(title)
    : await findMetadata(title, current.category, config);
  const updated = await repository.updateSession(chatId(ctx), userId(ctx), {
    title: cleanText(title, 180),
    metadata
  });

  if (isAdultCategory(current.category)) {
    await ctx.reply('Title saved. This 18+ draft stays private, uses the separate 18+ storage channel, and will never be sent to announcement channels. Upload files whenever you are ready.', uploadKeyboard());
  } else if (metadata.matched) {
    await ctx.reply(
      `Title saved. ${String(metadata.provider || 'metadata').toUpperCase()} found “${metadata.title}” (${metadata.year || 'year unavailable'}). Upload files whenever you are ready.`,
      uploadKeyboard()
    );
  } else {
    await ctx.reply(
      'Title saved. No confident metadata match was found, so a branded fallback poster will be created and mirrored to ImgBB when you publish. Upload files whenever you are ready.',
      uploadKeyboard()
    );
  }
  return updated;
}

async function beginDraft(ctx, category, suppliedTitle, repository, config) {
  if (isAdultCategory(category) && !hasDedicatedAdultStorage(config)) {
    await ctx.reply(`${adultStorageConfigurationHint(config)} Fix it before starting /18db.`);
    return null;
  }
  await repository.startSession({
    chatId: chatId(ctx),
    ownerId: userId(ctx),
    category,
    title: ''
  });

  if (suppliedTitle) {
    await updateTitleAndMetadata({ ctx, repository, config, title: suppliedTitle });
    return;
  }

  await ctx.reply(
    [
      `New ${categoryDetails(category).shortLabel} draft created.`,
      '',
      'Send the title next. After that, upload files directly to this chat and finish with /done.',
      isAdultCategory(category)
        ? 'This 18+ draft uses the isolated private storage channel and is never announced to public Telegram channels.'
        : 'Episode detection checks the clean caption first, strips @channel tags, then checks the filename.',
      'Optional: /lang Hindi, English · /year 2026 · /poster https://image.example/poster.jpg'
    ].join('\n'),
    uploadKeyboard()
  );
}

async function beginBatch(ctx, suppliedArgument, repository, config) {
  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    await ctx.reply('For privacy, start /batch in your private chat with this bot. It temporarily forwards each storage file there only to inspect its caption and media details.');
    return;
  }

  const parsed = parseBatchArgument(suppliedArgument);
  const category = parsed.category || 'movie';
  const storageChannelId = storageChannelForCategory(config, category);
  if (!storageChannelId) {
    await ctx.reply(`${storageEnvironmentName(category)} is not configured. Add the ${storageChannelDescription(category)} numeric -100… ID before importing a batch.`);
    return;
  }
  if (isAdultCategory(category) && !hasDedicatedAdultStorage(config)) {
    await ctx.reply(`${adultStorageConfigurationHint(config)} Fix it before importing an 18+ batch.`);
    return;
  }

  await repository.startSession({
    chatId: chatId(ctx),
    ownerId: userId(ctx),
    category,
    title: parsed.title
  });
  await repository.updateSession(chatId(ctx), userId(ctx), {
    workflow: 'batch',
    batch: {
      stage: 'awaiting-first-link',
      sourceChannelId: null,
      firstMessageId: null,
      lastMessageId: null,
      titleProvided: Boolean(parsed.title),
      categoryOverride: parsed.category
    }
  });

  await ctx.reply(
    [
      parsed.title ? `Batch import created for “${parsed.title}”.` : 'Untitled batch import created.',
      '',
      'Send the FIRST private database-channel link, then send the LAST link. Both links must look like:',
      'https://t.me/c/1234567890/123',
      '',
      'Every supported media message in the inclusive range is imported as one release. Large episode ranges are processed patiently with progress updates; the bot briefly forwards each item only to inspect its file details, then removes that preview.',
      isAdultCategory(category)
        ? 'This 18+ batch reads only the separate adult storage channel and will never create a public Telegram announcement.'
        : parsed.title
          ? 'The category will be detected from the title/files. To force it next time, use /batch anime | Your title.'
          : 'The title and category will be inferred from the imported file descriptions and names. Use /batch adult | Your title for the isolated 18+ storage channel.'
    ].join('\n')
  );
}

async function removeBatchPreview(ctx, message) {
  if (!message?.message_id) return;
  try {
    await ctx.telegram.deleteMessage(chatId(ctx), message.message_id);
  } catch (error) {
    // Removing a just-forwarded preview is best effort. It does not affect the
    // original storage message or the catalog record.
    console.warn('[telegram] could not remove batch inspection preview:', error?.description || error?.message || 'Unknown error');
  }
}

async function scrubExistingStorageCaption(ctx, storageChannelId, storageMessageId, message) {
  const originalCaption = typeof message?.caption === 'string' ? message.caption : '';
  if (!originalCaption || typeof ctx?.telegram?.editMessageCaption !== 'function') return false;
  const original = cleanText(originalCaption, 1_024);
  const caption = cleanStorageCaption(originalCaption);
  if (caption === original) return false;
  try {
    // /batch may inspect messages written by a human or a different bot. Bot
    // API only allows editing messages owned by this bot, so this is best
    // effort; regardless of ownership, the catalog file record is sanitized.
    await ctx.telegram.editMessageCaption(String(storageChannelId), storageMessageId, undefined, caption);
    return true;
  } catch (error) {
    console.info(`[telegram] batch kept an externally owned storage caption ${storageMessageId}; its catalog label is still sanitized.`);
    return false;
  }
}

function batchReasonRecordsLine(label, records, detailFormatter) {
  if (!records.length) return null;
  return `${label} (${records.length}): ${records.map((record) => detailFormatter(record)).join(', ')}`;
}

function batchDiagnosticLines({ skippedByReason, failures }) {
  return [
    batchReasonRecordsLine('Already linked to a catalog post', skippedByReason.alreadyPublished, (record) => `${record.messageId}${record.detail ? ` (${record.detail})` : ''}`),
    batchReasonRecordsLine('Already attached to an active draft', skippedByReason.activeDraft, (record) => `${record.messageId}${record.detail ? ` (${record.detail})` : ''}`),
    batchReasonRecordsLine('Not supported media / text-only', skippedByReason.nonMedia, (record) => String(record.messageId)),
    batchReasonRecordsLine('Could not inspect (inaccessible, deleted, or protected)', failures, (record) => `${record.messageId} (${record.detail})`)
  ].filter(Boolean);
}

async function replyBatchDiagnostics(ctx, lines) {
  const maximumLength = 3_700;
  let chunk = '';
  for (const originalLine of lines) {
    let line = originalLine;
    const next = chunk ? `${chunk}\n${line}` : line;
    if (next.length <= maximumLength) {
      chunk = next;
      continue;
    }
    if (chunk) await ctx.reply(chunk);
    // Details are compact, but Telegram's 4096-character limit should never
    // hide why a long inclusive range had individual messages skipped.
    while (line.length > maximumLength) {
      await ctx.reply(line.slice(0, maximumLength));
      line = line.slice(maximumLength);
    }
    chunk = line;
  }
  if (chunk) await ctx.reply(chunk);
}

function telegramRetryAfterMilliseconds(error, attempt) {
  const retryAfter = Number(
    error?.parameters?.retry_after
    || error?.response?.parameters?.retry_after
    || error?.response?.body?.parameters?.retry_after
  );
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1_000, 10 * 60_000);
  const details = telegramErrorText(error);
  if (/too many requests|flood|429/.test(details)) return Math.min(1_000 * (2 ** attempt), 30_000);
  return 0;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Schedule removal of one bot-delivered media message from the recipient chat.
 * This is intentionally best effort: Telegram may reject a deletion after a
 * user clears a chat or changes its availability, and it cannot erase a file
 * that has already been downloaded, forwarded, or saved outside Telegram.
 */
export function scheduleDeliveredFileDeletion({ telegram, recipientChatId, messageId, deleteAfterMs = DELIVERY_FILE_DELETE_AFTER_MS } = {}) {
  const destination = recipientChatId === null || recipientChatId === undefined ? '' : String(recipientChatId).trim();
  const numericMessageId = Number(messageId);
  if (!telegram || typeof telegram.deleteMessage !== 'function' || !destination || !Number.isSafeInteger(numericMessageId) || numericMessageId < 1) {
    return false;
  }
  const requestedDelay = Number(deleteAfterMs);
  const delay = Number.isFinite(requestedDelay) && requestedDelay >= 0
    ? Math.min(requestedDelay, 24 * 60 * 60_000)
    : DELIVERY_FILE_DELETE_AFTER_MS;
  const timer = setTimeout(() => {
    // Large releases can contain hundreds of copied files. Serialize removal
    // requests with a small gap so the five-minute cleanup itself does not
    // trigger Telegram's flood limit.
    deliveryDeletionQueue = deliveryDeletionQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await telegram.deleteMessage(destination, numericMessageId);
          console.info(`[telegram] automatically deleted delivered message ${numericMessageId} from chat ${destination}.`);
        } catch (error) {
          console.warn('[telegram] automatic delivery cleanup failed:', error?.description || error?.message || 'Unknown error');
        }
        if (DELIVERY_FILE_DELETE_SPACING_MS) await pause(DELIVERY_FILE_DELETE_SPACING_MS);
      });
  }, delay);
  // Scheduled cleanup should not keep an otherwise idle Koyeb process alive.
  timer.unref?.();
  return true;
}

async function forwardStorageMessageWithRetry(ctx, storageChannelId, storageMessageId) {
  let lastError = null;
  for (let attempt = 0; attempt <= BATCH_MAX_FORWARD_RETRIES; attempt += 1) {
    try {
      return await ctx.telegram.forwardMessage(
        chatId(ctx),
        String(storageChannelId),
        storageMessageId,
        { disable_notification: true }
      );
    } catch (error) {
      lastError = error;
      const waitMilliseconds = telegramRetryAfterMilliseconds(error, attempt);
      if (!waitMilliseconds || attempt === BATCH_MAX_FORWARD_RETRIES) throw error;
      const waitLabel = waitMilliseconds >= 1_000 ? `${Math.ceil(waitMilliseconds / 1_000)}s` : `${waitMilliseconds}ms`;
      console.warn(`[telegram] batch import rate limited at storage message ${storageMessageId}; retrying in ${waitLabel} (attempt ${attempt + 1}/${BATCH_MAX_FORWARD_RETRIES}).`);
      await pause(waitMilliseconds);
    }
  }
  throw lastError || new Error('Could not inspect the storage message.');
}

async function reportBatchProgress(ctx, { processed, total, imported, skipped, failed }) {
  try {
    await ctx.reply(
      `Batch progress: ${processed}/${total} storage messages inspected · ${imported} media imported · ${skipped} skipped${failed ? ` · ${failed} could not be inspected` : ''}.`
    );
  } catch (error) {
    // A progress update is helpful but must never interrupt a long release.
    console.warn('[telegram] could not send batch progress:', automationDiagnostic(error));
  }
}

export async function importStorageRange(ctx, session, lastLink, bot, repository, config, publish = publishDraft) {
  const batch = session.batch || {};
  const sourceStorageChannelId = batch.sourceChannelId || storageChannelForCategory(config, session.category || batch.categoryOverride);
  const includeLegacyStorageReferences = !isAdultCategory(session.category || batch.categoryOverride);
  const firstMessageId = Number(batch.firstMessageId);
  const lastMessageId = Number(lastLink.messageId);
  const imported = [];
  const skippedByReason = {
    alreadyPublished: [],
    activeDraft: [],
    nonMedia: []
  };
  const failures = [];
  const totalMessages = lastMessageId - firstMessageId + 1;
  let processedMessages = 0;

  for (let storageMessageId = firstMessageId; storageMessageId <= lastMessageId; storageMessageId += 1) {
    processedMessages += 1;
    let preview;
    try {
      const existing = await repository.findContentByStorageMessageId(
        storageMessageId,
        sourceStorageChannelId,
        { includeLegacy: includeLegacyStorageReferences }
      );
      if (existing) {
        skippedByReason.alreadyPublished.push({
          messageId: storageMessageId,
          detail: existing.adminId || cleanText(existing.title, 70) || 'published post'
        });
        continue;
      }
      const pendingDraft = await repository.findSessionByStorageMessageId(
        storageMessageId,
        sourceStorageChannelId,
        { includeLegacy: includeLegacyStorageReferences }
      );
      if (pendingDraft) {
        skippedByReason.activeDraft.push({
          messageId: storageMessageId,
          detail: pendingDraft.workflow || 'upload draft'
        });
        continue;
      }

      // Bot API has no getMessage endpoint. Forwarding to the logged-in
      // publisher is the safe way to inspect an existing channel message and
      // obtain its caption/file metadata; the preview is deleted immediately.
      preview = await forwardStorageMessageWithRetry(
        ctx,
        sourceStorageChannelId,
        storageMessageId
      );
      if (!isMediaMessage(preview)) {
        skippedByReason.nonMedia.push({ messageId: storageMessageId });
        continue;
      }

      const file = fileFromMessage(preview, storageMessageId, 'existing-storage', sourceStorageChannelId);
      await scrubExistingStorageCaption(ctx, sourceStorageChannelId, storageMessageId, preview);
      const updated = await repository.appendSessionFile(chatId(ctx), userId(ctx), file);
      if (!updated?.files?.length) throw new Error('The batch session expired while importing files.');
      imported.push(file);
    } catch (error) {
      const details = automationDiagnostic(error);
      failures.push({ messageId: storageMessageId, detail: details });
      console.error('[telegram] batch import message failed:', storageMessageId, details);
    } finally {
      await removeBatchPreview(ctx, preview);
      if (processedMessages === totalMessages || processedMessages % BATCH_PROGRESS_INTERVAL === 0) {
        const skipped = Object.values(skippedByReason).reduce((total, records) => total + records.length, 0);
        await reportBatchProgress(ctx, {
          processed: processedMessages,
          total: totalMessages,
          imported: imported.length,
          skipped,
          failed: failures.length
        });
      }
    }
  }

  const skippedCount = Object.values(skippedByReason).reduce((total, records) => total + records.length, 0);
  const latestSession = await repository.findSession(chatId(ctx), userId(ctx));
  const diagnostics = batchDiagnosticLines({ skippedByReason, failures });
  const diagnosticCounts = {
    alreadyPublished: skippedByReason.alreadyPublished.length,
    activeDraft: skippedByReason.activeDraft.length,
    nonMedia: skippedByReason.nonMedia.length
  };

  if (!imported.length || !latestSession) {
    if (latestSession) {
      await repository.updateSession(chatId(ctx), userId(ctx), {
        batch: {
          ...batch,
          stage: 'import-failed',
          lastMessageId,
          importedCount: 0,
          skippedCount,
          skipReasons: diagnosticCounts,
          failureCount: failures.length
        }
      });
    }
    const allAlreadyPublished = skippedByReason.alreadyPublished.length > 0
      && skippedByReason.alreadyPublished.length === lastMessageId - firstMessageId + 1;
    await replyBatchDiagnostics(ctx, [
      `No supported new media could be imported from messages ${firstMessageId}–${lastMessageId}.`,
      ...diagnostics,
      allAlreadyPublished
        ? 'Every selected message is already linked to an existing catalog post, so no duplicate delivery records were created. Use /posts 50 to see post IDs, remove unwanted old cards with /delete SB-…, then run /batch again to rebuild the range as one post.'
        : failures.length
          ? 'Check that this bot is an administrator in this exact storage channel. Protected/forward-disabled messages cannot be inspected by Telegram and must be uploaded again directly.'
          : 'No new catalog post was created. Correct the identified messages or links, then run /batch again.'
    ]);
    return { imported: 0, skippedByReason, failures };
  }

  const title = cleanText(session.title || inferBatchTitle(latestSession.files), 180) || `Storage import ${firstMessageId}–${lastMessageId}`;
  const category = batch.categoryOverride || inferBatchCategory({ title, files: latestSession.files });
  await repository.updateSession(chatId(ctx), userId(ctx), {
    title,
    category,
    metadata: null,
    batch: {
      ...batch,
      stage: 'ready',
      lastMessageId,
      importedCount: imported.length,
      skippedCount,
      skipReasons: diagnosticCounts,
      failureCount: failures.length
    }
  });

  await replyBatchDiagnostics(ctx, [
    `Imported ${imported.length} new file${imported.length === 1 ? '' : 's'} from messages ${firstMessageId}–${lastMessageId}. Detected ${categoryDetails(category).label} · “${title}”.`,
    ...diagnostics,
    'Matching metadata and publishing now…'
  ]);
  const publication = await publish(ctx, bot, repository, config);
  return { imported: imported.length, skippedByReason, failures, publication };
}

async function handleBatchLink(ctx, session, bot, repository, config) {
  const link = parsePrivateStorageMessageLink(ctx.message?.text);
  if (!link) {
    await ctx.reply('Please send a private storage link in the form https://t.me/c/<internal-channel-id>/<message-id>. Public @channel links cannot safely identify this database channel.');
    return;
  }
  const category = session.category || session.batch?.categoryOverride || 'movie';
  const storageChannelId = storageChannelForCategory(config, category);
  if (String(link.channelId) !== String(storageChannelId || '')) {
    await ctx.reply(`That link is not from the configured ${isAdultCategory(category) ? '18+ ' : ''}database channel. This batch only accepts links whose internal ID maps to ${storageChannelId || `the configured ${storageEnvironmentName(category)}`}.`);
    return;
  }

  const batch = session.batch || {};
  if (batch.stage === 'importing') {
    await ctx.reply('This batch is already being imported. Please wait for its publishing result before sending another link.');
    return;
  }
  if (batch.stage === 'ready') {
    await ctx.reply('This batch has already been prepared. Use /done if publishing did not finish, or begin a new /batch import.');
    return;
  }
  if (!batch.firstMessageId) {
    await repository.updateSession(chatId(ctx), userId(ctx), {
      batch: {
        ...batch,
        stage: 'awaiting-last-link',
        sourceChannelId: link.channelId,
        firstMessageId: link.messageId
      }
    });
    await ctx.reply(`First storage message saved: ${link.messageId}. Now send the LAST link (the range is inclusive).`);
    return;
  }

  if (String(batch.sourceChannelId) !== String(link.channelId)) {
    await ctx.reply('The last link must be from the same private storage channel as the first link.');
    return;
  }
  if (link.messageId < Number(batch.firstMessageId)) {
    await ctx.reply(`The last message ID must be ${batch.firstMessageId} or higher. Send the last link again.`);
    return;
  }
  const rangeCount = link.messageId - Number(batch.firstMessageId) + 1;

  await repository.updateSession(chatId(ctx), userId(ctx), {
    batch: { ...batch, stage: 'importing', lastMessageId: link.messageId }
  });
  await ctx.reply(`Inspecting ${rangeCount} storage message${rangeCount === 1 ? '' : 's'} and preparing the catalog post…`);
  await importStorageRange(ctx, session, link, bot, repository, config);
}

async function requirePublisher(ctx, repository, config) {
  if (!hasAllowedPublisherId(ctx, config)) {
    await ctx.reply('This is a delivery bot. Open a catalog link to receive files, or use /request to send the catalog team a request.');
    return false;
  }
  if (!config.adminLoginCode) {
    await ctx.reply('Publisher login is not configured yet. Add ADMIN_LOGIN_CODE as a server secret.');
    return false;
  }
  if (!(await isPublisher(ctx, repository, config))) {
    await ctx.reply('Publisher area is locked. Use /login followed by your private passcode first.');
    return false;
  }
  return true;
}

async function showDraftStatus(ctx, repository) {
  const session = await repository.findSession(chatId(ctx), userId(ctx));
  if (!session) {
    await ctx.reply('There is no active draft. Use /panel or /movie Title to start one.', panelKeyboard());
    return null;
  }
  await ctx.reply(displayDraft(session), uploadKeyboard());
  return session;
}

function announcementCaption(content) {
  const episodeSummary = content.episodeCount ? `${content.episodeCount} episode${content.episodeCount === 1 ? '' : 's'}` : null;
  const facts = [
    content.year ? `📅 <b>Year:</b> ${content.year}` : null,
    content.languages?.length ? `🗣 <b>Audio:</b> ${escapeHtml(content.languages.join(' · '))}` : null,
    content.subtitleLanguages?.length ? `💬 <b>Subtitles:</b> ${escapeHtml(content.subtitleLanguages.join(' · '))}` : null,
    content.genres?.length ? `✦ <b>Genres:</b> ${escapeHtml(content.genres.join(' · '))}` : null,
    episodeSummary ? `▣ <b>Included:</b> ${episodeSummary}` : `▣ <b>Delivery files:</b> ${content.filesCount}`
  ].filter(Boolean);
  const synopsis = cleanText(content.description, 420);

  return [
    `🎬 <b>NEW ${escapeHtml(String(content.categoryLabel || categoryDetails(content.category).label).toUpperCase())} DROP</b>`,
    '',
    `<b>${escapeHtml(content.title)}</b>`,
    '━━━━━━━━━━━━━━━━',
    ...facts,
    synopsis ? '' : null,
    synopsis ? escapeHtml(synopsis) : null,
    '',
    'Tap the button below for full details, episode guide, and Telegram delivery.'
  ].filter((line) => line !== null).join('\n').slice(0, 1000);
}

function announcementKeyboard(config, content, websiteUrl = null) {
  const link = websiteUrl || (config ? getContentPageUrl(config, content) : null);
  return link ? Markup.inlineKeyboard([[Markup.button.url('✨ VIEW ON WEBSITE', link)]]) : undefined;
}

/**
 * Keep the Telegram announcement of a published post visually identical to the
 * catalog card. Every edit path (title, languages, genres, synopsis, status,
 * release label, category, and poster) funnels through here, so an announcement
 * never keeps showing an old image or old information after /poster or /title.
 *
 * Only the messages this bot sent are touched, and only when the post recorded
 * where they landed; an announcement the publisher deleted manually is simply
 * forgotten instead of retried forever.
 */
export async function syncPublishedAnnouncements({ telegram, repository, content, config = null }) {
  const refs = Array.isArray(content?.announcementRefs) ? content.announcementRefs : [];
  const result = { updated: 0, unchanged: 0, failed: 0, dropped: 0, channels: refs.length };
  if (!refs.length || !telegram || isAdultCategory(content?.category)) return result;
  const caption = announcementCaption(content);
  const kept = [];

  for (const reference of refs) {
    // Only rewrite the button row when the destination link is actually known;
    // omitting reply_markup leaves the publisher's existing buttons untouched.
    const link = (config ? getContentPageUrl(config, content) : null) || reference.websiteUrl || null;
    const keyboard = link ? announcementKeyboard(config, content, link) : undefined;
    const replyMarkup = keyboard ? keyboard.reply_markup : undefined;
    try {
      if (reference.kind !== 'text' && content.posterUrl) {
        await telegram.editMessageMedia(
          reference.channelId,
          reference.messageId,
          null,
          { type: 'photo', media: content.posterUrl, caption, parse_mode: 'HTML' },
          replyMarkup ? { reply_markup: replyMarkup } : {}
        );
        // Some Bot API versions ignore reply_markup on editMessageMedia; a
        // second call is idempotent and keeps the website button present.
        if (replyMarkup) await telegram.editMessageReplyMarkup(reference.channelId, reference.messageId, null, replyMarkup).catch(() => {});
      } else {
        await telegram.editMessageText(reference.channelId, reference.messageId, null, caption, {
          parse_mode: 'HTML',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        });
      }
      kept.push(reference);
      result.updated += 1;
    } catch (error) {
      const description = cleanText(error?.description || error?.message, 200);
      if (/message is not modified/i.test(description)) {
        kept.push(reference);
        result.unchanged += 1;
        continue;
      }
      if (/not found|can't be edited|chat not found|deleted|message to edit/i.test(description)) {
        result.dropped += 1;
        continue;
      }
      kept.push(reference);
      result.failed += 1;
      console.warn('[telegram] announcement sync failed:', reference.channelId, description || 'Unknown error');
    }
  }

  if (kept.length !== refs.length && content?.adminId && typeof repository?.updateContentByAdminId === 'function') {
    await Promise.resolve(repository.updateContentByAdminId(content.adminId, { announcementRefs: kept })).catch(() => {});
  }
  return result;
}

export function announcementSyncNote(sync) {
  if (!sync?.channels) return 'No Telegram announcement is attached to this post, so nothing else needed updating.';
  const parts = [];
  if (sync.updated) parts.push(`${sync.updated} announcement${sync.updated === 1 ? '' : 's'} updated`);
  if (sync.unchanged) parts.push(`${sync.unchanged} already showing this information`);
  if (sync.failed) parts.push(`${sync.failed} could not be edited (is the bot still an admin?)`);
  if (sync.dropped) parts.push(`${sync.dropped} deleted announcement${sync.dropped === 1 ? '' : 's'} forgotten`);
  return parts.length ? `Telegram announcements: ${parts.join(', ')}.` : 'The Telegram announcement could not be edited.';
}

export async function announcePublishedContent({ bot, repository, content, websiteUrl, storageChannelId = null }) {
  // 18+ releases are intentionally never broadcast, even when normal
  // announcement destinations are configured. Their access route is the
  // age-confirmed category page only.
  if (isAdultCategory(content?.category)) return { sent: 0, failed: 0, skipped: 0, suppressed: true };
  const channels = await repository.listAnnouncementChannels();
  if (!channels.length) return { sent: 0, failed: 0, skipped: 0 };

  // A database channel is deliberately not an announcement destination. Apart
  // from keeping storage clean, this prevents an auto-published announcement
  // photo from becoming another storage-channel automation event.
  const normalizedStorageChannelId = storageChannelId === null || storageChannelId === undefined ? null : String(storageChannelId);

  // Announcement channels deliberately send users to the catalog page first.
  // The public page is where the user can review details and choose Telegram delivery.
  const keyboard = websiteUrl ? Markup.inlineKeyboard([[Markup.button.url('✨ VIEW ON WEBSITE', websiteUrl)]]) : undefined;
  const caption = announcementCaption(content);
  const posts = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const channel of channels) {
    if (normalizedStorageChannelId && String(channel.channelId) === normalizedStorageChannelId) {
      skipped += 1;
      console.warn('[telegram] skipped an announcement to the database storage channel to prevent an automation loop.');
      continue;
    }
    try {
      const posted = await bot.telegram.sendPhoto(channel.channelId, content.posterUrl, {
        caption,
        parse_mode: 'HTML',
        ...keyboard
      });
      posts.push({ channelId: String(channel.channelId), messageId: posted?.message_id, kind: 'photo', websiteUrl, postedAt: new Date().toISOString() });
      sent += 1;
    } catch (photoError) {
      try {
        const posted = await bot.telegram.sendMessage(channel.channelId, caption, {
          parse_mode: 'HTML',
          ...keyboard
        });
        posts.push({ channelId: String(channel.channelId), messageId: posted?.message_id, kind: 'text', websiteUrl, postedAt: new Date().toISOString() });
        sent += 1;
      } catch (messageError) {
        failed += 1;
        console.error('[telegram] announcement failed:', channel.channelId, messageError?.description || messageError?.message || photoError?.message || 'Unknown error');
      }
    }
  }

  return { sent, failed, skipped, posts: posts.filter((post) => Number(post.messageId) > 0) };
}

export async function inspectSessionMediaTracks({ session, bot, repository, config } = {}) {
  if (!session?.files?.length) return { session, inspection: { scanned: 0, skipped: 0, unavailable: 0, failed: 0 } };
  try {
    const inspection = await inspectDeferredMediaTracks({
      files: session.files,
      telegram: bot?.telegram,
      mediaInfo: config?.mediaInfo || {}
    });
    const changed = inspection.files.some((file, index) => file !== session.files[index]);
    if (!changed) return { session, inspection };
    let saved = null;
    if (typeof repository?.replaceSessionFiles === 'function') {
      saved = await repository.replaceSessionFiles(session.chatId, session.ownerId, inspection.files);
    }
    return { session: saved || { ...session, files: inspection.files }, inspection };
  } catch (error) {
    // Track labels are an enhancement. A failed download, timeout, or missing
    // MediaInfo binary must never prevent a publisher from releasing files.
    console.warn('[telegram] deferred media-track inspection failed:', automationDiagnostic(error));
    return { session, inspection: { scanned: 0, skipped: 0, unavailable: 0, failed: 1 } };
  }
}

/** A usable season number only: `null`, `0`, and text never count as Season 0. */
export function readSeason(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 99 ? number : null;
}

export function detectUploadSeasonForFile(file) {
  const stored = Number(file?.season);
  if (Number.isInteger(stored) && stored >= 1) return stored;
  return detectUploadSeason({
    caption: file?.displayName || file?.sourceLabel,
    filename: file?.name
  }).season;
}

/**
 * The season a whole release belongs to, or null when the batch is ambiguous.
 * A mixed batch deliberately returns null: existing posts stay addressable by
 * their title key, while a freshly split upload always knows its own season.
 */
export function dominantReleaseSeason(files = [], { requireEveryFile = false } = {}) {
  const list = Array.isArray(files) ? files : [];
  const seasons = new Set();
  let marked = 0;
  for (const file of list) {
    const season = detectUploadSeasonForFile(file);
    if (!season) continue;
    marked += 1;
    seasons.add(season);
  }
  // One agreement is a season. A mixed or unreadable batch deliberately stays
  // null so an older catalog card can never be reinterpreted by accident.
  if (seasons.size !== 1) return null;
  // A single stray "S1" file must not rename a whole release: when the label is
  // being invented rather than handed over by the split planner, every file in
  // the group has to carry the same season marker.
  if (requireEveryFile && list.length > 0 && marked !== list.length) return null;
  return [...seasons][0];
}

/**
 * A catalog card must be readable at a glance, so a season release gets its
 * season in the title. An explicit publisher title that already names a season
 * is never rewritten unless `replace` is requested by the multi-season split.
 */
export function withSeasonLabel(value, season, { replace = false } = {}) {
  const title = cleanText(value, 180);
  const number = readSeason(season);
  if (!title || !number) return title;
  const label = formatSeasonLabel(number);
  if (!label) return title;
  if (!replace && /\b(?:season|s)\s*0*\d{1,2}\b/i.test(title)) return title;
  const cleaned = replace
    ? cleanText(
      title
        // Keep an attached episode marker such as S01E03 intact while removing
        // the standalone season package label.
        .replace(/\b(?:SEASON|S)\s*0*\d{1,2}\b(?!\s*[- ]?E(?:P(?:ISODE)?)?\s*\d{1,3})/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim(),
      180
    )
    : title;
  return cleanText(`${cleaned || title} ${label}`, 180);
}

/**
 * Group one upload batch by the release each file actually belongs to. Files
 * are keyed by their cleaned title so a range that holds `RRR`, `Robot 2`, and
 * 24 `Fullmetal Alchemist` episodes becomes three posts instead of one card
 * named after whichever file happened to come first. A file whose caption is
 * unusable follows the file above it, because uploaders send a release together.
 */
export function groupFilesByReleaseTitle(files = []) {
  const entries = (Array.isArray(files) ? files : []).map((file) => {
    const title = cleanText(inferBatchTitle([file]), 180);
    return { file, title, key: title ? slugify(title) : '' };
  });
  const groups = new Map();
  let previousKey = null;
  for (const entry of entries) {
    const key = entry.key || previousKey;
    if (!key) {
      groups.set(slugify(entry.title || 'untitled'), { title: entry.title, files: [entry.file] });
      previousKey = key;
      continue;
    }
    const current = groups.get(key) || { title: entry.title, files: [] };
    current.files.push(entry.file);
    groups.set(key, current);
    previousKey = key;
  }
  if (groups.size < 2) return [];
  return [...groups.values()]
    .filter((group) => group.title && group.files.length)
    .map((group) => ({
      title: group.title,
      category: inferBatchCategory({ title: group.title, files: group.files }),
      files: group.files
    }));
}

/**
 * Decide what one draft should become. Returns [] when the draft is already a
 * single coherent post, so nothing about the ordinary flow changes.
 */
export function planDraftPublicationGroups(session) {
  const files = Array.isArray(session?.files) ? session.files : [];
  if (files.length < 2) return [];
  const seasonGroups = groupFilesBySeason(files);
  const batchWithoutTitle = session?.workflow === 'batch' && !session?.batch?.titleProvided && !session?.batch?.categoryOverride;
  const releaseGroups = batchWithoutTitle ? groupFilesByReleaseTitle(files) : [];

  if (!releaseGroups.length) {
    if (seasonGroups.length < 2) return [];
    return seasonGroups.map((group) => ({
      title: withSeasonLabel(session.title, group.season, { replace: true }),
      category: session.category,
      season: group.season,
      files: group.files,
      reason: 'season'
    }));
  }

  const planned = [];
  for (const group of releaseGroups) {
    const groupSeasons = groupFilesBySeason(group.files);
    if (groupSeasons.length > 1) {
      for (const season of groupSeasons) {
        planned.push({
          title: withSeasonLabel(group.title, season.season, { replace: true }),
          category: group.category,
          season: season.season,
          files: season.files,
          reason: 'season'
        });
      }
      continue;
    }
    planned.push({
      title: withSeasonLabel(group.title, groupSeasons[0]?.season ?? null),
      category: group.category,
      season: groupSeasons[0]?.season ?? null,
      files: group.files,
      reason: 'release'
    });
  }
  return planned.length > 1 ? planned : [];
}

export async function publishDraft(ctx, bot, repository, config) {
  let session = await repository.findSession(chatId(ctx), userId(ctx));
  if (!session) {
    const error = 'There is no active draft. Start one from /panel first.';
    await ctx.reply(error);
    return { content: null, error };
  }
  if (!session.title) {
    const error = 'Please send a title before publishing.';
    await ctx.reply(error);
    return { content: null, error };
  }
  if (!session.files?.length) {
    const error = 'Add at least one document, video, audio file, animation, or image before using /done.';
    await ctx.reply(error);
    return { content: null, error };
  }
  if (isAdultCategory(session.category) && !hasDedicatedAdultStorage(config)) {
    const error = adultStorageConfigurationHint(config);
    await ctx.reply(error);
    return { content: null, error };
  }
  if (!config.telegram.botUsername) {
    const error = 'TELEGRAM_BOT_USERNAME is not configured on the server, so I cannot create a shareable delivery link yet.';
    await ctx.reply(error);
    return { content: null, error };
  }

  // MediaInfo is deliberately deferred until all manual or batch files have
  // arrived. It processes only ambiguous candidates sequentially, rather than
  // opening a download/process for every incoming Telegram upload.
  const mediaTrackWork = await inspectSessionMediaTracks({ session, bot, repository, config });
  session = mediaTrackWork.session || session;
  const inspectionNote = mediaTrackWork.inspection?.scanned
    ? ` I verified tracks for ${mediaTrackWork.inspection.scanned} eligible file${mediaTrackWork.inspection.scanned === 1 ? '' : 's'} before publication.`
    : '';
  await ctx.reply(`Preparing your draft for publication…${inspectionNote}`);

  // One draft can legitimately contain several posts: an untitled /batch range
  // usually holds different releases, and a mixed-season upload must never share
  // one card. Splitting first keeps every episode list, category, and quality
  // ladder coherent, and lets a later upload merge into the right post.
  const plan = planDraftPublicationGroups(session);
  if (plan.length > 1) {
    const summary = plan
      .map((group) => `${group.title} (${group.files.length} file${group.files.length === 1 ? '' : 's'})`)
      .join(', ');
    const seasonOnly = plan.every((group) => group.reason === 'season');
    await ctx.reply(seasonOnly
      ? `${plan.length} seasons were detected in this upload: ${summary}. Each season is published as its own catalog post so their episode lists never collide.`
      : `${plan.length} separate releases were detected in this upload: ${summary}. Each one becomes its own catalog post with its own category, episode list, and delivery link. Send /title before /done when you really want them combined.`);

    const published = [];
    for (const group of plan) {
      // Each post is a separate publishing event with its own announcement and
      // metadata lookup, so sequential work is intentional here.
      // eslint-disable-next-line no-await-in-loop
      const result = await publishDraftSession({
        ctx,
        bot,
        repository,
        config,
        session: { ...session, title: group.title, category: group.category, files: group.files, metadata: null },
        season: group.season,
        deleteSessionOnSuccess: false
      });
      published.push({ ...result, season: group.season, title: group.title, reason: group.reason });
    }
    await repository.deleteSession(chatId(ctx), userId(ctx));

    const succeeded = published.filter((entry) => entry.content);
    if (!succeeded.length) {
      const error = published.find((entry) => entry.error)?.error || 'Nothing could be published.';
      await ctx.reply(`Nothing was published. ${error}`);
      return { content: null, error, published, seasons: published };
    }
    const last = succeeded.at(-1).content;
    await ctx.reply([
      `Published ${succeeded.length} catalog post${succeeded.length === 1 ? '' : 's'} from this upload.`,
      '',
      ...published.map((entry) => (entry.content
        ? `\u2713 ${entry.content.title} \u00b7 ${entry.content.filesCount} file${entry.content.filesCount === 1 ? '' : 's'} \u00b7 Post ID ${entry.content.adminId}`
        : `\u2717 ${entry.title} \u2014 ${entry.error || 'not published'}`)),
      '',
      'Use /done again only if a post still needs its own files.'
    ].join('\n'), publicationKeyboard(getContentPageUrl(config, last), getTelegramDeliveryUrl(config, last.shareCode)));
    return {
      content: last,
      published,
      seasons: published,
      multiPost: true,
      multiSeason: seasonOnly,
      websiteUrl: getContentPageUrl(config, last),
      deliveryUrl: getTelegramDeliveryUrl(config, last.shareCode)
    };
  }

  return publishDraftSession({ ctx, bot, repository, config, session });
}

/**
 * Publish exactly one prepared draft. Manual uploads, /batch imports, storage
 * automation, and each split season group all share this path so identity,
 * poster mirroring, announcements, and replies stay identical everywhere.
 */
async function publishDraftSession({
  ctx,
  bot,
  repository,
  config,
  session,
  season = null,
  deleteSessionOnSuccess = true
}) {
  // A season release is keyed and titled by season. The split orchestrator hands
  // each group its own season; a plain upload is settled by
  // `dominantReleaseSeason`, which deliberately returns null for a movie or an
  // ambiguous batch so those keep their established merge behaviour.
  const isMovieRelease = session?.category === 'movie';
  const releaseSeason = readSeason(season) ?? (isMovieRelease ? null : dominantReleaseSeason(session?.files || [], { requireEveryFile: true }));

  const draftTitle = withSeasonLabel(session.title, releaseSeason);

  try {
    const metadata = session.metadata || (isAdultCategory(session.category)
      ? emptyPrivateCategoryMetadata(draftTitle)
      : await findMetadata(draftTitle, session.category, config));
    const mergeKeys = releaseMergeKeys(session, metadata, { season: releaseSeason });
    // This final guard applies to manual uploads, /batch imports, and storage
    // automation. A later upload for the same category/title or verified
    // provider identity extends the existing post instead of making a second
    // catalog card and second delivery link.
    if (mergeKeys.length && typeof repository.appendFilesToContentByMergeKey === 'function') {
      const existingMatch = await findContentByMergeKeys(repository, mergeKeys, session.category, { season: releaseSeason });
      if (existingMatch) {
        const content = await repository.appendFilesToContentByMergeKey(existingMatch.key, session.files, mergeKeys, session.category);
        if (!content) throw new Error('The existing same-title post could not be updated.');
        if (deleteSessionOnSuccess) await repository.deleteSession(chatId(ctx), userId(ctx));
        const websiteUrl = getContentPageUrl(config, content);
        const deliveryUrl = getTelegramDeliveryUrl(config, content.shareCode);
        // The channel post lists how many episodes/files a release carries, so
        // an append has to refresh it as well.
        const sync = await syncPublishedAnnouncements({ telegram: ctx.telegram, repository, content, config });
        await ctx.reply(
          [
            `Added ${session.files.length} new file${session.files.length === 1 ? '' : 's'} to the existing catalog post “${content.title}”. It now has ${content.filesCount} file${content.filesCount === 1 ? '' : 's'} and keeps Post ID ${content.adminId}.`,
            announcementSyncNote(sync)
          ].join('\n'),
          publicationKeyboard(websiteUrl, deliveryUrl)
        );
        return { content, metadata, merged: true, websiteUrl, deliveryUrl };
      }
    }
    await ctx.reply('Creating a new catalog post and mirroring its poster to ImgBB now…');
    const overrides = session.overrides || {};
    const episodeSummary = summarizeEpisodes(session.files);
    const uploadedLanguages = summarizeUploadLanguages(session.files);
    const uploadedSubtitleLanguages = summarizeSubtitleLanguages(session.files);
    const metadataLanguages = (metadata.languages || []).filter((language) => !/^multi(?:\s+language)?$/i.test(String(language || '')));
    const releaseLanguages = overrides.languages?.length ? overrides.languages : uploadedLanguages.length ? uploadedLanguages : metadataLanguages;
    const releaseSubtitleLanguages = overrides.subtitleLanguages?.length ? overrides.subtitleLanguages : uploadedSubtitleLanguages;
    const posterResult = await mirrorPosterToImgBB({
      sourceUrl: session.posterOriginalUrl || metadata.posterOriginalUrl,
      sourceIsManual: Boolean(session.posterOriginalUrl),
      title: withSeasonLabel(metadata.matched ? metadata.title : draftTitle, releaseSeason),
      category: session.category,
      config
    });

    // The provider's canonical name wins, but a season boundary is never lost:
    // AniList and TMDB return the same series title for every season.
    const title = withSeasonLabel(metadata.matched ? metadata.title : draftTitle, releaseSeason);
    const releaseLabel = overrides.releaseLabel || episodeSummary.releaseLabel || metadata.releaseLabel || `${session.files.length} files`;
    const content = await repository.createContent({
      title,
      category: session.category,
      year: overrides.year || metadata.year,
      // Explicit /lang settings win. Otherwise the file caption/filename is
      // the source of truth for release audio labels (e.g. Multi Hindi + Malayalam).
      languages: releaseLanguages,
      subtitleLanguages: releaseSubtitleLanguages,
      subtitleLanguageSource: overrides.subtitleLanguages?.length ? 'manual' : uploadedSubtitleLanguages.length ? 'upload' : null,
      languageSource: overrides.languages?.length ? 'manual' : uploadedLanguages.length ? 'upload' : 'metadata',
      genres: overrides.genres || metadata.genres || [],
      description: overrides.description || metadata.description || '',
      status: overrides.status || metadata.status || 'New release',
      releaseLabel,
      posterUrl: posterResult.url,
      backdropUrl: posterResult.url,
      poster: {
        provider: 'imgbb',
        providerId: posterResult.providerId,
        originalUrl: posterResult.originalUrl,
        source: posterResult.source,
        mirroredAt: new Date().toISOString()
      },
      metadataProvider: metadata.provider,
      tmdbId: metadata.tmdbId,
      // Store a verified provider identity for every publishing workflow, not
      // just automatic storage posts, so an authorized later upload can find
      // and extend this exact release without relying only on a loose title.
      metadataKey: metadata.metadataKey || null,
      art: { tone: categoryDetails(session.category).tone },
      // A persistent normalized source title plus internet-verified aliases
      // lets later manual, batch, or automatic uploads append without another
      // catalog card.
      automationKey: session.workflow === 'automation' ? session.auto?.groupKey : null,
      automationKeys: mergeKeys,
      files: session.files
    });
    if (deleteSessionOnSuccess) await repository.deleteSession(chatId(ctx), userId(ctx));

    const url = getTelegramDeliveryUrl(config, content.shareCode);
    const websiteUrl = getContentPageUrl(config, content);
    const privateAdultPost = isAdultCategory(content.category);
    let announcements = { sent: 0, failed: 0, skipped: 0, configured: false, suppressed: privateAdultPost };
    // Do not even resolve public announcement destinations for an 18+ post.
    // This keeps the isolated publishing path independent of public channels.
    if (!privateAdultPost) {
      try {
        const configuredChannels = await repository.listAnnouncementChannels();
        announcements = {
          ...(await announcePublishedContent({
            bot,
            repository,
            content,
            websiteUrl,
            storageChannelId: storageChannelForCategory(config, session.category)
          })),
          configured: configuredChannels.length > 0
        };
      } catch (error) {
        console.error('[telegram] announcement dispatch failed:', error?.message || 'Unknown error');
        announcements = { sent: 0, failed: 1, skipped: 0, configured: true };
      }
    }
    // Remember where the announcement landed so a later /poster, /title, /lang,
    // or a new file can edit that same channel message instead of leaving it stale.
    if (announcements.posts?.length && typeof repository.updateContentByAdminId === 'function') {
      try {
        const saved = await repository.updateContentByAdminId(content.adminId, { announcementRefs: announcements.posts });
        if (saved) {
          content.announcementRefs = saved.announcementRefs || announcements.posts;
          announcements.refs = content.announcementRefs;
        }
      } catch (error) {
        console.warn('[telegram] could not remember announcement message IDs for later edits:', error?.message || 'Unknown error');
      }
    }
    const posterNote = posterResult.source === 'generated-fallback'
      ? 'A permanent fallback poster was generated and mirrored to ImgBB.'
      : `The ${String(metadata.provider || 'matched').toUpperCase()} poster was mirrored to ImgBB.`;
    const episodeNote = episodeSummary.releaseLabel ? `Episode index: ${episodeSummary.releaseLabel}.` : 'No episode labels were found; the post lists delivery files instead.';
    const channelNote = privateAdultPost
      ? 'This 18+ post was not announced to any Telegram channel.'
      : announcements.sent
        ? `Posted to ${announcements.sent} announcement channel${announcements.sent === 1 ? '' : 's'}${announcements.failed ? ` (${announcements.failed} failed)` : ''}${announcements.skipped ? ' (database channel skipped)' : ''}.`
        : announcements.skipped
          ? 'The database channel was skipped for announcements to prevent an auto-publish loop. Add a separate announcement channel if you want release posts there.'
          : announcements.configured
            ? 'The catalog post is live, but the announcement channel delivery failed. Check that the bot is an admin in each configured channel.'
            : 'No announcement channels are configured yet. Add one with /addchannel <channel_id>.';
    const websiteNote = privateAdultPost
      ? (websiteUrl ? `Private 18+ catalog page: ${websiteUrl}` : 'PUBLIC_SITE_URL is not configured, so the age-confirmed catalog page cannot be shared yet.')
      : websiteUrl
        ? `Announcement website link: ${websiteUrl}`
        : 'PUBLIC_SITE_URL is not configured, so announcement posts were sent without a button. Add your Koyeb website URL and publish the next post.';

    await ctx.reply(
      [
        'Published successfully.',
        '',
        `${content.title} is now live with ${content.filesCount} file${content.filesCount === 1 ? '' : 's'}.`,
        `Post ID: ${content.adminId} — delete later with /delete ${content.adminId}`,
        episodeNote,
        posterNote,
        channelNote,
        websiteNote,
        '',
        websiteUrl ? 'Share this stable catalog page (recommended):' : 'Share this delivery link:',
        websiteUrl || url,
        websiteUrl ? 'It will always generate Telegram links for the active delivery bot.' : null
      ].filter((line) => line !== null).join('\n'),
      publicationKeyboard(websiteUrl, url)
    );
    return { content, metadata, posterResult, announcements, websiteUrl, deliveryUrl: url };
  } catch (error) {
    const message = error instanceof PosterHostingError
      ? error.message
      : 'Publishing could not be completed. Your draft is still safe; please try /done again.';
    console.error('[telegram] publish failed:', error?.name || 'Error', error?.message || 'Unknown error');
    await ctx.reply(`Could not publish this draft. ${message}`);
    return { content: null, error: message, cause: error };
  }
}

function isBotGeneratedStoragePost(message, bot, ignoredStorageMessageIds) {
  const messageId = String(message?.message_id || '');
  if (messageId && ignoredStorageMessageIds?.delete(messageId)) return true;
  if (message?.from?.is_bot) return true;
  return Boolean(bot?.botInfo?.id && String(message?.from?.id || '') === String(bot.botInfo.id));
}

export function automationGroupKey(title, storageMessageId) {
  const key = slugify(title);
  // inferBatchTitle normally prevents a generic file name from becoming a title.
  // Keep unidentified uploads isolated so unrelated files can never merge.
  return key && key !== 'untitled-release' ? key : `storage-media-${storageMessageId}`;
}

function standaloneReleaseMergeAlias(value) {
  const raw = cleanText(value, 180);
  // Series seasons and individual episodes must retain their own release key.
  // This deliberately covers compact upload names such as S01E01 too, not
  // only spaced "Season 1" or "Episode 1" labels.
  if (!raw || /\b(?:s(?:eason)?\s*\d{1,2}(?:\s*e(?:p(?:isode)?)?\s*\d{1,3})?|e(?:p(?:isode)?)?\s*\d{1,3}|\d{1,2}\s*x\s*\d{1,3})\b/i.test(raw)) return null;
  const inferred = inferBatchTitle([{ displayName: raw, name: '' }]);
  const key = slugify(cleanText(inferred, 180));
  return key && key !== 'untitled-release' ? key : null;
}

/**
 * Save both the upload-derived and provider-verified identities. A channel may
 * label the same show as "Raakh S01" on one day and "Raakh" on another; the
 * metadata identity is the durable bridge that prevents a second card.
 *
 * The same keys are also used for a later manual or /batch upload. Once a
 * publisher has created a post, sending more files for that same release
 * should extend its existing delivery page—not create a duplicate card.
 */
export function releaseMergeKeys(session, metadata = {}, { season = null } = {}) {
  const rawValues = [
    // Prefer the verified provider identity over a collision-prone upload name.
    metadata?.metadataKey,
    metadata?.title,
    session?.auto?.groupKey,
    session?.title
  ];
  const baseKeys = [...new Set([
    ...rawValues.map((value) => slugify(cleanText(value, 180))),
    // Preserve a title-only alias for noisy standalone movie/release labels
    // such as "RRR (2022) Hindi 1080p". This is deliberately not generated
    // for explicit season/episode labels.
    standaloneReleaseMergeAlias(metadata?.title),
    standaloneReleaseMergeAlias(session?.title)
  ].filter((key) => key && key !== 'untitled-release'))];

  // A season upload is looked up by its own season-scoped identity first, so
  // Season 2 of a show cannot be appended onto the Season 1 card merely
  // because both share one provider ID. The plain keys stay behind it so an
  // older single-card release still merges rather than duplicating.
  const number = Number(season);
  if (!Number.isInteger(number) || number < 1) return baseKeys;
  return [...new Set([...baseKeys.map((key) => `${key}-season-${number}`), ...baseKeys])];
}

// Kept as the public name used by existing automation tests/integrations.
export function automationMergeKeys(session, metadata = {}, options = {}) {
  return releaseMergeKeys(session, metadata, options);
}

async function findContentByMergeKeys(repository, keys, category = null, { season = null } = {}) {
  if (typeof repository?.findContentByMergeKey !== 'function') return null;
  const wantedSeason = readSeason(season);
  for (const key of keys) {
    const content = await repository.findContentByMergeKey(key, category);
    // A title such as "Avatar" can legitimately exist in multiple categories.
    // Do not append a movie upload to an anime or series card merely because a
    // loose title happened to match.
    if (!content || (category && content.category !== category)) continue;
    // A season-specific upload must not land on a card whose own files clearly
    // belong to another season. An older card with no readable season stays
    // mergeable, so an established catalog keeps receiving its next episodes.
    if (wantedSeason) {
      const contentSeason = dominantReleaseSeason(content.files || []);
      if (contentSeason && contentSeason !== wantedSeason) continue;
    }
    return { content, key };
  }
  return null;
}

async function findAutomationContentByKeys(repository, keys, category = null) {
  return findContentByMergeKeys(repository, keys, category);
}

function automationTiming(options = {}) {
  const idleMs = Number(options?.idleMs);
  const maxWaitMs = Number(options?.maxWaitMs);
  return {
    idleMs: Number.isFinite(idleMs) && idleMs >= 1_000 ? idleMs : AUTO_COLLECTION_IDLE_MS,
    maxWaitMs: Number.isFinite(maxWaitMs) && maxWaitMs >= 5_000 ? maxWaitMs : AUTO_COLLECTION_MAX_WAIT_MS
  };
}

function earlierAutomationDeadline(first, second) {
  return String(first) <= String(second) ? String(first) : String(second);
}

function automationReplyContext(session) {
  const label = cleanText(session?.title, 100) || session?.auto?.groupKey || 'storage group';
  return {
    chat: { id: session.chatId },
    from: { id: session.ownerId },
    // Never reply in the storage channel. publishDraft can retain its normal
    // success/error path while the worker sends a separate admin notification.
    reply: async (text) => {
      console.info(`[telegram] automation ${label}: ${cleanText(text, 360)}`);
    }
  };
}

function automationDiagnostic(error) {
  return cleanText(error?.description || error?.message || error || 'Unknown automation error', 300);
}

async function notifyAutomationPublisher(bot, settings, { state, content, session, websiteUrl, deliveryUrl, error }) {
  const destination = settings?.notifyChatId || settings?.updatedBy;
  if (!destination || !bot?.telegram?.sendMessage) return false;

  const fileCount = content?.filesCount || session?.files?.length || 0;
  const title = content?.title || session?.title || 'Untitled storage release';
  const message = state === 'published'
    ? [
      '✅ <b>Storage automation published</b>',
      '',
      `<b>${escapeHtml(title)}</b>`,
      `Files collected: ${fileCount}`,
      `Post ID: <code>${escapeHtml(content.adminId)}</code>`,
      `Delete if needed: <code>/delete ${escapeHtml(content.adminId)}</code>`,
      websiteUrl ? `Catalog page: ${escapeHtml(websiteUrl)}` : null
    ].filter(Boolean).join('\n')
    : state === 'merged'
      ? [
        '✅ <b>Storage automation updated an existing post</b>',
        '',
        `<b>${escapeHtml(title)}</b>`,
        `Added ${session?.files?.length || 0} collected file${session?.files?.length === 1 ? '' : 's'} · total ${fileCount}.`,
        `Post ID: <code>${escapeHtml(content.adminId)}</code>`,
        'No second announcement was sent.'
      ].join('\n')
      : [
        '⚠️ <b>Storage automation needs attention</b>',
        '',
        `<b>${escapeHtml(title)}</b>`,
        `Collected files: ${fileCount}`,
        `Reason: ${escapeHtml(error || 'Unknown automation error')}`,
        'The database channel was left clean. The retained group can be retried by uploading another matching file after fixing the issue.'
      ].join('\n');

  try {
    await bot.telegram.sendMessage(destination, message, {
      parse_mode: 'HTML',
      ...(state === 'published' ? publicationKeyboard(websiteUrl, deliveryUrl) : {})
    });
    return true;
  } catch (notificationError) {
    console.error('[telegram] could not notify the automation publisher:', automationDiagnostic(notificationError));
    return false;
  }
}

/**
 * Persist a direct-storage upload in a normalized release group. It deliberately
 * does not publish: the queue worker flushes after a quiet period, surviving
 * Koyeb restarts because its deadline and files live in MongoDB.
 */
export async function autoPublishStoragePost(ctx, bot, repository, config, ignoredStorageMessageIds, inFlightStorageMessageIds, options = {}) {
  const message = ctx.channelPost || ctx.update?.channel_post;
  if (!message || String(message.chat?.id) !== String(config.telegram.storageChannelId || '')) return { queued: false, reason: 'not-storage-media' };
  if (!isMediaMessage(message)) return { queued: false, reason: 'not-supported-media' };
  if (isBotGeneratedStoragePost(message, bot, ignoredStorageMessageIds)) return { queued: false, reason: 'bot-generated' };

  const storageMessageId = message.message_id;
  const inFlightKey = String(storageMessageId);
  if (inFlightStorageMessageIds?.has(inFlightKey)) return { queued: false, reason: 'already-processing' };

  const settings = await repository.getAutoPublishSettings();
  if (!settings?.enabled) return { queued: false, reason: 'disabled' };

  const enabledAt = Date.parse(settings.enabledAt || '');
  const messageTimestamp = Number(message.date) * 1000;
  if (Number.isFinite(enabledAt) && Number.isFinite(messageTimestamp) && messageTimestamp < enabledAt - 5_000) {
    console.info(`[telegram] ignored storage message ${storageMessageId}; it predates the current auto-publish activation.`);
    return { queued: false, reason: 'predates-enable' };
  }

  const pendingDraft = await repository.findSessionByStorageMessageId(
    storageMessageId,
    config.telegram.storageChannelId,
    { includeLegacy: true }
  );
  if (pendingDraft) {
    console.info(`[telegram] ignored storage message ${storageMessageId}; it is already attached to an active ${pendingDraft.workflow || 'upload'} draft.`);
    return { queued: false, reason: 'active-draft' };
  }

  const existing = await repository.findContentByStorageMessageId(
    storageMessageId,
    config.telegram.storageChannelId,
    { includeLegacy: true }
  );
  if (existing) {
    console.info(`[telegram] ignored already-published auto storage message ${storageMessageId} (${existing.adminId || existing.title || 'existing post'}).`);
    return { queued: false, reason: 'already-published' };
  }

  inFlightStorageMessageIds?.add(inFlightKey);
  try {
    if (typeof repository.queueAutomationSession !== 'function') {
      throw new Error('The catalog repository does not support persistent automation groups.');
    }
    const file = fileFromMessage(message, storageMessageId, 'direct-storage', config.telegram.storageChannelId);
    await scrubExistingStorageCaption(ctx, config.telegram.storageChannelId, storageMessageId, message);
    const title = inferBatchTitle([file]) || `Storage media ${storageMessageId}`;
    const category = inferBatchCategory({ title, files: [file] });
    const groupKey = automationGroupKey(title, storageMessageId);
    const timing = automationTiming(typeof options === 'function' ? {} : options);
    const receivedAt = new Date().toISOString();
    const primaryOwnerId = `${AUTO_PUBLISH_OWNER_PREFIX}${groupKey}`;
    const primarySession = await repository.findSession(message.chat.id, primaryOwnerId);
    const isPublishing = primarySession?.workflow === 'automation' && primarySession.auto?.status === 'publishing';
    const ownerId = isPublishing
      ? `${AUTO_PUBLISH_LATE_OWNER_PREFIX}${groupKey}-${storageMessageId}`
      : primaryOwnerId;
    const activeSession = isPublishing ? null : primarySession;
    const restartingFailedGroup = activeSession?.auto?.status === 'failed';
    const firstReceivedAt = restartingFailedGroup
      ? receivedAt
      : activeSession?.auto?.firstReceivedAt || receivedAt;
    const maxWaitAt = restartingFailedGroup
      ? new Date(Date.parse(receivedAt) + timing.maxWaitMs).toISOString()
      : activeSession?.auto?.maxWaitAt || new Date(Date.parse(firstReceivedAt) + timing.maxWaitMs).toISOString();
    const quietDeadline = new Date(Date.parse(receivedAt) + timing.idleMs).toISOString();
    const scheduledAt = earlierAutomationDeadline(quietDeadline, maxWaitAt);

    let queued = await repository.queueAutomationSession({
      chatId: message.chat.id,
      ownerId,
      category: activeSession?.category || category,
      title: activeSession?.title || title,
      file,
      groupKey,
      scheduledAt,
      maxWaitAt,
      firstReceivedAt,
      receivedAt
    });

    // In the tiny race between findSession and the atomic queue update, a worker
    // may claim the primary group. Preserve the upload in a late group instead
    // of mutating/deleting a snapshot that is being published.
    if (queued?.auto?.status === 'publishing' && ownerId === primaryOwnerId) {
      const lateOwnerId = `${AUTO_PUBLISH_LATE_OWNER_PREFIX}${groupKey}-${storageMessageId}`;
      const lateMaxWaitAt = new Date(Date.parse(receivedAt) + timing.maxWaitMs).toISOString();
      queued = await repository.queueAutomationSession({
        chatId: message.chat.id,
        ownerId: lateOwnerId,
        category,
        title,
        file,
        groupKey,
        scheduledAt: earlierAutomationDeadline(quietDeadline, lateMaxWaitAt),
        maxWaitAt: lateMaxWaitAt,
        firstReceivedAt: receivedAt,
        receivedAt
      });
    }
    if (!queued?.files?.length) throw new Error('The persistent automation group could not retain the storage file.');

    console.info(`[telegram] queued storage message ${storageMessageId} in ${groupKey} (${queued.files.length} file${queued.files.length === 1 ? '' : 's'}; flush ${queued.auto?.scheduledAt || 'pending'}).`);
    return { queued: true, groupKey, ownerId: queued.ownerId || ownerId, session: queued };
  } catch (error) {
    console.error('[telegram] auto-publish queue failed:', storageMessageId, automationDiagnostic(error));
    // The global channel handler and bot.catch also suppress replies here; the
    // storage database should never receive a generic error message.
    return { queued: false, reason: 'queue-error', error: automationDiagnostic(error) };
  } finally {
    inFlightStorageMessageIds?.delete(inFlightKey);
  }
}

/** Flush due persistent auto-upload groups. Exported for deterministic tests. */
export async function processQueuedAutomationSessions({ bot, repository, config, publish = publishDraft, now = new Date().toISOString(), limit = 20 } = {}) {
  const settings = await repository.getAutoPublishSettings();
  if (!settings?.enabled || typeof repository.listDueAutomationSessions !== 'function') return [];

  const dueSessions = await repository.listDueAutomationSessions({ limit, now });
  const results = [];
  for (const dueSession of dueSessions) {
    let session;
    try {
      session = await repository.claimAutomationSession(dueSession.chatId, dueSession.ownerId, { now });
    } catch (error) {
      console.error('[telegram] could not claim automation group:', dueSession.ownerId, automationDiagnostic(error));
      continue;
    }
    if (!session?.files?.length) continue;

    const groupKey = session.auto?.groupKey || automationGroupKey(session.title, session.files[0]?.storageMessageId || session.ownerId);
    try {
      // Just like manual and /batch publishing, do this after the group has
      // fully collected and before any merge/create decision is persisted.
      const mediaTrackWork = await inspectSessionMediaTracks({ session, bot, repository, config });
      session = mediaTrackWork.session || session;
      // Resolve a canonical provider identity before looking for an existing
      // release. This makes aliases/noisy filenames converge instead of
      // producing a fresh post just because their raw group keys differ.
      const metadata = session.metadata || (await findMetadata(session.title, session.category, config));
      const automationKeys = automationMergeKeys(session, metadata);
      const existingMatch = await findAutomationContentByKeys(repository, automationKeys.length ? automationKeys : [groupKey], session.category);
      if (existingMatch) {
        const content = await repository.appendFilesToContentByMergeKey(existingMatch.key, session.files, automationKeys, session.category);
        if (!content) throw new Error('The existing same-title post could not be updated.');
        await repository.deleteSession(session.chatId, session.ownerId);
        const websiteUrl = getContentPageUrl(config, content);
        const deliveryUrl = getTelegramDeliveryUrl(config, content.shareCode);
        await notifyAutomationPublisher(bot, settings, {
          state: 'merged',
          content,
          session,
          websiteUrl,
          deliveryUrl
        });
        console.info(`[telegram] merged ${session.files.length} auto file(s) into ${content.adminId || content.title}.`);
        results.push({ state: 'merged', content, session });
        continue;
      }

      // Store the preflight result so publishDraft uses the same verified
      // canonical title/poster rather than performing a potentially different
      // provider search a moment later.
      session = await repository.updateSession(session.chatId, session.ownerId, { metadata }) || { ...session, metadata };
      console.info(`[telegram] publishing queued storage group ${groupKey} as ${session.category}: ${session.title} (${session.files.length} file(s)).`);
      const result = await publish(automationReplyContext(session), bot, repository, config);
      if (!result?.content) {
        // publishDraft keeps manual-chat wording friendly, but the authorized
        // publisher needs the concrete underlying failure in the private
        // automation report (for example an ImgBB or MongoDB configuration error).
        throw result?.cause instanceof Error
          ? result.cause
          : new Error(result?.error || 'The automation publisher returned no catalog post.');
      }
      // publishDraft deletes its own session; custom publishers in tests and
      // future workers may not, so make the successful cleanup idempotent.
      await repository.deleteSession(session.chatId, session.ownerId);
      const state = result.merged ? 'merged' : 'published';
      await notifyAutomationPublisher(bot, settings, {
        state,
        content: result.content,
        session,
        websiteUrl: result.websiteUrl || getContentPageUrl(config, result.content),
        deliveryUrl: result.deliveryUrl || getTelegramDeliveryUrl(config, result.content.shareCode)
      });
      results.push({ state, content: result.content, session });
    } catch (error) {
      const diagnostic = automationDiagnostic(error);
      console.error('[telegram] queued auto-publish failed:', session.ownerId, diagnostic);
      try {
        await repository.markAutomationSessionFailed(session.chatId, session.ownerId, { error: diagnostic });
      } catch (saveError) {
        console.error('[telegram] could not save automation failure state:', automationDiagnostic(saveError));
      }
      await notifyAutomationPublisher(bot, settings, { state: 'failed', session, error: diagnostic });
      results.push({ state: 'failed', error: diagnostic, session });
    }
  }
  return results;
}

export async function deliverContent(ctx, delivery, repository, config, { scheduleDeletion = scheduleDeliveredFileDeletion } = {}) {
  if (!delivery?.shareCode || delivery.shareCode.length > 48) {
    await ctx.reply('That delivery link is invalid.');
    return;
  }

  const content = await repository.findContentByShareCode(delivery.shareCode);
  if (!content) {
    await ctx.reply('This release is unavailable or the link has expired.');
    return;
  }
  const defaultStorageChannelId = storageChannelForCategory(config, content.category);
  if (!defaultStorageChannelId || (isAdultCategory(content.category) && !hasDedicatedAdultStorage(config))) {
    await ctx.reply(isAdultCategory(content.category)
      ? '18+ file delivery is being configured with its separate private storage. Please try again later.'
      : 'File delivery is being configured. Please try again later.');
    return;
  }
  if (!content.files?.length) {
    await ctx.reply('This release does not have any delivery files yet.');
    return;
  }

  const files = delivery.filePosition
    ? [content.files[delivery.filePosition - 1]].filter(Boolean)
    : content.files;
  if (!files.length) {
    await ctx.reply('That file choice is no longer available for this release. Return to the website and choose another option.');
    return;
  }

  await ctx.reply(
    delivery.filePosition
      ? `Preparing your selected file for “${content.title}”…`
      : `Preparing ${files.length} item${files.length === 1 ? '' : 's'} for “${content.title}”…`
  );
  let delivered = 0;
  let cleanupScheduled = 0;
  for (const file of files) {
    try {
      // New records retain their source channel; old normal records fall back
      // to TELEGRAM_STORAGE_CHANNEL_ID for backwards-compatible delivery.
      const sourceChannelId = isAdultCategory(content.category)
        ? defaultStorageChannelId
        : cleanText(file?.storageChannelId, 80) || defaultStorageChannelId;
      const copied = await ctx.telegram.copyMessage(chatId(ctx), sourceChannelId, file.storageMessageId);
      delivered += 1;
      try {
        if (scheduleDeletion({
          telegram: ctx.telegram,
          recipientChatId: chatId(ctx),
          messageId: copied?.message_id,
          deleteAfterMs: DELIVERY_FILE_DELETE_AFTER_MS
        })) cleanupScheduled += 1;
      } catch (cleanupError) {
        // Delivery succeeded; a local scheduling problem must not be reported
        // as though Telegram failed to copy the file.
        console.warn('[telegram] could not schedule delivery cleanup:', cleanupError?.message || 'Unknown error');
      }
    } catch (error) {
      console.error('[telegram] delivery copy failed:', error?.description || error?.message || 'Unknown error');
    }
  }

  if (delivered) {
    await repository.incrementDelivery(delivery.shareCode);
    const cleanupNote = cleanupScheduled
      ? ` The bot will remove ${cleanupScheduled === 1 ? 'this delivered file' : `${cleanupScheduled} delivered files`} from this chat in about 5 minutes.`
      : '';
    await ctx.reply(
      delivery.filePosition
        ? `Your selected file has been delivered. Enjoy responsibly.${cleanupNote}`
        : `Delivered ${delivered} of ${files.length} item${files.length === 1 ? '' : 's'}. Enjoy responsibly.${cleanupNote}`
    );
  } else {
    await ctx.reply('I could not retrieve these files from the storage channel. Please let the catalog administrator know.');
  }
}

async function logRequestToChannel(ctx, request, config) {
  const channelId = config.telegram.requestChannelId || config.telegram.storageChannelId;
  if (!channelId) return false;
  const requester = request.requester?.username
    ? `@${escapeHtml(request.requester.username)}`
    : escapeHtml(request.requester?.name || 'Telegram user');
  const caption = [
    '📨 <b>NEW CATALOG REQUEST</b>',
    '',
    `<b>Request:</b> ${escapeHtml(request.requestText)}`,
    `<b>Request ID:</b> ${escapeHtml(request.id)}`,
    `<b>From:</b> ${requester}`,
    `<b>User ID:</b> <code>${escapeHtml(request.requester?.id)}</code>`,
    '',
    'Use this private channel entry to review or fulfill the request.'
  ].join('\n');
  try {
    await ctx.telegram.sendMessage(channelId, caption, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    console.error('[telegram] request channel log failed:', error?.description || error?.message || 'Unknown error');
    return false;
  }
}

const REQUEST_SELECTION_PAGE_SIZE = 8;
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function requestManagerKeyboard() {
  // Keep the entry screen intentionally simple: publishers first choose to
  // select open requests or leave the management workflow.
  return Markup.inlineKeyboard([[
    Markup.button.callback('Select requests', 'requests:select'),
    Markup.button.callback('Back', 'requests:back')
  ]]);
}

function requesterLabel(request) {
  return request?.requester?.username
    ? `@${request.requester.username}`
    : cleanText(request?.requester?.name || '', 60) || 'Telegram user';
}

function requestManagerText(openRequestCount = 0) {
  return [
    'Request management',
    '',
    openRequestCount
      ? `${openRequestCount} open request${openRequestCount === 1 ? '' : 's'} ready for review.`
      : 'There are no open catalog requests right now.',
    'Choose Select requests to mark one or several requests Completed or Rejected.'
  ].join('\n');
}

async function replaceInteractiveMessage(ctx, text, keyboard) {
  if (ctx.callbackQuery?.message && typeof ctx.editMessageText === 'function') {
    try {
      return await ctx.editMessageText(text, keyboard);
    } catch (error) {
      const details = telegramErrorText(error);
      if (/message is not modified/.test(details)) return null;
      console.warn('[telegram] could not update interactive publisher view:', automationDiagnostic(error));
    }
  }
  return ctx.reply(text, keyboard);
}

function requestSelectionText(requests, selectedIds, page, totalPages) {
  const start = page * REQUEST_SELECTION_PAGE_SIZE;
  const visible = requests.slice(start, start + REQUEST_SELECTION_PAGE_SIZE);
  return [
    'Select open requests',
    '',
    `${selectedIds.size} selected · showing ${visible.length ? `${start + 1}–${start + visible.length}` : '0'} of ${requests.length} open request${requests.length === 1 ? '' : 's'} · page ${page + 1}/${totalPages}.`,
    '',
    ...visible.map((request, index) => {
      const selected = selectedIds.has(request.id) ? '☑' : '☐';
      return `${selected} ${start + index + 1}. ${cleanText(request.requestText, 180)}\n   ${request.id} · ${requesterLabel(request)}`;
    }),
    '',
    'Tap requests to toggle them, then choose Completed or Rejected. Statuses update immediately.'
  ].join('\n');
}

function requestSelectionKeyboard(requests, selectedIds, page, totalPages) {
  const start = page * REQUEST_SELECTION_PAGE_SIZE;
  const visible = requests.slice(start, start + REQUEST_SELECTION_PAGE_SIZE);
  const rows = visible.map((request) => [Markup.button.callback(
    `${selectedIds.has(request.id) ? '☑' : '☐'} ${request.id} · ${cleanText(request.requestText, 28)}`,
    `requests:toggle:${request.id}:${page}`
  )]);
  if (totalPages > 1) {
    const navigation = [];
    if (page > 0) navigation.push(Markup.button.callback('‹ Previous', `requests:page:${page - 1}`));
    if (page < totalPages - 1) navigation.push(Markup.button.callback('Next ›', `requests:page:${page + 1}`));
    if (navigation.length) rows.push(navigation);
  }
  rows.push([
    Markup.button.callback(`Completed (${selectedIds.size})`, 'requests:resolve:completed'),
    Markup.button.callback(`Rejected (${selectedIds.size})`, 'requests:resolve:rejected')
  ]);
  rows.push([Markup.button.callback('Back', 'requests:back')]);
  return Markup.inlineKeyboard(rows);
}

async function renderRequestSelection(ctx, repository, page = 0) {
  const requests = await repository.listRequests({ status: 'open', limit: 200 });
  const selection = await repository.findRequestSelection(chatId(ctx), userId(ctx));
  if (!selection) {
    return replaceInteractiveMessage(ctx, 'Your request selection expired. Start it again when you are ready.', requestManagerKeyboard());
  }
  if (!requests.length) {
    await repository.deleteRequestSelection(chatId(ctx), userId(ctx));
    return replaceInteractiveMessage(ctx, requestManagerText(0), requestManagerKeyboard());
  }
  const openIds = new Set(requests.map((request) => request.id));
  const selectedIds = new Set((selection.requestIds || []).filter((requestId) => openIds.has(requestId)));
  const totalPages = Math.max(1, Math.ceil(requests.length / REQUEST_SELECTION_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  return replaceInteractiveMessage(
    ctx,
    requestSelectionText(requests, selectedIds, safePage, totalPages),
    requestSelectionKeyboard(requests, selectedIds, safePage, totalPages)
  );
}

export function requestResolutionNotificationText(request, status) {
  return status === 'completed'
    ? `✅ Your catalog request “${cleanText(request?.requestText, 180)}” has been completed. Please kindly check the site.`
    : `⚠️ Your catalog request “${cleanText(request?.requestText, 180)}” was rejected due to issues.`;
}

async function notifyResolvedRequesters(bot, requests, status) {
  let notified = 0;
  let failed = 0;
  for (const request of requests) {
    const destination = String(request?.requester?.id || '');
    if (!destination) {
      failed += 1;
      continue;
    }
    const text = requestResolutionNotificationText(request, status);
    try {
      await bot.telegram.sendMessage(destination, text);
      notified += 1;
    } catch (error) {
      failed += 1;
      console.warn('[telegram] could not notify request user:', destination, automationDiagnostic(error));
    }
  }
  return { notified, failed };
}

function indiaDayStart(value = new Date(), daysAgo = 0) {
  const instant = value instanceof Date ? value : new Date(value);
  const shifted = new Date(instant.getTime() + INDIA_OFFSET_MS);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysAgo
  ) - INDIA_OFFSET_MS);
}

export function postIdTimeWindow(period, now = new Date()) {
  const today = indiaDayStart(now);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  if (period === 'today') return { label: 'Today (IST)', startAt: today, endAt: tomorrow };
  if (period === 'yesterday') return { label: 'Yesterday (IST)', startAt: indiaDayStart(now, 1), endAt: today };
  if (period === 'week') return { label: 'Last 7 days (IST)', startAt: indiaDayStart(now, 6), endAt: tomorrow };
  if (period === 'month') return { label: 'Last 30 days (IST)', startAt: indiaDayStart(now, 29), endAt: tomorrow };
  return null;
}

export function postIdKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Today', 'postid:today'), Markup.button.callback('Yesterday', 'postid:yesterday')],
    [Markup.button.callback('Week', 'postid:week'), Markup.button.callback('Month', 'postid:month')],
    [Markup.button.callback('Back', 'postid:back')]
  ]);
}

function formatPostIdResults(window, posts) {
  if (!posts.length) return `No uploaded post IDs were found for ${window.label}.`;
  return [
    `Uploaded post IDs · ${window.label} (${posts.length}${posts.length === 100 ? '+' : ''})`,
    '',
    ...posts.map((post, index) => `${index + 1}. ${post.adminId} · ${cleanText(post.title, 130)} — ${categoryDetails(post.category).shortLabel}`),
    '',
    'Copy an ID into /delete if you need to remove a post.'
  ].join('\n');
}

function formatAnalyticsTime(value) {
  if (!value) return 'No activity recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No activity recorded';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  }).format(date);
}

function formatPublisherStats(stats) {
  const categories = Object.entries(stats.catalog?.byCategory || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([category, count]) => `${categoryDetails(category).shortLabel}: ${count}`)
    .join(' · ') || 'No posts yet';
  return [
    'Publisher statistics',
    '',
    'Anonymous site activity',
    `Visitors: ${stats.site?.visitors || 0} unique · Visits: ${stats.site?.visits || 0}`,
    `Active: ${stats.site?.activeVisitors24h || 0} visitors / ${stats.site?.visits24h || 0} visits (24h) · ${stats.site?.activeVisitors7d || 0} visitors / ${stats.site?.visits7d || 0} visits (7d)`,
    `Last site activity: ${formatAnalyticsTime(stats.site?.latestActivityAt)}`,
    '',
    'Private bot activity',
    `Bot users: ${stats.bot?.users || 0} · Interactions: ${stats.bot?.interactions || 0}`,
    `Active bot users: ${stats.bot?.activeUsers24h || 0} (24h) · ${stats.bot?.activeUsers7d || 0} (7d)`,
    `Last bot activity: ${formatAnalyticsTime(stats.bot?.latestActivityAt)}`,
    '',
    'Catalog',
    `Posts: ${stats.catalog?.posts || 0} · Files: ${stats.catalog?.files || 0} · Episodes: ${stats.catalog?.episodes || 0} · Telegram deliveries: ${stats.catalog?.deliveries || 0}`,
    categories,
    '',
    'Requests',
    `Total: ${stats.requests?.total || 0} · Open: ${stats.requests?.open || 0} · Completed: ${stats.requests?.completed || 0} · Rejected: ${stats.requests?.rejected || 0}`
  ].join('\n');
}

function backupOptionsFromConfig(config) {
  return config?.backup || {};
}

function backupCreatedAt(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function formatBackupCounts(counts = {}) {
  const content = Number(counts.content || 0);
  const sessions = Number(counts.upload_sessions || 0);
  const requests = Number(counts.requests || 0);
  const visitors = Number(counts.site_visitors || 0);
  return `${content} post${content === 1 ? '' : 's'} · ${sessions} upload session${sessions === 1 ? '' : 's'} · ${requests} request${requests === 1 ? '' : 's'} · ${visitors} anonymous visitor record${visitors === 1 ? '' : 's'}`;
}

export async function sendStorageBackup({ repository, telegram, config, createdAt = new Date().toISOString() } = {}) {
  return createAndSendBackup({
    repository,
    telegram,
    storageChannelId: config?.telegram?.storageChannelId,
    signingSecret: config?.backup?.signingSecret,
    options: backupOptionsFromConfig(config),
    createdAt
  });
}

/** Run once per India calendar month, with a durable repository claim. */
export async function runMonthlyBackup({ bot, repository, config, now = new Date() } = {}) {
  if (!config?.backup?.monthlyEnabled || !config?.telegram?.storageChannelId) {
    return { sent: false, reason: 'disabled-or-no-storage-channel' };
  }
  if (!config?.backup?.signingSecret) return { sent: false, reason: 'no-signing-secret' };
  if (typeof repository?.claimMonthlyBackup !== 'function') {
    return { sent: false, reason: 'repository-does-not-support-monthly-backups' };
  }
  const createdAt = backupCreatedAt(now);
  const month = indiaMonthKey(createdAt);
  if (!month) return { sent: false, reason: 'invalid-date' };
  const claimed = await repository.claimMonthlyBackup({ month, now: createdAt });
  if (!claimed) return { sent: false, reason: 'already-sent-or-claimed', month };
  try {
    const backup = await sendStorageBackup({ repository, telegram: bot?.telegram, config, createdAt });
    if (typeof repository.markMonthlyBackupCreated === 'function') {
      await repository.markMonthlyBackupCreated({ month, createdAt });
    }
    return { sent: true, month, backup };
  } catch (error) {
    if (typeof repository.releaseMonthlyBackupClaim === 'function') {
      await repository.releaseMonthlyBackupClaim({ month }).catch(() => {});
    }
    throw error;
  }
}

function streamingOptionsFromConfig(config) {
  return { allowedHosts: config?.streaming?.allowedHosts || [] };
}

function streamingDownloadOptionsFromConfig(config) {
  const maxBytes = Number(config?.streaming?.manifestMaxBytes) || 512 * 1024;
  return {
    maxBytes,
    // This importer reads plain JSON/CSV only, but the shared Telegram download
    // helper has an uncompressed bound as well. Keep both bounds tiny so a
    // malformed document cannot consume a free Koyeb instance.
    maxUncompressedBytes: maxBytes,
    timeoutMs: Number(config?.streaming?.downloadTimeoutMs) || 15_000
  };
}

function episodePathRange(episode) {
  const start = Number(episode?.start);
  const end = Number(episode?.end ?? episode?.start);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) return null;
  return start === end ? String(start) : `${start}-${end}`;
}

function directEpisodeLabel(start, end) {
  return start === end
    ? `Episode ${String(start).padStart(2, '0')}`
    : `Episodes ${String(start).padStart(2, '0')}–${String(end).padStart(2, '0')}`;
}

/**
 * Accept one clearly scoped player link without making publishers build a
 * manifest. Bare URLs remain intentional release-level players; adding
 * `ep`/`episode` (or a leading number) ties the link to that delivery episode.
 */
/**
 * Split one message into separate player links. A publisher commonly pastes a
 * list ("ep 2 url1 url2" or one link per line, sometimes as Markdown links), and
 * each pasted link is a player the publisher wants to keep.
 */
export function splitPlayerLinks(value, { allowedHosts = [] } = {}) {
  const candidates = cleanText(value, 4_000)
    .split(/\r?\n|\s{2,}|[,;]+|\s+(?=https?:\/\/|\[|<iframe)/i)
    .map((entry) => entry.replace(/^\s*(?:[-*•]\s*|\d{1,3}[.)]\s*)/, '').trim())
    .filter(Boolean);
  const urls = [];
  const rejected = [];
  for (const candidate of candidates) {
    if (!/https?:\/\//i.test(candidate) && !/iframe/i.test(candidate)) continue;
    const link = safeStreamingLink(candidate, { allowedHosts });
    if (link?.embedUrl || link?.watchUrl) {
      urls.push(link);
      continue;
    }
    rejected.push(extractStreamingUrl(candidate).slice(0, 80) || cleanText(candidate, 80));
  }
  return { urls, rejected };
}

/**
 * Parse the removal grammar of /cmd: `del 3`, `del 2, 4`, `del ep 5`,
 * `del ep 2-7`, or `del all`. Episode ranges remove every player of those
 * episodes at once, which is how a wrong bulk import is undone.
 */
export function parseStreamRemoval(value) {
  const text = cleanText(value, 120).replace(/^#/, '').trim();
  if (!text) return { error: 'Say what to remove: /cmd SB-0123ABCDEF del 3, del ep 5, del ep 2-7, or del all.' };
  if (/^(?:all|everything|every|everythang|the whole list)$/i.test(text)) return { mode: 'all' };
  const episode = text.match(/^(?:ep|episode|eps)\.?\s*(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?$/i);
  if (episode) {
    const start = Number(episode[1]);
    const end = Number(episode[2] || episode[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) {
      return { error: 'Episode numbers must be between 1 and 999, with the end no earlier than the start.' };
    }
    return { mode: 'episode', episode: { start, end, label: directEpisodeLabel(start, end) } };
  }
  if (/^(?:ep|episode|eps)\b/i.test(text)) return { error: 'Use a range such as del ep 5 or del ep 2-7.' };
  const indexes = [...text.matchAll(/\d{1,4}/g)].map((match) => Number(match[0])).filter((number) => number >= 1);
  if (!indexes.length) return { error: 'Say which player number to remove, for example /cmd SB-0123ABCDEF del 3.' };
  return { mode: 'index', indexes: [...new Set(indexes)] };
}

/**
 * One manual player paste can name the episode in front of every link:
 *
 *   Ep 176 https://www.dailymotion.com/embed/video/one
 *   Ep 177 https://www.dailymotion.com/embed/video/two
 *
 * Lines without their own label continue the episode above them, so several
 * sources for one episode are still pasted as plain lines, and labels packed onto
 * a single line are read as separate episodes too — otherwise every link after
 * the first label would land on that one episode and the rest stay empty.
 */
export function manualPlayerGroups(value) {
  const groups = [];
  let current = null;
  for (const line of String(value || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/\s+(?=(?:ep|eps|episode|e)\.?\s*0*\d{1,3}\b)/i)) {
      const labeled = part.match(/^(?:ep|eps|episode|e)\.?\s*0*(\d{1,3})(?:\s*(?:-|\u2013|to)\s*0*(\d{1,3}))?\b[:\-]?\s*([\s\S]*)$/i);
      if (labeled) {
        const start = Number(labeled[1]);
        const end = Number(labeled[2] || labeled[1]);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) {
          if (current) {
            current.text = `${current.text}\n${part}`.trim();
            continue;
          }
          return { error: 'Episode numbers must be between 1 and 999, with the end no earlier than the start.' };
        }
        current = { episode: { start, end, label: directEpisodeLabel(start, end) }, text: String(labeled[3] || '').trim() };
        groups.push(current);
        continue;
      }
      if (!current) {
        current = { episode: null, text: '' };
        groups.push(current);
      }
      current.text = `${current.text}\n${part}`.trim();
    }
  }
  return { groups: groups.filter((group) => group.text) };
}

/**
 * Turn one manual player paste into manifest rows, honouring an episode label in
 * front of every link. `/cmd SB-… <links>` and a follow-up message in an armed
 * import chat go through this, so the same paste behaves the same way in both.
 */
export function buildManualPlayerManifest(targetAdminId, value, config) {
  const directInput = parseDirectStreamingInput(value);
  if (directInput.error) return { error: directInput.error };
  // A removal instruction is never a link list; the caller handles it separately.
  if (directInput.action === 'delete') {
    return { delete: directInput.delete, manifest: { entries: [], rejected: [] }, links: 0, rejected: [], episodes: [] };
  }
  const manual = manualPlayerGroups(value);
  if (manual.error) return { error: manual.error };
  const options = streamingOptionsFromConfig(config);
  const groups = manual.groups.length
    ? manual.groups
    : [{ episode: directInput.episode, text: directInput.playerValue }];
  const entries = [];
  const rejected = [];
  for (const group of groups) {
    const found = splitPlayerLinks(group.text, options);
    rejected.push(...found.rejected);
    entries.push(...directStreamingManifest(targetAdminId, found.urls, group.episode).entries);
  }
  entries.forEach((entry, index) => { entry.row = index + 1; });
  return {
    manifest: { entries, rejected },
    links: entries.length,
    rejected,
    episodes: [...new Set(entries.map((entry) => entry.entry?.episode?.label).filter(Boolean))]
  };
}

function episodeCoverageNote(episodes, groupCount) {
  if (!episodes.length || (groupCount <= 1 && episodes.length === 1)) return '';
  return `\nEpisodes covered: ${episodes.slice(0, 12).join(', ')}${episodes.length > 12 ? ` … (+${episodes.length - 12} more)` : ''}`;
}

export function parseDirectStreamingInput(value) {
  const supplied = cleanText(value, 4_000);
  const removal = supplied.match(/^(?:del|delete|remove|unlink)\b[\s:]*([\s\S]*)$/i);
  if (removal) {
    const deletePlan = parseStreamRemoval(removal[1]);
    return { playerValue: '', urls: [], episode: null, action: 'delete', delete: deletePlan, error: deletePlan.error || null };
  }
  const match = supplied.match(/^(?:(?:episode|ep)\.?\s*)?(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\s+([\s\S]+)$/i);
  if (!match) return { playerValue: supplied, urls: [], episode: null, action: 'add', delete: null, error: null };
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) {
    return { playerValue: '', urls: [], episode: null, action: 'add', delete: null, error: 'Episode numbers must be between 1 and 999, with the end no earlier than the start.' };
  }
  return {
    playerValue: cleanText(match[3], 3_800),
    urls: [],
    episode: { start, end, label: directEpisodeLabel(start, end) },
    action: 'add',
    delete: null,
    error: null
  };
}

function watchPageUrl(config, content, episode = null) {
  const detailUrl = getContentPageUrl(config, content);
  if (!detailUrl) return null;
  const range = episodePathRange(episode);
  return `${detailUrl}/watch${range ? `/episode/${range}` : ''}`;
}

function streamImportInstructions(targetAdminId = null) {
  const target = targetAdminId
    ? `Every valid row in the next manifest will be attached to ${targetAdminId}.`
    : 'Each row needs a Post ID, or a Title that exactly matches one existing SoraBox release.';
  const armedEpisodeExample = targetAdminId
    ? `In this armed chat, you can also send: ep 1 https://soraboxs.embedseek.com/#your-video`
    : 'For one episode now: /cmd SB-0123ABCDEF ep 1 https://soraboxs.embedseek.com/#your-video';
  return [
    'Manual Watch-link import is armed for 15 minutes.',
    target,
    '',
    'For several episodes in one message, put the episode in front of each link on its own line: ep 176 https://… then ep 177 https://… Every link is attached to the episode named beside it, and a line with no label continues the episode above it.',
    'For many episodes at once, send one small .json or .csv document exported from SeekStreaming, Dailymotion, Rumble, or another approved host. I only save player URLs—no media is uploaded, downloaded, transcoded, or announced from Koyeb.',
    'SeekStreaming exports work directly with its Title, Embed Link, or Embed Code fields. An iframe snippet is reduced safely to its src URL, and a pasted Markdown link such as [https://rumble.com/v….html](…) is read like plain text.',
    'Page links are converted automatically to the URL the site can actually frame, so https://www.dailymotion.com/video/x… and https://rumble.com/v…-title.html work as sent. Each player is named after its provider (Dailymotion server, Rumble server), and a second link for an episode you already filled stays beside the first one instead of replacing it.',
    '',
    'Recommended CSV columns: postId, episode, label, embedUrl, watchUrl',
    armedEpisodeExample,
    'Several links in one message are all saved: ep 2 <url1> <url2>, one per line, or a bullet list. For a whole range use ep 2-7 <URL>, which is what a multi-episode release needs.',
    'For a release-wide player, omit ep: /cmd SB-0123ABCDEF https://soraboxs.embedseek.com/#your-video',
    `To undo: del 2 removes one numbered player, del ep 2-7 removes an episode range, del all clears the post. ${targetAdminId ? `Current players and their numbers: /players ${targetAdminId}.` : `Players and their numbers: /players SB-0123ABCDEF.`}`,
    'Use /cmd cancel to stop this import.'
  ].join('\n');
}

function streamImportIssueText(rejected = []) {
  if (!rejected.length) return '';
  const examples = rejected.slice(0, 5)
    .map((issue) => `Entry ${issue.row || '?'}: ${cleanText(issue.error, 180)}`)
    .join('\n');
  return `\nSkipped ${rejected.length} invalid or unresolved entr${rejected.length === 1 ? 'y' : 'ies'}:\n${examples}${rejected.length > 5 ? '\n…' : ''}`;
}

async function resolveStreamImportContent(repository, entry, targetAdminId = null) {
  if (targetAdminId) {
    if (entry.postId && entry.postId !== targetAdminId) {
      return { error: `belongs to ${entry.postId}, but this import was armed for ${targetAdminId}` };
    }
    const content = await repository.findContentByAdminId?.(targetAdminId);
    if (!content) return { error: `could not find target post ${targetAdminId}` };
    if (entry.category && entry.category !== content.category) {
      return { error: `uses category ${entry.category}, but ${targetAdminId} is in ${content.category}` };
    }
    return { content };
  }

  if (entry.postId) {
    const content = await repository.findContentByAdminId?.(entry.postId);
    return content ? { content } : { error: `could not find published post ${entry.postId}` };
  }
  if (!entry.sourceTitle || typeof repository.findContentByTitle !== 'function') {
    return { error: 'needs a Post ID or an exact existing catalog Title' };
  }
  const candidates = await repository.findContentByTitle(entry.sourceTitle, { category: entry.category, limit: 3 });
  if (candidates.length === 1) return { content: candidates[0] };
  if (candidates.length > 1) {
    return { error: `Title “${entry.sourceTitle}” matches multiple catalog posts; use /cmd SB-… to select one` };
  }
  return { error: `could not find one existing catalog post with Title “${entry.sourceTitle}”` };
}

/**
 * Attach validated provider links to existing posts only. This deliberately
 * does not call publication/announcement functions: importing a player link
 * must preserve the post and never create a Telegram announcement.
 */
export async function applyStreamingManifest({ repository, manifest, targetAdminId = null, config = {}, granularity = 'provider' } = {}) {
  if (!repository?.updateContentStreamByAdminId || !repository?.findContentByAdminId) {
    throw new Error('This catalog store cannot attach manual Watch links.');
  }
  const rejected = [...(manifest?.rejected || [])];
  const groups = new Map();
  for (const item of manifest?.entries || []) {
    const resolved = await resolveStreamImportContent(repository, item, targetAdminId);
    if (!resolved.content) {
      rejected.push({ row: item.row, error: resolved.error || 'could not resolve a catalog post' });
      continue;
    }
    const key = resolved.content.adminId;
    const group = groups.get(key) || { content: resolved.content, entries: [], rows: 0 };
    group.entries.push(item.entry);
    group.rows += 1;
    groups.set(key, group);
  }

  const updated = [];
  for (const group of groups.values()) {
    const stream = mergeStreamingEntries(group.content.stream, group.entries, { ...streamingOptionsFromConfig(config), granularity });
    if (!stream) {
      rejected.push({ row: '?', error: `could not create a safe player entry for ${group.content.adminId}` });
      continue;
    }
    const saved = await repository.updateContentStreamByAdminId(group.content.adminId, stream);
    if (!saved) {
      rejected.push({ row: '?', error: `could not update ${group.content.adminId}; it may have been removed` });
      continue;
    }
    updated.push({ content: saved, rows: group.rows, stream, entries: group.entries });
  }
  return {
    updated,
    attachedRows: updated.reduce((total, item) => total + item.rows, 0),
    rejected
  };
}

/**
 * Turn one or more pasted player links into manifest entries. Each link keeps
 * the provider's own name, so the site shows "Dailymotion server" and
 * "Rumble server" instead of an anonymous "Player 1 / Player 2".
 */
function directStreamingManifest(targetAdminId, playerLinks, episode = null) {
  const links = (Array.isArray(playerLinks) ? playerLinks : [playerLinks]).filter(Boolean);
  return {
    entries: links.map((link, index) => {
      const embedUrl = typeof link === 'string' ? link : link?.embedUrl || null;
      const watchUrl = typeof link === 'string' ? link : link?.watchUrl || null;
      const server = streamServerName(embedUrl || watchUrl);
      const shortName = server.replace(/\s+server$/i, '');
      return {
        row: index + 1,
        postId: targetAdminId,
        sourceTitle: null,
        category: null,
        entry: {
          label: `${shortName}${episode?.label ? ` · ${episode.label}` : ''}`,
          episode: episode || null,
          provider: shortName,
          server,
          embedUrl,
          watchUrl
        }
      };
    }),
    rejected: []
  };
}

/**
 * Remove the players a publisher selects by list number, by episode (including
 * a range), or all of them. Only the existing post is touched — like every
 * other /cmd action it never publishes, deletes files, or announces.
 */
export async function removeAttachedPlayers({ repository, targetAdminId, removal = {}, config = {} } = {}) {
  const content = await repository.findContentByAdminId?.(String(targetAdminId).toUpperCase());
  if (!content) return { error: `No published catalog post was found for ${targetAdminId}.` };
  const entries = Array.isArray(content.stream?.entries) ? content.stream.entries : [];
  if (!entries.length) return { error: `${content.title} has no player links attached, so nothing was removed.`, removed: 0, remaining: 0 };
  const total = publicStreamingData(content.stream, streamingOptionsFromConfig(config)).entries.length;
  const indexes = removal.mode === 'index'
    ? removal.indexes.filter((index) => index >= 1 && index <= total)
    : null;
  if (indexes && !indexes.length) {
    return { error: `This post has ${total} player${total === 1 ? '' : 's'}. Use a number between 1 and ${total}, or del ep 5 for an episode.`, removed: 0, remaining: total };
  }
  const outcome = removeStreamingEntries(content.stream, {
    indexes,
    episode: removal.mode === 'episode' ? removal.episode : null,
    all: removal.mode === 'all'
  }, streamingOptionsFromConfig(config));
  if (!outcome.removed) {
    return { error: 'No attached player matched that episode range, so nothing was removed.', removed: 0, remaining: total };
  }
  const saved = await repository.updateContentStreamByAdminId(content.adminId, outcome.stream || null);
  if (!saved) return { error: 'The player list could not be saved. Nothing was removed.', removed: 0, remaining: total };
  return {
    content: saved,
    removed: outcome.removed,
    remaining: outcome.remaining,
    scope: removal.mode === 'episode'
      ? `${removal.episode.label}`
      : removal.mode === 'all'
        ? 'every attached player'
        : `player${indexes.length === 1 ? '' : 's'} ${indexes.join(', ')}`
  };
}

/**
 * The publisher-facing list of attached players. Numbers shown here are exactly
 * what `del <number>` and the Remove buttons address, so a mistaken bulk import
 * can be cleaned up without remembering provider URLs.
 */
export function playersList(content, config = {}) {
  const data = publicStreamingData(content?.stream, streamingOptionsFromConfig(config));
  return data.entries.map((entry, index) => ({
    ...entry,
    number: index + 1,
    title: entry.label || entry.episode?.label || 'Main player',
    server: entry.server || streamServerName(entry.embedUrl || entry.watchUrl),
    url: entry.embedUrl || entry.watchUrl || null
  }));
}

/**
 * A release can hold hundreds of players, so the list is a window and not a dump:
 * the publisher narrows it to one episode or range, jumps to the episodes that have
 * no player yet, or pages through everything. Numbers always come from the stored
 * order, so a number printed here is the number `/cmd SB-… del <n>` addresses, and
 * the Remove buttons carry the card they belong to.
 */
export const PLAYERS_PAGE_SIZE = 8;

function playersEpisodeGroups(content) {
  return (Array.isArray(content?.episodeGroups) ? content.episodeGroups : [])
    .map((group) => ({ start: Number(group?.start), end: Number(group?.end ?? group?.start) }))
    .filter((group) => Number.isInteger(group.start) && group.start >= 1);
}

function playersCoversEpisodeNumber(content, number) {
  return playersEpisodeGroups(content).some((group) => number >= group.start && number <= (Number.isInteger(group.end) ? group.end : group.start));
}

/**
 * The view a publisher asked for. `content` lets a bare number mean what they
 * meant by it: on a card that has an Episode 176, `/players SB-… 176` opens that
 * episode; on any other card the same number pages through the list.
 */
export function parsePlayersView(value, content = null) {
  const text = cleanText(value, 80).trim();
  if (!text) return { mode: 'all', episode: null, page: 1, focus: null };
  const lowered = text.toLowerCase();
  if (/^(?:all|everything|every|full|list)$/.test(lowered)) return { mode: 'all', episode: null, page: 1, focus: null };
  if (/^(?:miss|missing|gaps|uncovered)$/.test(lowered)) return { mode: 'missing', episode: null, page: 1, focus: null };

  const bare = lowered.match(/^(#|row|n)?\.?\s*0*(\d{1,4})$/);
  if (bare) {
    const number = Number(bare[2]);
    const explicitRow = Boolean(bare[1]);
    if (!explicitRow && playersCoversEpisodeNumber(content, number)) {
      return { mode: 'episode', episode: { start: number, end: number, label: directEpisodeLabel(number, number) }, page: 1, focus: null };
    }
    if (explicitRow) {
      // `#12` is the row they are reading, so it opens the page holding it.
      return { mode: 'all', episode: null, page: Math.floor((Math.max(1, number) - 1) / PLAYERS_PAGE_SIZE) + 1, focus: number || null };
    }
    return { mode: 'all', episode: null, page: Math.max(1, number || 1), focus: null };
  }

  const page = lowered.match(/^(?:page|p)\s*0*(\d{1,4})$/);
  if (page) return { mode: 'all', episode: null, page: Math.max(1, Number(page[1])), focus: null };

  const episode = lowered.match(/^(?:ep|eps|episode|e)\.?\s*0*(\d{1,3})(?:\s*(?:-|\u2013|to)\s*0*(\d{1,3}))?$/);
  if (episode) {
    const start = Number(episode[1]);
    const end = Number(episode[2] || episode[1]);
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end > 999) {
      return { error: 'Episode numbers run from 1 to 999, with the end no earlier than the start. Example: /players SB-0123ABCDEF ep 176' };
    }
    return { mode: 'episode', episode: { start, end, label: directEpisodeLabel(start, end) }, page: 1, focus: null };
  }
  return { error: 'Use /players SB-0123ABCDEF ep 176 for one episode, ep 170-180 for a range, missing for the episodes with no player, or a page number.' };
}

/** The view travels inside the button data, so an older message stays usable. */
export function playersViewKey(view = {}) {
  if (view.mode === 'episode' && view.episode) return `${view.episode.start}-${view.episode.end}`;
  return view.mode === 'missing' ? 'miss' : 'all';
}

export function playersViewFromKey(key) {
  const range = String(key || '').match(/^(\d{1,3})-(\d{1,3})$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return { mode: 'episode', episode: { start, end, label: directEpisodeLabel(start, end) }, page: 1, focus: null };
  }
  return { mode: key === 'miss' ? 'missing' : 'all', episode: null, page: 1, focus: null };
}

function playersRangesOverlap(first, second) {
  const leftStart = Number(first?.start);
  const leftEnd = Number(first?.end ?? first?.start);
  const rightStart = Number(second?.start);
  const rightEnd = Number(second?.end ?? second?.start);
  if (!Number.isInteger(leftStart) || !Number.isInteger(rightStart)) return false;
  return leftStart <= (Number.isInteger(rightEnd) ? rightEnd : rightStart)
    && (Number.isInteger(leftEnd) ? leftEnd : leftStart) >= rightStart;
}

/**
 * Which episodes the card actually has a player for. A release-wide link is
 * deliberately not counted: the site offers a player on an episode page only when
 * a link covers that episode, so counting it would hide a real gap.
 */
export function playersCoverage(content, entries = []) {
  const groups = playersEpisodeGroups(content);
  const list = Array.isArray(entries) ? entries : [];
  const episodic = list.filter((entry) => Number.isInteger(Number(entry?.episode?.start)));
  const missing = [];
  let covered = 0;
  for (const group of groups) {
    const end = Number.isInteger(group.end) && group.end >= group.start ? group.end : group.start;
    const span = Math.min(400, end - group.start + 1);
    let hit = 0;
    for (let offset = 0; offset < span; offset += 1) {
      const number = group.start + offset;
      if (episodic.some((entry) => playersRangesOverlap(entry.episode, { start: number, end: number }))) hit += 1;
    }
    if (!hit) {
      const last = missing[missing.length - 1];
      if (last && group.start === last.end + 1) last.end = end;
      else missing.push({ start: group.start, end });
    }
    covered += hit;
  }
  const total = groups.reduce((sum, group) => sum + Math.min(400, (Number.isInteger(group.end) ? group.end : group.start) - group.start + 1), 0);
  return { total, covered, missing, releaseWide: list.length - episodic.length };
}

function playersGapLabel(range) {
  const pad = (value) => String(value).padStart(2, '0');
  return range.start === range.end ? `Ep ${pad(range.start)}` : `Ep ${pad(range.start)}\u2013${pad(range.end)}`;
}

function playersGapCommand(adminId, range) {
  if (!range) return `/cmd ${adminId} ep 1 <player URL>`;
  return `/cmd ${adminId} ep ${range.start === range.end ? range.start : `${range.start}-${range.end}`} <player URL>`;
}

function selectPlayersEntries(entries, view) {
  if (view.mode !== 'episode') return entries;
  return entries.filter((entry) => playersRangesOverlap(entry?.episode, view.episode));
}

export function playersListText(content, entries = [], config = {}, view = { mode: 'all', page: 1 }) {
  const watchUrl = watchPageUrl(config, content, null);
  const all = Array.isArray(entries) ? entries : [];
  if (!all.length) {
    return [
      `\u25b8 ${content.title} (${content.adminId})`,
      '',
      'No player is attached to this release yet.',
      'Add one: /cmd ' + content.adminId + ' ep 1 https://rumble.com/vxxxx-title.html',
      'Many at once: /cmd ' + content.adminId + ' then send the provider .json or .csv export.',
      'Several episodes in one message: put "ep 176 <link>" and "ep 177 <link>" on their own lines.'
    ].join('\n');
  }

  const coverage = playersCoverage(content, all);
  const selected = selectPlayersEntries(all, view);
  const pages = Math.max(1, Math.ceil(selected.length / PLAYERS_PAGE_SIZE));
  const wanted = Math.max(1, Number(view.page) || 1);
  const page = Math.min(wanted, pages);
  const shown = selected.slice((page - 1) * PLAYERS_PAGE_SIZE, page * PLAYERS_PAGE_SIZE);

  const header = [`\u25b8 ${content.title} (${content.adminId}) \u2014 ${all.length} player${all.length === 1 ? '' : 's'}`];
  if (view.mode === 'episode') {
    header.push(`\u25aa ${view.episode.label}: ${selected.length} of ${all.length} players${selected.length ? ` \u00b7 page ${page} of ${pages}` : ''}`);
  } else if (coverage.total) {
    const episodeWord = coverage.total === 1 ? 'episode has' : 'episodes have';
    header.push(`\u25aa ${coverage.covered} of ${coverage.total} ${episodeWord} a player \u00b7 page ${page} of ${pages}`);
  } else {
    header.push(`\u25aa page ${page} of ${pages}`);
  }
  if (page !== wanted) {
    // A number that is neither an episode of this card nor a real page is a typo,
    // and silently landing somewhere else would be worse than saying so.
    header.push(`\u25aa There ${pages === 1 ? 'is only 1 page' : `are only ${pages} pages`} of ${all.length} players${coverage.total && wanted > coverage.total ? `, and this release runs to ${directEpisodeLabel(1, coverage.total)}` : ''} \u2014 showing page ${page}.`);
  }

  const lines = shown.map((entry) => [
    `${view.focus && entry.number === view.focus ? '\u25b6' : '\u25aa'} ${entry.number}. ${entry.episode?.label || 'Release-wide'} \u00b7 ${entry.server}`,
    `   \u2192 ${entry.url}`
  ].join('\n'));

  const tail = [];
  if (view.mode === 'episode' && !selected.length) {
    const beyond = coverage.total > 0 && view.episode.start > coverage.total;
    tail.push(beyond
      ? `This release runs to ${directEpisodeLabel(1, coverage.total)}, so ${view.episode.label} does not exist on it. Nothing was changed.`
      : `No player is attached to ${view.episode.label} yet. Add one: ${playersGapCommand(content.adminId, view.episode)}`);
    tail.push(beyond
      ? `\u25aa /players ${content.adminId} missing lists the episodes that still need a player.`
      : 'After that this same page shows it, with its Remove button.');
  }
  if (view.mode !== 'episode' && coverage.missing.length) {
    tail.push(`\u25aa With no player yet: ${coverage.missing.slice(0, 8).map(playersGapLabel).join(', ')}${coverage.missing.length > 8 ? ` \u00b7 +${coverage.missing.length - 8} more` : ''}`);
    tail.push(`   Fill the first gap: ${playersGapCommand(content.adminId, coverage.missing[0])}`);
  }
  if (view.mode === 'episode') {
    tail.push(`\u25aa Back to every player: /players ${content.adminId} all`);
  } else if (all.length > PLAYERS_PAGE_SIZE && view.mode !== 'missing') {
    tail.push(`\u25aa Narrow it: /players ${content.adminId} ep 176 for one episode, ep 170-180 for a range, missing for the gaps, #12 for row twelve, 3 for page three \u2014 or use the buttons below.`);
  }
  const episodeHint = view.episode?.start ?? shown[0]?.episode?.start ?? 1;
  tail.push([
    `\u25aa Remove: /cmd ${content.adminId} del ${shown[0]?.number ?? 1} for that line`,
    `/cmd ${content.adminId} del ep ${episodeHint} for that whole episode`,
    `/cmd ${content.adminId} del ep ${episodeHint}-${episodeHint + 5} for a range`
  ].join(' \u00b7 '));
  if (coverage.releaseWide) {
    tail.push(`\u25aa ${coverage.releaseWide} release-wide link${coverage.releaseWide === 1 ? '' : 's'} sit${coverage.releaseWide === 1 ? 's' : ''} on the release page only, not on an episode page.`);
  }
  if (watchUrl) tail.push(`Watch page: ${watchUrl}`);

  return [...header, '', ...lines, '', ...tail.filter(Boolean)].join('\n').slice(0, 3_600);
}

export function playersMissingText(content, entries = [], config = {}, view = { mode: 'missing', page: 1 }) {
  const coverage = playersCoverage(content, entries);
  if (!coverage.total) {
    return `\u25b8 ${content.title} (${content.adminId})\n\nThis card numbers no episodes, so there is nothing to check. It has ${entries.length} player${entries.length === 1 ? '' : 's'} attached.`;
  }
  if (!coverage.missing.length) {
    return `\u25b8 ${content.title} (${content.adminId})\n\nAll ${coverage.total} of its episodes have a player${coverage.releaseWide ? ` (${coverage.releaseWide} release-wide link${coverage.releaseWide === 1 ? '' : 's'} as well)` : ''}. Nothing is missing.`;
  }
  const gapPages = Math.max(1, Math.ceil(coverage.missing.length / PLAYERS_PAGE_SIZE));
  const gapPage = Math.min(Math.max(1, Number(view.page) || 1), gapPages);
  const gaps = coverage.missing.slice((gapPage - 1) * PLAYERS_PAGE_SIZE, gapPage * PLAYERS_PAGE_SIZE);
  return [
    `\u25b8 ${content.title} (${content.adminId}) \u2014 ${coverage.covered} of ${coverage.total} episodes covered`,
    '',
    ...gaps.map((gap) => `\u25aa ${playersGapLabel(gap)} \u00b7 ${gap.end - gap.start + 1} episode${gap.end === gap.start ? '' : 's'} with no player`),
    gapPages > 1 ? `\u25aa Gap page ${gapPage} of ${gapPages}` : null,
    coverage.missing.length > gapPage * PLAYERS_PAGE_SIZE ? `\u2026 ${coverage.missing.length - gapPage * PLAYERS_PAGE_SIZE} more gap${coverage.missing.length - gapPage * PLAYERS_PAGE_SIZE === 1 ? '' : 's'} on the next page` : null,
    '',
    `Fill one: ${playersGapCommand(content.adminId, gaps[0])}`,
    '\u25aa Tap a gap below to open the view that prints the command filling it.'
  ].filter(Boolean).join('\n').slice(0, 3_600);
}

export function playersKeyboard(content, entries = [], view = { mode: 'all', page: 1 }) {
  const adminId = String(content?.adminId || '').toUpperCase();
  const all = (Array.isArray(entries) ? entries : []).filter((entry) => Number.isInteger(entry?.number));
  if (!all.length) {
    // Nothing to remove yet, so the only useful action is to add the first link.
    return Markup.inlineKeyboard([[Markup.button.callback('Add players', `ply:add:${adminId}`)]]);
  }
  const selected = selectPlayersEntries(all, view);
  const pages = Math.max(1, Math.ceil(selected.length / PLAYERS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(view.page) || 1), pages);
  const shown = selected.slice((page - 1) * PLAYERS_PAGE_SIZE, page * PLAYERS_PAGE_SIZE);
  const key = playersViewKey(view);
  const shortName = (entry) => String(entry.server || 'player').replace(/\s+server$/i, '');

  if (view.mode === 'missing') {
    const gaps = playersCoverage(content, all).missing;
    const gapPages = Math.max(1, Math.ceil(gaps.length / PLAYERS_PAGE_SIZE));
    const gapPage = Math.min(Math.max(1, Number(view.page) || 1), gapPages);
    const shownGaps = gaps.slice((gapPage - 1) * PLAYERS_PAGE_SIZE, gapPage * PLAYERS_PAGE_SIZE);
    const gapRows = [];
    for (let index = 0; index < shownGaps.length; index += 2) {
      gapRows.push(shownGaps.slice(index, index + 2).map((gap) => Markup.button.callback(
        telegramButtonText(`\u2192 ${playersGapLabel(gap)} \u00b7 ${gap.end - gap.start + 1} missing`),
        `ply:pag:${adminId}:${gap.start === gap.end ? gap.start : `${gap.start}-${gap.end}`}:1`
      )));
    }
    const gapNav = [];
    if (gapPage > 1) gapNav.push(Markup.button.callback(`\u25c0 ${gapPage - 1}`, `ply:pag:${adminId}:miss:${gapPage - 1}`));
    if (gapPage < gapPages) gapNav.push(Markup.button.callback(`${gapPage + 1} \u25b6`, `ply:pag:${adminId}:miss:${gapPage + 1}`));
    if (gapNav.length) gapRows.push(gapNav);
    gapRows.push([
      Markup.button.callback('All players', `ply:pag:${adminId}:all:1`),
      Markup.button.callback('Add players', `ply:add:${adminId}`)
    ]);
    return Markup.inlineKeyboard(gapRows);
  }
  const rows = [];
  for (let index = 0; index < shown.length; index += 2) {
    rows.push(shown.slice(index, index + 2).map((entry) => Markup.button.callback(
      telegramButtonText(`\u2715 ${entry.episode?.label || 'Release'} \u00b7 ${shortName(entry)}`),
      `ply:rem:${adminId}:${entry.number}:${key}:${page}`
    )));
  }
  if (view.mode === 'episode' && selected.length) {
    rows.push([Markup.button.callback(
      telegramButtonText(`\u2715 Remove all ${selected.length} for ${view.episode.label}`),
      `ply:remep:${adminId}:${view.episode.start}-${view.episode.end}`
    )]);
  }
  const navigation = [];
  if (page > 1) navigation.push(Markup.button.callback(`\u25c0 ${page - 1}`, `ply:pag:${adminId}:${key}:${page - 1}`));
  if (page < pages) navigation.push(Markup.button.callback(`${page + 1} \u25b6`, `ply:pag:${adminId}:${key}:${page + 1}`));
  navigation.push(Markup.button.callback(
    view.mode === 'missing' ? 'All players' : 'Missing episodes',
    `ply:pag:${adminId}:${view.mode === 'missing' ? 'all' : 'miss'}:1`
  ));
  if (view.mode === 'episode') navigation.push(Markup.button.callback('All players', `ply:pag:${adminId}:all:1`));
  rows.push(navigation);
  const footer = [Markup.button.callback('Add players', `ply:add:${adminId}`)];
  if (view.mode === 'all') {
    footer.push(Markup.button.callback(`Remove all ${all.length}`, `ply:rem:${adminId}:all:${key}:${page}`));
  }
  rows.push(footer);
  // Telegram caps an inline keyboard at 100 buttons and a wall of them is
  // unreadable anyway, which is why the list pages instead of growing.
  return Markup.inlineKeyboard(rows);
}

/* ---------------------------------------------------------------------------
 * Post merging (/merge)
 *
 * A multi-season upload is intentionally published as one card per season, and
 * providers sometimes export the same show as several cards. /merge puts those
 * cards back together: the target keeps its own ID, slug, poster, and delivery
 * identity, absorbs every file and player of the listed cards, rebuilds its
 * season blocks, and the cards it absorbed are removed from the website and from
 * the announcement channels. Private storage messages are never touched, so a
 * merge can be undone by re-adding files with /batch.
 * ------------------------------------------------------------------------- */

/**
 * Parse a /merge line. The first Post ID is always the card that receives the
 * files; a title in front of it is a safety check, not a search. `drop` trims
 * files back off one card, by season or by episode range.
 */
export function parseMergeCommand(value) {
  const text = cleanText(value, 1_200);
  const lowered = text.trim().toLowerCase();
  if (!text || /^(?:help|example|\?)$/.test(lowered)) return { action: 'help' };
  if (/^(?:confirm|yes|do it|go ahead|merge it)$/.test(lowered)) return { action: 'confirm' };
  if (/^(?:cancel|never mind|stop|no)$/.test(lowered)) return { action: 'cancel' };

  const adminIds = postIdsFromCommand(text);
  // Everything that is not a Post ID, so a mistyped ID can never be read as a
  // title: "Sb -29292" is reported instead of silently ignored.
  const words = cleanText(text.replace(/SB-[A-F0-9]{10}/gi, ' ').replace(/\s+/g, ' ').trim(), 140);
  // Anything shaped like a Post ID that is not one: a wrong length or stray
  // letters is reported instead of being read as a title or dropped silently.
  const malformed = [...text.matchAll(/\bs\s*b\s*[-]?\s*[a-f0-9]{1,14}\b/gi)]
    .filter((match) => !adminIds.includes(cleanText(match[0], 40).toUpperCase().replace(/\s+/g, '').replace(/^(SB)[^A-F0-9]/, 'SB-')));
  if (adminIds.length < 2 && malformed.length) {
    return { error: `“${malformed.map((match) => cleanText(match[0], 24)).join('”, “')}” ${malformed.length === 1 ? 'is' : 'are'} not a SoraBox Post ID. A Post ID is SB- plus ten hexadecimal characters — copy the exact IDs from /posts 50.` };
  }

  if (/^drop\b/i.test(words)) {
    const instruction = cleanText(words.replace(/^drop\b/i, '').trim(), 120);
    const drop = parseMergeDropInstruction(instruction);
    if (drop.error) return { error: drop.error };
    if (!adminIds.length) return { error: 'Say which card to trim: /merge drop SB-0123ABCDEF season 2' };
    return { action: 'drop', targetAdminId: adminIds[0], drop };
  }

  if (adminIds.length === 0) {
    return { error: 'Usage: /merge Bleach SB-0123ABCDEF SB-1111222233 SB-4444555566 — the first Post ID keeps its card and receives every file of the others. Use /merge help for removing a season or episodes.' };
  }
  if (adminIds.length < 2) {
    return { error: `Add at least one Post ID to absorb after the target: /merge ${adminIds[0]} SB-SECONDID${words ? ` (or /merge ${words.split(' ')[0]} ${adminIds[0]} SB-SECONDID)` : ''}` };
  }
  return {
    action: 'plan',
    label: adminIds.length > 1 ? cleanText(words, 140) : '',
    targetAdminId: adminIds[0],
    sourceAdminIds: adminIds.slice(1)
  };
}

/**
 * `season 2`, `s2`, `ep 5`, `episodes 5-7`, or `season 2 ep 5-7`. Episode
 * numbers restart in every season, so a bare `ep 5` on a merged card removes
 * Episode 5 of every season and a season-qualified one removes only that block.
 */
export function parseMergeDropInstruction(value) {
  const text = cleanText(value, 120);
  if (!text) return { error: 'Say what to remove: /merge drop SB-0123ABCDEF season 2, ep 5, ep 2-7, or season 2 ep 5.' };
  const season = text.match(/^(?:all\s+of\s+)?s(?:eason)?\.?\s*0*(\d{1,2})\b(.*)$/i);
  const seasonNumber = season ? Number(season[1]) : null;
  // `Season 0` is not a block anyone can read back off a card, and a bare word
  // like `season two` must be reported rather than dropped.
  if (season && !(Number.isInteger(seasonNumber) && seasonNumber >= 1)) {
    return { error: 'Season numbers must be digits from 1 to 99, for example season 2.' };
  }
  const remainder = cleanText(season ? season[2] : text, 60);
  const episodes = remainder.match(/^(?:ep|eps|episode|e)\.?\s*0*(\d{1,3})(?:\s*(?:-|\u2013|to)\s*0*(\d{1,3}))?$/i);
  if (episodes) {
    const start = Number(episodes[1]);
    const end = Number(episodes[2] || episodes[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) {
      return { error: 'Episode numbers must be between 1 and 999, with the end no earlier than the start.' };
    }
    return { mode: 'episodes', season: seasonNumber, start, end };
  }
  if (remainder) {
    // "season two" names a season but not in digits, which is the mistake worth
    // calling out rather than a generic format complaint.
    const words = /^(?:all\s+of\s+)?s(?:eason)?\.?\b/i.test(remainder);
    return { error: words
      ? 'Season numbers must be digits from 1 to 99, for example season 2.'
      : 'Use a form such as season 2, ep 5, ep 2-7, or season 2 ep 5-7.' };
  }
  if (!season) {
    const bareSeason = text.match(/^s(?:eason)?\.?\s*0*(\d{1,2})$/i);
    if (bareSeason) return { mode: 'season', season: Number(bareSeason[1]) };
    return { error: 'Use a form such as season 2, ep 5, ep 2-7, or season 2 ep 5-7.' };
  }
  return { mode: 'season', season: seasonNumber };
}

function titleIdentityKey(value) {
  return cleanText(value, 180).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Read every card the publisher named and turn it into an explicit plan. Nothing
 * is changed here: a merge deletes catalog posts, so the plan is shown first and
 * applied by the confirmation button.
 */
export async function resolveMergePlan({ repository, parsed = {} }) {
  if (typeof repository.findContentByAdminId !== 'function' || typeof repository.deleteContentByAdminId !== 'function') {
    return { error: 'Post merging is not available in this catalog store.' };
  }
  const target = await repository.findContentByAdminId(parsed.targetAdminId);
  if (!target) return { error: `No published catalog post was found for ${parsed.targetAdminId}. Use /posts 50 to copy the exact target ID.` };
  // The named title is a safety check, not a search: it has to agree with the
  // card the publisher pointed at, but a shorter form of the same name ("bleach
  // movie" under "Bleach Movie 2024") must not refuse an intended merge.
  if (parsed.label) {
    const wanted = titleIdentityKey(parsed.label);
    const actual = titleIdentityKey(target.title);
    const agrees = wanted && (wanted === actual || actual.includes(wanted) || wanted.includes(actual));
    if (!agrees) {
      return { error: `“${cleanText(parsed.label, 60)}” is not the name of ${target.adminId} (“${target.title}”). I stopped so the files cannot land on the wrong card — check the target ID with /posts 50, or drop the name and rely on the ID alone.` };
    }
  }

  const sources = [];
  const missing = [];
  const blocked = [];
  const sourceFiles = [];
  const seasons = new Set();
  let movedFiles = 0;
  let movedPlayers = 0;
  let movedAnnouncements = 0;
  for (const adminId of parsed.sourceAdminIds) {
    if (adminId === target.adminId) continue;
    const source = await repository.findContentByAdminId(adminId);
    if (!source) {
      missing.push(adminId);
      continue;
    }
    if (isAdultCategory(source.category) !== isAdultCategory(target.category)) {
      blocked.push({ adminId, title: cleanText(source.title, 70), reason: '18+ storage and age gate stay separate' });
      continue;
    }
    const files = Array.isArray(source.files) ? source.files : [];
    const summary = summarizeEpisodes(files);
    // Per-file detection, not the split planner: a source carrying one marked
    // season is still worth naming in the preview even though it needs no split.
    const sourceSeasons = [...new Set(files.map((file) => detectUploadSeasonForFile(file)).filter(Boolean))].sort((first, second) => first - second);
    for (const season of sourceSeasons) seasons.add(season);
    sourceFiles.push(...files);
    movedFiles += files.length;
    movedPlayers += (Array.isArray(source.stream?.entries) ? source.stream.entries : []).length;
    movedAnnouncements += (Array.isArray(source.announcementRefs) ? source.announcementRefs : []).length;
    sources.push({
      adminId: source.adminId,
      title: cleanText(source.title, 70),
      category: source.category,
      files: files.length,
      episodes: summary.count,
      seasons: sourceSeasons,
      players: (Array.isArray(source.stream?.entries) ? source.stream.entries : []).length,
      announcements: (Array.isArray(source.announcementRefs) ? source.announcementRefs : []).length
    });
  }
  if (!sources.length) {
    if (blocked.length) return { error: `None of the listed posts can be merged into ${target.adminId}: ${blocked.map((entry) => `${entry.adminId} (${entry.reason})`).join('; ')}.` };
    return { error: `There is no other post to absorb${missing.length ? ` (${missing.join(', ')} was not found)` : ''}.` };
  }

  const targetFiles = Array.isArray(target.files) ? target.files : [];
  const targetSummary = summarizeEpisodes(targetFiles);
  for (const season of targetFiles.map((file) => detectUploadSeasonForFile(file)).filter(Boolean)) seasons.add(season);

  return {
    plan: {
      targetAdminId: target.adminId,
      targetTitle: cleanText(target.title, 90),
      targetCategory: target.category,
      label: cleanText(parsed.label, 140) || null,
      targetFiles: targetFiles.length,
      targetPlayers: (Array.isArray(target.stream?.entries) ? target.stream.entries : []).length,
      sources,
      missing,
      blocked,
      movedFiles,
      movedPlayers,
      movedAnnouncements,
      // The blocks the card will actually show: season attribution runs over the
      // combined list the same way the merged card itself computes it.
      seasons: attributeUploadSeasons([...targetFiles, ...sourceFiles]).seasons,
      targetSeasons: [...seasons].sort((first, second) => first - second),
      resultingFiles: targetFiles.length + movedFiles,
      resultingEpisodes: targetSummary.count + sources.reduce((total, source) => total + (source.episodes || 0), 0)
    }
  };
}

export function mergePlanText(plan, config = {}) {
  const lines = [
    `Merge into ${plan.targetAdminId} · ${plan.targetTitle}`,
    '',
    `▪ Absorbing ${plan.sources.length} post${plan.sources.length === 1 ? '' : 's'} — ${plan.movedFiles} file${plan.movedFiles === 1 ? '' : 's'} move to ${plan.targetAdminId}:`,
    ...plan.sources.map((source) => `   • ${source.adminId} · ${source.title} — ${source.files} file${source.files === 1 ? '' : 's'}${source.episodes ? `, ${source.episodes} episode${source.episodes === 1 ? '' : 's'}` : ''}${source.seasons.length ? `, S${source.seasons.join('/S')}` : ''}${source.players ? `, ${source.players} player${source.players === 1 ? '' : 's'}` : ''}`),
    '',
    `▪ The target keeps its own ID, slug, poster, and delivery links, then shows ${plan.resultingFiles} file${plan.resultingFiles === 1 ? '' : 's'} and ${plan.resultingEpisodes} episode${plan.resultingEpisodes === 1 ? '' : 's'}${plan.seasons.length > 1 ? ` across ${plan.seasons.length} season blocks (${plan.seasons.map((season) => `S${season}`).join(', ')})` : ''}.`,
    plan.movedAnnouncements ? `▪ ${plan.movedAnnouncements} announcement message${plan.movedAnnouncements === 1 ? '' : 's'} for the absorbed posts will be deleted from the announcement channel${plan.movedAnnouncements === 1 ? '' : 's'}.` : '▪ None of the absorbed posts has a recorded announcement message.',
    '▪ The files themselves stay in the private storage channel, so this can be undone with /batch and /merge drop.',
    plan.missing.length ? `▪ Not found and skipped: ${plan.missing.join(', ')}.` : null,
    plan.blocked.length ? `▪ Left alone: ${plan.blocked.map((entry) => `${entry.adminId} (${entry.reason})`).join('; ')}.` : null,
    '',
    'Confirm to apply. Nothing changes until then.'
  ].filter((line) => line !== null);
  return lines.join('\n').slice(0, 3_700);
}

export function mergeConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Confirm merge', 'mrg:go'), Markup.button.callback('Cancel', 'mrg:no')],
    [Markup.button.callback('Show the cards again', 'mrg:peek')]
  ]);
}

export function mergeInstructions() {
  return [
    'Merge cards so one show lives in one post.',
    '',
    'Put the target first, then every card to absorb:',
    '/merge Bleach SB-0123ABCDEF SB-1111222233 SB-4444555566',
    '/merge SB-0123ABCDEF SB-1111222233',
    '',
    'The title in front is only a check: I stop if that Post ID carries a different name. The target keeps its ID, slug, poster, and delivery links; every file and player of the other cards moves into it; season blocks are rebuilt (S1 with its episodes, then S2 …); and the absorbed cards are deleted from the website and their announcement messages deleted from the announcement channels.',
    '',
    'I show the plan first and change nothing until you tap Confirm merge (or /merge confirm). /merge cancel drops the plan.',
    '',
    'To trim a card instead — a whole season, or an episode added to it by mistake:',
    '/merge drop SB-0123ABCDEF season 2',
    '/merge drop SB-0123ABCDEF ep 5',
    '/merge drop SB-0123ABCDEF season 2 ep 5-7',
    'A drop only removes files from that card; the storage messages stay, so you can re-add them with /batch. Players attached to removed episodes stay until you remove them: /players SB-0123ABCDEF, then /cmd SB-0123ABCDEF del ep 5.'
  ].join('\n');
}

/** A file name the publisher recognises, kept from its tail where the number is. */
function shortFileName(file) {
  const raw = cleanText(file?.name || file?.displayName || file?.sourceLabel || 'unnamed file', 160).replace(/\.[a-z0-9]{2,4}$/i, '');
  return raw.length > 42 ? `…${raw.slice(-41)}` : raw;
}

export function mergeResultText(outcome, config = {}) {
  if (outcome.error) return outcome.error;
  const content = outcome.content || {};
  const moved = Array.isArray(outcome.moved) ? outcome.moved : [];
  const totalFiles = (Array.isArray(content?.files) ? content.files : []).length;
  // One line per season block the website now shows, so the publisher can read
  // the same structure a visitor sees without opening the page.
  const cardFiles = Array.isArray(content?.files) ? content.files : [];
  const isEpisodicMerge = String(content?.category || '').trim().toLowerCase() !== 'movie';
  const unnumbered = isEpisodicMerge ? cardFiles.filter((file) => !hasEpisodeRange(file)) : [];
  const perSeason = new Map();
  for (const group of Array.isArray(content?.episodeGroups) ? content.episodeGroups : []) {
    if (!group.seasonLabel) continue;
    const current = perSeason.get(group.seasonLabel) || 0;
    perSeason.set(group.seasonLabel, current + (group.count || 1));
  }
  const seasonLines = [...perSeason.entries()].map(([label, count]) => `   • ${label}: ${count} episode${count === 1 ? '' : 's'}`);
  const multiSeason = perSeason.size > 1;
  return [
    `Merged ${moved.length || outcome.plan?.sources?.length || 0} post${(moved.length || 0) === 1 ? '' : 's'} into ${content.adminId || outcome.plan?.targetAdminId} · ${content.title || outcome.plan?.targetTitle}.`,
    `▪ ${totalFiles} file${totalFiles === 1 ? '' : 's'} on this card · ${content.episodeCount || 0} episode${content.episodeCount === 1 ? '' : 's'}.`,
    seasonLines.length ? `▪ Season blocks on the website:\n${seasonLines.join('\n')}` : null,
    outcome.playersMerged ? `▪ ${outcome.playersMerged} player${outcome.playersMerged === 1 ? '' : 's'} moved to /players ${content.adminId}.${multiSeason ? ' Players are matched by episode number only, so check each season keeps its own link.' : ''}` : null,
    // Files whose episode number cannot be read at all are listed rather than
    // left invisible, because "the merge lost my episodes" is otherwise the only
    // thing a publisher can conclude.
    unnumbered.length
      ? `▪ ${unnumbered.length} moved file${unnumbered.length === 1 ? '' : 's'} ${unnumbered.length === 1 ? 'has' : 'have'} no episode number and ${unnumbered.length === 1 ? 'stays' : 'stay'} outside the episode index (${unnumbered.slice(0, 3).map((file) => shortFileName(file)).join(', ')}${unnumbered.length > 3 ? `, +${unnumbered.length - 3} more` : ''}). ${unnumbered.length === 1 ? 'It' : 'They'} ${unnumbered.length === 1 ? 'is' : 'are'} still on the card and delivered as files — re-send ${unnumbered.length === 1 ? 'it' : 'them'} with a caption like “Ep 12” to place ${unnumbered.length === 1 ? 'it' : 'them'} in the index.`
      : null,
    moved.length ? `▪ Deleted from the website: ${moved.map((entry) => entry.adminId).join(', ')}.` : null,
    outcome.announcementMessages?.deleted || outcome.announcementMessages?.failed
      ? `▪ Announcement messages: ${outcome.announcementMessages.deleted} deleted${outcome.announcementMessages.failed ? `, ${outcome.announcementMessages.failed} could not be deleted (is the bot an admin in that channel?)` : ''}.`
      : null,
    outcome.plan.missing?.length ? `▪ Already gone: ${outcome.plan.missing.join(', ')}.` : null,
    '▪ The private storage files were not touched, so nothing was uploaded again.',
    getContentPageUrl(config, content) ? `Card: ${getContentPageUrl(config, content)}` : null
  ].filter((line) => line !== null).join('\n').slice(0, 3_700);
}

export function mergeDropResultText(outcome, config = {}) {
  if (outcome.error) return outcome.error;
  const { content, removed, remaining } = outcome;
  return [
    `Removed ${removed.length} file${removed.length === 1 ? '' : 's'} (${outcome.description}) from ${content.adminId} · ${content.title}.`,
    `▪ ${remaining} file${remaining === 1 ? '' : 's'} · ${content.episodeCount || 0} episode${content.episodeCount === 1 ? '' : 's'} left on the card${content.episodeCount === 0 ? ' — it is empty now, so use /delete ' + content.adminId + ' to drop the card or /batch to re-add the files' : ''}.`,
    outcome.playersLeft ? `▪ ${outcome.playersLeft} player${outcome.playersLeft === 1 ? '' : 's'} for the removed ${outcome.playersLeft === 1 ? 'episode is' : 'episodes are'} still attached: /cmd ${content.adminId} del ep ${outcome.playerRange || 'all'}.` : null,
    '▪ The storage messages were not deleted, so these files can be added back with /batch later.'
  ].filter(Boolean).join('\n');
}

/**
 * Move every absorbed card's files and players onto the target, then delete the
 * absorbed cards and their announcement messages. The plan is re-read here, so a
 * catalog change between preview and confirmation is applied as it stands rather
 * than from a stale snapshot.
 */
export async function applyMergePlan({ bot, repository, config = {}, plan = {} }) {
  const target = await repository.findContentByAdminId(plan.targetAdminId);
  if (!target) return { error: `${plan.targetAdminId} no longer exists, so nothing was merged.` };
  const movedFiles = [];
  const movedPlayers = [];
  const aliases = [];
  const moved = [];
  const missing = [];
  const blocked = [];
  const announcementMessages = { deleted: 0, failed: 0 };
  const telegram = bot?.telegram;

  for (const entry of plan.sources || []) {
    const source = await repository.findContentByAdminId(entry.adminId);
    if (!source) {
      missing.push(entry.adminId);
      continue;
    }
    if (isAdultCategory(source.category) !== isAdultCategory(target.category)) {
      blocked.push({ adminId: source.adminId, reason: '18+ storage and age gate stay separate' });
      continue;
    }
    movedFiles.push(...(Array.isArray(source.files) ? source.files : []));
    movedPlayers.push(...(Array.isArray(source.stream?.entries) ? source.stream.entries : []));
    aliases.push(...[source.titleKey, source.automationKey, ...(Array.isArray(source.automationKeys) ? source.automationKeys : [])].filter(Boolean));
    for (const reference of Array.isArray(source.announcementRefs) ? source.announcementRefs : []) {
      try {
        await telegram.deleteMessage(reference.channelId, reference.messageId);
        announcementMessages.deleted += 1;
      } catch (error) {
        announcementMessages.failed += 1;
        console.warn('[telegram] merged-post announcement delete failed:', reference.channelId, error?.description || error?.message || 'Unknown error');
      }
    }
    moved.push({
      adminId: source.adminId,
      title: cleanText(source.title, 70),
      files: (Array.isArray(source.files) ? source.files : []).length
    });
    await repository.deleteContentByAdminId(source.adminId);
  }

  if (!moved.length) {
    return {
      error: missing.length
        ? `None of the listed posts still exist (${missing.join(', ')}), so nothing was merged.`
        : 'Every listed post was refused, so nothing was merged.'
    };
  }

  // supersede: false — a Season 2 Episode 1 must land beside the Season 1
  // Episode 1, unlike a re-upload of the same delivery slot, which replaces it.
  const appended = await repository.appendFilesToContentByAdminId(target.adminId, movedFiles, aliases, { supersede: false });
  if (!appended) return { error: `The absorbed files could not be saved on ${target.adminId}. No card was deleted.` };

  let playersMerged = 0;
  if (movedPlayers.length && typeof repository.updateContentStreamByAdminId === 'function') {
    const stream = mergeStreamingEntries(appended.stream, movedPlayers.map((entry) => ({ entry })), { ...streamingOptionsFromConfig(config), granularity: 'exact' });
    if (stream) {
      await repository.updateContentStreamByAdminId(target.adminId, stream);
      playersMerged = movedPlayers.length;
    }
  }

  const content = await repository.findContentByAdminId(target.adminId);
  // The merged card shows a new episode summary, so its own announcement must
  // say the same thing.
  const sync = await syncPublishedAnnouncements({ telegram, repository, content, config });
  return {
    plan,
    content,
    moved,
    missing,
    blocked,
    filesMoved: movedFiles.length,
    playersMerged,
    announcementMessages,
    announcementSync: sync
  };
}

/**
 * Trim files off one card: a whole season block, or specific episodes. Season
 * attribution matches how the card was grouped, so "season 2" removes exactly
 * what the card shows under Season 2.
 */
export async function applyMergeDrop({ repository, bot, config = {}, adminId, drop = {} }) {
  const existing = await repository.findContentByAdminId(adminId);
  if (!existing) return { error: `No published catalog post was found for ${adminId}.` };
  const files = Array.isArray(existing.files) ? existing.files : [];
  if (!files.length) return { error: `${existing.title} has no files attached, so there is nothing to remove.` };
  const { entries, seasons } = attributeUploadSeasons(files);
  if (drop.mode === 'season' && !seasons.includes(drop.season)) {
    // A single-season card reports no blocks at all, so the season numbers that
    // are really present are read file by file to make the refusal useful.
    const present = [...new Set(files.map((file) => detectUploadSeasonForFile(file)).filter(Boolean))].sort((first, second) => first - second);
    const listing = present.length ? ` (${present.map((season) => `S${season}`).join(', ')})` : '';
    return { error: `${existing.adminId} has no Season ${drop.season} block${listing}. Nothing was removed.` };
  }

  const kept = [];
  const removed = [];
  for (const entry of entries) {
    if (drop.mode === 'season') {
      (entry.season === drop.season ? removed : kept).push(entry.file);
      continue;
    }
    const start = Number(entry.file?.episode?.start);
    const end = Number(entry.file?.episode?.end ?? entry.file?.episode?.start);
    const overlaps = Number.isInteger(start) && Number.isInteger(end) && start <= drop.end && end >= drop.start;
    const seasonOk = !drop.season || entry.season === drop.season;
    (overlaps && seasonOk ? removed : kept).push(entry.file);
  }
  if (!removed.length) {
    return { error: `Nothing on ${existing.adminId} matches ${describeMergeDrop(drop)}, so nothing was removed.` };
  }
  const content = await repository.replaceContentFilesByAdminId(existing.adminId, kept);
  if (!content) return { error: 'The card could not be saved. Nothing was removed.' };

  const players = publicStreamingData(content.stream, streamingOptionsFromConfig(config)).entries;
  const droppedEpisodes = removed.map((file) => Number(file?.episode?.start)).filter(Number.isInteger);
  const playersLeft = players.filter((entry) => {
    const entryStart = Number(entry.episode?.start);
    return Number.isInteger(entryStart) && droppedEpisodes.includes(entryStart);
  }).length;
  const sync = await syncPublishedAnnouncements({ telegram: bot?.telegram, repository, content, config });
  return {
    content,
    removed,
    remaining: kept.length,
    description: describeMergeDrop(drop),
    playersLeft,
    // The advice has to name the episodes that actually lost their files, not
    // the season number, because players are matched by episode number only.
    playerRange: droppedEpisodes.length
      ? (() => {
        const lowest = Math.min(...droppedEpisodes);
        const highest = Math.max(...droppedEpisodes);
        return lowest === highest ? `${lowest}` : `${lowest}-${highest}`;
      })()
      : null,
    announcementSync: sync
  };
}

function describeMergeDrop(drop = {}) {
  const seasonPart = drop.season ? `Season ${drop.season} ` : '';
  if (drop.mode === 'season') return `${seasonPart.trim()}`;
  return drop.end && drop.end !== drop.start
    ? `${seasonPart}Episodes ${String(drop.start).padStart(2, '0')}\u2013${String(drop.end).padStart(2, '0')}`
    : `${seasonPart}Episode ${String(drop.start).padStart(2, '0')}`;
}

function streamImportResultText(result, config) {
  const pages = [...new Set(result.updated
    .flatMap(({ content, entries }) => (entries || []).map((entry) => watchPageUrl(config, content, entry?.episode)))
    .filter(Boolean))]
    .slice(0, 4);
  const hasEpisodePlayers = result.updated.some(({ entries }) => (entries || []).some((entry) => episodePathRange(entry?.episode)));
  const success = result.updated.length
    ? `✅ Saved ${result.attachedRows} manual player link${result.attachedRows === 1 ? '' : 's'} on ${result.updated.length} existing catalog post${result.updated.length === 1 ? '' : 's'}. No Telegram announcement was sent.`
    : 'No Watch links were saved.';
  const availability = hasEpisodePlayers
    ? 'Matching episode delivery pages now show Watch beside their Telegram file action. Set PUBLIC_SITE_URL on Koyeb if you also want direct episode Watch URLs here.'
    : 'The Watch button is now available on the existing release page. Set PUBLIC_SITE_URL on Koyeb if you also want the bot to return its direct Watch URL.';
  return [
    success,
    pages.length ? `Watch page${pages.length === 1 ? '' : 's'}:\n${pages.join('\n')}` : result.updated.length ? availability : null,
    result.rejected.length ? streamImportIssueText(result.rejected).trimStart() : null
  ].filter(Boolean).join('\n\n');
}

async function handleStreamImportUpload(ctx, repository, config) {
  if (typeof repository?.findStreamImport !== 'function') return false;
  const pending = await repository.findStreamImport(chatId(ctx), userId(ctx));
  if (!pending) return false;
  const document = ctx.message?.document;
  if (!document) {
    const directInput = pending.targetAdminId && ctx.message?.text
      ? parseDirectStreamingInput(ctx.message.text)
      : null;
    if (directInput?.error) {
      await ctx.reply(directInput.error);
      return true;
    }
    if (directInput?.action === 'delete') {
      const outcome = await removeAttachedPlayers({ repository, targetAdminId: pending.targetAdminId, removal: directInput.delete, config });
      if (outcome.error) {
        await ctx.reply(`${outcome.error} Use /players ${pending.targetAdminId} to list the current players with their numbers.`);
        return true;
      }
      await repository.deleteStreamImport?.(chatId(ctx), userId(ctx));
      await ctx.reply(
        `Removed ${outcome.removed} player${outcome.removed === 1 ? '' : 's'} (${outcome.scope}) from “${outcome.content.title}”. ${outcome.remaining} player${outcome.remaining === 1 ? '' : 's'} still attached. No announcement was sent and no file was changed.`,
        playersKeyboard(outcome.content, playersList(outcome.content, config))
      );
      return true;
    }
    // A follow-up message may name the episode on every line, exactly like the
    // /cmd form, so one paste fills a whole run of episodes.
    const manual = pending.targetAdminId && ctx.message?.text
      ? buildManualPlayerManifest(pending.targetAdminId, ctx.message.text, config)
      : null;
    if (manual?.error) {
      await ctx.reply(manual.error);
      return true;
    }
    if (manual?.links) {
      const result = await applyStreamingManifest({
        repository,
        targetAdminId: pending.targetAdminId,
        config,
        granularity: 'exact',
        manifest: manual.manifest
      });
      if (result.updated.length) await repository.deleteStreamImport?.(chatId(ctx), userId(ctx));
      const rejectedNote = manual.rejected.length
        ? `\nSkipped ${manual.rejected.length} link${manual.rejected.length === 1 ? '' : 's'} from an unapproved host: ${manual.rejected.slice(0, 3).join(', ')}${manual.rejected.length > 3 ? '…' : ''}`
        : '';
      await ctx.reply(`${streamImportResultText(result, config)}${episodeCoverageNote(manual.episodes, manual.links)}${rejectedNote}${result.updated.length ? `\nManage them with /players ${pending.targetAdminId}` : ''}`);
      return true;
    }
    await ctx.reply(pending.targetAdminId
      ? 'Watch-link import is waiting for a .json/.csv document or approved player URLs. For one episode, send “ep 1 <player URL or iframe>”; several links in one message are all saved, and each line can carry its own “ep 176 …” label. To remove players, send “del ep 2-7” or “del 3”. Or use /cmd cancel.'
      : 'Watch-link import is waiting for one .json or .csv document. To paste one episode player directly, start with /cmd SB-0123ABCDEF ep 1 <player URL>.');
    return true;
  }
  const format = inferStreamManifestFormat(document);
  if (!format) {
    await ctx.reply('This does not look like a .json or .csv Watch-link export. Send the provider export as a document, or use /cmd cancel.');
    return true;
  }
  try {
    await ctx.reply('Checking the manual player-link manifest…');
    const archive = await downloadTelegramDocument({
      document,
      telegram: ctx.telegram,
      options: streamingDownloadOptionsFromConfig(config),
      label: 'streaming manifest'
    });
    const manifest = parseStreamingManifest(archive, {
      format,
      ...streamingOptionsFromConfig(config),
      allowMissingTarget: Boolean(pending.targetAdminId)
    });
    const result = await applyStreamingManifest({
      repository,
      manifest,
      targetAdminId: pending.targetAdminId || null,
      config
    });
    if (result.updated.length) await repository.deleteStreamImport?.(chatId(ctx), userId(ctx));
    await ctx.reply(streamImportResultText(result, config));
    if (!result.updated.length) {
      await ctx.reply('The import remains armed so you can correct the file and send it again, or use /cmd cancel.');
    }
  } catch (error) {
    const message = cleanText(error?.message || 'The streaming manifest could not be imported.', 500);
    console.error('[telegram] streaming manifest import failed:', message);
    await ctx.reply(`No Watch links were changed. ${message}\nThe import remains armed; correct the export and try again, or use /cmd cancel.`);
  }
  return true;
}

async function handleBackupRecoveryUpload(ctx, repository, config) {
  if (typeof repository?.findBackupRecovery !== 'function') return false;
  const recovery = await repository.findBackupRecovery(chatId(ctx), userId(ctx));
  if (!recovery) return false;
  const document = ctx.message?.document;
  if (!document) {
    await ctx.reply('Recovery is waiting for a signed SoraBox backup document. Send the .json.gz backup file as a document, not as a photo/video.');
    return true;
  }
  if (typeof repository.restoreBackupData !== 'function') {
    await ctx.reply('This catalog store cannot restore backup data.');
    return true;
  }
  try {
    await ctx.reply('Verifying the signed backup before replacing application data…');
    const archive = await downloadTelegramDocument({
      document,
      telegram: ctx.telegram,
      options: backupOptionsFromConfig(config)
    });
    const backup = readSignedBackupArchive({
      archive,
      signingSecret: config?.backup?.signingSecret,
      options: backupOptionsFromConfig(config)
    });
    const counts = await repository.restoreBackupData(backup.data);
    await repository.deleteBackupRecovery?.(chatId(ctx), userId(ctx));
    await ctx.reply([
      '✅ Backup recovery completed.',
      `Restored signed snapshot: ${backup.createdAt || 'unknown timestamp'}.`,
      `Application data restored: ${formatBackupCounts(counts)}.`,
      'Your current Telegram publisher login remains active; open /posts or /stats to verify the restored catalog.'
    ].join('\n'));
  } catch (error) {
    const message = cleanText(error?.message || 'The backup could not be restored.', 500);
    console.error('[telegram] backup recovery failed:', message);
    await ctx.reply(`Recovery was not applied. ${message}\nThe existing application data was left unchanged.`);
  }
  return true;
}

export async function launchTelegramBot({ config, repository }) {
  if (!config.telegram.botToken || config.telegram.mode !== 'polling') {
    console.info('[telegram] Bot polling is disabled; web catalog remains available.');
    return null;
  }

  const bot = new Telegraf(config.telegram.botToken);
  // Private Telegram activity is tracked only in the publisher-side repository
  // for aggregate analytics; it is never exposed from the public site API.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot && typeof repository.recordBotUser === 'function') {
      try {
        await repository.recordBotUser(ctx.from);
      } catch (error) {
        console.warn('[telegram] could not record bot activity:', automationDiagnostic(error));
      }
    }
    return next();
  });
  const ignoredAutoStorageMessageIds = new Set();
  const autoPublishInFlightMessageIds = new Set();
  let automationQueuePromise = null;
  const runAutomationQueue = () => {
    if (automationQueuePromise) return automationQueuePromise;
    automationQueuePromise = processQueuedAutomationSessions({ bot, repository, config })
      .catch((error) => {
        console.error('[telegram] persistent automation worker failed:', automationDiagnostic(error));
        return [];
      })
      .finally(() => {
        automationQueuePromise = null;
      });
    return automationQueuePromise;
  };
  const ignoreAutoStorageMessage = (messageId) => {
    const key = String(messageId);
    ignoredAutoStorageMessageIds.add(key);
    const timer = setTimeout(() => ignoredAutoStorageMessageIds.delete(key), 10 * 60 * 1000);
    timer.unref?.();
  };

  bot.on('channel_post', async (ctx) => {
    try {
      const queued = await autoPublishStoragePost(ctx, bot, repository, config, ignoredAutoStorageMessageIds, autoPublishInFlightMessageIds);
      // Also inspect an overdue group on incoming traffic; the interval below is
      // still the durable primary scheduler after quiet uploads and restarts.
      if (queued?.queued) void runAutomationQueue();
    } catch (error) {
      // This handler must never reply into the private database channel.
      console.error('[telegram] storage-channel automation handler failed:', error?.message || 'Unknown error');
    }
  });

  bot.start(async (ctx) => {
    const payload = parseStartPayload(ctx);
    const delivery = parseDeliveryPayload(payload);
    if (delivery) {
      await deliverContent(ctx, delivery, repository, config);
      return;
    }
    // Install the owner/admin scope as soon as an authorized person opens the
    // bot, not only after a later successful /login. This avoids Telegram's
    // command-menu cache leaving /posts or /postid absent for the owner.
    if (hasAllowedPublisherId(ctx, config) && config.adminLoginCode) await setPublisherCommands(bot, ctx);
    const publisher = await isPublisher(ctx, repository, config);
    await ctx.reply(publisher ? publisherWelcomeText() : visitorWelcomeText(hasAllowedPublisherId(ctx, config)), publisher ? panelKeyboard() : undefined);
  });

  bot.command('login', async (ctx) => {
    if (!hasAllowedPublisherId(ctx, config) || !config.adminLoginCode) {
      await ctx.reply(visitorWelcomeText(false));
      return;
    }
    const passcode = parseCommandArgument(ctx.message.text);
    if (!sameSecret(passcode, config.adminLoginCode)) {
      await ctx.reply('Login failed. Check the passcode and try again.');
      return;
    }
    const expiresAt = new Date(Date.now() + config.adminSessionHours * 60 * 60 * 1000);
    await repository.createAdminSession({ chatId: chatId(ctx), ownerId: userId(ctx), expiresAt });
    await setPublisherCommands(bot, ctx);
    await ctx.reply(`Publisher session unlocked for ${config.adminSessionHours} hour${config.adminSessionHours === 1 ? '' : 's'}.`, panelKeyboard());
  });

  bot.command('logout', async (ctx) => {
    await repository.deleteAdminSession(chatId(ctx), userId(ctx));
    // Keep the owner scope registered: visible command names never grant
    // access, while deleting the scope made Telegram intermittently hide
    // /posts and /postid until its command-menu cache refreshed.
    await ctx.reply('Publisher session locked. Publisher commands remain visible but are locked until /login; you can still open delivery links or use /request.');
  });

  bot.command('request', async (ctx) => {
    const requestText = parseCommandArgument(ctx.message.text);
    if (!requestText || requestText.length < 2) {
      await ctx.reply('Tell us what you are looking for. Example: /request Perfect World season 1 Hindi');
      return;
    }
    const request = await repository.createRequest({ requestText, requester: ctx.from });
    const logged = await logRequestToChannel(ctx, request, config);
    await ctx.reply(
      logged
        ? `Request received. Your reference is ${request.id}; the catalog team can review it now.`
        : `Request received. Your reference is ${request.id}. It was saved for the catalog team.`
    );
  });

  bot.command('help', async (ctx) => {
    if (await isPublisher(ctx, repository, config)) {
      await ctx.reply(
        [
          'Publisher quick guide',
          '1. /movie Title, /anime Title, /cartoon Title, /donghua Title, /kdrama Title, /series Title, or /18db Title',
          '2. Upload your files to this private chat',
          '3. Use /done to create the catalog post, permanent ImgBB poster, delivery link, and channel announcements',
          '',
          'Episode parsing checks a cleaned caption first, then the filename. @channel handles and t.me links are ignored.',
          'Batch import: /batch Optional title, then send FIRST and LAST https://t.me/c/<internal-channel-id>/<message-id> links. The range is inclusive; omit the title to infer it from file details. Optional category override: /batch anime | Your title.',
          '18+ publishing: /18db Title (or /adultdb Title) stores files only in TELEGRAM_ADULT_STORAGE_CHANNEL_ID. Use /batch adult | Your title for an existing adult-storage range. These releases are never sent to announcement channels and use the website age gate.',
          'Automation: /auto opens persistent ON/OFF controls. Matching direct-storage files are grouped by cleaned title and published once after 90 seconds of quiet (15-minute maximum); later matching uploads append silently to the same post.',
          'Draft metadata: /lang Hindi, English · /subtitles English · /year 2026 · /genres Action, Fantasy · /description Text · /poster HTTPS_URL. Ambiguous Dual/Multi or unlabeled media tracks are checked once at final publishing when Telegram download limits allow it.',
          'Artwork: /poster (also /p and /imgdd) asks which style you want. Old style sends the Post ID then an image link. New style sends the Post ID then the title, and you tap the exact poster found on AniList/TMDB/OMDb — it is mirrored to ImgBB and saved on the card.',
          'Edit published posts by ID: /lang SB-0123ABCDEF Hindi, English (aliases /lan and /lam) · /subtitles SB-0123ABCDEF English · /year SB-0123ABCDEF 2026 · /title SB-0123ABCDEF New title · /genres, /description, /poster, /category, /release, or /status followed by the post ID. Several posts at once works for category, languages, subtitles, genres, year, release, and status: /category SB-0123ABCDEF, SB-1122334455 anime — every named post is corrected and each posted announcement is edited with it.',
          'Manual Watch pages: /cmd SB-0123ABCDEF ep 2 <player URL> saves one player immediately — paste several links in one message and all of them are kept, and a Rumble or Dailymotion page link works as sent. /cmd SB-0123ABCDEF ep 2-7 <URL> covers a whole episode range, and the provider’s small JSON/CSV export still works for a full season. /players SB-0123ABCDEF lists what is attached with Remove buttons, and /cmd SB-0123ABCDEF del ep 2-7 removes a range. It updates only the existing post, never uploads media through Koyeb and never sends an announcement.',
          'Merging cards: /merge <exact title> <target Post ID> <Post ID to absorb> [more IDs] — the target keeps its ID, slug, poster, and delivery links, every file and player of the others moves onto it, its season blocks are rebuilt, and the absorbed cards plus their announcement messages are deleted. Nothing changes until you tap Confirm merge. /merge drop SB-0123ABCDEF season 2 (or ep 5, or season 2 ep 5-7) trims files back off one card; /merge help lists every form.',
          'Management: /status · /teststorage · /cancel · /posts 50 · /postid · /stats · /cmd · /backup · /recover · /delete POST_ID[, POST_ID] · /addchannel CHANNEL_ID · /channels · /requests · /logout'
        ].join('\n'),
        panelKeyboard()
      );
    } else {
      await ctx.reply(visitorWelcomeText(hasAllowedPublisherId(ctx, config)));
    }
  });

  bot.command('panel', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    await ctx.reply('Choose a category for a new draft.', panelKeyboard());
  });

  for (const category of PUBLISH_CATEGORIES) {
    const command = categoryCommandLabel(category);
    bot.command(command, async (ctx) => {
      if (!(await requirePublisher(ctx, repository, config))) return;
      await beginDraft(ctx, category, parseCommandArgument(ctx.message.text), repository, config);
    });
  }

  // The letter-first /adultdb name is listed in Telegram's command menu, while
  // /18db is the short publisher alias requested for the isolated category.
  bot.command('18db', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    await beginDraft(ctx, ADULT_CATEGORY, parseCommandArgument(ctx.message.text), repository, config);
  });

  bot.command('batch', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    await beginBatch(ctx, parseCommandArgument(ctx.message.text), repository, config);
  });

  bot.command('auto', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const settings = await repository.getAutoPublishSettings();
    await ctx.reply(autoPublishStatusText(settings, config), autoPublishKeyboard(Boolean(settings?.enabled)));
  });

  bot.command('title', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const postTarget = parsePublishedPostEdit(argument);
    if (postTarget) {
      if (!postTarget.value) {
        await ctx.reply(`Usage: /title ${postTarget.adminId} Your corrected title`);
        return;
      }
      await updatePublishedPost({ ctx, repository, argument, field: 'title', fieldLabel: 'Title' });
      return;
    }
    if (!argument) {
      await ctx.reply('Usage: /title Your release title\nEdit an existing post: /title SB-0123ABCDEF Corrected title');
      return;
    }
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session) {
      await ctx.reply('Start a draft first using /panel.');
      return;
    }
    await updateTitleAndMetadata({ ctx, repository, config, title: argument });
  });

  const handleLanguageCommand = async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const postTarget = parsePublishedPostEdit(argument);
    if (postTarget) {
      const languages = parseDelimitedList(postTarget.value);
      if (!languages.length) {
        await ctx.reply(`Usage: /lang ${postTarget.adminIds.join(', ')} Hindi, English\nSeveral posts at once: /lang SB-0123ABCDEF, SB-1122334455 Hindi, English`);
        return;
      }
      await updatePublishedPost({
        ctx,
        repository,
        argument,
        field: 'languages',
        value: languages,
        fieldLabel: 'Audio languages'
      });
      return;
    }
    const languages = parseDelimitedList(argument);
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session || !languages.length) {
      await ctx.reply('Usage: /lang Hindi, English\nEdit an existing post: /lang SB-0123ABCDEF Hindi, English\nSeveral posts at once: /lang SB-0123ABCDEF, SB-1122334455 Hindi, English');
      return;
    }
    const overrides = { ...(session.overrides || {}), languages };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply(`Languages saved: ${languages.join(', ')}`);
  };
  for (const command of ['lang', 'lan', 'lam']) bot.command(command, handleLanguageCommand);

  const handleSubtitleCommand = async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const postTarget = parsePublishedPostEdit(argument);
    const languages = parseDelimitedList(postTarget ? postTarget.value : argument);
    if (!languages.length) {
      await ctx.reply(postTarget
        ? `Usage: /subtitles ${postTarget.adminIds.join(', ')} English, Hindi\nSeveral posts at once: /subtitles SB-0123ABCDEF, SB-1122334455 English, Hindi`
        : 'Usage: /subtitles English, Hindi\nEdit an existing post: /subtitles SB-0123ABCDEF English, Hindi\nSeveral posts at once: /subtitles SB-0123ABCDEF, SB-1122334455 English, Hindi');
      return;
    }
    if (postTarget) {
      await updatePublishedPost({ ctx, repository, argument, field: 'subtitleLanguages', value: languages, fieldLabel: 'Subtitle languages' });
      return;
    }
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session) {
      await ctx.reply('Start a draft first using /panel.');
      return;
    }
    const overrides = { ...(session.overrides || {}), subtitleLanguages: languages };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply(`Subtitle languages saved: ${languages.join(', ')}`);
  };
  for (const command of ['subtitles', 'subs']) bot.command(command, handleSubtitleCommand);

  bot.command('year', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const postTarget = parsePublishedPostEdit(argument);
    const suppliedYear = Number.parseInt(postTarget ? postTarget.value : argument, 10);
    if (!Number.isInteger(suppliedYear) || suppliedYear < 1888 || suppliedYear > new Date().getFullYear() + 5) {
      await ctx.reply(postTarget
        ? `Usage: /year ${postTarget.adminIds.join(', ')} 2026\nSeveral posts at once: /year SB-0123ABCDEF, SB-1122334455 2026`
        : 'Usage: /year 2026\nEdit an existing post: /year SB-0123ABCDEF 2026\nSeveral posts at once: /year SB-0123ABCDEF, SB-1122334455 2026');
      return;
    }
    if (postTarget) {
      await updatePublishedPost({
        ctx,
        repository,
        argument,
        field: 'year',
        value: suppliedYear,
        fieldLabel: 'Year'
      });
      return;
    }
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session) {
      await ctx.reply('Start a draft first using /panel.');
      return;
    }
    const overrides = { ...(session.overrides || {}), year: suppliedYear };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply(`Year saved: ${suppliedYear}`);
  });

  bot.command('genres', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const postTarget = parsePublishedPostEdit(argument);
    const genres = parseDelimitedList(postTarget ? postTarget.value : argument);
    if (!genres.length) {
      await ctx.reply(postTarget
        ? `Usage: /genres ${postTarget.adminIds.join(', ')} Action, Fantasy\nSeveral posts at once: /genres SB-0123ABCDEF, SB-1122334455 Action, Fantasy`
        : 'Usage: /genres Action, Fantasy\nEdit an existing post: /genres SB-0123ABCDEF Action, Fantasy\nSeveral posts at once: /genres SB-0123ABCDEF, SB-1122334455 Action, Fantasy');
      return;
    }
    if (postTarget) {
      await updatePublishedPost({ ctx, repository, argument, field: 'genres', value: genres, fieldLabel: 'Genres' });
      return;
    }
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session) {
      await ctx.reply('Start a draft first using /panel.');
      return;
    }
    const overrides = { ...(session.overrides || {}), genres };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply(`Genres saved: ${genres.join(', ')}`);
  });

  bot.command('description', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, 1_500);
    const postTarget = parsePublishedPostEdit(argument);
    const description = cleanText(postTarget ? postTarget.value : argument, 1400);
    if (!description) {
      await ctx.reply(postTarget ? `Usage: /description ${postTarget.adminId} A short, readable synopsis` : 'Usage: /description A short, readable synopsis\nEdit an existing post: /description SB-0123ABCDEF New synopsis');
      return;
    }
    if (postTarget) {
      await updatePublishedPost({ ctx, repository, argument, field: 'description', value: description, fieldLabel: 'Description' });
      return;
    }
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session) {
      await ctx.reply('Start a draft first using /panel.');
      return;
    }
    const overrides = { ...(session.overrides || {}), description };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply('Description saved.');
  });

  const handlePosterCommand = async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, 2_000);
    if (!argument || /^(help|style|menu|\?)$/i.test(argument)) {
      if (typeof repository.startPosterFlow === 'function') {
        await repository.startPosterFlow({
          chatId: chatId(ctx),
          ownerId: userId(ctx),
          stage: 'style',
          targetAdminId: null,
          query: '',
          candidates: []
        });
        await ctx.reply('How should I set this poster?', posterStyleKeyboard());
        return;
      }
      await ctx.reply(POSTER_COMMAND_USAGE);
      return;
    }

    const postTarget = parsePublishedPostEdit(argument);
    const posterValue = postTarget ? postTarget.value : argument;

    // Artwork is per-release identity, so a list of post IDs is refused here
    // instead of quietly changing only the first one.
    if (postTarget && postTarget.adminIds.length > 1) {
      await ctx.reply(`Poster artwork is set one post at a time, because every release keeps its own image. Send /poster ${postTarget.adminIds[0]} <image link or title>${postTarget.adminIds.length > 2 ? ` (and repeat it for ${postTarget.adminIds.slice(1).join(', ')})` : ''}. Category, languages, subtitles, genres, year, release, and status do accept a list.`);
      return;
    }

    // Old style: an explicit image link is validated, mirrored, and saved.
    if (posterValue.startsWith('https://')) {
      if (postTarget) {
        try {
          await ctx.reply(`Mirroring the new poster for ${postTarget.adminId} to ImgBB…`);
          const result = await mirrorPosterForPublishedPost({
            ctx,
            repository,
            adminId: postTarget.adminId,
            sourceUrl: posterValue,
            config
          });
          if (!result) return;
          await ctx.reply(result.updated
            ? `Poster updated for ${result.updated.adminId} · ${result.updated.title}.`
            : `The poster was mirrored, but ${postTarget.adminId} is no longer available.`);
        } catch (error) {
          const message = error instanceof PosterHostingError
            ? error.message
            : 'The new poster could not be mirrored to ImgBB. The existing poster is unchanged.';
          console.error('[telegram] published-poster edit failed:', error?.message || 'Unknown error');
          await ctx.reply(`Poster was not changed. ${message}`);
        }
        return;
      }
      const session = await repository.findSession(chatId(ctx), userId(ctx));
      if (!session) {
        await ctx.reply('Start a draft first using /panel.');
        return;
      }
      await repository.updateSession(chatId(ctx), userId(ctx), { posterOriginalUrl: posterValue });
      await ctx.reply('Manual poster saved. It will be validated, downloaded once, and mirrored to ImgBB during publishing.');
      return;
    }

    // New style: search provider artwork for the supplied title and let the
    // publisher tap the exact poster they want.
    if (postTarget && !posterValue) {
      await ctx.reply(`Usage: /poster ${postTarget.adminId} Exact Title — I will show the artwork I can find, or send a direct HTTPS image link instead.`);
      return;
    }
    await presentPosterCandidates({
      ctx,
      repository,
      config,
      adminId: postTarget?.adminId || null,
      query: posterValue
    });
  };
  // /p is the short form publishers asked for, and /imgdd follows the identical
  // old/new flow so artwork handling has exactly one behaviour to learn.
  for (const command of ['poster', 'p', 'imgdd']) bot.command(command, handlePosterCommand);

  bot.action(/^poster:(?:style:(?:old|new)|cancel|retry|pick:\d{1,2})$/, async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    const handled = await handlePosterAction(ctx, repository, config, ctx.match?.[0] || '');
    if (!handled) await acknowledgeTap(ctx, 'That poster button is no longer active.');
  });

  bot.command('category', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const target = parsePublishedPostEdit(argument);
    const rawCategory = String(target?.value || '').trim().toLowerCase().replace(/[\s_-]+/g, '-');
    const category = rawCategory === 'webseries'
      ? 'web-series'
      : rawCategory === 'k-drama' || rawCategory === 'kdrama'
        ? 'kdrama'
        : rawCategory === '18+' || rawCategory === '18'
          ? ADULT_CATEGORY
          : rawCategory;
    if (!target || !PUBLISH_CATEGORIES.includes(category)) {
      await ctx.reply('Usage: /category SB-0123ABCDEF anime\nSeveral posts at once: /category SB-0123ABCDEF, SB-1122334455 anime\nCategories: anime, cartoon, donghua, kdrama, movie, web-series, adult');
      return;
    }
    // The 18+ storage boundary is decided per post: one restricted card in a
    // list must not cancel the rest of the batch, and it must not be moved.
    await updatePublishedPost({
      ctx,
      repository,
      argument,
      field: 'category',
      value: category,
      fieldLabel: 'Category',
      guard: (content) => (isAdultCategory(content.category) !== isAdultCategory(category)
        ? '18+ boundary: use /18db for that release'
        : null)
    });
  });

  bot.command('release', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const target = parsePublishedPostEdit(argument);
    if (!target?.value) {
      await ctx.reply('Usage: /release SB-0123ABCDEF Season 2 · 12 episodes\nSeveral posts at once: /release SB-0123ABCDEF, SB-1122334455 Season 2 · 12 episodes');
      return;
    }
    await updatePublishedPost({ ctx, repository, argument, field: 'releaseLabel', fieldLabel: 'Release label' });
  });

  bot.command('status', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const argument = parseCommandArgument(ctx.message.text, POST_EDIT_ARGUMENT_LIMIT);
    const target = parsePublishedPostEdit(argument);
    if (target) {
      if (!target.value) {
        await ctx.reply(`Usage: /status ${target.adminIds.join(', ')} New release\nSeveral posts at once: /status SB-0123ABCDEF, SB-1122334455 Ongoing`);
        return;
      }
      await updatePublishedPost({ ctx, repository, argument, field: 'status', fieldLabel: 'Status' });
      return;
    }
    await showDraftStatus(ctx, repository);
  });

  bot.command('teststorage', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    if (!config.telegram.storageChannelId) {
      await ctx.reply('TELEGRAM_STORAGE_CHANNEL_ID is not configured. Add the private channel’s numeric -100… ID and restart the service.');
      return;
    }
    try {
      await ctx.telegram.sendMessage(
        config.telegram.storageChannelId,
        `SoraBox storage check · ${new Date().toISOString()}`,
        { disable_notification: true }
      );
      await ctx.reply('Storage channel connection is working. If a particular upload still fails, it is likely protected/forwarded content; upload the original file directly to this bot so the file-ID fallback can store it.');
    } catch (error) {
      console.error('[telegram] storage check failed:', error?.description || error?.message || 'Unknown error');
      await ctx.reply(`Storage channel test failed. ${storageErrorHint(error)}`);
    }
  });

  bot.command('cancel', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    await repository.deleteSession(chatId(ctx), userId(ctx));
    await repository.deleteBackupRecovery?.(chatId(ctx), userId(ctx));
    await repository.deleteStreamImport?.(chatId(ctx), userId(ctx));
    await repository.deleteMergePlan?.(chatId(ctx), userId(ctx));
    await ctx.reply('Draft, pending backup recovery, manual Watch-link import, or merge plan discarded. No catalog record was created or deleted.', panelKeyboard());
  });

  bot.command('done', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    await publishDraft(ctx, bot, repository, config);
  });

  bot.command('delete', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const adminIds = postIdsFromCommand(ctx.message.text);
    if (!adminIds.length) {
      await ctx.reply('Usage: /delete SB-0123ABCDEF\nYou can remove several unwanted cards at once: /delete SB-0123ABCDEF, SB-FEDCBA3210\nUse /posts 50 to list recent post IDs.');
      return;
    }

    const removed = [];
    const missing = [];
    for (const adminId of adminIds) {
      const content = await repository.deleteContentByAdminId(adminId);
      if (content) removed.push(content);
      else missing.push(adminId);
    }
    if (!removed.length) {
      await ctx.reply(`No published post was found for ${missing.join(', ')}.`);
      return;
    }
    await ctx.reply([
      `Deleted ${removed.length} catalog post${removed.length === 1 ? '' : 's'}: ${removed.map((content) => content.adminId).join(', ')}.`,
      'Their delivery links no longer resolve. The original files remain in the private storage channel so you can manage them separately.',
      missing.length ? `Not found: ${missing.join(', ')}.` : null
    ].filter(Boolean).join('\n'));
  });

  // ── /merge: absorb other cards into one, then delete them and their
  //    announcements. Destructive, so the plan is always shown first.
  bot.command('merge', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    if (ctx.chat?.type && ctx.chat.type !== 'private') {
      await ctx.reply('For safety, run /merge in your private publisher chat — it deletes catalog posts.');
      return;
    }
    if (typeof repository.startMergePlan !== 'function' || typeof repository.findMergePlan !== 'function') {
      await ctx.reply('This catalog store cannot hold a pending merge plan, so /merge is unavailable here.');
      return;
    }
    const parsed = parseMergeCommand(parseCommandArgument(ctx.message.text, 1_200));
    if (parsed.action === 'help') {
      await ctx.reply(mergeInstructions());
      return;
    }
    if (parsed.error) {
      await ctx.reply(`${parsed.error}\nSend /merge help for the full form, including how to drop one season or a few episodes.`);
      return;
    }
    if (parsed.action === 'cancel') {
      await repository.deleteMergePlan?.(chatId(ctx), userId(ctx));
      await ctx.reply('Merge cancelled. No post was merged or deleted.', panelKeyboard());
      return;
    }
    if (parsed.action === 'confirm') {
      const pending = await repository.findMergePlan?.(chatId(ctx), userId(ctx));
      if (!pending?.plan) {
        await ctx.reply('There is no merge waiting for confirmation. Start one with /merge Title SB-TARGET SB-SOURCE.');
        return;
      }
      const outcome = await applyMergePlan({ bot, repository, config, plan: pending.plan });
      if (outcome.error) {
        await ctx.reply(outcome.error);
        return;
      }
      await repository.deleteMergePlan?.(chatId(ctx), userId(ctx));
      await replyBatchDiagnostics(ctx, [mergeResultText(outcome, config)]);
      return;
    }
    if (parsed.action === 'drop') {
      const outcome = await applyMergeDrop({ repository, bot, config, adminId: parsed.targetAdminId, drop: parsed.drop });
      if (outcome.error) {
        await ctx.reply(outcome.error);
        return;
      }
      await repository.deleteMergePlan?.(chatId(ctx), userId(ctx));
      await ctx.reply(mergeDropResultText(outcome, config));
      return;
    }

    const resolved = await resolveMergePlan({ repository, parsed });
    if (resolved.error) {
      await ctx.reply(resolved.error);
      return;
    }
    await repository.startMergePlan({ chatId: chatId(ctx), ownerId: userId(ctx), plan: resolved.plan });
    await ctx.reply(mergePlanText(resolved.plan, config), mergeConfirmKeyboard());
  });

  bot.action(/^mrg:(go|no|peek)$/, async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    const pending = await repository.findMergePlan?.(chatId(ctx), userId(ctx));
    if (ctx.match[0] === 'peek') {
      await acknowledgeTap(ctx, pending?.plan ? 'The plan is in the message above.' : 'That merge plan expired.');
      return;
    }
    if (!pending?.plan) {
      await acknowledgeTap(ctx, 'That merge plan expired. Run /merge again.', { alert: true });
      await ctx.editMessageReplyMarkup?.(null)?.catch?.(() => {});
      return;
    }
    await repository.deleteMergePlan?.(chatId(ctx), userId(ctx));
    if (ctx.match[0] === 'no') {
      await acknowledgeTap(ctx, 'Merge cancelled');
      await ctx.editMessageText(`${ctx.message?.text || ''}\n\nCancelled — nothing was merged.`).catch(() => {});
      return;
    }
    const outcome = await applyMergePlan({ bot, repository, config, plan: pending.plan });
    await acknowledgeTap(ctx, outcome.error ? 'This merge could not be applied' : `Merged ${outcome.moved?.length || 0} post(s)`);
    if (outcome.error) {
      await ctx.reply(`${outcome.error}\nNothing else was changed.`);
      return;
    }
    await ctx.editMessageReplyMarkup?.(null)?.catch?.(() => {});
    await replyBatchDiagnostics(ctx, [mergeResultText(outcome, config)]);
  });

  bot.command('posts', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const suppliedLimit = Number.parseInt(parseCommandArgument(ctx.message.text), 10);
    const limit = Number.isInteger(suppliedLimit) ? Math.max(1, Math.min(suppliedLimit, 50)) : 25;
    const posts = await repository.listAdminContent(limit);
    if (!posts.length) {
      await ctx.reply('There are no catalog posts yet.');
      return;
    }
    await replyBatchDiagnostics(ctx, [
      `Recent catalog posts (${posts.length}) — copy an ID into /delete.`,
      ...posts.map((post, index) => {
        const episodes = post.episodeCount ? ` · ${post.episodeCount} episode${post.episodeCount === 1 ? '' : 's'}` : '';
        return `${index + 1}. ${post.adminId} · ${cleanText(post.title, 74)} — ${categoryDetails(post.category).shortLabel} · ${post.filesCount || 0} file${post.filesCount === 1 ? '' : 's'}${episodes}`;
      }),
      '',
      'Tip: /delete accepts multiple IDs in one message.'
    ]);
  });

  bot.command('postid', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    await ctx.reply('Choose an upload period. I will return the post IDs and names uploaded in that time window.', postIdKeyboard());
  });

  bot.command('stats', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    if (typeof repository.getPublisherStats !== 'function') {
      await ctx.reply('Publisher statistics are not available in this catalog store.');
      return;
    }
    const stats = await repository.getPublisherStats();
    await ctx.reply(formatPublisherStats(stats));
  });

  bot.command('cmd', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    if (ctx.chat?.type && ctx.chat.type !== 'private') {
      await ctx.reply('For safety, run /cmd in your private publisher chat, then send the small JSON/CSV player-link export there.');
      return;
    }
    if (typeof repository.startStreamImport !== 'function' || typeof repository.findContentByAdminId !== 'function') {
      await ctx.reply('Manual Watch-link import is not available in this catalog store.');
      return;
    }
    const argument = parseMultilineCommandArgument(ctx.message.text, 6_000);
    if (/^(?:cancel|stop)$/i.test(argument)) {
      await repository.deleteStreamImport?.(chatId(ctx), userId(ctx));
      await ctx.reply('Manual Watch-link import cancelled. No player links were changed.', panelKeyboard());
      return;
    }
    if (/^(?:help|example)$/i.test(argument)) {
      await ctx.reply(streamImportInstructions());
      return;
    }
    if (await repository.findBackupRecovery?.(chatId(ctx), userId(ctx))) {
      await ctx.reply('A backup recovery is waiting for a document. Finish it or use /cancel first, then start /cmd.');
      return;
    }

    const target = argument.match(/^(SB-[A-F0-9]{10})(?:\s+([\s\S]+))?$/i);
    if (argument && !target) {
      await ctx.reply('Usage: /cmd SB-0123ABCDEF ep 1 <player URL or iframe> for one episode (several links in one message are all saved), /cmd SB-0123ABCDEF ep 2-7 <URL> for a range, /cmd SB-0123ABCDEF with \u201cep 176 <URL>\u201d and \u201cep 177 <URL>\u201d on separate lines for several episodes at once, /cmd SB-0123ABCDEF <player URL or iframe> for a release-wide player, /cmd SB-0123ABCDEF del ep 2-7 to remove players, or /cmd SB-0123ABCDEF followed by a JSON/CSV export. Use /cmd help for the manifest fields, or /players SB-0123ABCDEF to see what is attached.');
      return;
    }
    const targetAdminId = target?.[1]?.toUpperCase() || null;
    const directValue = cleanMultilineText(target?.[2] || '', 4_800);
    if (targetAdminId) {
      const content = await repository.findContentByAdminId(targetAdminId);
      if (!content) {
        await ctx.reply(`No published catalog post was found for ${targetAdminId}. Use /posts or /postid to find its private ID.`);
        return;
      }
      if (directValue) {
        const directInput = parseDirectStreamingInput(directValue);
        if (directInput.error) {
          await ctx.reply(directInput.error);
          return;
        }
        if (directInput.action === 'delete') {
          const outcome = await removeAttachedPlayers({ repository, targetAdminId, removal: directInput.delete, config });
          if (outcome.error) {
            await ctx.reply(`${outcome.error} Use /players ${targetAdminId} to list the current players with their numbers.`);
            return;
          }
          await repository.deleteStreamImport?.(chatId(ctx), userId(ctx));
          await ctx.reply(
            `Removed ${outcome.removed} player${outcome.removed === 1 ? '' : 's'} (${outcome.scope}) from “${outcome.content.title}”. ${outcome.remaining} player${outcome.remaining === 1 ? '' : 's'} still attached. No announcement was sent and no file was changed.`,
            playersKeyboard(outcome.content, playersList(outcome.content, config))
          );
          return;
        }
        // Each labeled line becomes its own episode group, and every link of a
        // group is attached to that group's episode.
        const manual = buildManualPlayerManifest(targetAdminId, directValue, config);
        if (manual.error) {
          await ctx.reply(manual.error);
          return;
        }
        const { manifest } = manual;
        const links = { urls: manifest.entries, rejected: manual.rejected };
        if (!links.urls.length) {
          await ctx.reply('That player URL or iframe is not an approved HTTPS streaming source. SeekStreaming Embed Link/Embed Code, Dailymotion, and Rumble are accepted by default; page links are converted to their embeddable player URL automatically. Add another trusted domain through STREAMING_ALLOWED_HOSTS. For an episode-specific player, use /cmd SB-0123ABCDEF ep 1 <player URL>.');
          return;
        }
        const result = await applyStreamingManifest({
          repository,
          targetAdminId,
          config,
          // Manual links are added, never silently replaced: a second source for
          // the same episode is a deliberate choice by the publisher.
          granularity: 'exact',
          manifest
        });
        await repository.deleteStreamImport?.(chatId(ctx), userId(ctx));
        const rejectedNote = links.rejected.length
          ? `\nSkipped ${links.rejected.length} link${links.rejected.length === 1 ? '' : 's'} from an unapproved host: ${links.rejected.slice(0, 3).join(', ')}${links.rejected.length > 3 ? '…' : ''}`
          : '';
        await ctx.reply(`${streamImportResultText(result, config)}${episodeCoverageNote(manual.episodes, manifest.entries.length)}${rejectedNote}${result.updated.length ? `\nManage them with /players ${targetAdminId}` : ''}`);
        return;
      }
    }

    await repository.startStreamImport({ chatId: chatId(ctx), ownerId: userId(ctx), targetAdminId });
    await ctx.reply(streamImportInstructions(targetAdminId));
  });

  // ── /players: the list view of attached players, with Remove buttons. The
  //    numbers here are the numbers `del <n>` uses, so a wrong or bulk import is
  //    reversible without remembering provider URLs.
  bot.command('players', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    if (typeof repository.findContentByAdminId !== 'function') {
      await ctx.reply('Player management is not available in this catalog store.');
      return;
    }
    const argument = parseCommandArgument(ctx.message.text, 120);
    const targetAdminId = postIdsFromCommand(argument)[0] || null;
    const scoped = targetAdminId ? cleanText(String(argument).replace(targetAdminId, ' '), 80) : String(argument || '');
    let view = parsePlayersView(scoped);
    if (view.error) {
      await ctx.reply(view.error);
      return;
    }
    if (!targetAdminId) {
      const posts = typeof repository.listAdminContent === 'function' ? await repository.listAdminContent(10) : [];
      await ctx.reply([
        'Usage: /players SB-0123ABCDEF',
        'That lists every player attached to a release and lets you remove one, an episode range, or all of them.',
        'A card with many episodes is easier to narrow than to scroll: /players SB-0123ABCDEF 176 (that episode), ep 170-180 (a range), missing (the episodes nobody has filled yet), #12 (row twelve), or 3 (page three). The buttons below the list do the same, and a Remove button always names the card it acts on.',
        posts.length ? `Recent post IDs:\n${posts.map((post) => `▪ ${post.adminId} — ${cleanText(post.title, 60)}`).join('\n')}` : 'No published posts were found in this bot store yet.'
      ].join('\n'));
      return;
    }
    const content = await repository.findContentByAdminId(targetAdminId);
    if (!content) {
      await ctx.reply(`No published catalog post was found for ${targetAdminId}. Use /posts or /postid to find its private ID.`);
      return;
    }
    // Re-read with the card in hand: a bare number means the episode they are
    // looking for on a card that has it, and a page number on one that does not.
    view = parsePlayersView(scoped, content);
    const entries = playersList(content, config);
    if (view.mode === 'missing') {
      await ctx.reply(playersMissingText(content, entries, config), playersKeyboard(content, entries, { mode: 'missing', page: 1 }));
      return;
    }
    await ctx.reply(playersListText(content, entries, config, view), playersKeyboard(content, entries, view));
  });

  const renderPlayersMessage = async (adminId, playersView) => {
    const latest = await repository.findContentByAdminId?.(adminId);
    if (!latest) return 'gone';
    const latestEntries = playersList(latest, config);
    const text = playersView.mode === 'missing'
      ? playersMissingText(latest, latestEntries, config, playersView)
      : playersListText(latest, latestEntries, config, playersView);
    return ctx.editMessageText(text, playersKeyboard(latest, latestEntries, playersView))
      .then(() => 'edited')
      .catch(() => 'reply');
  };

  bot.action(/^ply:rem:([A-Z0-9-]{4,40}):(all|\d{1,4})(?::([a-z0-9-]{1,16}):(\d{1,4}))?$/, async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    const [, removalAdminId, rawTarget, rawView, rawPage] = ctx.match;
    const view = rawView ? { ...playersViewFromKey(rawView), page: Number(rawPage) || 1 } : { mode: 'all', page: 1 };
    const removal = rawTarget === 'all'
      ? { mode: 'all' }
      : { mode: 'index', indexes: [Number(rawTarget)] };
    let outcome;
    try {
      outcome = await removeAttachedPlayers({ repository, targetAdminId: removalAdminId, removal, config });
    } catch (error) {
      console.error('[telegram] player removal failed:', error?.message || 'Unknown error');
      await acknowledgeTap(ctx, 'The player could not be removed. Nothing was changed.', { alert: true });
      return;
    }
    if (outcome.error) {
      await acknowledgeTap(ctx, `${outcome.error} Nothing was changed.`, { alert: true });
      return;
    }
    const entries = playersList(outcome.content, config);
    const note = `Removed ${outcome.removed} player${outcome.removed === 1 ? '' : 's'} (${outcome.scope}) from “${outcome.content.title}”. ${outcome.remaining} still attached. No announcement was sent and no file was changed.`;
    // The same view comes back, so clearing one episode's players never throws the
    // publisher to page one of everything they were not looking at.
    const pages = Math.max(1, Math.ceil(entries.length / PLAYERS_PAGE_SIZE));
    const nextView = { ...view, page: entries.length ? Math.min(view.page || 1, pages) : 1 };
    const rendered = await renderPlayersMessage(outcome.content.adminId, nextView);
    if (rendered === 'reply') {
      await ctx.reply(playersListText(outcome.content, entries, config, nextView), playersKeyboard(outcome.content, entries, nextView)).catch(() => {});
    } else if (rendered === 'gone') {
      await ctx.reply(note).catch(() => {});
    }
    await acknowledgeTap(ctx, `Removed ${outcome.removed} player${outcome.removed === 1 ? '' : 's'}`);
  });

  bot.action(/^ply:remep:([A-Z0-9-]{4,40}):(\d{1,3})-(\d{1,3})$/, async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    const [, episodeAdminId, rawStart, rawEnd] = ctx.match;
    const start = Number(rawStart);
    const end = Number(rawEnd) || start;
    const view = { mode: 'episode', episode: { start, end, label: directEpisodeLabel(start, end) }, page: 1 };
    const outcome = await removeAttachedPlayers({ repository, targetAdminId: episodeAdminId, removal: { mode: 'episode', episode: view.episode }, config });
    if (outcome.error) {
      await acknowledgeTap(ctx, `${outcome.error} Nothing was changed.`, { alert: true });
      return;
    }
    const rendered = await renderPlayersMessage(episodeAdminId, view);
    if (rendered === 'reply') {
      const content = await repository.findContentByAdminId?.(episodeAdminId);
      if (content) {
        const entries = playersList(content, config);
        await ctx.reply(playersListText(content, entries, config, view), playersKeyboard(content, entries, view)).catch(() => {});
      }
    }
    await acknowledgeTap(ctx, `Removed ${outcome.removed} player${outcome.removed === 1 ? '' : 's'}`);
  });

  bot.action(/^ply:pag:([A-Z0-9-]{4,40}):([a-z0-9-]{1,16}):(\d{1,4})$/, async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    const [, pageAdminId, rawView, rawPage] = ctx.match;
    const view = { ...playersViewFromKey(rawView), page: Number(rawPage) || 1 };
    const rendered = await renderPlayersMessage(pageAdminId, view);
    if (rendered === 'gone') {
      await acknowledgeTap(ctx, 'That post is no longer available. Use /posts to find its current private ID.', { alert: true });
      return;
    }
    if (rendered === 'reply') {
      const content = await repository.findContentByAdminId?.(pageAdminId);
      if (content) {
        const entries = playersList(content, config);
        await ctx.reply(view.mode === 'missing'
          ? playersMissingText(content, entries, config, view)
          : playersListText(content, entries, config, view), playersKeyboard(content, entries, view)).catch(() => {});
      }
      return;
    }
    await acknowledgeTap(ctx, view.mode === 'episode' ? view.episode.label : view.mode === 'missing' ? 'Episodes without a player' : `Page ${view.page}`);
  });

  bot.action(/^ply:add:([A-Z0-9-]{4,40})$/, async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    const [, addAdminId] = ctx.match;
    const content = await repository.findContentByAdminId?.(addAdminId);
    if (!content) {
      await acknowledgeTap(ctx, 'That post is no longer available. Use /posts to find its current private ID.', { alert: true });
      return;
    }
    if (typeof repository.startStreamImport !== 'function') {
      await acknowledgeTap(ctx, 'Player links can only be pasted in the private publisher chat.', { alert: true });
      return;
    }
    await repository.startStreamImport({ chatId: chatId(ctx), ownerId: userId(ctx), targetAdminId: content.adminId });
    await acknowledgeTap(ctx, 'Now paste the player URL or the provider export');
    await ctx.reply(streamImportInstructions(content.adminId));
  });

  bot.action(/^ply:close$/, async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    await acknowledgeTap(ctx, 'Player list closed. Use /players SB-0123ABCDEF to show it again.');
  });

  bot.command('backup', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    if (!config.telegram.storageChannelId) {
      await ctx.reply('TELEGRAM_STORAGE_CHANNEL_ID is required before I can send a private backup file.');
      return;
    }
    try {
      await ctx.reply('Creating a signed, compressed application backup and sending it only to the private storage channel…');
      const createdAt = new Date().toISOString();
      const backup = await sendStorageBackup({ repository, telegram: bot.telegram, config, createdAt });
      const month = indiaMonthKey(createdAt);
      if (month && typeof repository.markMonthlyBackupCreated === 'function') {
        await repository.markMonthlyBackupCreated({ month, createdAt });
      }
      await ctx.reply(`✅ Backup sent privately as ${backup.filename}. Snapshot: ${formatBackupCounts(backup.counts)}. Keep the file private; it is signed and can be restored with /recover.`);
    } catch (error) {
      const message = cleanText(error?.message || 'The backup could not be created.', 500);
      console.error('[telegram] backup failed:', message);
      await ctx.reply(`Backup was not sent. ${message}`);
    }
  });

  bot.command('recover', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    if (await repository.findStreamImport?.(chatId(ctx), userId(ctx))) {
      await ctx.reply('A manual Watch-link import is waiting for a document. Finish it or use /cmd cancel first, then start /recover.');
      return;
    }
    if (ctx.chat?.type && ctx.chat.type !== 'private') {
      await ctx.reply('For safety, run /recover in your private chat with this bot, then send the signed backup document there.');
      return;
    }
    if (typeof repository.startBackupRecovery !== 'function') {
      await ctx.reply('Backup recovery is not available in this catalog store.');
      return;
    }
    try {
      await repository.startBackupRecovery({ chatId: chatId(ctx), ownerId: userId(ctx) });
      await ctx.reply([
        'Recovery mode is armed for 15 minutes.',
        'Send one unmodified SoraBox .json.gz backup document in this private chat.',
        'I will verify its signature before replacing catalog/application data. This works after switching to a new or empty MongoDB URI, provided BACKUP_SIGNING_SECRET is unchanged.',
        'Do not send backups in a public group.'
      ].join('\n'));
    } catch (error) {
      const message = cleanText(error?.message || 'Could not arm backup recovery.', 300);
      console.error('[telegram] could not arm backup recovery:', message);
      await ctx.reply(`Recovery was not armed. ${message}`);
    }
  });

  bot.command('addchannel', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const suppliedId = normalizeChannelId(parseCommandArgument(ctx.message.text));
    if (!suppliedId) {
      await ctx.reply('Usage: /addchannel -1001234567890\nThe bot must be an administrator in that Telegram channel first.');
      return;
    }
    try {
      const chat = await ctx.telegram.getChat(suppliedId);
      if (chat.type !== 'channel') {
        await ctx.reply('That ID is not a Telegram channel. Add a channel ID (normally beginning with -100) or a public @channelusername.');
        return;
      }
      if (String(chat.id) === String(config.telegram.storageChannelId || '')) {
        await ctx.reply('The private database channel cannot be an announcement destination. Keeping it separate prevents auto-publish loops and keeps stored media uncluttered.');
        return;
      }
      const channel = await repository.addAnnouncementChannel({
        channelId: chat.id,
        title: chat.title || '',
        username: chat.username || '',
        addedBy: userId(ctx)
      });
      await ctx.reply(`Announcement channel saved: ${channel.title || channel.username || channel.channelId}. Every future published post will be sent there with poster, details, and delivery button.`);
    } catch (error) {
      console.error('[telegram] add channel failed:', error?.description || error?.message || 'Unknown error');
      await ctx.reply('I could not access that channel. Check the ID and make the bot an administrator there, then try again.');
    }
  });

  bot.command('channels', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const channels = await repository.listAnnouncementChannels();
    if (!channels.length) {
      await ctx.reply('No announcement channels are configured. Use /addchannel <channel_id> after making the bot an admin.');
      return;
    }
    await ctx.reply(['Announcement channels:', '', ...channels.map((channel, index) => `${index + 1}. ${channel.title || channel.username || 'Untitled channel'} — ${channel.channelId}`), '', 'Remove one with /removechannel <channel_id>.'].join('\n'));
  });

  bot.command('removechannel', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const suppliedId = normalizeChannelId(parseCommandArgument(ctx.message.text));
    if (!suppliedId) {
      await ctx.reply('Usage: /removechannel -1001234567890');
      return;
    }
    const removed = await repository.removeAnnouncementChannel(suppliedId);
    await ctx.reply(removed ? `Removed ${removed.title || removed.channelId} from automatic announcements.` : 'That channel was not in the announcement list.');
  });

  bot.command('requests', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const requests = await repository.listRequests({ status: 'open', limit: 200 });
    await ctx.reply(requestManagerText(requests.length), requestManagerKeyboard());
  });

  bot.action('requests:select', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await repository.startRequestSelection({ chatId: chatId(ctx), ownerId: userId(ctx) });
    await renderRequestSelection(ctx, repository, 0);
  });

  bot.action(/^requests:page:(\d{1,3})$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await renderRequestSelection(ctx, repository, Number(ctx.match[1]));
  });

  bot.action(/^requests:toggle:(REQ-[A-F0-9]{10}):(\d{1,3})$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    const selection = await repository.toggleRequestSelection(chatId(ctx), userId(ctx), ctx.match[1]);
    if (!selection) {
      await replaceInteractiveMessage(ctx, 'That request is no longer open, or your selection expired. Start Select requests again.', requestManagerKeyboard());
      return;
    }
    await renderRequestSelection(ctx, repository, Number(ctx.match[2]));
  });

  bot.action(/^requests:resolve:(completed|rejected)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    const selection = await repository.findRequestSelection(chatId(ctx), userId(ctx));
    const requestIds = selection?.requestIds || [];
    if (!requestIds.length) {
      await replaceInteractiveMessage(ctx, 'Select at least one open request before choosing a status.', requestManagerKeyboard());
      return;
    }
    // Persist the status first, then notify requesters. A delivery failure can
    // never leave a request looking unresolved after the publisher acted.
    const status = ctx.match[1];
    const resolved = await repository.resolveRequests({ requestIds, status, resolvedBy: userId(ctx) });
    await repository.deleteRequestSelection(chatId(ctx), userId(ctx));
    const notifications = await notifyResolvedRequesters(bot, resolved, status);
    const remaining = await repository.listRequests({ status: 'open', limit: 200 });
    const label = status === 'completed' ? 'Completed' : 'Rejected';
    await replaceInteractiveMessage(
      ctx,
      `${label} ${resolved.length} request${resolved.length === 1 ? '' : 's'} immediately. ${notifications.notified} requester${notifications.notified === 1 ? '' : 's'} notified${notifications.failed ? `; ${notifications.failed} notification${notifications.failed === 1 ? '' : 's'} could not be delivered` : ''}. ${remaining.length} open request${remaining.length === 1 ? '' : 's'} remain.`,
      requestManagerKeyboard()
    );
  });

  bot.action('requests:back', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await repository.deleteRequestSelection(chatId(ctx), userId(ctx));
    await replaceInteractiveMessage(ctx, 'Request management closed. Choose a publisher action below.', panelKeyboard());
  });

  bot.action(/^postid:(today|yesterday|week|month)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    const window = postIdTimeWindow(ctx.match[1]);
    const posts = await repository.listAdminContent({ startAt: window.startAt, endAt: window.endAt, limit: 100 });
    await replyBatchDiagnostics(ctx, formatPostIdResults(window, posts).split('\n'));
  });

  bot.action('postid:back', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await replaceInteractiveMessage(ctx, 'Post-ID lookup closed. Choose a publisher action below.', panelKeyboard());
  });

  bot.action(/^auto:(status|on|off)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;

    const action = ctx.match[1];
    if (action === 'on' && !config.telegram.storageChannelId) {
      const settings = await repository.getAutoPublishSettings();
      await ctx.reply('Auto-publish cannot be enabled until TELEGRAM_STORAGE_CHANNEL_ID is configured with the private database channel’s numeric -100… ID.', autoPublishKeyboard(Boolean(settings?.enabled)));
      return;
    }

    const settings = action === 'on' || action === 'off'
      ? await repository.setAutoPublishSettings({
        enabled: action === 'on',
        updatedBy: userId(ctx),
        // Completion/error reports must go to the authorized publisher, never
        // back into the private database channel.
        notifyChatId: ctx.chat?.type === 'private' ? chatId(ctx) : undefined
      })
      : await repository.getAutoPublishSettings();
    await ctx.reply(autoPublishStatusText(settings, config), autoPublishKeyboard(Boolean(settings?.enabled)));
  });

  bot.action(/^new:(anime|cartoon|donghua|kdrama|movie|web-series|adult)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await beginDraft(ctx, ctx.match[1], '', repository, config);
  });

  bot.action('draft:status', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await showDraftStatus(ctx, repository);
  });

  bot.action('draft:cancel', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await repository.deleteSession(chatId(ctx), userId(ctx));
    await ctx.reply('Draft discarded. No catalog record was created.', panelKeyboard());
  });

  bot.action('draft:done', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requirePublisher(ctx, repository, config))) return;
    await publishDraft(ctx, bot, repository, config);
  });

  bot.on('message', async (ctx) => {
    if (!(await isPublisher(ctx, repository, config))) return;
    const message = ctx.message;
    if (await handleBackupRecoveryUpload(ctx, repository, config)) return;
    if (await handleStreamImportUpload(ctx, repository, config)) return;
    // An armed /poster conversation takes the next message (post ID, image
    // link, or title) before it can be mistaken for a draft title.
    if (await handlePosterFlowMessage(ctx, repository, config)) return;
    const session = await repository.findSession(chatId(ctx), userId(ctx));

    if (isMediaMessage(message)) {
      if (session?.workflow === 'batch') {
        await ctx.reply('This batch is waiting for private storage links, not new uploads. Send the first/last https://t.me/c/... links, or use /cancel and start a normal draft.');
        return;
      }
      if (!session) {
        await ctx.reply('Start a draft first with /panel, then upload files.');
        return;
      }
      if (!session.title) {
        await ctx.reply('Send the release title before uploading files.');
        return;
      }
      const storageChannelId = storageChannelForCategory(config, session.category);
      if (!storageChannelId) {
        await ctx.reply(`${storageEnvironmentName(session.category)} is not configured. Add the bot as an admin to the ${storageChannelDescription(session.category)}, configure its ID, then try again.`);
        return;
      }
      if (isAdultCategory(session.category) && !hasDedicatedAdultStorage(config)) {
        await ctx.reply(`${adultStorageConfigurationHint(config)} Fix it before uploading to this 18+ draft.`);
        return;
      }

      let stored;
      try {
        stored = await storeMediaInChannel(
          ctx.telegram,
          storageChannelId,
          chatId(ctx),
          message
        );
      } catch (error) {
        console.error(
          '[telegram] storage transport failed:',
          error?.copyError?.description || error?.copyError?.message || error?.message || 'Unknown error',
          '| fallback:',
          error?.fallbackError?.description || error?.fallbackError?.message || 'not attempted'
        );
        await ctx.reply(`I could not store that file. ${storageErrorHint(error)}`);
        return;
      }

      // A publisher-uploaded copy is emitted back to the bot as a channel_post
      // in many Telegram setups. Mark it before persistence so /auto never
      // turns a normal draft file into a second, one-file catalog post.
      ignoreAutoStorageMessage(stored.storageMessageId);

      let updated;
      let last;
      let summary;
      try {
        updated = await repository.appendSessionFile(
          chatId(ctx),
          userId(ctx),
          fileFromMessage(message, stored.storageMessageId, stored.method, stored.storageChannelId || storageChannelId)
        );
        if (!updated?.files?.length) {
          throw new Error('The active draft was no longer available after the file reached Telegram storage.');
        }
        last = updated.files.at(-1);
        summary = summarizeEpisodes(updated.files);
      } catch (error) {
        // A screenshot of the database channel can show the media in this case:
        // Telegram storage succeeded, but MongoDB could not attach its message ID
        // to the draft. Keep this separate from a channel-permission failure.
        console.error('[telegram] draft record failed after storage success:', error?.message || 'Unknown error');
        await ctx.reply(
          'The file reached the storage channel, but I could not attach it to this upload draft. Please use /status. If it is not listed, start a new draft before uploading again; do not assume the channel copy is linked to the website.'
        );
        return;
      }

      const size = formatBytes(last.size);
      const fallbackNote = stored.method === 'file-id-fallback' ? ' Stored with Telegram’s file-ID fallback.' : '';
      await ctx.reply(
        `Added ${updated.files.length} file${updated.files.length === 1 ? '' : 's'} to this draft${size ? ` · latest ${size}` : ''}${episodeUploadNote(last, {
          // The release is episodic when its other files already found their
          // number, which is when a missing one is worth complaining about.
          episodic: (updated.files || []).some((entry) => entry !== last && entry?.episode?.start)
        })}.${summary.releaseLabel ? ` Current index: ${summary.releaseLabel}.` : ''}${fallbackNote} Use /done when the upload is complete.`,
        uploadKeyboard()
      );
      return;
    }

    if (message.text && !message.text.startsWith('/') && session?.workflow === 'batch') {
      await handleBatchLink(ctx, session, bot, repository, config);
      return;
    }

    if (message.text && !message.text.startsWith('/') && session && !session.title) {
      await updateTitleAndMetadata({ ctx, repository, config, title: message.text });
      return;
    }

    if (message.text && !message.text.startsWith('/') && session) {
      await ctx.reply('Your title is already set. Upload files, edit metadata with /help, or use /done to publish.', uploadKeyboard());
    }
  });

  bot.catch(async (error, ctx) => {
    const diagnostic = automationDiagnostic(error);
    const channelPost = ctx?.channelPost || ctx?.update?.channel_post;
    if (channelPost) {
      // Never put a fallback reply into the database channel. Those generic
      // replies were themselves channel posts and made real upload failures
      // look like a growing series of broken catalog messages.
      console.error('[telegram] unhandled channel-post error (reply suppressed):', diagnostic);
      try {
        const settings = await repository.getAutoPublishSettings();
        await notifyAutomationPublisher(bot, settings, {
          state: 'failed',
          session: { title: 'Storage channel update', files: [] },
          error: diagnostic
        });
      } catch (notificationError) {
        console.error('[telegram] could not report suppressed channel error:', automationDiagnostic(notificationError));
      }
      return;
    }

    console.error('[telegram] unhandled update error:', diagnostic);
    try {
      await ctx.reply('Something went wrong while handling that request. Please try again.');
    } catch {
      // No further action is possible if Telegram cannot receive the fallback reply.
    }
  });

  try {
    // Public command menu stays intentionally small. Publisher scopes are
    // installed both for configured owners at startup and for a permitted user
    // on /start or /login, so Telegram reliably exposes /posts and /postid.
    await bot.telegram.setMyCommands(VISITOR_COMMANDS);
    await setConfiguredPublisherCommandScopes(bot, config, repository);
  } catch (error) {
    console.warn('[telegram] Could not register bot commands:', error?.message || 'Unknown error');
  }

  // A process can stop while an ImgBB/metadata request is in flight. Release
  // its durable claim before polling begins so that group is retried instead of
  // stranded or routed into a late-arrival group during startup.
  if (typeof repository.releaseAutomationClaims === 'function') {
    try {
      const released = await repository.releaseAutomationClaims();
      if (released) console.warn(`[telegram] released ${released} interrupted automation claim${released === 1 ? '' : 's'} for retry.`);
    } catch (error) {
      console.error('[telegram] could not recover interrupted automation claims:', automationDiagnostic(error));
    }
  }

  await bot.launch({ dropPendingUpdates: false }, () => {
    const deliveryBot = synchronizeDeliveryBotUsername(config, bot.botInfo);
    if (deliveryBot.changed) {
      console.warn(
        `[telegram] Token belongs to @${deliveryBot.username}, replacing configured @${deliveryBot.previousUsername} for dynamic delivery links.`
      );
    } else {
      console.info(`[telegram] Delivery links are using @${deliveryBot.username || 'an unconfigured bot'}.`);
    }
  });

  // Process any group whose persisted deadline elapsed while Koyeb restarted,
  // then continue checking at a modest interval. There is no in-memory-only
  // debounce state, so a restart cannot split a 100-file upload into cards.
  await runAutomationQueue();
  const automationTimer = setInterval(() => { void runAutomationQueue(); }, AUTO_QUEUE_INTERVAL_MS);
  automationTimer.unref?.();

  let monthlyBackupPromise = null;
  const runMonthlyBackupSafely = () => {
    if (monthlyBackupPromise) return monthlyBackupPromise;
    monthlyBackupPromise = runMonthlyBackup({ bot, repository, config })
      .then((result) => {
        if (result.sent) console.info(`[telegram] monthly signed backup sent for ${result.month}.`);
        return result;
      })
      .catch((error) => {
        console.error('[telegram] monthly backup failed:', automationDiagnostic(error));
        return { sent: false, reason: 'error' };
      })
      .finally(() => { monthlyBackupPromise = null; });
    return monthlyBackupPromise;
  };
  // Check at startup and periodically. The durable monthly claim prevents a
  // restart or multiple worker wakeups from generating duplicate archive files.
  await runMonthlyBackupSafely();
  const monthlyBackupTimer = setInterval(() => { void runMonthlyBackupSafely(); }, 6 * 60 * 60 * 1000);
  monthlyBackupTimer.unref?.();

  const originalStop = bot.stop.bind(bot);
  bot.stop = (reason) => {
    clearInterval(automationTimer);
    clearInterval(monthlyBackupTimer);
    return originalStop(reason);
  };

  console.info('[telegram] Long polling started. Keep this service at one replica.');
  return bot;
}
