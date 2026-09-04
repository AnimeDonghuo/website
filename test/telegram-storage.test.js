import test from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramFileDeliveryUrl } from '../src/server/config.js';
import { DELIVERY_FILE_DELETE_AFTER_MS, PUBLISHER_COMMANDS, announcePublishedContent, announcementSyncNote, planDraftPublicationGroups, syncPublishedAnnouncements, updatePublishedPost, applyStreamingManifest, automationGroupKey, automationMergeKeys, autoPublishStoragePost, cleanStorageCaption, deliverContent, fileFromMessage, importStorageRange, inferBatchCategory, inferBatchTitle, parseDeliveryPayload, parseDirectStreamingInput, parseStreamRemoval, playersList, playersListText, removeAttachedPlayers, splitPlayerLinks, parsePrivateStorageMessageLink, parsePublishedPostEdit, postIdKeyboard, postIdTimeWindow, processQueuedAutomationSessions, publishDraft, releaseMergeKeys, requestManagerKeyboard, requestResolutionNotificationText, scheduleDeliveredFileDeletion, storageErrorHint, storeMediaInChannel, synchronizeDeliveryBotUsername } from '../src/server/services/telegram-bot.js';
import { parseStreamingManifest, publicStreamingData, safeStreamingUrl, streamServerName } from '../src/server/services/streaming-service.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { applyMergeDrop, applyMergePlan, buildManualPlayerManifest, manualPlayerGroups, mergeInstructions, mergePlanText, mergeResultText, parseMergeCommand, parseMergeDropInstruction, resolveMergePlan, POST_EDIT_ARGUMENT_LIMIT } from '../src/server/services/telegram-bot.js';
import { parseCommandArgument } from '../src/server/lib/strings.js';
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
    adminId: 'SB-A1B2C3D4E5', adminIds: ['SB-A1B2C3D4E5'], value: 'Hindi, English'
  });
  assert.deepEqual(parsePublishedPostEdit('SB-A1B2C3D4E5: 2026'), {
    adminId: 'SB-A1B2C3D4E5', adminIds: ['SB-A1B2C3D4E5'], value: '2026'
  });
  assert.deepEqual(parsePublishedPostEdit('SB-A1B2C3D4E5'), {
    adminId: 'SB-A1B2C3D4E5', adminIds: ['SB-A1B2C3D4E5'], value: ''
  });
  assert.equal(parsePublishedPostEdit('Hindi, English'), null);
  // many post IDs in front of the value, in any separator style, deduplicated
  assert.deepEqual(parsePublishedPostEdit('SB-0123ABCDEF , sb-00aabbccdd;SB-1122334455 anime').adminIds, [
    'SB-0123ABCDEF', 'SB-00AABBCCDD', 'SB-1122334455'
  ]);
  assert.equal(parsePublishedPostEdit('SB-0123ABCDEF, SB-1122334455 anime').value, 'anime');
  // a value that happens to contain commas keeps belonging to the last ID
  assert.equal(parsePublishedPostEdit('SB-0123ABCDEF, SB-1122334455 Hindi, English').value, 'Hindi, English');
  // text that merely looks like an ID at the start of a draft value is not one
  assert.equal(parsePublishedPostEdit('SB-112233445 anime'), null);
  assert.deepEqual(parsePublishedPostEdit('  sb-0123abcdef,anime  ').adminIds, ['SB-0123ABCDEF']);
});

