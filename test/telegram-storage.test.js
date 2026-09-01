import test from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramFileDeliveryUrl } from '../src/server/config.js';
import { automationGroupKey, automationMergeKeys, autoPublishStoragePost, fileFromMessage, importStorageRange, inferBatchCategory, inferBatchTitle, parseDeliveryPayload, parsePrivateStorageMessageLink, postIdKeyboard, postIdTimeWindow, processQueuedAutomationSessions, requestManagerKeyboard, requestResolutionNotificationText, storageErrorHint, storeMediaInChannel, synchronizeDeliveryBotUsername } from '../src/server/services/telegram-bot.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';

test('storage uses a reusable Telegram file ID when copyMessage is refused', async () => {
  const calls = [];
  const telegram = {
    async copyMessage() {
      throw { description: "Bad Request: message can't be copied" };
    },
    async sendDocument(destination, fileId, extra) {
      calls.push({ destination, fileId, extra });
      return { message_id: 456 };
    }
  };
  const stored = await storeMediaInChannel(telegram, '-100123', 999, {
    message_id: 12,
    caption: 'Perfect World Ep 01',
    document: { file_id: 'document-file-id', file_name: 'perfect-world.mkv' }
  });

  assert.deepEqual(stored, { storageMessageId: 456, method: 'file-id-fallback' });
  assert.deepEqual(calls[0], {
    destination: '-100123',
    fileId: 'document-file-id',
    extra: { disable_notification: true, caption: 'Perfect World Ep 01' }
  });
});

test('single-file deep-link payload preserves hyphens in the share code', () => {
  assert.deepEqual(parseDeliveryPayload('file-aB-cD_ef-12'), { shareCode: 'aB-cD_ef', filePosition: 12 });
  assert.deepEqual(parseDeliveryPayload('get-aB-cD_ef'), { shareCode: 'aB-cD_ef', filePosition: null });
  assert.equal(parseDeliveryPayload('file-not-valid'), null);
});

test('private storage links map their internal channel ID to the Bot API channel ID', () => {
  assert.deepEqual(
    parsePrivateStorageMessageLink('first: https://t.me/c/2617067511/9335?single'),
    {
      channelId: '-1002617067511',
      messageId: 9335,
      url: 'https://t.me/c/2617067511/9335'
    }
  );
  assert.equal(parsePrivateStorageMessageLink('https://t.me/publicchannel/9335'), null);
  assert.equal(parsePrivateStorageMessageLink('https://t.me/c/not-a-channel/9335'), null);
});

test('request management starts with Select requests and Back buttons, while post ID filters expose all periods', () => {
  const requestButtons = requestManagerKeyboard().reply_markup.inline_keyboard.flat();
  assert.deepEqual(requestButtons.map((button) => button.text), ['Select requests', 'Back']);
  const postIdButtons = postIdKeyboard().reply_markup.inline_keyboard.flat();
  assert.deepEqual(postIdButtons.map((button) => button.text), ['Today', 'Yesterday', 'Week', 'Month', 'Back']);
});

test('post ID time windows use India calendar boundaries for publisher filters', () => {
  const now = new Date('2026-09-01T18:45:00.000Z'); // 2 September, 00:15 IST
  const today = postIdTimeWindow('today', now);
  const yesterday = postIdTimeWindow('yesterday', now);
  const week = postIdTimeWindow('week', now);
  const month = postIdTimeWindow('month', now);

  assert.equal(today.startAt.toISOString(), '2026-09-01T18:30:00.000Z');
  assert.equal(today.endAt.toISOString(), '2026-09-02T18:30:00.000Z');
  assert.equal(yesterday.startAt.toISOString(), '2026-08-31T18:30:00.000Z');
  assert.equal(week.startAt.toISOString(), '2026-08-26T18:30:00.000Z');
  assert.equal(month.startAt.toISOString(), '2026-08-03T18:30:00.000Z');
  assert.equal(postIdTimeWindow('unknown', now), null);
});

