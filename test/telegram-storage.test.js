import test from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramFileDeliveryUrl } from '../src/server/config.js';
import { autoPublishStoragePost, fileFromMessage, importStorageRange, inferBatchCategory, inferBatchTitle, parseDeliveryPayload, parsePrivateStorageMessageLink, storageErrorHint, storeMediaInChannel, synchronizeDeliveryBotUsername } from '../src/server/services/telegram-bot.js';

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

test('enabled storage automation builds an isolated draft and ignores its own reply channel', async () => {
  const calls = [];
  let published;
  const repository = {
    async getAutoPublishSettings() { return { enabled: true }; },
    async findSessionByStorageMessageId() { return null; },
    async findContentByStorageMessageId() { return null; },
    async startSession(input) { calls.push({ type: 'start', input }); },
    async updateSession(chat, owner, patch) { calls.push({ type: 'update', chat, owner, patch }); return patch; },
    async appendSessionFile(chat, owner, file) { calls.push({ type: 'append', chat, owner, file }); return { files: [file] }; }
  };
  const ctx = {
    channelPost: {
      message_id: 71,
      chat: { id: -1002617067511 },
      caption: 'Perfect World Episode 178 Hindi 1080p',
      document: { file_id: 'stored-file', file_name: 'Perfect.World.S01E178.1080p.mkv', file_size: 123 }
    }
  };

  await autoPublishStoragePost(
    ctx,
    { botInfo: { id: 999 } },
    repository,
    { telegram: { storageChannelId: '-1002617067511', botUsername: 'DeliveryBot' } },
    new Set(),
    new Set(),
    async (automationContext) => { published = automationContext; }
  );

  assert.equal(calls[0].type, 'start');
  assert.equal(calls[0].input.title, 'Perfect World');
  assert.equal(calls[0].input.category, 'web-series');
  assert.equal(calls[1].patch.workflow, 'automation');
  assert.equal(calls[2].type, 'append');
  assert.equal(calls[2].file.storageMessageId, 71);
  assert.equal(published.from.id, 'auto-storage-message-71');
  await published.reply('kept out of the database channel');
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