test('one metadata edit can be applied to every named post at once', async () => {
  const repository = new MemoryCatalogRepository([]);
  const one = await repository.createContent({ title: 'Donghua A', category: 'movie', files: [{ storageMessageId: 91, name: 'A.1.mkv' }] });
  const two = await repository.createContent({ title: 'Donghua B', category: 'movie', files: [{ storageMessageId: 92, name: 'B.1.mkv' }] });
  const adult = await repository.createContent({ title: 'Private C', category: 'adult', files: [{ storageMessageId: 93, name: 'C.1.mkv' }] });
  const replies = [];
  const edits = [];
  const ctx = {
    async reply(text) { replies.push(text); },
    telegram: {
      async editMessageText(chatId, messageId, inlineMessageId, text) { edits.push({ chatId, text }); return {}; }
    }
  };
  await repository.updateContentByAdminId(one.adminId, { announcementRefs: [{ channelId: '-100public', messageId: 31, kind: 'text', websiteUrl: 'https://site.test/movie/donghua-a' }] });

  const outcome = await updatePublishedPost({
    ctx,
    repository,
    field: 'category',
    value: 'donghua',
    fieldLabel: 'Category',
    argument: `${one.adminId}, ${two.adminId}, ${adult.adminId}, SB-9999999999 donghua`,
    guard: (content) => (isAdultCategoryForTest(content.category) ? '18+ boundary: use /18db for that release' : null)
  });

  assert.equal(outcome.handled, true);
  assert.equal(outcome.contents.length, 2);
  assert.equal((await repository.findContentByAdminId(one.adminId)).category, 'donghua');
  assert.equal((await repository.findContentByAdminId(two.adminId)).category, 'donghua');
  assert.equal((await repository.findContentByAdminId(adult.adminId)).category, 'adult', 'a restricted post is never moved by a batch edit');
  assert.match(replies[0], /Category updated for 2 posts:/);
  assert.match(replies[0], new RegExp(two.adminId));
  assert.match(replies[0], /left alone: SB-.+\s\(18\+ boundary/);
  assert.match(replies[0], /Not found and skipped: SB-9999999999\./);
  assert.match(replies[0], /1 announcement updated/);
  // the announcement of the changed post is edited in place, not re-posted
  assert.deepEqual(edits.map((entry) => entry.chatId), ['-100public']);

  // a value every release must write itself is still refused across posts
  replies.length = 0;
  const titles = await updatePublishedPost({
    ctx, repository, argument: `${one.adminId}, ${two.adminId} Same Title`, field: 'title', fieldLabel: 'Title'
  });
  assert.equal(titles.content, null);
  assert.match(replies[0], /one post at a time/);
  assert.equal((await repository.findContentByAdminId(one.adminId)).title, 'Donghua A');
});

function isAdultCategoryForTest(category) {
  return category === 'adult' || category === '18+';
}


test('direct /cmd input can attach one explicit episode player while preserving intentional main players', () => {
  assert.deepEqual(parseDirectStreamingInput('ep 01 https://soraboxs.embedseek.com/#episode-one'), {
    playerValue: 'https://soraboxs.embedseek.com/#episode-one',
    urls: [],
    episode: { start: 1, end: 1, label: 'Episode 01' },
    action: 'add',
    delete: null,
    error: null
  });
  assert.deepEqual(parseDirectStreamingInput('episode 2-4 <iframe src="https://soraboxs.embedseek.com/#episodes-two-four"></iframe>'), {
    playerValue: '<iframe src="https://soraboxs.embedseek.com/#episodes-two-four"></iframe>',
    urls: [],
    episode: { start: 2, end: 4, label: 'Episodes 02–04' },
    action: 'add',
    delete: null,
    error: null
  });
  assert.deepEqual(parseDirectStreamingInput('https://soraboxs.embedseek.com/#release-main'), {
    playerValue: 'https://soraboxs.embedseek.com/#release-main',
    urls: [],
    episode: null,
    action: 'add',
    delete: null,
    error: null
  });
  // `del ...` is a removal, not a player link, and is reported as such.
  const removal = parseDirectStreamingInput('del ep 2-7');
  assert.equal(removal.action, 'delete');
  assert.deepEqual(removal.delete, { mode: 'episode', episode: { start: 2, end: 7, label: 'Episodes 02–07' } });
  assert.equal(removal.error, null);
  // two links after the episode number are two players, not a malformed one
  const multi = parseDirectStreamingInput('ep 2 https://rumble.com/v1a-one.html https://www.dailymotion.com/video/x1a2b3c');
  assert.equal(multi.error, null);
  assert.equal(multi.playerValue.includes('rumble.com/v1a-one.html'), true);
  assert.equal(multi.playerValue.includes('dailymotion.com/video/x1a2b3c'), true);
});

test('pasted player lists become one embeddable player each, whatever form they arrive in', () => {
  const pasted = [
    '[https://rumble.com/v7exnu4-the-episode.html](https://rumble.com/v7exnu4-the-episode.html)',
    'https://www.dailymotion.com/video/x8abcde',
    '- https://soraboxs.embedseek.com/#episode-nine',
    '<iframe src="https://soraboxs.embedseek.com/#episode-ten" width="100%"></iframe>'
  ].join('\n');
  const { urls, rejected } = splitPlayerLinks(pasted, { allowedHosts: [] });
  assert.equal(rejected.length, 0);
  assert.deepEqual(urls.map((link) => link.embedUrl), [
    'https://rumble.com/embed/v7exnu4/',
    'https://www.dailymotion.com/embed/video/x8abcde',
    'https://soraboxs.embedseek.com/#episode-nine',
    'https://soraboxs.embedseek.com/#episode-ten'
  ]);
  assert.equal(urls[0].watchUrl, 'https://rumble.com/v7exnu4-the-episode.html');
  // a page link from a host the site does not trust is never saved, and
  // executable or non-HTTPS input is refused instead of being rewritten
  assert.deepEqual(splitPlayerLinks('https://evil.example/player.js\ndailymotion.com/video/x8abcde', { allowedHosts: [] }).rejected, [
    'https://evil.example/player.js'
  ]);
  assert.equal(safeStreamingUrl('javascript:alert(1)'), null);
  assert.equal(streamServerName('https://rumble.com/embed/v7exnu4/'), 'Rumble server');
  assert.equal(streamServerName('https://www.dailymotion.com/embed/video/x8abcde'), 'Dailymotion server');
  assert.equal(streamServerName('https://soraboxs.embedseek.com/#x'), 'Seek server');
});

test('player removal grammar accepts list numbers, episodes, ranges, and all', () => {
  assert.deepEqual(parseStreamRemoval('3'), { mode: 'index', indexes: [3] });
  assert.deepEqual(parseStreamRemoval('#4'), { mode: 'index', indexes: [4] });
  assert.deepEqual(parseStreamRemoval('2, 4'), { mode: 'index', indexes: [2, 4] });
  assert.deepEqual(parseStreamRemoval('ep 5'), { mode: 'episode', episode: { start: 5, end: 5, label: 'Episode 05' } });
  assert.deepEqual(parseStreamRemoval('episode 2 to 7'), { mode: 'episode', episode: { start: 2, end: 7, label: 'Episodes 02–07' } });
  assert.deepEqual(parseStreamRemoval('all'), { mode: 'all' });
  assert.match(parseStreamRemoval('').error, /Say what to remove/i);
  assert.match(parseStreamRemoval('ep nine').error, /Use a range/i);
});

test('a second player added to one episode stays beside the first, while a provider export still replaces its own slot', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Cascade S01',
    category: 'web-series',
    files: [{ storageMessageId: 71, name: 'Cascade.S01E02.mkv' }]
  });
  const manual = (entries) => ({ entries: entries.map((entry, index) => ({ row: index + 1, postId: created.adminId, entry })), rejected: [] });
  // two pasted links for the same episode are both kept, each named by provider
  const pasted = await applyStreamingManifest({
    repository,
    config: { streaming: {} },
    granularity: 'exact',
    manifest: manual([
      {
        label: 'Dailymotion · Episode 02',
        provider: 'Dailymotion',
        episode: { start: 2, end: 2, label: 'Episode 02' },
        embedUrl: 'https://www.dailymotion.com/embed/video/x8abcde',
        watchUrl: 'https://www.dailymotion.com/video/x8abcde'
      },
      {
        label: 'Rumble · Episode 02',
        provider: 'Rumble',
        episode: { start: 2, end: 2, label: 'Episode 02' },
        embedUrl: 'https://rumble.com/embed/v7exnu4/',
        watchUrl: 'https://rumble.com/v7exnu4-the-episode.html'
      }
    ])
  });
  assert.equal(pasted.rejected.length, 0);
  const afterPaste = await repository.findContentByAdminId(created.adminId);
  assert.equal(afterPaste.stream.entries.length, 2);
  const publicPlayers = publicStreamingData(afterPaste.stream, { allowedHosts: [] }).entries;
  assert.deepEqual(publicPlayers.map((entry) => entry.server), ['Dailymotion server', 'Rumble server']);
  assert.deepEqual(publicPlayers.map((entry) => entry.label), ['Dailymotion · Episode 02', 'Rumble · Episode 02']);

  // a corrected provider export for the same slot replaces only that slot
  const corrected = await applyStreamingManifest({
    repository,
    config: { streaming: {} },
    manifest: {
      entries: [{
        row: 9,
        postId: created.adminId,
        entry: { episode: { start: 2, end: 2, label: 'Episode 02' }, provider: 'Dailymotion', label: 'Episode 02 · corrected', embedUrl: 'https://www.dailymotion.com/embed/video/xFIXED' }
      }],
      rejected: []
    }
  });
  assert.equal(corrected.attachedRows, 1);
  const afterCorrect = await repository.findContentByAdminId(created.adminId);
  assert.equal(afterCorrect.stream.entries.length, 2);
  assert.equal(afterCorrect.stream.entries.filter((entry) => entry.embedUrl.includes('x8abcde')).length, 0);
  assert.equal(afterCorrect.stream.entries.find((entry) => entry.embedUrl.includes('xFIXED')).label, 'Episode 02 · corrected');
  // the Rumble source a publisher added by hand is untouched by the export
  assert.equal(afterCorrect.stream.entries.some((entry) => entry.embedUrl === 'https://rumble.com/embed/v7exnu4/'), true);
});

