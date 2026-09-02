import test from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramFileDeliveryUrl } from '../src/server/config.js';
import { DELIVERY_FILE_DELETE_AFTER_MS, PUBLISHER_COMMANDS, announcePublishedContent, applyStreamingManifest, automationGroupKey, automationMergeKeys, autoPublishStoragePost, cleanStorageCaption, deliverContent, fileFromMessage, importStorageRange, inferBatchCategory, inferBatchTitle, parseDeliveryPayload, parseDirectStreamingInput, parsePrivateStorageMessageLink, parsePublishedPostEdit, postIdKeyboard, postIdTimeWindow, processQueuedAutomationSessions, publishDraft, releaseMergeKeys, requestManagerKeyboard, requestResolutionNotificationText, scheduleDeliveredFileDeletion, storageErrorHint, storeMediaInChannel, synchronizeDeliveryBotUsername } from '../src/server/services/telegram-bot.js';
import { parseStreamingManifest } from '../src/server/services/streaming-service.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { handlePosterAction, handlePosterFlowMessage, posterCandidateKeyboard, presentPosterCandidates, readSeason, withSeasonLabel } from '../src/server/services/telegram-bot.js';

const posterConfig = { telegram: { botUsername: 'DeliveryBot' }, imgbbApiKey: 'test-imgbb-key', mediaInfo: { enabled: false } };

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
    caption: 'Perfect World Ep 01 Hindi 1080p @release_source',
    document: { file_id: 'document-file-id', file_name: 'perfect-world.mkv' }
  });

  assert.deepEqual(stored, { storageMessageId: 456, storageChannelId: '-100123', method: 'file-id-fallback' });
  assert.deepEqual(calls[0], {
    destination: '-100123',
    fileId: 'document-file-id',
    extra: { disable_notification: true, caption: 'Perfect World Ep 01 Hindi 1080p' }
  });
});