test('request resolution messages immediately explain completed and rejected statuses', () => {
  const request = { requestText: 'Perfect World Hindi' };
  assert.match(requestResolutionNotificationText(request, 'completed'), /completed\. Please kindly check the site\./);
  assert.match(requestResolutionNotificationText(request, 'rejected'), /rejected due to issues\./);
});

test('batch title and category inference prefer cleaned file descriptions', () => {
  const files = [
    {
      displayName: 'Perfect World @release_source Episode 178 Hindi + Malayalam 1080p',
      name: 'Perfect.World.S01E178.1080p.mkv',
      episode: { start: 178, end: 178 }
    }
  ];
  assert.equal(inferBatchTitle(files), 'Perfect World');
  assert.equal(inferBatchCategory({ files, title: inferBatchTitle(files) }), 'web-series');
  assert.equal(inferBatchTitle([{ displayName: 'Episode 02', name: 'Moonlit.Archive.S01E02.720p.mkv' }]), 'Moonlit Archive');
  assert.equal(inferBatchCategory({ files: [{ displayName: 'Lingwu Continent Episode 204 Chinese', episode: { start: 204, end: 204 } }] }), 'donghua');
  assert.equal(inferBatchCategory({ title: 'A new Donghua release', files: [] }), 'donghua');
  const cocktail = {
    name: 'Cocktail.2.2026.1080p.NF.WEB-DL.Hindi.DDP5.1.H.265~[C_B].mkv'
  };
  assert.equal(inferBatchTitle([cocktail]), 'Cocktail 2');
  const raakh = {
    name: 'Raakh.S01E03.1080p.AMZN.mkv',
    episode: { start: 3, end: 3 }
  };
  assert.equal(inferBatchTitle([raakh]), 'Raakh');
  assert.equal(inferBatchCategory({ files: [raakh], title: 'Raakh' }), 'web-series');
  assert.equal(inferBatchTitle([{ name: 'Sora.Test.S02.1080p.NF.[t.is](http://t.is).mkv' }]), 'Sora Test');
});

test('batch import inspects every message in an inclusive private-storage range and keeps original IDs', async () => {
  const forwarded = [];
  const removed = [];
  const replies = [];
  const session = {
    title: '',
    category: 'movie',
    files: [],
    batch: { firstMessageId: 10, sourceChannelId: '-1002617067511', categoryOverride: null }
  };
  const previews = {
    10: {
      message_id: 501,
      caption: 'Perfect World Episode 01 Hindi 1080p',
      document: { file_id: 'first', file_name: 'Perfect.World.S01E01.1080p.mkv' }
    },
    11: { message_id: 502, text: 'A note between files' },
    12: {
      message_id: 503,
      caption: 'Perfect World Episode 02 Hindi 720p',
      video: { file_id: 'last', file_name: 'Perfect.World.S01E02.720p.mkv' }
    }
  };
  const repository = {
    async findContentByStorageMessageId() { return null; },
    async findSessionByStorageMessageId() { return null; },
    async appendSessionFile(_chat, _owner, file) { session.files.push(file); return session; },
    async findSession() { return session; },
    async updateSession(_chat, _owner, patch) { Object.assign(session, patch); return session; }
  };
  const ctx = {
    chat: { id: 200 },
    from: { id: 300 },
    telegram: {
      async forwardMessage(destination, source, messageId) {
        forwarded.push({ destination, source, messageId });
        return previews[messageId];
      },
      async deleteMessage(destination, messageId) { removed.push({ destination, messageId }); }
    },
    async reply(text) { replies.push(text); }
  };
  let published = false;

  await importStorageRange(
    ctx,
    session,
    { channelId: '-1002617067511', messageId: 12 },
    {},
    repository,
    { telegram: { storageChannelId: '-1002617067511' } },
    async () => { published = true; }
  );

  assert.deepEqual(forwarded.map((entry) => entry.messageId), [10, 11, 12]);
  assert.deepEqual(session.files.map((file) => file.storageMessageId), [10, 12]);
  assert.deepEqual(removed.map((entry) => entry.messageId), [501, 502, 503]);
  assert.equal(session.title, 'Perfect World');
  assert.equal(session.category, 'web-series');
  assert.equal(published, true);
  assert.match(replies.at(-1), /Imported 2 new files/);
});