test('players can be removed by number, by episode range, or all at once', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Prune S01',
    category: 'web-series',
    files: [{ storageMessageId: 72, name: 'Prune.S01E01.mkv' }]
  });
  await applyStreamingManifest({
    repository,
    config: { streaming: {} },
    manifest: parseStreamingManifest(JSON.stringify([
      { Post: created.adminId, Episode: 'S01E01', 'Embed Link': 'https://www.dailymotion.com/video/xONE' },
      { Post: created.adminId, Episode: 'S01E02', 'Embed Link': 'https://rumble.com/v7twp-two.html' },
      { Post: created.adminId, Episode: 'S01E03', 'Embed Link': 'https://soraboxs.embedseek.com/#three' }
    ]), { format: 'json' })
  });
  const before = await repository.findContentByAdminId(created.adminId);
  assert.equal(before.stream.entries.length, 3);

  // the /players list numbers what `del <n>` addresses
  const listed = playersList(before, {});
  assert.deepEqual(listed.map((entry) => entry.number), [1, 2, 3]);
  assert.deepEqual(listed.map((entry) => entry.server), ['Dailymotion server', 'Rumble server', 'Seek server']);
  const listing = playersListText(before, listed, {});
  assert.match(listing, /1\. Dailymotion server · Episode 01/);
  assert.match(listing, /del ep 2-7/);
  assert.match(listing, /Remove one: \/cmd/);

  const ranged = await removeAttachedPlayers({ repository, targetAdminId: created.adminId, removal: parseStreamRemoval('ep 2-3'), config: {} });
  assert.equal(ranged.error, undefined);
  assert.equal(ranged.removed, 2);
  assert.equal(ranged.remaining, 1);
  const afterRange = await repository.findContentByAdminId(created.adminId);
  assert.deepEqual(afterRange.stream.entries.map((entry) => entry.episode?.start), [1]);

  const last = await removeAttachedPlayers({ repository, targetAdminId: created.adminId, removal: parseStreamRemoval('1'), config: {} });
  assert.equal(last.remaining, 0);
  const cleared = await repository.findContentByAdminId(created.adminId);
  // removing every player leaves the release readable but without a Watch page
  assert.equal(cleared.stream, null);
  assert.equal(cleared.filesCount, 1);
  const nothing = await removeAttachedPlayers({ repository, targetAdminId: created.adminId, removal: parseStreamRemoval('all'), config: {} });
  assert.match(nothing.error, /no player links attached/i);
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

test('a corrected published post edits the announcement in place instead of posting a second card', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'The Gentlemen',
    category: 'web-series',
    posterUrl: 'https://imgbb.test/final-one.png',
    description: 'Two seasons of a very loud hotel.',
    files: [{ storageMessageId: 80, name: 'The.Gentlemen.S01E01.mkv' }]
  });
  await repository.updateContentByAdminId(created.adminId, {
    announcementRefs: [
      { channelId: '-100public', messageId: 11, kind: 'photo', websiteUrl: 'https://site.test/web-series/the-gentlemen' },
      { channelId: '-100mirror', messageId: 12, kind: 'text', websiteUrl: null },
      { channelId: '-100gone', messageId: 13, kind: 'photo', websiteUrl: null }
    ]
  });
  const edits = [];
  const telegram = {
    async editMessageMedia(chatId, messageId, inlineMessageId, media, extra) {
      edits.push({ op: 'media', chatId, messageId, media, replyMarkup: extra?.reply_markup });
      if (chatId === '-100gone') throw { description: 'Bad Request: message to edit is not found' };
      return { message_id: messageId };
    },
    async editMessageText(chatId, messageId, inlineMessageId, text, extra) {
      edits.push({ op: 'text', chatId, messageId, text, replyMarkup: extra?.reply_markup });
      return { message_id: messageId };
    },
    async editMessageReplyMarkup() {
      edits.push({ op: 'markup' });
    },
    async sendMessage() {
      throw new Error('a correction must never post a new announcement');
    }
  };
  const renamed = await repository.updateContentByAdminId(created.adminId, { title: 'The Gentlemen S01' });
  const sync = await syncPublishedAnnouncements({ telegram, repository, content: renamed });

  assert.equal(sync.updated, 2);
  assert.equal(sync.dropped, 1);
  assert.deepEqual(edits.filter((entry) => entry.op === 'media').map((entry) => entry.chatId), ['-100public', '-100gone']);
  const photo = edits.find((entry) => entry.chatId === '-100public');
  assert.equal(photo.media.type, 'photo');
  assert.equal(photo.media.media, 'https://imgbb.test/final-one.png');
  assert.match(photo.media.caption, /The Gentlemen S01/);
  // the text-only mirror keeps the same corrected copy
  const text = edits.find((entry) => entry.op === 'text');
  assert.match(text.text, /NEW WEB SERIES DROP/);
  assert.match(text.text, /The Gentlemen S01/);
  // the remembered detail-page link keeps the buttons pointing at the site
  const buttons = JSON.stringify(photo.replyMarkup || {});
  assert.match(buttons, /https:\/\/site\.test\/web-series\/the-gentlemen/);
  // a reference without a known link leaves the existing buttons untouched
  assert.equal(text.replyMarkup, undefined);
  // a dead reference is pruned, so later edits do not keep chasing it
  const stored = await repository.findContentByAdminId(created.adminId);
  assert.deepEqual(stored.announcementRefs.map((ref) => ref.messageId), [11, 12]);
  assert.equal(announcementSyncNote(sync), 'Telegram announcements: 2 announcements updated, 1 deleted announcement forgotten.');
});