test('copied storage captions and persisted source labels remove Telegram promotion handles', async () => {
  const calls = [];
  const message = {
    message_id: 16,
    caption: 'RRR (2022) Dual Audio Hindi + English 1080p @Doraemon_Movies_Hindi1 https://t.me/example',
    document: { file_id: 'rrr-file-id', file_name: 'RRR.2022.1080p.mkv' }
  };
  const telegram = {
    async copyMessage(destination, source, messageId, extra) {
      calls.push({ destination, source, messageId, extra });
      return { message_id: 321 };
    }
  };

  const stored = await storeMediaInChannel(telegram, '-100private', 501, message);
  const file = fileFromMessage(message, stored.storageMessageId, stored.method, stored.storageChannelId);

  assert.equal(cleanStorageCaption(message.caption), 'RRR (2022) Dual Audio Hindi + English 1080p');
  assert.deepEqual(calls, [{
    destination: '-100private',
    source: 501,
    messageId: 16,
    extra: { disable_notification: true, caption: 'RRR (2022) Dual Audio Hindi + English 1080p' }
  }]);
  assert.equal(file.sourceLabel.includes('@Doraemon_Movies_Hindi1'), false);
  assert.equal(file.sourceLabel.includes('https://t.me'), false);
  assert.deepEqual(file.audioLanguages, ['Hindi', 'English']);
  assert.equal(file.storageChannelId, '-100private');
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

test('publisher menu exposes post management, backup, and compatible metadata commands', () => {
  const commands = PUBLISHER_COMMANDS.map((entry) => entry.command);
  for (const command of ['posts', 'postid', 'lang', 'lan', 'lam', 'year', 'cmd', 'backup', 'recover', 'adultdb']) {
    assert.ok(commands.includes(command), `${command} should be available to publisher command scopes`);
  }
  assert.deepEqual(parsePublishedPostEdit('SB-a1b2c3d4e5 Hindi, English'), {
    adminId: 'SB-A1B2C3D4E5', value: 'Hindi, English'
  });
  assert.deepEqual(parsePublishedPostEdit('SB-A1B2C3D4E5: 2026'), {
    adminId: 'SB-A1B2C3D4E5', value: '2026'
  });
  assert.deepEqual(parsePublishedPostEdit('SB-A1B2C3D4E5'), {
    adminId: 'SB-A1B2C3D4E5', value: ''
  });
  assert.equal(parsePublishedPostEdit('Hindi, English'), null);
});


test('direct /cmd input can attach one explicit episode player while preserving intentional main players', () => {
  assert.deepEqual(parseDirectStreamingInput('ep 01 https://soraboxs.embedseek.com/#episode-one'), {
    playerValue: 'https://soraboxs.embedseek.com/#episode-one',
    episode: { start: 1, end: 1, label: 'Episode 01' },
    error: null
  });
  assert.deepEqual(parseDirectStreamingInput('episode 2-4 <iframe src="https://soraboxs.embedseek.com/#episodes-two-four"></iframe>'), {
    playerValue: '<iframe src="https://soraboxs.embedseek.com/#episodes-two-four"></iframe>',
    episode: { start: 2, end: 4, label: 'Episodes 02–04' },
    error: null
  });
  assert.deepEqual(parseDirectStreamingInput('https://soraboxs.embedseek.com/#release-main'), {
    playerValue: 'https://soraboxs.embedseek.com/#release-main',
    episode: null,
    error: null
  });
});

test('18+ posts never dispatch a Telegram announcement', async () => {
  let listed = 0;
  let sent = 0;
  const result = await announcePublishedContent({
    bot: { telegram: { sendMessage: async () => { sent += 1; } } },
    repository: { listAnnouncementChannels: async () => { listed += 1; return [{ channelId: '-100public' }]; } },
    content: { category: 'adult', title: 'Restricted release' },
    websiteUrl: 'https://catalog.example/adult/restricted-release',
    storageChannelId: '-100adult'
  });
  assert.deepEqual(result, { sent: 0, failed: 0, skipped: 0, suppressed: true });
  assert.equal(listed, 0);
  assert.equal(sent, 0);
});


test('18+ delivery always reads the isolated adult storage channel, never a saved normal source', async () => {
  const copied = [];
  const replies = [];
  await deliverContent(
    {
      chat: { id: 400 },
      telegram: { copyMessage: async (...args) => { copied.push(args); } },
      reply: async (text) => { replies.push(text); }
    },
    { shareCode: 'adult-share-code', filePosition: null },
    {
      findContentByShareCode: async () => ({
        title: 'Restricted release',
        category: 'adult',
        files: [{ storageMessageId: 42, storageChannelId: '-100normal' }]
      }),
      incrementDelivery: async () => {}
    },
    { telegram: { storageChannelId: '-100normal', adultStorageChannelId: '-100adult' } }
  );

  assert.deepEqual(copied, [[400, '-100adult', 42]]);
  assert.match(replies.at(-1), /Delivered 1 of 1/);
});


test('bot delivery schedules every copied media message for deletion after five minutes', async () => {
  const copied = [];
  const scheduled = [];
  const replies = [];
  let deliveryIncrements = 0;
  await deliverContent(
    {
      chat: { id: 555 },
      telegram: {
        copyMessage: async (...args) => {
          copied.push(args);
          return { message_id: 900 + copied.length };
        }
      },
      reply: async (text) => { replies.push(text); }
    },
    { shareCode: 'normal-share-code', filePosition: null },
    {
      findContentByShareCode: async () => ({
        title: 'Temporary delivery',
        category: 'movie',
        files: [{ storageMessageId: 42 }, { storageMessageId: 43 }]
      }),
      incrementDelivery: async () => { deliveryIncrements += 1; }
    },
    { telegram: { storageChannelId: '-100normal' } },
    {
      scheduleDeletion: (details) => {
        scheduled.push(details);
        return true;
      }
    }
  );

  assert.deepEqual(copied, [[555, '-100normal', 42], [555, '-100normal', 43]]);
  assert.equal(deliveryIncrements, 1);
  assert.deepEqual(scheduled.map(({ recipientChatId, messageId, deleteAfterMs }) => ({ recipientChatId, messageId, deleteAfterMs })), [
    { recipientChatId: 555, messageId: 901, deleteAfterMs: DELIVERY_FILE_DELETE_AFTER_MS },
    { recipientChatId: 555, messageId: 902, deleteAfterMs: DELIVERY_FILE_DELETE_AFTER_MS }
  ]);
  assert.match(replies.at(-1), /remove 2 delivered files from this chat in about 5 minutes/i);
});

test('scheduled cleanup removes a bot-delivered message without deleting anything from storage', async () => {
  const deleted = [];
  let resolveDeletion;
  const didDelete = new Promise((resolve) => { resolveDeletion = resolve; });
  const scheduled = scheduleDeliveredFileDeletion({
    telegram: {
      async deleteMessage(destination, messageId) {
        deleted.push({ destination, messageId });
        resolveDeletion();
      }
    },
    recipientChatId: 777,
    messageId: 55,
    deleteAfterMs: 0
  });
  assert.equal(scheduled, true);
  await Promise.race([
    didDelete,
    new Promise((_, reject) => setTimeout(() => reject(new Error('delivery cleanup did not run')), 250))
  ]);
  assert.deepEqual(deleted, [{ destination: '777', messageId: 55 }]);
  assert.equal(scheduleDeliveredFileDeletion({ telegram: {}, recipientChatId: 777, messageId: 55 }), false);
});

test('18+ publishing rejects a missing or shared storage configuration before any post is created', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.startSession({ chatId: 88, ownerId: 88, category: 'adult', title: 'Restricted release' });
  await repository.appendSessionFile(88, 88, { storageMessageId: 1, storageChannelId: '-100normal', name: 'restricted.mkv' });
  const replies = [];
  const result = await publishDraft(
    { chat: { id: 88 }, from: { id: 88 }, reply: async (text) => { replies.push(text); } },
    { telegram: {} },
    repository,
    { telegram: { botUsername: 'DeliveryBot', storageChannelId: '-100normal', adultStorageChannelId: '-100normal' }, mediaInfo: { enabled: false } }
  );

  assert.equal(result.content, null);
  assert.match(result.error, /must be different/);
  assert.match(replies.at(-1), /must be different/);
  assert.equal((await repository.listContent({ category: 'adult', limit: 10 })).length, 0);
});

test('a later manual upload for the same release appends files instead of creating a duplicate post', async () => {
  const repository = new MemoryCatalogRepository([]);
  const existing = await repository.createContent({
    title: 'The Gentlemen',
    category: 'web-series',
    files: [{ storageMessageId: 40, name: 'The.Gentlemen.S01.480p.mkv', languages: ['Hindi'] }]
  });
  await repository.startSession({ chatId: 501, ownerId: 501, category: 'web-series', title: 'The Gentlemen' });
  await repository.appendSessionFile(501, 501, {
    storageMessageId: 41,
    name: 'The.Gentlemen.S01.720p.mkv',
    languages: ['Hindi'],
    audioLanguages: ['Hindi'],
    kind: 'video'
  });
  const replies = [];
  const result = await publishDraft(
    { chat: { id: 501 }, from: { id: 501 }, reply: async (text) => { replies.push(text); } },
    { telegram: {} },
    repository,
    { telegram: { botUsername: 'DeliveryBot' }, mediaInfo: { enabled: false } }
  );

  assert.equal(result.merged, true);
  assert.equal(result.content.adminId, existing.adminId);
  assert.equal(result.content.filesCount, 2);
  assert.deepEqual(result.content.files.map((file) => file.storageMessageId), [40, 41]);
  assert.equal(await repository.findSession(501, 501), null);
  assert.ok(replies.some((text) => /Added 1 new file to the existing catalog post/.test(text)));
  assert.deepEqual(releaseMergeKeys({ title: 'The Gentlemen' }, { title: 'The Gentlemen' }), ['the-gentlemen']);
});


test('a later noisy RRR batch release merges into the original movie rather than creating a second card', async () => {
  const repository = new MemoryCatalogRepository([]);
  const original = await repository.createContent({
    title: 'RRR (2022) Hindi 1080p',
    category: 'movie',
    files: [{ storageMessageId: 10, storageChannelId: '-100normal', name: 'RRR.2022.1080p.mkv' }]
  });
  await repository.startSession({ chatId: 502, ownerId: 502, category: 'movie', title: 'RRR' });
  await repository.updateSession(502, 502, {
    workflow: 'batch',
    metadata: { matched: false, title: 'RRR', languages: [], genres: [], description: '', status: 'New release', releaseLabel: null }
  });
  await repository.appendSessionFile(502, 502, {
    storageMessageId: 11,
    storageChannelId: '-100normal',
    name: 'RRR.2022.720p.mkv',
    sourceLabel: 'RRR (2022) Hindi 720p @Doraemon_Movies_Hindi1',
    kind: 'video'
  });

  const result = await publishDraft(
    { chat: { id: 502 }, from: { id: 502 }, reply: async () => {} },
    { telegram: {} },
    repository,
    { telegram: { botUsername: 'DeliveryBot' }, mediaInfo: { enabled: false } }
  );

  assert.equal(result.merged, true);
  assert.equal(result.content.adminId, original.adminId);
  assert.equal(result.content.filesCount, 2);
  assert.equal((await repository.listContent({ category: 'movie', limit: 10 })).length, 1);
  assert.equal(result.content.files.at(-1).sourceLabel.includes('@Doraemon_Movies_Hindi1'), false);
  assert.ok(releaseMergeKeys({ category: 'movie', title: 'RRR' }, {}).includes('rrr'));
  assert.equal(releaseMergeKeys({ category: 'web-series', title: 'RRR S01E01 1080p' }, {}).includes('rrr'), false);
});

test('manual /cmd manifests attach Watch players to existing posts without publishing or announcing again', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'The Gentlemen Season 1',
    category: 'web-series',
    files: [{ storageMessageId: 90, name: 'The.Gentlemen.S01E01.mkv' }]
  });
  const manifest = parseStreamingManifest(JSON.stringify([{
    Title: 'The Gentlemen Season 1',
    Episode: '1',
    'Embed Code': '<iframe src="https://soraboxs.embedseek.com/#58yvk" width="100%"></iframe>'
  }]), { format: 'json' });

  const result = await applyStreamingManifest({ repository, manifest, config: { streaming: {} } });
  const updated = await repository.findContentByAdminId(created.adminId);

  assert.equal(result.updated.length, 1);
  assert.equal(result.attachedRows, 1);
  assert.equal(updated.adminId, created.adminId);
  assert.equal(updated.filesCount, 1);
  assert.equal(updated.stream.entries[0].embedUrl, 'https://soraboxs.embedseek.com/#58yvk');
  assert.equal((await repository.listContent({ limit: 10 })).length, 1);
  // applyStreamingManifest only updates stream metadata: it has no Telegram
  // bot/announcement dependency and cannot create a second post.
  assert.equal(result.rejected.length, 0);
});