test('batch import accepts a 448-message inclusive range as one release with progress updates', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.startSession({ chatId: 200, ownerId: 300, category: 'web-series', title: 'Long Running Show' });
  await repository.updateSession(200, 300, {
    workflow: 'batch',
    batch: { firstMessageId: 1, sourceChannelId: '-1002617067511', categoryOverride: 'web-series' }
  });
  const session = await repository.findSession(200, 300);
  const forwarded = [];
  const replies = [];
  const ctx = {
    chat: { id: 200 },
    from: { id: 300 },
    telegram: {
      async forwardMessage(_destination, _source, messageId) {
        forwarded.push(messageId);
        return {
          message_id: 10_000 + messageId,
          document: {
            file_id: `file-${messageId}`,
            file_name: `Long.Running.Show.S01E${String(messageId).padStart(3, '0')}.1080p.mkv`
          }
        };
      },
      async deleteMessage() {}
    },
    async reply(text) { replies.push(text); }
  };

  const result = await importStorageRange(
    ctx,
    session,
    { channelId: '-1002617067511', messageId: 448 },
    {},
    repository,
    { telegram: { storageChannelId: '-1002617067511' } },
    async () => ({ content: { title: 'Long Running Show' } })
  );

  assert.equal(result.imported, 448);
  assert.equal(forwarded.length, 448);
  assert.deepEqual([forwarded[0], forwarded.at(-1)], [1, 448]);
  assert.equal((await repository.findSession(200, 300)).files.length, 448);
  assert.ok(replies.some((text) => text.includes('Batch progress: 448/448')));
  assert.ok(replies.some((text) => text.includes('Imported 448 new files')));
});

test('batch import retries a Telegram rate-limit response before recording a failure', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.startSession({ chatId: 200, ownerId: 300, category: 'movie', title: 'Retry release' });
  await repository.updateSession(200, 300, {
    workflow: 'batch',
    batch: { firstMessageId: 44, sourceChannelId: '-1002617067511', categoryOverride: 'movie' }
  });
  let attempts = 0;
  const ctx = {
    chat: { id: 200 },
    from: { id: 300 },
    telegram: {
      async forwardMessage() {
        attempts += 1;
        if (attempts === 1) throw { description: 'Too Many Requests', parameters: { retry_after: 0.001 } };
        return { message_id: 500, document: { file_id: 'retry-file', file_name: 'Retry.Release.1080p.mkv' } };
      },
      async deleteMessage() {}
    },
    async reply() {}
  };

  const result = await importStorageRange(
    ctx,
    await repository.findSession(200, 300),
    { channelId: '-1002617067511', messageId: 44 },
    {}, repository, { telegram: { storageChannelId: '-1002617067511' } },
    async () => ({ content: { title: 'Retry release' } })
  );
  assert.equal(attempts, 2);
  assert.equal(result.imported, 1);
});