test('an unchanged announcement is not counted as a failure and 18+ posts are never touched', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({ title: 'Quiet', category: 'movie', files: [{ storageMessageId: 81, name: 'Quiet.mkv' }] });
  await repository.updateContentByAdminId(created.adminId, { announcementRefs: [{ channelId: '-100public', messageId: 21, kind: 'text', websiteUrl: null }] });
  let calls = 0;
  const same = await syncPublishedAnnouncements({
    repository,
    content: await repository.findContentByAdminId(created.adminId),
    telegram: { async editMessageText() { calls += 1; throw { description: 'Bad Request: message is not modified: specified new content is the same' }; } }
  });
  assert.deepEqual({ updated: same.updated, failed: same.failed, unchanged: same.unchanged }, { updated: 0, failed: 0, unchanged: 1 });
  assert.equal(calls, 1);

  const adult = await repository.createContent({ title: 'Private', category: 'adult', files: [{ storageMessageId: 82, name: 'Private.mkv' }] });
  await repository.updateContentByAdminId(adult.adminId, { announcementRefs: [{ channelId: '-100public', messageId: 22, kind: 'text', websiteUrl: null }] });
  let adultCalls = 0;
  const skipped = await syncPublishedAnnouncements({
    repository,
    content: await repository.findContentByAdminId(adult.adminId),
    telegram: { async editMessageText() { adultCalls += 1; return {}; } }
  });
  assert.equal(adultCalls, 0);
  assert.deepEqual({ updated: skipped.updated, channels: skipped.channels }, { updated: 0, channels: 1 });
});

