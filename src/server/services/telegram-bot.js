import { Markup, Telegraf } from 'telegraf';
import { getTelegramDeliveryUrl, isTelegramAdmin } from '../config.js';
import { categoryDetails, cleanText, formatBytes, parseCommandArgument } from '../lib/strings.js';
import { findMetadata } from './metadata-service.js';
import { PosterHostingError, mirrorPosterToImgBB } from './poster-service.js';

const PUBLISH_CATEGORIES = ['anime', 'cartoon', 'donghua', 'kdrama', 'movie', 'web-series'];

function userId(ctx) {
  return ctx.from?.id;
}

function chatId(ctx) {
  return ctx.chat?.id;
}

function isAdmin(ctx, config) {
  return Boolean(userId(ctx) && isTelegramAdmin(config, userId(ctx)));
}

function categoryCommandLabel(category) {
  return category === 'web-series' ? 'series' : category;
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

function welcomeText(admin) {
  if (admin) {
    return [
      'SoraBox publisher is ready.',
      '',
      'Start with a category below or send /movie Title. Then upload the files one by one and use /done.',
      'The poster is matched automatically when possible, mirrored to ImgBB during publishing, and files are copied to your private Telegram storage channel.'
    ].join('\n');
  }

  return [
    'Welcome to SoraBox.',
    '',
    'Open a catalog delivery link to receive its available files here. This bot does not accept public uploads.'
  ].join('\n');
}

function displayDraft(session) {
  const category = categoryDetails(session.category).label;
  const title = session.title || 'Waiting for title';
  const files = session.files?.length || 0;
  const matched = session.metadata?.matched ? 'Auto-match ready' : 'Fallback artwork ready';
  const language = session.overrides?.languages?.length ? session.overrides.languages.join(', ') : 'Not set';

  return [
    `Draft · ${category}`,
    `Title: ${title}`,
    `Files: ${files}`,
    `Poster: ${session.posterOriginalUrl ? 'Manual poster selected' : matched}`,
    `Languages: ${language}`,
    '',
    'Upload more files, then use /done to publish.'
  ].join('\n');
}

function fileFromMessage(message, storedMessageId) {
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

  return {
    storageMessageId,
    telegramFileId: source?.file_id || null,
    name: cleanText(source?.file_name || `${kind}-${message.message_id}`, 180),
    mimeType: cleanText(source?.mime_type || '', 80),
    size: Number(source?.file_size) || 0,
    kind,
    addedAt: new Date().toISOString()
  };
}

function isMediaMessage(message) {
  return Boolean(message?.document || message?.video || message?.audio || message?.animation || message?.photo?.length);
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
      `Title saved. I found “${metadata.title}” (${metadata.year || 'year unavailable'}). Upload files whenever you are ready.`,
      uploadKeyboard()
    );
  } else {
    await ctx.reply(
      'Title saved. I could not confidently match it, so a branded fallback poster will be created and mirrored to ImgBB when you publish. Upload your files whenever you are ready.',
      uploadKeyboard()
    );
  }
  return updated;
}

async function beginDraft(ctx, category, suppliedTitle, repository, config) {
  const session = await repository.startSession({
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
      'Send the title next. After that, upload the files directly to this chat and finish with /done.',
      'Optional: /lang Hindi, English · /year 2026 · /poster https://image.example/poster.jpg'
    ].join('\n'),
    uploadKeyboard()
  );
  return session;
}