test('batch import enumerates already-published, active-draft, non-media, and inaccessible message IDs', async () => {
  const replies = [];
  const session = {
    title: '',
    category: 'movie',
    files: [],
    batch: { firstMessageId: 20, sourceChannelId: '-1002617067511', categoryOverride: null }
  };
  const repository = {
    async findContentByStorageMessageId(id) { return id === 20 ? { adminId: 'SB-0123ABCDEF' } : null; },
    async findSessionByStorageMessageId(id) { return id === 21 ? { workflow: 'automation' } : null; },
    async appendSessionFile() { throw new Error('must not append a non-media range'); },
    async findSession() { return session; },
    async updateSession(_chat, _owner, patch) { Object.assign(session, patch); return session; }
  };
  const ctx = {
    chat: { id: 200 },
    from: { id: 300 },
    telegram: {
      async forwardMessage(_destination, _source, id) {
        if (id === 22) return { message_id: 800, text: 'A note between releases' };
        throw { description: 'Bad Request: message to forward not found' };
      },
      async deleteMessage() {}
    },
    async reply(text) { replies.push(text); }
  };

  await importStorageRange(
    ctx,
    session,
    { channelId: '-1002617067511', messageId: 23 },
    {},
    repository,
    { telegram: { storageChannelId: '-1002617067511' } }
  );

  const diagnostic = replies.join('\n');
  assert.match(diagnostic, /Already linked to a catalog post \(1\): 20 \(SB-0123ABCDEF\)/);
  assert.match(diagnostic, /Already attached to an active draft \(1\): 21 \(automation\)/);
  assert.match(diagnostic, /Not supported media \/ text-only \(1\): 22/);
  assert.match(diagnostic, /Could not inspect .*23 \(Bad Request: message to forward not found\)/);
  assert.equal(session.batch.skipReasons.alreadyPublished, 1);
  assert.equal(session.batch.failureCount, 1);
});

test('storage automation persistently groups matching direct uploads, then publishes once and silently appends later files', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.setAutoPublishSettings({ enabled: true, updatedBy: 300, notifyChatId: 300 });
  const notifications = [];
  const bot = {
    botInfo: { id: 999 },
    telegram: { async sendMessage(_destination, text) { notifications.push(text); } }
  };
  const config = { telegram: { storageChannelId: '-1002617067511', botUsername: 'DeliveryBot' } };
  const makeContext = (messageId, filename) => ({
    channelPost: {
      message_id: messageId,
      chat: { id: -1002617067511 },
      document: { file_id: `stored-file-${messageId}`, file_name: filename, file_size: 123 }
    }
  });

  const first = await autoPublishStoragePost(
    makeContext(71, 'Cocktail.2.2026.1080p.NF.WEB-DL.Hindi.DDP5.1.H.265~[C_B].mkv'),
    bot,
    repository,
    config,
    new Set(),
    new Set(),
    { idleMs: 1_000, maxWaitMs: 5_000 }
  );
  const second = await autoPublishStoragePost(
    makeContext(72, 'Cocktail.2.2026.720p.NF.WEB-DL.Hindi.AAC2.0.x264~[C_B].mkv'),
    bot,
    repository,
    config,
    new Set(),
    new Set(),
    { idleMs: 1_000, maxWaitMs: 5_000 }
  );

  assert.equal(first.groupKey, 'cocktail-2');
  assert.equal(second.groupKey, 'cocktail-2');
  const queued = await repository.findSession(-1002617067511, 'auto-storage-group-cocktail-2');
  assert.equal(queued.title, 'Cocktail 2');
  assert.equal(queued.category, 'movie');
  assert.equal(queued.files.length, 2);
  assert.equal(queued.auto.status, 'collecting');
  assert.ok(queued.auto.scheduledAt);

  let publicationCalls = 0;
  const publish = async (automationContext, _bot, activeRepository) => {
    publicationCalls += 1;
    const active = await activeRepository.findSession(automationContext.chat.id, automationContext.from.id);
    return {
      content: await activeRepository.createContent({
        title: active.title,
        category: active.category,
        files: active.files,
        automationKey: active.auto.groupKey
      })
    };
  };
  await processQueuedAutomationSessions({
    bot,
    repository,
    config,
    publish,
    now: new Date(Date.now() + 2_000).toISOString()
  });
  assert.equal(publicationCalls, 1);
  let content = await repository.findContentByMergeKey('cocktail-2');
  assert.equal(content.files.length, 2);
  assert.match(notifications.at(-1), /Post ID:/);

  await autoPublishStoragePost(
    makeContext(73, 'Cocktail.2.2026.480p.NF.WEB-DL.Hindi.mkv'),
    bot,
    repository,
    config,
    new Set(),
    new Set(),
    { idleMs: 1_000, maxWaitMs: 5_000 }
  );
  await processQueuedAutomationSessions({
    bot,
    repository,
    config,
    publish,
    now: new Date(Date.now() + 2_000).toISOString()
  });
  content = await repository.findContentByMergeKey('cocktail-2');
  assert.equal(publicationCalls, 1);
  assert.equal(content.files.length, 3);
  assert.match(notifications.at(-1), /No second announcement was sent/);
  assert.equal(automationGroupKey('Cocktail 2', 73), 'cocktail-2');
});