test('an untitled /batch range containing several releases becomes one post per release and season', () => {
  const files = [
    { name: 'RRR.2022.1080p.WEB-DL.mkv', displayName: 'RRR (2022) Hindi 1080p @chan' },
    { name: 'Entha.Andhra.Robots.2023.Telugu.720p.mkv', displayName: 'Robots (2023) Telugu 720p @chan' },
    { name: 'ams.2024.hindi.1080p.mkv', displayName: 'AMS (2024) Hindi 1080p @chan' },
    { name: 'Fullmetal.Alchemist.S01E01.1080p.mkv', displayName: 'Fullmetal Alchemist S01E01 Hindi @chan' },
    { name: 'Fullmetal.Alchemist.S01E02.1080p.mkv', displayName: 'Fullmetal Alchemist S01E02 Hindi @chan' },
    { name: 'Fullmetal.Alchemist.S03E01.720p.mkv', displayName: 'Fullmetal Alchemist S03E01 English @chan' }
  ];
  const plan = planDraftPublicationGroups({ workflow: 'batch', files, batch: {} });

  assert.deepEqual(plan.map((group) => ({
    title: group.title,
    category: group.category,
    season: group.season,
    files: group.files.length,
    reason: group.reason
  })), [
    { title: 'RRR', category: 'movie', season: null, files: 1, reason: 'release' },
    { title: 'Robots', category: 'movie', season: null, files: 1, reason: 'release' },
    { title: 'AMS', category: 'movie', season: null, files: 1, reason: 'release' },
    { title: 'Fullmetal Alchemist Season 1', category: 'web-series', season: 1, files: 2, reason: 'season' },
    { title: 'Fullmetal Alchemist Season 3', category: 'web-series', season: 3, files: 1, reason: 'season' }
  ], 'each release is identified separately, and only the one with real seasons is split');

  // a named batch keeps the publisher's own title for the whole range: it may
  // still split seasons, but it is never re-cut by guessed release titles
  const titled = planDraftPublicationGroups({ workflow: 'batch', title: 'Collection Drop', category: 'web-series', files, batch: { titleProvided: true } });
  assert.deepEqual(titled.map((group) => ({ title: group.title, category: group.category, files: group.files.length })), [
    { title: 'Collection Drop Season 1', category: 'web-series', files: 5 },
    { title: 'Collection Drop Season 3', category: 'web-series', files: 1 }
  ]);
  // one release with several seasons still splits by season, without touching movies
  assert.deepEqual(
    planDraftPublicationGroups({ workflow: 'batch', title: 'Fullmetal Alchemist', files: files.slice(3), batch: {} }).map((group) => group.title),
    ['Fullmetal Alchemist Season 1', 'Fullmetal Alchemist Season 3']
  );
  assert.deepEqual(planDraftPublicationGroups({ workflow: 'batch', title: 'RRR', files: files.slice(0, 1), batch: {} }), []);
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

// ── /merge: one card absorbs the others, and can be trimmed again ──────────
function mergeFile(messageId, name, season, episode) {
  return {
    storageMessageId: messageId,
    name,
    sourceLabel: name,
    displayName: name,
    season,
    episode: episode ? { start: episode, end: episode, label: `Episode ${String(episode).padStart(2, '0')}` } : null
  };
}

async function mergeFixture() {
  const repository = new MemoryCatalogRepository([]);
  const seasonOne = await repository.createContent({
    title: 'Bleach',
    category: 'donghua',
    files: [mergeFile(1, 'Bleach.S01E01.mkv', 1, 1), mergeFile(2, 'Bleach.S01E02.mkv', 1, 2)],
    announcementRefs: [{ channelId: '-100anime', messageId: 100, kind: 'photo', websiteUrl: 'https://site.test/donghua/bleach' }]
  });
  const seasonTwo = await repository.createContent({
    title: 'Bleach Season 2',
    category: 'donghua',
    files: [mergeFile(3, 'Bleach.S02E01.mkv', 2, 1), mergeFile(4, 'Bleach.S02E02.mkv', 2, 2), mergeFile(5, 'Bleach.S02E03.mkv', 2, 3)],
    stream: { entries: [{ label: 'S02E01', episode: { start: 1, end: 1, label: 'Episode 01' }, embedUrl: 'https://www.dailymotion.com/embed/video/xS2E1' }] },
    announcementRefs: [{ channelId: '-100anime', messageId: 101, kind: 'photo' }]
  });
  const movie = await repository.createContent({
    title: 'Bleach Movie',
    category: 'movie',
    files: [mergeFile(6, 'Bleach.Movie.1080p.mkv', null, null)]
  });
  const edits = [];
  const deletes = [];
  const bot = {
    telegram: {
      async editMessageText(...args) { edits.push(args); return true; },
      async deleteMessage(chatId, messageId) { deletes.push(`${chatId}:${messageId}`); return true; }
    }
  };
  return { repository, seasonOne, seasonTwo, movie, bot, edits, deletes };
}

test('the first Post ID is always the card that survives a merge', () => {
  const target = 'SB-0123ABCDEF';
  const first = 'SB-1111222233';
  const second = 'SB-4444555566';
  assert.deepEqual(parseMergeCommand(`${target} ${first}`), { action: 'plan', label: '', targetAdminId: target, sourceAdminIds: [first] });
  assert.deepEqual(parseMergeCommand(`bleach ${target} ${first} ${second}`), { action: 'plan', label: 'bleach', targetAdminId: target, sourceAdminIds: [first, second] });
  assert.deepEqual(parseMergeCommand('confirm'), { action: 'confirm' });
  assert.deepEqual(parseMergeCommand('cancel'), { action: 'cancel' });
  assert.deepEqual(parseMergeCommand('help'), { action: 'help' });
  assert.deepEqual(parseMergeCommand(''), { action: 'help' });
  assert.deepEqual(parseMergeCommand(`drop ${target} season 2`), { action: 'drop', targetAdminId: target, drop: { mode: 'season', season: 2 } });

  // A name alone, or a name and no source, is never enough to act on.
  assert.match(parseMergeCommand('Bleach').error, /Usage: \/merge Bleach SB-/);
  assert.match(parseMergeCommand(target).error, /Add at least one Post ID to absorb/);
  // "Sb -29292" looks like an ID and must be reported, not read as a title.
  assert.match(parseMergeCommand('bleach Sb -29292 SB-1111222233').error, /is not a SoraBox Post ID/);
  // A valid ID is never reported as a near-miss, however the rest reads.
  assert.equal(parseMergeCommand('SB-0123ABCDEF SB-1111222233').error, undefined);
});

test('a merge trim is described by season, episode, or both', () => {
  assert.deepEqual(parseMergeDropInstruction('season 2'), { mode: 'season', season: 2 });
  assert.deepEqual(parseMergeDropInstruction('s2'), { mode: 'season', season: 2 });
  assert.deepEqual(parseMergeDropInstruction('all of season 12'), { mode: 'season', season: 12 });
  assert.deepEqual(parseMergeDropInstruction('ep 5'), { mode: 'episodes', season: null, start: 5, end: 5 });
  assert.deepEqual(parseMergeDropInstruction('episode 2 to 7'), { mode: 'episodes', season: null, start: 2, end: 7 });
  assert.deepEqual(parseMergeDropInstruction('season 2 ep 5-7'), { mode: 'episodes', season: 2, start: 5, end: 7 });
  assert.match(parseMergeDropInstruction('').error, /Say what to remove/);
  assert.match(parseMergeDropInstruction('season 0').error, /Season numbers must be digits from 1 to 99/);
  assert.match(parseMergeDropInstruction('season two').error, /Season numbers must be digits from 1 to 99/);
  assert.match(parseMergeDropInstruction('ep 9-2').error, /no earlier than the start/);
  assert.match(parseMergeDropInstruction('everything').error, /Use a form such as season 2/);
});

test('a merge plan names the cards, the season blocks, and the announcements it will delete', async () => {
  const { repository } = await mergeFixture();
  const mistyped = parseMergeCommand('bleach SB-NOPE SB-112233445');
  assert.match(mistyped.error, /is not a SoraBox Post ID/);
  assert.match(mistyped.error, /copy the exact IDs from \/posts 50/);

  const missing = await resolveMergePlan({ repository, parsed: { action: 'plan', targetAdminId: 'SB-0000000000', sourceAdminIds: ['SB-1111111111'], label: '' } });
  assert.match(missing.error, /No published catalog post was found for SB-0000000000/);

  const cards = await repository.listAdminContent({ limit: 50 });
  const byTitle = new Map((Array.isArray(cards) ? cards : cards.items).map((item) => [item.title, item.adminId]));
  const preview = await resolveMergePlan({
    repository,
    parsed: { action: 'plan', label: 'Bleach', targetAdminId: byTitle.get('Bleach'), sourceAdminIds: [byTitle.get('Bleach Season 2'), byTitle.get('Bleach Movie'), 'SB-9999999999'] }
  });
  assert.equal(preview.error, undefined);
  assert.deepEqual(preview.plan.sources.map((source) => source.title), ['Bleach Season 2', 'Bleach Movie']);
  assert.deepEqual(preview.plan.seasons, [1, 2], 'the merged card spans both seasons');
  assert.equal(preview.plan.movedFiles, 4);
  assert.equal(preview.plan.movedAnnouncements, 1);
  assert.deepEqual(preview.plan.missing, ['SB-9999999999']);

  const text = mergePlanText(preview.plan, {});
  assert.match(text, new RegExp(`Merge into ${byTitle.get('Bleach')} \u00b7 Bleach`));
  assert.match(text, /6 files and 5 episodes across 2 season blocks \(S1, S2\)/);
  assert.match(text, /1 announcement message for the absorbed posts will be deleted/);
  assert.match(text, /Not found and skipped: SB-9999999999/);
  assert.match(text, /Nothing changes until then/);

  // The title in front is a safety check, and a mismatch stops the merge.
  const refused = await resolveMergePlan({
    repository,
    parsed: { action: 'plan', label: 'Naruto', targetAdminId: byTitle.get('Bleach'), sourceAdminIds: [byTitle.get('Bleach Season 2')] }
  });
  assert.match(refused.error, /is not the name of/);
  assert.match(refused.error, /I stopped so the files cannot land on the wrong card/);

  // 18+ never shares a card with a normal release, because the age gate and the
  // private storage channel both follow the target.
  const adult = await repository.createContent({ title: 'Bleach 18+', category: 'adult', files: [mergeFile(7, 'Bleach.X.mp4', null, null)] });
  const boundary = await resolveMergePlan({
    repository,
    parsed: { action: 'plan', targetAdminId: byTitle.get('Bleach'), sourceAdminIds: [adult.adminId], label: '' }
  });
  assert.deepEqual(boundary.error.match(/18\+ storage and age gate stay separate/), boundary.error.match(/18\+ storage and age gate stay separate/));
  assert.match(boundary.error, /18\+ storage and age gate stay separate/);
  assert.match(mergeInstructions(), /\/merge drop SB-0123ABCDEF season 2/);
});

test('applying a merge moves every file and player, deletes the absorbed cards, and keeps the storage', async () => {
  const { repository, seasonOne, seasonTwo, movie, bot, deletes } = await mergeFixture();
  const { plan } = await resolveMergePlan({
    repository,
    parsed: parseMergeCommand(`bleach ${seasonOne.adminId} ${seasonTwo.adminId} ${movie.adminId} SB-9999999999`)
  });
  const outcome = await applyMergePlan({ bot, repository, config: { publicSiteUrl: 'https://site.test' }, plan });

  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.moved.map((entry) => entry.title), ['Bleach Season 2', 'Bleach Movie']);
  assert.deepEqual(deletes, ['-100anime:101'], 'only the absorbed announcement message is deleted');
  assert.equal(await repository.findContentByAdminId(seasonTwo.adminId), null);
  assert.equal(await repository.findContentByAdminId(movie.adminId), null);
  assert.notEqual(await repository.findContentByAdminId(seasonOne.adminId), null, 'the target keeps its own card');

  const merged = await repository.findContentByAdminId(seasonOne.adminId);
  assert.equal(merged.files.length, 6, 'Season 2 Episode 01 must never replace Season 1 Episode 01');
  assert.equal(merged.episodeCount, 5);
  assert.deepEqual(merged.files.map((file) => file.storageMessageId).sort(), [1, 2, 3, 4, 5, 6], 'the same Telegram messages are still what gets delivered');
  assert.deepEqual(
    merged.episodeGroups.map((group) => [group.season, group.seasonLabel, group.label]),
    [[1, 'Season 1', 'Episode 01'], [1, 'Season 1', 'Episode 02'], [2, 'Season 2', 'Episode 01'], [2, 'Season 2', 'Episode 02'], [2, 'Season 2', 'Episode 03']]
  );
  assert.equal(merged.stream.entries.some((entry) => entry.embedUrl === 'https://www.dailymotion.com/embed/video/xS2E1'), true, 'the moved player travels with the files');
  assert.deepEqual(
    [merged.automationKey, ...(merged.automationKeys || [])].filter(Boolean).sort(),
    [...new Set(['bleach', 'bleach', 'bleach-movie', 'bleach-season-2'])].sort(),
    'an upload using an absorbed title lands on this card instead of a new one'
  );

  const result = mergeResultText(outcome, { publicSiteUrl: 'https://site.test' });
  assert.match(result, /6 files on this card \u00b7 5 episodes/);
  assert.match(result, /Season 1: 2 episodes/);
  assert.match(result, /Season 2: 3 episodes/);
  assert.match(result, /Deleted from the website: SB-/);
  assert.match(result, /Announcement messages: 1 deleted/);
  assert.match(result, /private storage files were not touched/);

  // The card is still announced from its own post, so its own announcement has
  // to be rewritten with the new episode summary.
  assert.equal(deletes.length, 1);
  assert.equal(outcome.announcementSync.updated >= 0, true);

  // Merging the same card again is refused instead of half-applied.
  const replay = await applyMergePlan({ bot, repository, config: {}, plan });
  assert.match(replay.error, /None of the listed posts still exist/);
});

test('a merge that cannot delete an announcement still reports it', async () => {
  const { repository, seasonOne, seasonTwo } = await mergeFixture();
  const refused = {
    telegram: {
      async editMessageText() { return true; },
      async deleteMessage() { throw new Error('Forbidden: bot is not a channel admin'); }
    }
  };
  const { plan } = await resolveMergePlan({ repository, parsed: parseMergeCommand(`bleach ${seasonOne.adminId} ${seasonTwo.adminId}`) });
  const outcome = await applyMergePlan({ bot: refused, repository, config: {}, plan });
  assert.equal(outcome.announcementMessages.deleted, 0);
  assert.equal(outcome.announcementMessages.failed, 1, 'the card is merged even when Telegram refuses the delete');
  assert.match(mergeResultText(outcome, {}), /1 could not be deleted \(is the bot an admin in that channel\?\)/);
});

test('dropping a season or an episode trims one card without touching storage', async () => {
  const { repository, seasonOne, seasonTwo, bot } = await mergeFixture();
  const { plan } = await resolveMergePlan({ repository, parsed: parseMergeCommand(`bleach ${seasonOne.adminId} ${seasonTwo.adminId}`) });
  await applyMergePlan({ bot, repository, config: {}, plan });
  const card = await repository.findContentByAdminId(seasonOne.adminId);

  const dropped = await applyMergeDrop({ repository, bot, config: {}, adminId: card.adminId, drop: { mode: 'season', season: 1 } });
  assert.equal(dropped.error, undefined);
  assert.equal(dropped.removed.length, 2, 'both Season 1 files came off the card');
  assert.equal(dropped.remaining, 3);
  const afterSeason = await repository.findContentByAdminId(card.adminId);
  assert.deepEqual(afterSeason.files.map((file) => file.name), ['Bleach.S02E01.mkv', 'Bleach.S02E02.mkv', 'Bleach.S02E03.mkv']);
  // One season left is not a season block any more, so the labels collapse back.
  assert.deepEqual(afterSeason.episodeGroups.map((group) => group.seasonLabel ?? null), [null, null, null]);

  const episodes = await applyMergeDrop({ repository, bot, config: {}, adminId: card.adminId, drop: { mode: 'episodes', season: null, start: 2, end: 3 } });
  assert.deepEqual(episodes.removed.map((file) => file.name), ['Bleach.S02E02.mkv', 'Bleach.S02E03.mkv']);
  const emptied = await repository.findContentByAdminId(card.adminId);
  assert.equal(emptied.files.length, 1);
  assert.equal(emptied.episodeCount, 1);

  const nothing = await applyMergeDrop({ repository, bot, config: {}, adminId: card.adminId, drop: { mode: 'season', season: 5 } });
  assert.match(nothing.error, /has no Season 5 block \(S2\)/);

  // The last file on the card is refused so no empty card is left behind silently.
  const last = await applyMergeDrop({ repository, bot, config: {}, adminId: card.adminId, drop: { mode: 'episodes', season: null, start: 1, end: 1 } });
  assert.deepEqual(last.removed.map((file) => file.name), ['Bleach.S02E01.mkv']);
  assert.equal((await repository.findContentByAdminId(card.adminId)).files.length, 0);
});

test('a pending merge is remembered for one publisher chat and forgotten on cancel', async () => {
  const repository = new MemoryCatalogRepository([]);
  assert.equal(await repository.findMergePlan(642, 642), null, 'no plan before the publisher asks for one');
  await repository.startMergePlan({ chatId: 642, ownerId: 642, plan: { targetAdminId: 'SB-0123ABCDEF', sources: [{ adminId: 'SB-1111222233' }] } });
  const pending = await repository.findMergePlan(642, 642);
  assert.equal(pending.plan.targetAdminId, 'SB-0123ABCDEF');
  await repository.startMergePlan({ chatId: 642, ownerId: 642, plan: { targetAdminId: 'SB-0000000000', sources: [] } });
  assert.equal((await repository.findMergePlan(642, 642)).plan.targetAdminId, 'SB-0000000000', 'the newest plan replaces the old one');
  assert.equal(await repository.findMergePlan(643, 643), null, 'another publisher never inherits this plan');
  await repository.deleteMergePlan(642, 642);
  assert.equal(await repository.findMergePlan(642, 642), null);

  const expired = await repository.startMergePlan({ chatId: 642, ownerId: 642, plan: { targetAdminId: 'SB-0123ABCDEF' }, expiresAt: new Date(Date.now() - 1000) });
  assert.equal(expired.plan.targetAdminId, 'SB-0123ABCDEF');
  assert.equal(await repository.findMergePlan(642, 642), null, 'an unread merge plan lapses instead of waiting to be confirmed by accident');
});

// ── manual players, long ID lists, and files the index must not lose ───────
test('a manual player paste keeps each link on the episode it was labelled with', () => {
  const pasted = 'Ep 176 https://www.dailymotion.com/embed/video/k40kzv\n\nEp 177 https://www.dailymotion.com/embed/video/k1934IH';
  const groups = manualPlayerGroups(pasted).groups;
  assert.deepEqual(groups.map((group) => group.episode.label), ['Episode 176', 'Episode 177']);
  assert.deepEqual(groups.map((group) => group.text.split('/').pop()), ['k40kzv', 'k1934IH']);

  // The same two lines flattened onto one line (which is what a collapsed paste
  // looks like) still separate, because every link after the first label would
  // otherwise be attached to that one episode.
  const flat = manualPlayerGroups('Ep 176 https://a/1 Ep 177 https://b/2').groups;
  assert.deepEqual(flat.map((group) => [group.episode.start, group.text]), [[176, 'https://a/1'], [177, 'https://b/2']]);

  // An unlabelled list stays one group with every link in it, and a range label
  // covers everything written under it.
  assert.deepEqual(manualPlayerGroups('https://a/1\nhttps://b/2').groups.map((group) => [group.episode, group.text.split('\n').length]), [[null, 2]]);
  assert.deepEqual(manualPlayerGroups('ep 2-7\nhttps://a/1\nhttps://b/2').groups.map((group) => [group.episode.label, group.text.split('\n').length]), [['Episodes 02–07', 2]]);
  assert.deepEqual(manualPlayerGroups('').groups, []);
  assert.match(manualPlayerGroups('Ep 0 https://a/1').error, /between 1 and 999/);
});

test('several labelled links reach their own episodes on the catalog post', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Shrouding the Heavens',
    category: 'donghua',
    files: [{ storageMessageId: 1, name: 'Shrouding.the.Heavens.EP.176.mkv' }]
  });
  const groups = manualPlayerGroups('Ep 176 https://www.dailymotion.com/embed/video/kAAA\nEp 177 https://rumble.com/v7twp-two.html').groups;
  const entries = [];
  for (const group of groups) {
    for (const url of group.text.split('\n')) {
      entries.push({
        row: entries.length + 1,
        postId: created.adminId,
        entry: { label: 'x', episode: group.episode, embedUrl: url.trim() }
      });
    }
  }
  const result = await applyStreamingManifest({ repository, manifest: { entries, rejected: [] }, targetAdminId: created.adminId, config: { streaming: {} }, granularity: 'exact' });
  assert.equal(result.attachedRows, 2);
  const after = await repository.findContentByAdminId(created.adminId);
  assert.deepEqual(after.stream.entries.map((entry) => [entry.episode.label, entry.embedUrl]), [
    ['Episode 176', 'https://www.dailymotion.com/embed/video/kAAA'],
    ['Episode 177', 'https://rumble.com/embed/v7twp/']
  ]);
});