async function requireAdmin(ctx, config) {
  if (isAdmin(ctx, config)) return true;
  await ctx.reply('Publishing is restricted to the catalog administrators. Use a delivery link to request available files.');
  return false;
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

async function publishDraft(ctx, repository, config) {
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
    const posterResult = await mirrorPosterToImgBB({
      sourceUrl: session.posterOriginalUrl || metadata.posterOriginalUrl,
      sourceIsManual: Boolean(session.posterOriginalUrl),
      title: session.title,
      category: session.category,
      config
    });

    const title = metadata.matched ? metadata.title : session.title;
    const content = await repository.createContent({
      title,
      category: session.category,
      year: overrides.year || metadata.year,
      languages: overrides.languages || metadata.languages || [],
      genres: overrides.genres || metadata.genres || [],
      description: overrides.description || metadata.description || '',
      status: overrides.status || metadata.status || 'New release',
      releaseLabel: overrides.releaseLabel || metadata.releaseLabel || `${session.files.length} files`,
      posterUrl: posterResult.url,
      backdropUrl: posterResult.url,
      poster: {
        provider: 'imgbb',
        providerId: posterResult.providerId,
        originalUrl: posterResult.originalUrl,
        source: posterResult.source,
        mirroredAt: new Date().toISOString()
      },
      tmdbId: metadata.tmdbId,
      art: { tone: categoryDetails(session.category).tone },
      files: session.files
    });
    await repository.deleteSession(chatId(ctx), userId(ctx));

    const url = getTelegramDeliveryUrl(config, content.shareCode);
    const posterNote = posterResult.source === 'generated-fallback'
      ? 'A permanent fallback poster was generated and mirrored to ImgBB.'
      : 'The matched poster was mirrored to ImgBB.';
    await ctx.reply(
      [
        'Published successfully.',
        '',
        `${content.title} is now live in the catalog with ${content.filesCount} file${content.filesCount === 1 ? '' : 's'}.`,
        posterNote,
        '',
        'Share this delivery link:',
        url
      ].join('\n'),
      deliveryKeyboard(url)
    );
  } catch (error) {
    const message = error instanceof PosterHostingError
      ? error.message
      : 'Publishing could not be completed. Your draft is still safe; please try /done again.';
    console.error('[telegram] publish failed:', error?.name || 'Error', error?.message || 'Unknown error');
    await ctx.reply(`Could not publish this draft. ${message}`);
  }
}