test('provider-verified aliases merge noisy automatic titles into one catalog record', async () => {
  const repository = new MemoryCatalogRepository([]);
  const firstKeys = automationMergeKeys(
    { title: 'Raakh', auto: { groupKey: 'raakh' } },
    { title: 'Raakh', metadataKey: 'tmdb-tv-444' }
  );
  const first = await repository.createContent({
    title: 'Raakh',
    category: 'web-series',
    metadataKey: 'tmdb-tv-444',
    automationKey: 'raakh',
    automationKeys: firstKeys,
    files: [{ storageMessageId: 1, name: 'Raakh.S01E01.mkv' }]
  });
  const laterKeys = automationMergeKeys(
    { title: 'Raakh S01', auto: { groupKey: 'raakh-s01' } },
    { title: 'Raakh', metadataKey: 'tmdb-tv-444' }
  );
  assert.ok(laterKeys.includes('tmdb-tv-444'));
  const matched = await repository.findContentByMergeKey('tmdb-tv-444');
  assert.equal(matched.adminId, first.adminId);
  const merged = await repository.appendFilesToContentByMergeKey('tmdb-tv-444', [{ storageMessageId: 2, name: 'Raakh.S01E02.mkv' }], laterKeys);
  assert.equal(merged.adminId, first.adminId);
  assert.equal(merged.filesCount, 2);
  assert.ok(merged.automationKeys.includes('raakh-s01'));
  assert.equal((await repository.listContent({ limit: 10 })).length, 1);
});

test('automatic publishing resolves a verified TMDB alias before it can create a duplicate post', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [{ id: 444, name: 'Raakh', poster_path: '/raakh.jpg', popularity: 10 }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const repository = new MemoryCatalogRepository([]);
  await repository.setAutoPublishSettings({ enabled: true, updatedBy: 700, notifyChatId: 700 });
  const existing = await repository.createContent({
    title: 'Raakh',
    category: 'web-series',
    metadataKey: 'tmdb-tv-444',
    automationKey: 'raakh',
    files: [{ storageMessageId: 1, name: 'Raakh.S01E01.mkv' }]
  });
  const now = new Date().toISOString();
  await repository.queueAutomationSession({
    chatId: '-1002617067511',
    ownerId: 'auto-storage-group-raakh-season-01',
    category: 'web-series',
    title: 'Raakh Season 01',
    groupKey: 'raakh-season-01',
    file: { storageMessageId: 2, name: 'Raakh.S01E02.mkv' },
    scheduledAt: now,
    maxWaitAt: now,
    firstReceivedAt: now,
    receivedAt: now
  });
  let publishCalls = 0;
  const results = await processQueuedAutomationSessions({
    bot: { telegram: { async sendMessage() {} } },
    repository,
    config: { tmdbApiKey: 'test-key', telegram: { botUsername: 'DeliveryBot' } },
    publish: async () => { publishCalls += 1; return { content: null }; },
    now: new Date(Date.now() + 1_000).toISOString()
  });

  assert.equal(publishCalls, 0);
  assert.equal(results[0].state, 'merged');
  assert.equal((await repository.findContentByMergeKey('tmdb-tv-444')).adminId, existing.adminId);
  assert.equal((await repository.findContentByMergeKey('tmdb-tv-444')).filesCount, 2);
});