test('a metadata edit accepts every Post ID in the message, not the first dozen', () => {
  const ids = Array.from({ length: 24 }, (unused, index) => `SB-${String(index + 1).padStart(10, '0').replace(/\d/g, (digit) => 'ABCDEF0123'[Number(digit)])}`);
  const line = `/lang ${ids.join(', ')} Hindi, English`;
  const argument = parseCommandArgument(line, POST_EDIT_ARGUMENT_LIMIT);
  const target = parsePublishedPostEdit(argument);
  assert.equal(target.adminIds.length, 24, 'no batch cap is applied to a list of posts');
  assert.equal(target.value, 'Hindi, English', 'the value survives instead of being cut off mid-list');
  assert.deepEqual(parseCommandArgument(line).split(', ').length < 24 ? 'truncated' : 'kept', 'truncated', 'the old default really was too short — that is why the limit is passed');
});

test('a series numbers its files from the wording the uploader chose', async () => {
  const repository = new MemoryCatalogRepository([]);
  const file = (number, extra = '') => ({
    storageMessageId: number,
    name: `Everything.Is.Fine.With.The.Emperor.${number}${extra}.mkv`,
    sourceLabel: `Everything Is Fine With The Emperor ${number}${extra}`,
    displayName: `Everything Is Fine With The Emperor ${number}${extra}`
  });
  const created = await repository.createContent({
    title: 'Everything Is Fine With The Emperor',
    category: 'donghua',
    files: [file(3), file(4, ' 480p')]
  });
  assert.deepEqual(created.episodeGroups.map((group) => group.label), ['Episode 03', 'Episode 04']);

  // Episodes 1 and 2 appended afterwards are added, not treated as a second copy
  // of the same slot: the release name plus quality alone once collapsed them and
  // the pair silently replaced 3 and 4.
  const appended = await repository.appendFilesToContentByAdminId(created.adminId, [file(1, ' 480p'), file(2, ' 480p')], []);
  assert.equal(appended.files.length, 4);
  assert.equal(appended.episodeCount, 4);
  assert.deepEqual(appended.episodeGroups.map((group) => group.label), ['Episode 01', 'Episode 02', 'Episode 03', 'Episode 04']);

  // A film is never given an invented number, and a season pack is not reduced to
  // the one episode its digits happen to look like.
  const movie = await repository.createContent({ title: 'Cocktail', category: 'movie', files: [{ storageMessageId: 9, name: 'Cocktail.2.1080p.mkv' }] });
  assert.deepEqual(movie.episodeGroups, []);
  assert.equal(movie.releaseLabel, 'Feature');
  const withPack = await repository.appendFilesToContentByAdminId(created.adminId, [{ storageMessageId: 77, name: 'Everything.Is.Fine.With.The.Emperor.S01.Complete.1080p.mkv' }], []);
  assert.equal(withPack.files.length, 5, 'the pack file is kept as a file');
  assert.equal(withPack.episodeCount, 4, 'but it is not read as one episode');

  // A file no parser can number is reported by a merge instead of being dropped
  // from the index in silence.
  const trailer = await repository.createContent({ title: 'Emperor Trailer', category: 'donghua', files: [{ storageMessageId: 88, name: 'emperor behind the scenes.mp4' }] });
  const { plan } = await resolveMergePlan({ repository, parsed: parseMergeCommand(`${created.adminId} ${trailer.adminId}`) });
  const outcome = await applyMergePlan({ bot: { telegram: { async deleteMessage() { return true; }, async editMessageText() { return true; } } }, repository, config: {}, plan });
  const note = mergeResultText(outcome, {});
  // The trailer and the season pack are both named: one cannot be numbered at
  // all, the other is intentionally a whole season rather than one episode.
  assert.match(note, /2 moved files have no episode number and stay outside the episode index/);
  assert.match(note, /emperor behind the scenes/);
  assert.match(note, /S01\.Complete\.1080p/);
  assert.match(note, /still on the card and delivered as files/);
});