async function deliverContent(ctx, payload, repository, config) {
  const shareCode = payload.replace(/^get-/, '').trim();
  if (!shareCode || shareCode.length > 48) {
    await ctx.reply('That delivery link is invalid.');
    return;
  }

  const content = await repository.findContentByShareCode(shareCode);
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

  await ctx.reply(`Preparing ${content.files.length} item${content.files.length === 1 ? '' : 's'} for “${content.title}”…`);
  let delivered = 0;
  for (const file of content.files) {
    try {
      await ctx.telegram.copyMessage(chatId(ctx), config.telegram.storageChannelId, file.storageMessageId);
      delivered += 1;
    } catch (error) {
      console.error('[telegram] delivery copy failed:', error?.description || error?.message || 'Unknown error');
    }
  }

  if (delivered) {
    await repository.incrementDelivery(shareCode);
    await ctx.reply(`Delivered ${delivered} of ${content.files.length} item${content.files.length === 1 ? '' : 's'}. Enjoy responsibly.`);
  } else {
    await ctx.reply('I could not retrieve these files from the storage channel. Please let the catalog administrator know.');
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
    if (payload.startsWith('get-')) {
      await deliverContent(ctx, payload, repository, config);
      return;
    }
    await ctx.reply(welcomeText(isAdmin(ctx, config)), isAdmin(ctx, config) ? panelKeyboard() : undefined);
  });

  bot.command('help', async (ctx) => {
    if (isAdmin(ctx, config)) {
      await ctx.reply(
        [
          'Publisher quick guide',
          '1. /movie Title, /anime Title, /cartoon Title, /donghua Title, /kdrama Title, or /series Title',
          '2. Upload your files to this private chat',
          '3. Use /done to make the catalog record and its Telegram delivery link',
          '',
          'Optional metadata: /lang Hindi, English · /year 2026 · /genres Action, Fantasy · /description Text · /poster HTTPS_URL',
          'Use /status to inspect a draft and /cancel to discard it.'
        ].join('\n'),
        panelKeyboard()
      );
    } else {
      await ctx.reply('Open a catalog delivery link to receive available files.');
    }
  });

  bot.command('panel', async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
    await ctx.reply('Choose a category for a new draft.', panelKeyboard());
  });

  for (const category of PUBLISH_CATEGORIES) {
    const command = categoryCommandLabel(category);
    bot.command(command, async (ctx) => {
      if (!(await requireAdmin(ctx, config))) return;
      await beginDraft(ctx, category, parseCommandArgument(ctx.message.text), repository, config);
    });
  }

  bot.command('title', async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
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
    if (!(await requireAdmin(ctx, config))) return;
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
    if (!(await requireAdmin(ctx, config))) return;
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
    if (!(await requireAdmin(ctx, config))) return;
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
    if (!(await requireAdmin(ctx, config))) return;
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
    if (!(await requireAdmin(ctx, config))) return;
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
    if (!(await requireAdmin(ctx, config))) return;
    await showDraftStatus(ctx, repository);
  });

  bot.command('cancel', async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
    await repository.deleteSession(chatId(ctx), userId(ctx));
    await ctx.reply('Draft discarded. No catalog record was created.', panelKeyboard());
  });

  bot.command('done', async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
    await publishDraft(ctx, repository, config);
  });

  bot.action(/^new:(anime|cartoon|donghua|kdrama|movie|web-series)$/, async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
    await ctx.answerCbQuery();
    await beginDraft(ctx, ctx.match[1], '', repository, config);
  });

  bot.action('draft:status', async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
    await ctx.answerCbQuery();
    await showDraftStatus(ctx, repository);
  });

  bot.action('draft:cancel', async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
    await ctx.answerCbQuery('Draft discarded');
    await repository.deleteSession(chatId(ctx), userId(ctx));
    await ctx.reply('Draft discarded. No catalog record was created.', panelKeyboard());
  });

  bot.action('draft:done', async (ctx) => {
    if (!(await requireAdmin(ctx, config))) return;
    await ctx.answerCbQuery();
    await publishDraft(ctx, repository, config);
  });

  bot.on('message', async (ctx) => {
    if (!isAdmin(ctx, config)) return;
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

      try {
        const copied = await ctx.telegram.copyMessage(
          config.telegram.storageChannelId,
          chatId(ctx),
          message.message_id,
          { disable_notification: true }
        );
        const updated = await repository.appendSessionFile(
          chatId(ctx),
          userId(ctx),
          fileFromMessage(message, copied.message_id)
        );
        const last = updated.files.at(-1);
        const size = formatBytes(last.size);
        await ctx.reply(
          `Added ${updated.files.length} file${updated.files.length === 1 ? '' : 's'} to this draft${size ? ` · latest ${size}` : ''}. Use /done when the upload is complete.`,
          uploadKeyboard()
        );
      } catch (error) {
        console.error('[telegram] storage copy failed:', error?.description || error?.message || 'Unknown error');
        await ctx.reply('I could not copy that file to the storage channel. Confirm that the bot is an administrator in the configured private channel, then try again.');
      }
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
    await bot.telegram.setMyCommands([
      { command: 'panel', description: 'Open the publisher panel' },
      { command: 'movie', description: 'New movie draft' },
      { command: 'anime', description: 'New anime draft' },
      { command: 'cartoon', description: 'New cartoon draft' },
      { command: 'donghua', description: 'New donghua draft' },
      { command: 'kdrama', description: 'New K-Drama draft' },
      { command: 'series', description: 'New web series draft' },
      { command: 'done', description: 'Publish current draft' },
      { command: 'status', description: 'Show current draft' },
      { command: 'help', description: 'Publisher help' }
    ]);
  } catch (error) {
    console.warn('[telegram] Could not register bot commands:', error?.message || 'Unknown error');
  }

  await bot.launch({ dropPendingUpdates: false });
  console.info('[telegram] Long polling started. Keep this service at one replica.');
  return bot;
}