test('queued automation keeps errors out of storage and sends an actionable report only to the publisher', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.setAutoPublishSettings({ enabled: true, updatedBy: 700, notifyChatId: 700 });
  const now = new Date().toISOString();
  await repository.queueAutomationSession({
    chatId: '-1002617067511',
    ownerId: 'auto-storage-group-broken-release',
    category: 'movie',
    title: 'Broken release',
    file: { storageMessageId: 88, name: 'Broken.Release.1080p.mkv' },
    groupKey: 'broken-release',
    scheduledAt: now,
    maxWaitAt: now,
    firstReceivedAt: now,
    receivedAt: now
  });
  const sent = [];
  const result = await processQueuedAutomationSessions({
    bot: { telegram: { async sendMessage(destination, text) { sent.push({ destination, text }); } } },
    repository,
    config: { telegram: { botUsername: 'DeliveryBot' } },
    publish: async () => ({ content: null, error: 'ImgBB is unavailable' }),
    now: new Date(Date.now() + 1_000).toISOString()
  });

  assert.equal(result[0].state, 'failed');
  assert.equal((await repository.findSession('-1002617067511', 'auto-storage-group-broken-release')).auto.status, 'failed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].destination, '700');
  assert.match(sent[0].text, /ImgBB is unavailable/);
});

test('storage automation ignores bot-originated media before it can create a loop', async () => {
  let settingsRead = false;
  const repository = {
    async getAutoPublishSettings() { settingsRead = true; return { enabled: true }; }
  };
  await autoPublishStoragePost(
    {
      channelPost: {
        message_id: 91,
        chat: { id: -1002617067511 },
        from: { id: 999, is_bot: true },
        document: { file_id: 'announcement', file_name: 'announcement.jpg' }
      }
    },
    { botInfo: { id: 999 } },
    repository,
    { telegram: { storageChannelId: '-1002617067511' } },
    new Set(),
    new Set(),
    async () => { throw new Error('must not publish bot-originated media'); }
  );
  assert.equal(settingsRead, false);
});

test('a replacement bot token updates runtime delivery links to its detected username', () => {
  const config = { telegram: { botUsername: 'RetiredDeliveryBot' } };
  const result = synchronizeDeliveryBotUsername(config, { username: 'ReplacementDeliveryBot' });

  assert.deepEqual(result, {
    username: 'ReplacementDeliveryBot',
    previousUsername: 'RetiredDeliveryBot',
    changed: true
  });
  assert.equal(config.telegram.botUsername, 'ReplacementDeliveryBot');
  assert.equal(
    getTelegramFileDeliveryUrl(config, 'aB-cD_ef', 1),
    'https://t.me/ReplacementDeliveryBot?start=file-aB-cD_ef-1'
  );
});

test('stored file record keeps the returned storage message ID', () => {
  const file = fileFromMessage(
    {
      message_id: 12,
      caption: 'Lingwu Continent @sourcechannel Episode 204 Hindi + Malayalam 1080p',
      video: {
        file_id: 'telegram-file-id',
        file_name: 'Lingwu.Continent.Episode.204.English.Sub.mkv',
        mime_type: 'video/x-matroska',
        file_size: 72_100_000
      }
    },
    987,
    'copy'
  );

  assert.equal(file.storageMessageId, 987);
  assert.equal(file.episode.start, 204);
  assert.equal(file.episode.source, 'caption');
  assert.deepEqual(file.languages, ['Hindi', 'Malayalam']);
  assert.equal(file.quality, '1080P');
});

test('storage troubleshooting distinguishes protected content and wrong channel IDs', () => {
  assert.match(storageErrorHint({ description: "Bad Request: message can't be copied" }), /protected/i);
  assert.match(storageErrorHint({ description: 'Bad Request: chat not found' }), /numeric -100/i);
});