test('a merge accepts a shorter form of the target name and refuses a different one', async () => {
  const repository = new MemoryCatalogRepository([]);
  const target = await repository.createContent({ title: 'Bleach Movie 2024', category: 'movie', files: [{ storageMessageId: 1, name: 'Bleach.Movie.2024.mkv' }] });
  const source = await repository.createContent({ title: 'Bleach Movie', category: 'movie', files: [{ storageMessageId: 2, name: 'Bleach.Movie.Part.2.mkv' }] });

  const short = await resolveMergePlan({ repository, parsed: parseMergeCommand(`bleach movie ${target.adminId} ${source.adminId}`) });
  assert.equal(short.error, undefined, 'an abbreviated name is the same release, not a mistake');
  assert.equal(short.plan.sources.length, 1);

  const wrong = await resolveMergePlan({ repository, parsed: parseMergeCommand(`naruto ${target.adminId} ${source.adminId}`) });
  assert.match(wrong.error, /is not the name of/);
  assert.match(wrong.error, /drop the name and rely on the ID alone/);
});

test('an extra beside a series is not mistaken for an episode', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Read The Time',
    category: 'anime',
    files: [
      { storageMessageId: 1, name: 'Read.The.Time.4.mp4', displayName: 'Read The Time 4 1080p' },
      { storageMessageId: 2, name: 'Read.The.Time.Trailer.2.mp4', displayName: 'Read The Time Trailer 2' }
    ]
  });
  assert.deepEqual(created.episodeGroups.map((group) => group.label), ['Episode 04'], 'the trailer keeps its files and its own name');
  assert.equal(created.files.length, 2);
  assert.equal(created.files[1].episode?.start, undefined);
});