test('manual /cmd title matching refuses an ambiguous category until the manifest specifies one', async () => {
  const repository = new MemoryCatalogRepository([]);
  const movie = await repository.createContent({ title: 'Shared Watch Title', category: 'movie' });
  const series = await repository.createContent({ title: 'Shared Watch Title', category: 'web-series' });
  const ambiguous = parseStreamingManifest(JSON.stringify([{
    Title: 'Shared Watch Title', 'Embed Link': 'https://soraboxs.embedseek.com/#ambiguous'
  }]), { format: 'json' });
  const rejected = await applyStreamingManifest({ repository, manifest: ambiguous, config: { streaming: {} } });
  assert.equal(rejected.updated.length, 0);
  assert.match(rejected.rejected[0].error, /multiple catalog posts/i);

  const scoped = parseStreamingManifest(JSON.stringify([{
    Title: 'Shared Watch Title', Category: 'web-series', 'Embed Link': 'https://soraboxs.embedseek.com/#series'
  }]), { format: 'json' });
  const attached = await applyStreamingManifest({ repository, manifest: scoped, config: { streaming: {} } });
  assert.equal(attached.updated[0].content.adminId, series.adminId);
  assert.equal((await repository.findContentByAdminId(movie.adminId)).stream, null);
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
  const captionEdits = [];
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
      caption: 'Perfect World Episode 01 Hindi 1080p @release_source',
      document: { file_id: 'first', file_name: 'Perfect.World.S01E01.1080p.mkv' }
    },
    11: { message_id: 502, text: 'A note between files' },
    12: {
      message_id: 503,
      caption: 'Perfect World Episode 02 Hindi 720p @release_source',
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
      async deleteMessage(destination, messageId) { removed.push({ destination, messageId }); },
      async editMessageCaption(destination, messageId, _inlineMessageId, caption) { captionEdits.push({ destination, messageId, caption }); }
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
  assert.deepEqual(session.files.map((file) => file.storageChannelId), ['-1002617067511', '-1002617067511']);
  assert.deepEqual(captionEdits, [
    { destination: '-1002617067511', messageId: 10, caption: 'Perfect World Episode 01 Hindi 1080p' },
    { destination: '-1002617067511', messageId: 12, caption: 'Perfect World Episode 02 Hindi 720p' }
  ]);
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
  assert.deepEqual(file.audioLanguages, ['Hindi', 'Malayalam']);
  assert.deepEqual(file.subtitleLanguages, ['English']);
  assert.equal(file.mediaInfo.status, 'filename');
  assert.equal(file.quality, '1080P');

  const dualCaptionFile = fileFromMessage({
    message_id: 13,
    caption: 'Release Dual Audio Hindi + English 1080p',
    document: { file_id: 'dual-file', file_name: 'release.1080p.mkv' }
  }, 988);
  assert.equal(dualCaptionFile.mediaInfo.status, 'pending');
  assert.equal(dualCaptionFile.mediaInfo.needsInspection, true);
});

