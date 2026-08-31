import crypto from 'node:crypto';
import { Markup, Telegraf } from 'telegraf';
import { getContentPageUrl, getTelegramDeliveryUrl, isTelegramAdmin } from '../config.js';
import { categoryDetails, cleanText, formatBytes, parseCommandArgument } from '../lib/strings.js';
import { summarizeEpisodes, summarizeUploadLanguages, detectMediaQuality, detectUploadEpisode, detectUploadLanguages } from './episode-service.js';
import { findMetadata } from './metadata-service.js';
import { PosterHostingError, mirrorPosterToImgBB } from './poster-service.js';

const PUBLISH_CATEGORIES = ['anime', 'cartoon', 'donghua', 'kdrama', 'movie', 'web-series'];

function userId(ctx) {
  return ctx.from?.id;
}

function chatId(ctx) {
  return ctx.chat?.id;
}

function categoryCommandLabel(category) {
  return category === 'web-series' ? 'series' : category;
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

const PUBLISHER_COMMANDS = [
  ...VISITOR_COMMANDS,
  { command: 'panel', description: 'Open the publisher panel' },
  { command: 'movie', description: 'New movie draft' },
  { command: 'anime', description: 'New anime draft' },
  { command: 'cartoon', description: 'New cartoon draft' },
  { command: 'donghua', description: 'New donghua draft' },
  { command: 'kdrama', description: 'New K-Drama draft' },
  { command: 'series', description: 'New web series draft' },
  { command: 'done', description: 'Publish current draft' },
  { command: 'status', description: 'Show current draft' },
  { command: 'teststorage', description: 'Check the storage channel connection' },
  { command: 'delete', description: 'Delete a post by post ID' },
  { command: 'addchannel', description: 'Add an announcement channel' },
  { command: 'channels', description: 'List announcement channels' },
  { command: 'removechannel', description: 'Remove an announcement channel' },
  { command: 'requests', description: 'View open catalog requests' },
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

async function clearPublisherCommands(bot, ctx) {
  try {
    await bot.telegram.deleteMyCommands({ scope: { type: 'chat', chat_id: chatId(ctx) } });
  } catch (error) {
    console.warn('[telegram] Could not clear publisher command scope:', error?.message || 'Unknown error');
  }
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

function displayDraft(session) {
  const category = categoryDetails(session.category).label;
  const title = session.title || 'Waiting for title';
  const files = session.files?.length || 0;
  const matched = session.metadata?.matched ? `${String(session.metadata.provider || 'metadata').toUpperCase()} match ready` : 'Fallback artwork ready';
  const detectedLanguages = summarizeUploadLanguages(session.files || []);
  const language = session.overrides?.languages?.length
    ? `${session.overrides.languages.join(', ')} (manual)`
    : detectedLanguages.length
      ? `${detectedLanguages.join(', ')} (from uploaded file details)`
      : (session.metadata?.languages || []).filter((item) => !/^multi(?:\s+language)?$/i.test(String(item || ''))).join(', ') || 'Not set';
  const episodeSummary = summarizeEpisodes(session.files || []);

  return [
    `Draft · ${category}`,
    `Title: ${title}`,
    `Files: ${files}`,
    `Episodes: ${episodeSummary.releaseLabel || 'No episode labels detected yet'}`,
    `Poster: ${session.posterOriginalUrl ? 'Manual poster selected' : matched}`,
    `Languages: ${language}`,
    '',
    'Caption episode labels are checked before filenames. Telegram @channel names are removed automatically.',
    'Upload more files, then use /done to publish.'
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

export function fileFromMessage(message, storedMessageId, storageMethod = 'copy') {
  const { kind, source } = mediaDescriptor(message);
  const filename = source?.file_name || `${kind}-${message.message_id}`;
  const episode = detectUploadEpisode({ caption: message.caption, filename });
  const quality = detectMediaQuality({ caption: message.caption, filename });
  const languages = detectUploadLanguages({ caption: message.caption, filename });

  return {
    storageMessageId: storedMessageId,
    storageMethod,
    telegramFileId: source?.file_id || null,
    name: cleanText(filename, 180),
    displayName: episode.displayName,
    quality,
    languages,
    mimeType: cleanText(source?.mime_type || '', 80),
    size: Number(source?.file_size) || 0,
    kind,
    episode: episode.start ? {
      start: episode.start,
      end: episode.end,
      label: episode.label,
      source: episode.source
    } : null,
    addedAt: new Date().toISOString()
  };
}

function isMediaMessage(message) {
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
  if (message.caption) extra.caption = message.caption;

  if (kind === 'document') return telegram.sendDocument(destinationChatId, source.file_id, extra);
  if (kind === 'video') return telegram.sendVideo(destinationChatId, source.file_id, extra);
  if (kind === 'audio') return telegram.sendAudio(destinationChatId, source.file_id, extra);
  if (kind === 'animation') return telegram.sendAnimation(destinationChatId, source.file_id, extra);
  if (kind === 'photo') return telegram.sendPhoto(destinationChatId, source.file_id, extra);
  throw new Error('This Telegram media type is not supported by the storage fallback.');
}

// copyMessage is fastest and preserves the original message. Some forwarded or
// protected-origin items cannot be copied, however. In that case Telegram often
// still lets a bot re-send the file it received by its file_id, so we attempt a
// type-safe fallback before reporting a storage failure to the publisher.
export async function storeMediaInChannel(telegram, destinationChatId, sourceChatId, message) {
  try {
    const copied = await telegram.copyMessage(destinationChatId, sourceChatId, message.message_id, {
      disable_notification: true
    });
    return { storageMessageId: copied.message_id, method: 'copy' };
  } catch (copyError) {
    try {
      const sent = await sendByFileId(telegram, destinationChatId, message);
      return { storageMessageId: sent.message_id, method: 'file-id-fallback' };
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

function episodeUploadNote(file) {
  if (!file.episode?.label) return '';
  return ` · ${file.episode.label} detected from ${file.episode.source}`;
}

async function updateTitleAndMetadata({ ctx, repository, config, title }) {
  const current = await repository.findSession(chatId(ctx), userId(ctx));
  if (!current) return null;
  const metadata = await findMetadata(title, current.category, config);
  const updated = await repository.updateSession(chatId(ctx), userId(ctx), {
    title: cleanText(title, 180),
    metadata
  });

  if (metadata.matched) {
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
      'Episode detection checks the clean caption first, strips @channel tags, then checks the filename.',
      'Optional: /lang Hindi, English · /year 2026 · /poster https://image.example/poster.jpg'
    ].join('\n'),
    uploadKeyboard()
  );
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

async function announcePublishedContent({ bot, repository, content, websiteUrl }) {
  const channels = await repository.listAnnouncementChannels();
  if (!channels.length) return { sent: 0, failed: 0 };

  // Announcement channels deliberately send users to the catalog page first.
  // The public page is where the user can review details and choose Telegram delivery.
  const keyboard = websiteUrl ? Markup.inlineKeyboard([[Markup.button.url('✨ VIEW ON WEBSITE', websiteUrl)]]) : undefined;
  const caption = announcementCaption(content);
  let sent = 0;
  let failed = 0;

  for (const channel of channels) {
    try {
      await bot.telegram.sendPhoto(channel.channelId, content.posterUrl, {
        caption,
        parse_mode: 'HTML',
        ...keyboard
      });
      sent += 1;
    } catch (photoError) {
      try {
        await bot.telegram.sendMessage(channel.channelId, caption, {
          parse_mode: 'HTML',
          ...keyboard
        });
        sent += 1;
      } catch (messageError) {
        failed += 1;
        console.error('[telegram] announcement failed:', channel.channelId, messageError?.description || messageError?.message || photoError?.message || 'Unknown error');
      }
    }
  }

  return { sent, failed };
}

async function publishDraft(ctx, bot, repository, config) {
  const session = await repository.findSession(chatId(ctx), userId(ctx));
  if (!session) {
    await ctx.reply('There is no active draft. Start one from /panel first.');
    return;
  }
  if (!session.title) {
    await ctx.reply('Please send a title before publishing.');
    return;
  }
  if (!session.files?.length) {
    await ctx.reply('Add at least one document, video, audio file, animation, or image before using /done.');
    return;
  }
  if (!config.telegram.botUsername) {
    await ctx.reply('TELEGRAM_BOT_USERNAME is not configured on the server, so I cannot create a shareable delivery link yet.');
    return;
  }

  await ctx.reply('Publishing your draft. I am mirroring the poster to ImgBB now…');

  try {
    const metadata = session.metadata || (await findMetadata(session.title, session.category, config));
    const overrides = session.overrides || {};
    const episodeSummary = summarizeEpisodes(session.files);
    const uploadedLanguages = summarizeUploadLanguages(session.files);
    const metadataLanguages = (metadata.languages || []).filter((language) => !/^multi(?:\s+language)?$/i.test(String(language || '')));
    const releaseLanguages = overrides.languages?.length ? overrides.languages : uploadedLanguages.length ? uploadedLanguages : metadataLanguages;
    const posterResult = await mirrorPosterToImgBB({
      sourceUrl: session.posterOriginalUrl || metadata.posterOriginalUrl,
      sourceIsManual: Boolean(session.posterOriginalUrl),
      title: session.title,
      category: session.category,
      config
    });

    const title = metadata.matched ? metadata.title : session.title;
    const releaseLabel = overrides.releaseLabel || episodeSummary.releaseLabel || metadata.releaseLabel || `${session.files.length} files`;
    const content = await repository.createContent({
      title,
      category: session.category,
      year: overrides.year || metadata.year,
      // Explicit /lang settings win. Otherwise the file caption/filename is
      // the source of truth for release audio labels (e.g. Multi Hindi + Malayalam).
      languages: releaseLanguages,
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
      art: { tone: categoryDetails(session.category).tone },
      files: session.files
    });
    await repository.deleteSession(chatId(ctx), userId(ctx));

    const url = getTelegramDeliveryUrl(config, content.shareCode);
    const websiteUrl = getContentPageUrl(config, content);
    let announcements = { sent: 0, failed: 0, configured: false };
    try {
      const configuredChannels = await repository.listAnnouncementChannels();
      announcements = {
        ...(await announcePublishedContent({ bot, repository, content, websiteUrl })),
        configured: configuredChannels.length > 0
      };
    } catch (error) {
      console.error('[telegram] announcement dispatch failed:', error?.message || 'Unknown error');
      announcements = { sent: 0, failed: 1, configured: true };
    }
    const posterNote = posterResult.source === 'generated-fallback'
      ? 'A permanent fallback poster was generated and mirrored to ImgBB.'
      : `The ${String(metadata.provider || 'matched').toUpperCase()} poster was mirrored to ImgBB.`;
    const episodeNote = episodeSummary.releaseLabel ? `Episode index: ${episodeSummary.releaseLabel}.` : 'No episode labels were found; the post lists delivery files instead.';
    const channelNote = announcements.sent
      ? `Posted to ${announcements.sent} announcement channel${announcements.sent === 1 ? '' : 's'}${announcements.failed ? ` (${announcements.failed} failed)` : ''}.`
      : announcements.configured
        ? 'The catalog post is live, but the announcement channel delivery failed. Check that the bot is an admin in each configured channel.'
        : 'No announcement channels are configured yet. Add one with /addchannel <channel_id>.';
    const websiteNote = websiteUrl
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
  } catch (error) {
    const message = error instanceof PosterHostingError
      ? error.message
      : 'Publishing could not be completed. Your draft is still safe; please try /done again.';
    console.error('[telegram] publish failed:', error?.name || 'Error', error?.message || 'Unknown error');
    await ctx.reply(`Could not publish this draft. ${message}`);
  }
}

async function deliverContent(ctx, delivery, repository, config) {
  if (!delivery?.shareCode || delivery.shareCode.length > 48) {
    await ctx.reply('That delivery link is invalid.');
    return;
  }

  const content = await repository.findContentByShareCode(delivery.shareCode);
  if (!content) {
    await ctx.reply('This release is unavailable or the link has expired.');
    return;
  }
  if (!config.telegram.storageChannelId) {
    await ctx.reply('File delivery is being configured. Please try again later.');
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
  for (const file of files) {
    try {
      await ctx.telegram.copyMessage(chatId(ctx), config.telegram.storageChannelId, file.storageMessageId);
      delivered += 1;
    } catch (error) {
      console.error('[telegram] delivery copy failed:', error?.description || error?.message || 'Unknown error');
    }
  }

  if (delivered) {
    await repository.incrementDelivery(delivery.shareCode);
    await ctx.reply(
      delivery.filePosition
        ? 'Your selected file has been delivered. Enjoy responsibly.'
        : `Delivered ${delivered} of ${files.length} item${files.length === 1 ? '' : 's'}. Enjoy responsibly.`
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

export async function launchTelegramBot({ config, repository }) {
  if (!config.telegram.botToken || config.telegram.mode !== 'polling') {
    console.info('[telegram] Bot polling is disabled; web catalog remains available.');
    return null;
  }

  const bot = new Telegraf(config.telegram.botToken);

  bot.start(async (ctx) => {
    const payload = parseStartPayload(ctx);
    const delivery = parseDeliveryPayload(payload);
    if (delivery) {
      await deliverContent(ctx, delivery, repository, config);
      return;
    }
    const publisher = await isPublisher(ctx, repository, config);
    if (publisher) await setPublisherCommands(bot, ctx);
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
    await clearPublisherCommands(bot, ctx);
    await ctx.reply('Publisher session locked. You can still open delivery links or use /request.');
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
          '1. /movie Title, /anime Title, /cartoon Title, /donghua Title, /kdrama Title, or /series Title',
          '2. Upload your files to this private chat',
          '3. Use /done to create the catalog post, permanent ImgBB poster, delivery link, and channel announcements',
          '',
          'Episode parsing checks a cleaned caption first, then the filename. @channel handles and t.me links are ignored.',
          'Optional metadata: /lang Hindi, English · /year 2026 · /genres Action, Fantasy · /description Text · /poster HTTPS_URL',
          'Management: /status · /teststorage · /cancel · /delete POST_ID · /addchannel CHANNEL_ID · /channels · /requests · /logout'
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

  bot.command('title', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const title = parseCommandArgument(ctx.message.text);
    if (!title) {
      await ctx.reply('Usage: /title Your release title');
      return;
    }
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session) {
      await ctx.reply('Start a draft first using /panel.');
      return;
    }
    await updateTitleAndMetadata({ ctx, repository, config, title });
  });

  bot.command('lang', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const languages = parseDelimitedList(parseCommandArgument(ctx.message.text));
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session || !languages.length) {
      await ctx.reply('Usage: /lang Hindi, English');
      return;
    }
    const overrides = { ...(session.overrides || {}), languages };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply(`Languages saved: ${languages.join(', ')}`);
  });

  bot.command('year', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const year = Number.parseInt(parseCommandArgument(ctx.message.text), 10);
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session || !Number.isInteger(year) || year < 1888 || year > new Date().getFullYear() + 5) {
      await ctx.reply('Usage: /year 2026');
      return;
    }
    const overrides = { ...(session.overrides || {}), year };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply(`Year saved: ${year}`);
  });

  bot.command('genres', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const genres = parseDelimitedList(parseCommandArgument(ctx.message.text));
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session || !genres.length) {
      await ctx.reply('Usage: /genres Action, Fantasy');
      return;
    }
    const overrides = { ...(session.overrides || {}), genres };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply(`Genres saved: ${genres.join(', ')}`);
  });

  bot.command('description', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const description = cleanText(parseCommandArgument(ctx.message.text), 1400);
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session || !description) {
      await ctx.reply('Usage: /description A short, readable synopsis');
      return;
    }
    const overrides = { ...(session.overrides || {}), description };
    await repository.updateSession(chatId(ctx), userId(ctx), { overrides });
    await ctx.reply('Description saved.');
  });

  bot.command('poster', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const posterOriginalUrl = parseCommandArgument(ctx.message.text);
    const session = await repository.findSession(chatId(ctx), userId(ctx));
    if (!session || !posterOriginalUrl.startsWith('https://')) {
      await ctx.reply('Usage: /poster https://public-image-host.example/poster.jpg');
      return;
    }
    await repository.updateSession(chatId(ctx), userId(ctx), { posterOriginalUrl });
    await ctx.reply('Manual poster saved. It will be validated, downloaded once, and mirrored to ImgBB during publishing.');
  });

  bot.command('status', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
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
    await ctx.reply('Draft discarded. No catalog record was created.', panelKeyboard());
  });

  bot.command('done', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    await publishDraft(ctx, bot, repository, config);
  });

  bot.command('delete', async (ctx) => {
    if (!(await requirePublisher(ctx, repository, config))) return;
    const adminId = parseCommandArgument(ctx.message.text).toUpperCase();
    if (!/^SB-[A-F0-9]{10}$/.test(adminId)) {
      await ctx.reply('Usage: /delete SB-0123ABCDEF\nUse the Post ID shown when the release was published.');
      return;
    }
    const removed = await repository.deleteContentByAdminId(adminId);
    if (!removed) {
      await ctx.reply('No published post was found with that ID.');
      return;
    }
    await ctx.reply(
      `Deleted “${removed.title}” from the public catalog. Its delivery link no longer resolves. The original files remain in the private storage channel so you can manage them separately.`
    );
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
    const requests = await repository.listRequests(12);
    if (!requests.length) {
      await ctx.reply('There are no open catalog requests.');
      return;
    }
    await ctx.reply(['Latest open requests:', '', ...requests.map((request, index) => `${index + 1}. ${request.requestText}\n   ${request.id} · ${request.requester?.username ? `@${request.requester.username}` : request.requester?.name || 'Telegram user'}`)].join('\n'));
  });

  bot.action(/^new:(anime|cartoon|donghua|kdrama|movie|web-series)$/, async (ctx) => {
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
    const session = await repository.findSession(chatId(ctx), userId(ctx));

    if (isMediaMessage(message)) {
      if (!session) {
        await ctx.reply('Start a draft first with /panel, then upload files.');
        return;
      }
      if (!session.title) {
        await ctx.reply('Send the release title before uploading files.');
        return;
      }
      if (!config.telegram.storageChannelId) {
        await ctx.reply('TELEGRAM_STORAGE_CHANNEL_ID is not configured. Add the bot as an admin to a private channel, configure its ID, then try again.');
        return;
      }

      let stored;
      try {
        stored = await storeMediaInChannel(
          ctx.telegram,
          config.telegram.storageChannelId,
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

      let updated;
      let last;
      let summary;
      try {
        updated = await repository.appendSessionFile(
          chatId(ctx),
          userId(ctx),
          fileFromMessage(message, stored.storageMessageId, stored.method)
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
        `Added ${updated.files.length} file${updated.files.length === 1 ? '' : 's'} to this draft${size ? ` · latest ${size}` : ''}${episodeUploadNote(last)}.${summary.releaseLabel ? ` Current index: ${summary.releaseLabel}.` : ''}${fallbackNote} Use /done when the upload is complete.`,
        uploadKeyboard()
      );
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
    console.error('[telegram] unhandled update error:', error?.message || error);
    try {
      await ctx.reply('Something went wrong while handling that request. Please try again.');
    } catch {
      // No further action is possible if Telegram cannot receive the fallback reply.
    }
  });

  try {
    // Public command menu stays intentionally small. A successful /login installs
    // the full publisher menu only in that administrator's private bot chat.
    await bot.telegram.setMyCommands(VISITOR_COMMANDS);
  } catch (error) {
    console.warn('[telegram] Could not register bot commands:', error?.message || 'Unknown error');
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
  console.info('[telegram] Long polling started. Keep this service at one replica.');
  return bot;
}