test('one manual paste builds one manifest row per labelled episode', () => {
  const paste = 'Ep 176 https://www.dailymotion.com/embed/video/kAAA https://rumble.com/v7twp-two.html\nEp 177 https://www.dailymotion.com/embed/video/kBBB\nhttps://not-allowed.example/x.mp4';
  const built = buildManualPlayerManifest('SB-098C73DC38', paste, {});
  assert.deepEqual(built.manifest.entries.map((item) => [item.row, item.entry.episode.label, item.entry.embedUrl]), [
    [1, 'Episode 176', 'https://www.dailymotion.com/embed/video/kAAA'],
    [2, 'Episode 176', 'https://rumble.com/embed/v7twp/'],
    [3, 'Episode 177', 'https://www.dailymotion.com/embed/video/kBBB']
  ], 'both links written beside Episode 176 stay on 176, and 177 gets its own row');
  assert.deepEqual(built.episodes, ['Episode 176', 'Episode 177']);
  assert.equal(built.links, 3);
  assert.equal(built.manifest.rejected.length, 1, 'the unapproved host is reported, never saved');
  assert.equal(built.manifest.entries.some((item) => item.entry.embedUrl.includes('not-allowed')), false);

  // A removal line is not a link list, and a paste with no usable link is refused
  // by the caller with the host explanation rather than saving nothing quietly.
  assert.deepEqual(buildManualPlayerManifest('SB-098C73DC38', 'del ep 2-7', {}).delete, { mode: 'episode', episode: { start: 2, end: 7, label: 'Episodes 02–07' } });
  const empty = buildManualPlayerManifest('SB-098C73DC38', 'ep 5 nothing here', {});
  assert.equal(empty.links, 0);
  assert.equal(empty.manifest.entries.length, 0);
});