test('storage troubleshooting distinguishes protected content and wrong channel IDs', () => {
  assert.match(storageErrorHint({ description: "Bad Request: message can't be copied" }), /protected/i);
  assert.match(storageErrorHint({ description: 'Bad Request: chat not found' }), /numeric -100/i);
});

test('a mixed-season batch publishes one catalog post per season and keeps later uploads apart', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.startSession({ chatId: 640, ownerId: 640, category: 'anime', title: 'Demon Slayer' });
  await repository.updateSession(640, 640, {
    workflow: 'batch',
    metadata: { matched: false, title: 'Demon Slayer', languages: ['Hindi'], genres: [], description: '', status: 'New release', releaseLabel: null }
  });
  const names = ['Demon.Slayer.S01E01.1080p.mkv', 'Demon.Slayer.S01E02.1080p.mkv', 'Demon.Slayer.S02E01.1080p.mkv', 'Demon.Slayer.S02E02.1080p.mkv'];
  for (const [index, name] of names.entries()) {
    await repository.appendSessionFile(640, 640, { storageMessageId: 900 + index, storageChannelId: '-100normal', name, kind: 'video' });
  }

  const replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: { id: 'imgbb-seasons', url: 'https://i.ibb.co/mirror/seasons.png', display_url: 'https://i.ibb.co/mirror/seasons.png' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const publishConfig = { telegram: { botUsername: 'DeliveryBot' }, imgbbApiKey: 'test-imgbb-key', mediaInfo: { enabled: false } };
  try {
    const result = await publishDraft(
      { chat: { id: 640 }, from: { id: 640 }, reply: async (text) => { replies.push(text); } },
      { telegram: {} },
      repository,
      publishConfig
    );

    assert.equal(result.multiSeason, true);
    assert.equal(result.seasons.length, 2);
    const posts = (await repository.listContent({ category: 'anime', limit: 10 }))
      .sort((first, second) => first.title.localeCompare(second.title));
    assert.deepEqual(posts.map((post) => post.title), ['Demon Slayer Season 1', 'Demon Slayer Season 2']);
    assert.deepEqual(posts.map((post) => post.files.length), [2, 2], 'each season holds exactly its own files');
    assert.deepEqual(posts.map((post) => post.files.map((file) => file.name)), [
      ['Demon.Slayer.S01E01.1080p.mkv', 'Demon.Slayer.S01E02.1080p.mkv'],
      ['Demon.Slayer.S02E01.1080p.mkv', 'Demon.Slayer.S02E02.1080p.mkv']
    ]);
    assert.ok(replies.some((text) => /2 seasons were detected/.test(text)));
    assert.equal(await repository.findSession(640, 640), null, 'the draft is cleared once every season is published');

    // A lone Season 2 file sent later must land on the Season 2 card, not the
    // first post that happens to share the base title.
    await repository.startSession({ chatId: 640, ownerId: 640, category: 'anime', title: 'Demon Slayer' });
    await repository.updateSession(640, 640, {
      workflow: 'batch',
      metadata: { matched: false, title: 'Demon Slayer', languages: ['Hindi'], genres: [], description: '', status: 'New release', releaseLabel: null }
    });
    await repository.appendSessionFile(640, 640, { storageMessageId: 970, storageChannelId: '-100normal', name: 'Demon.Slayer.S02E03.1080p.mkv', kind: 'video' });
    const followUp = await publishDraft(
      { chat: { id: 640 }, from: { id: 640 }, reply: async (text) => { replies.push(text); } },
      { telegram: {} },
      repository,
      publishConfig
    );

    assert.equal(followUp.merged, true);
    assert.equal(followUp.content.adminId, posts[1].adminId);
    assert.equal(followUp.content.files.length, 3);
    assert.ok(replies.some((text) => /Added 1 new file to the existing catalog post/.test(text)));
    assert.equal((await repository.listContent({ category: 'anime', limit: 10 })).length, 2, 'no third post was created');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('season identity is part of the release merge key, while legacy posts still merge', () => {
  assert.deepEqual(
    releaseMergeKeys({ title: 'Show' }, { metadataKey: 'tmdb-tv-9' }, { season: 2 }),
    ['tmdb-tv-9-season-2', 'show-season-2', 'tmdb-tv-9', 'show']
  );
  assert.deepEqual(releaseMergeKeys({ title: 'Show' }, { title: 'Show' }), ['show'], 'a season-less release keeps its old key');
  assert.deepEqual(automationMergeKeys({ title: 'Show' }, { metadataKey: 'tmdb-tv-9' }, { season: 4 })[0], 'tmdb-tv-9-season-4');
  assert.equal(withSeasonLabel('Show', 2), 'Show Season 2');
  assert.equal(withSeasonLabel('Show', null), 'Show');
  assert.equal(withSeasonLabel('Show Season 1', 1), 'Show Season 1', 'a season already named in the title is not repeated');
  assert.equal(withSeasonLabel('Demon Slayer', 3, { replace: true }), 'Demon Slayer Season 3');

  // `Number(null)` is 0, which used to be accepted as a season and silently
  // produced "Season 0" keys that matched nothing.
  for (const value of [null, undefined, '', 0, '3', 2.5, 100]) {
    assert.equal(readSeason(value), Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 99 ? Number(value) : null, `readSeason(${String(value)})`);
  }
});

test('the old poster style still works: post ID then an HTTPS image link', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Poster release',
    category: 'movie',
    posterUrl: 'https://old.example/poster.jpg',
    files: [{ storageMessageId: 60, name: 'Poster.release.1080p.mkv', quality: '1080P' }]
  });
  const originalFetch = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.imgbb.com')) {
      posted.push(options?.method || 'GET');
      return new Response(JSON.stringify({ success: true, data: { id: 'imgbb-1', url: 'https://i.ibb.co/mirror/poster.png', display_url: 'https://i.ibb.co/mirror/poster.png' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(Buffer.from('poster-bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const replies = [];
  const taps = [];
  // Telegraf, not grammY: the real context answers a tap through `answerCbQuery`.
  const ctx = {
    chat: { id: 641 },
    from: { id: 641 },
    message: { text: '' },
    reply: async (text) => { replies.push(text); },
    answerCbQuery: async (text, extra) => { taps.push({ text, showAlert: Boolean(extra?.show_alert) }); },
    replyWithPhoto: async () => {}
  };
  try {
    await repository.startPosterFlow({ chatId: 641, ownerId: 641, style: 'old', stage: 'post-id' });

    await handlePosterAction(ctx, repository, posterConfig, 'poster:style:old');
    assert.equal((await repository.findPosterFlow(641, 641)).stage, 'post-id');
    assert.deepEqual(taps, [{ text: undefined, showAlert: false }], 'the tap is answered exactly once');

    ctx.message = { text: 'not-a-post-id' };
    assert.equal(await handlePosterFlowMessage(ctx, repository, posterConfig), true);
    assert.match(replies.at(-1), /Send the post ID only/);

    ctx.message = { text: created.adminId };
    assert.equal(await handlePosterFlowMessage(ctx, repository, posterConfig), true);
    assert.equal((await repository.findPosterFlow(641, 641)).stage, 'image-url');
    assert.match(replies.at(-1), new RegExp(`Editing ${created.adminId}`));

    ctx.message = { text: 'please mirror this one' };
    assert.equal(await handlePosterFlowMessage(ctx, repository, posterConfig), true);
    assert.match(replies.at(-1), /not an HTTPS image link/);
    assert.equal((await repository.findContentByAdminId(created.adminId)).posterUrl, 'https://old.example/poster.jpg', 'an invalid link never touches the card');

    ctx.message = { text: 'mirror https://8.8.8.8/new-poster.jpg thanks' };
    assert.equal(await handlePosterFlowMessage(ctx, repository, posterConfig), true);
    assert.match(replies.at(-1), /Poster updated for SB-/);
    const updated = await repository.findContentByAdminId(created.adminId);
    assert.equal(updated.posterUrl, 'https://i.ibb.co/mirror/poster.png');
    assert.equal(updated.poster.source, 'remote-mirror');
    assert.equal(updated.poster.provider, 'imgbb');
    assert.equal(updated.poster.providerId, 'imgbb-1');
    assert.equal(updated.poster.originalUrl, 'https://8.8.8.8/new-poster.jpg');
    assert.equal(await repository.findPosterFlow(641, 641), null, 'a finished flow is removed');
    assert.deepEqual(posted, ['POST']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the new poster style mirrors a tapped artwork button and a failed search stays harmless', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Picked release',
    category: 'anime',
    posterUrl: 'https://old.example/poster.jpg',
    files: [{ storageMessageId: 61, name: 'Picked.release.S01E01.mkv' }]
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('api.imgbb.com')
    ? new Response(JSON.stringify({ success: true, data: { id: 'imgbb-2', url: 'https://i.ibb.co/mirror/pick.png', display_url: 'https://i.ibb.co/mirror/pick.png' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(Buffer.from('picked-bytes'), { status: 200, headers: { 'content-type': 'image/png' } }));
  const replies = [];
  const taps = [];
  const ctx = {
    chat: { id: 642 },
    from: { id: 642 },
    reply: async (text) => { replies.push(text); },
    answerCbQuery: async (text, extra) => { taps.push({ text, showAlert: Boolean(extra?.show_alert) }); },
    replyWithPhoto: async () => {}
  };
  const candidates = [
    { title: 'Picked Release', year: 2026, provider: 'tmdb', posterUrl: 'https://8.8.8.8/a.jpg' },
    { title: 'Kaizen रेलीज डेका के से बहुत लम्बा पहला बुत लम्बा है', year: null, provider: 'omdb', posterUrl: 'https://8.8.8.8/b.jpg' }
  ];
  const arm = (list) => repository.startPosterFlow({
    chatId: 642,
    ownerId: 642,
    style: 'new',
    targetAdminId: created.adminId,
    stage: 'pick',
    query: 'Picked release',
    candidates: list
  });

  try {
    const keyboard = posterCandidateKeyboard(candidates);
    const labels = keyboard.reply_markup.inline_keyboard.flat().map((button) => button.text);
    assert.equal(labels[0], '1. TMDB · Picked Release (2026)', 'the provider tag leads so a cut label stays readable');
    assert.ok(labels[1].startsWith('2. IMDb · '), labels[1]);
    assert.ok(labels[1].endsWith('…') && !labels[1].includes('IMDb…'), `a long non-Latin title is shortened, not the provider: ${labels[1]}`);
    assert.deepEqual(labels.at(-1), 'Cancel');
    for (const label of labels) {
      assert.ok(Buffer.byteLength(label, 'utf8') <= 64, `button label must fit Telegram: ${label}`);
    }

    await arm(candidates);
    await arm(candidates);
    assert.equal(await handlePosterAction(ctx, repository, posterConfig, 'poster:pick:1'), true);
    assert.equal(taps.length, 1, 'the tap is answered exactly once');
    assert.ok(taps[0].text.startsWith('Mirroring '), taps[0].text);
    assert.ok(taps[0].text.length <= 200, 'a tap note must stay inside the Bot API text limit');
    assert.equal(taps[0].showAlert, false, 'progress belongs in the chat, not in an alert popup');
    const updated = await repository.findContentByAdminId(created.adminId);
    assert.equal(updated.posterUrl, 'https://i.ibb.co/mirror/pick.png');
    assert.equal(updated.poster.originalUrl, 'https://8.8.8.8/b.jpg');
    assert.equal(updated.poster.source, 'remote-mirror');
    assert.match(replies.at(-1), /Poster updated for SB-.* using the IMDb artwork\./);
    assert.equal(updated.files.length, 1, 'choosing artwork never touches the files');
    assert.equal(await repository.findPosterFlow(642, 642), null, 'a finished flow is removed');

    // A context that cannot answer a tap at all must still complete the update:
    // tap feedback is cosmetic, the publisher's artwork choice is not.
    const blind = { chat: { id: 642 }, from: { id: 642 }, reply: async (text) => { replies.push(text); } };
    await repository.updateContentByAdminId(created.adminId, { posterUrl: 'https://old.example/poster.jpg' });
    await arm(candidates);
    assert.equal(await handlePosterAction(blind, repository, posterConfig, 'poster:pick:0'), true);
    assert.equal((await repository.findContentByAdminId(created.adminId)).posterUrl, 'https://i.ibb.co/mirror/pick.png');
    assert.match(replies.at(-1), /using the TMDB artwork\./);

    // An expired menu says so instead of throwing or changing anything.
    replies.length = 0;
    assert.equal(await handlePosterAction(ctx, repository, posterConfig, 'poster:pick:1'), true);
    assert.deepEqual(taps.at(-1), { text: 'This poster menu expired. Send /poster again.', showAlert: true });
    assert.deepEqual(replies, [], 'no chat spam for an expired button');
    assert.equal((await repository.findContentByAdminId(created.adminId)).posterUrl, 'https://i.ibb.co/mirror/pick.png');

    // No provider keys configured: the search reports it instead of guessing.
    await repository.startPosterFlow({ chatId: 642, ownerId: 642, style: 'new', targetAdminId: created.adminId, stage: 'search-title' });
    const found = await presentPosterCandidates({ ctx, repository, config: posterConfig, adminId: created.adminId, query: 'Nothing matches this title' });
    assert.equal(found, false);
    assert.equal(await repository.findPosterFlow(642, 642), null, 'a failed search leaves no half-open flow');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
