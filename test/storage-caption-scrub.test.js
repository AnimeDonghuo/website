import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import {
  announcementLaneDrained,
  announcementSyncStatus,
  batchCaptionQueueNote,
  captionNeedsScrub,
  clearStorageCaptionMemory,
  listStorageCaptionBlockers,
  listStorageCaptionTargets,
  queueStorageCaptionScrub,
  queueStorageCaptionSweep,
  resetAnnouncementLane,
  runStorageCaptionSweep,
  scrubStorageCaptions,
  storageScrubNote,
  settleQueuedJob,
  storageScrubPreviewText,
  storageSweepReport,
  storageSweepStatusText
} from '../src/server/services/telegram-bot.js';

const error = (description, retryAfter = null) => Object.assign(new Error(description), {
  description,
  ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {})
});

const target = (overrides = {}) => ({
  adminId: 'SB-AAA111',
  title: 'Naruto Shippuden',
  channel: '-100db',
  messageId: 91,
  ...overrides
});

const PROMOTIONAL = '@AnimeXEmpire Naruto S22 E480 1080p';

/**
 * A Telegram fake that behaves like the real API for this feature: a message can be read through
 * a one-time forward, an edit only ever applies the text it is handed, and each message below is
 * configured to answer in one specific way.
 */
function makeTelegram({ liveCaptions = new Map(), edits = () => {}, forwardError = () => null } = {}) {
  const calls = { forwards: [], deletions: [], edits: [] };
  return {
    calls,
    async forwardMessage(chatIdArg, fromChat, messageId) {
      calls.forwards.push({ chat: chatIdArg, from: fromChat, messageId });
      const failure = forwardError(messageId);
      if (failure) throw failure;
      const caption = liveCaptions.get(Number(messageId));
      return { message_id: 5_000 + Number(messageId), ...(caption === undefined ? {} : { caption }) };
    },
    async deleteMessage(chatIdArg, messageId) {
      calls.deletions.push({ chat: chatIdArg, messageId });
      return { ok: true };
    },
    async editMessageCaption(chatIdArg, messageId, inlineId, caption) {
      calls.edits.push({ chat: chatIdArg, messageId, inlineId, caption });
      return edits(messageId);
    }
  };
}

beforeEach(() => {
  resetAnnouncementLane();
});

test('the work list is every database message the catalog knows, not only the ones with a stored label', async () => {
  const repository = new MemoryCatalogRepository([
    {
      slug: 'naruto',
      title: 'Naruto Shippuden',
      category: 'anime',
      publishedAt: '2026-09-02T10:00:00.000Z',
      files: [
        // two qualities copied from one message: the sweep reads and, if needed, edits it once
        { name: 'Naruto.S22E480.mkv', sourceLabel: 'Naruto Shippuden S22 E480 - 486 Combined 1080p', storageMessageId: 91, storageChannelId: '-100db' },
        { name: 'Naruto.S22E480.720p.mkv', sourceLabel: 'Naruto Shippuden S22 E480 720p', storageMessageId: 91, storageChannelId: '-100db' },
        // a native upload whose record kept only the filename: the caption is read from Telegram
        { name: 'Naruto.S22E481.mkv', sourceLabel: 'Naruto.S22E481.mkv', storageMessageId: 92, storageChannelId: '-100db' },
        // a file with no database reference at all, so nothing to look at
        { name: 'Naruto.S22E482.mkv', sourceLabel: 'Naruto Shippuden S22 E482' }
      ]
    },
    {
      slug: 'older',
      title: 'Older Show',
      category: 'anime',
      publishedAt: '2026-01-01T10:00:00.000Z',
      files: [{ name: 'Older.001.mkv', storageMessageId: 40, storageChannelId: '-100db' }]
    },
    {
      slug: 'draft',
      title: 'Not Published',
      category: 'anime',
      published: false,
      files: [{ name: 'Draft.001.mkv', storageMessageId: 41, storageChannelId: '-100db' }]
    }
  ]);
  await repository.init();
  // The seed marks everything published, so the draft is unpublished the way a real card is.
  repository.contents.get('draft').published = false;

  const { targets, available, blocked, clean } = await listStorageCaptionTargets(repository, { limit: 10 });
  assert.equal(available, true);
  assert.equal(blocked, 0, 'nothing has been refused yet');
  assert.equal(clean, 0, 'nothing has been read yet');
  assert.deepEqual(targets.map((entry) => entry.messageId), [91, 92, 40], 'one entry per database message, newest card first');
  assert.equal(targets[0].label, undefined, 'no label is trusted: the caption is read from Telegram');
  assert.match(targets[0].adminId, /^SB-[A-F0-9]{10}$/, 'the card is named, so a reply can say whose message it is');
  assert.equal(targets[1].messageId, 92, 'a record that kept no caption is still checked, like /batch checks it');
  assert.equal(targets[2].messageId, 40, 'a file whose message never had a caption is listed too — reading is what decides');

  const scoped = await listStorageCaptionTargets(repository, { adminId: targets[2].adminId });
  assert.deepEqual(scoped.targets.map((entry) => entry.messageId), [40]);
  const capped = await listStorageCaptionTargets(repository, { limit: 1 });
  assert.equal(capped.targets.length, 1);
  assert.equal(capped.stats.capped, true, 'a run that stops at its cap says so, so it never reads like the whole archive');

  const listed = await listStorageCaptionTargets(repository, { limit: 10 });
  assert.equal(listed.stats.files, 4, 'every file record naming a database message, before deduping');
  assert.equal(listed.stats.cards, 2, 'and how many cards have something to check');
  assert.equal(listed.stats.noChannel, 0, 'a channel is configured for this store, so nothing is out of reach');
});

test('a caption is read from Telegram first, then written back cleaned — never composed', async () => {
  const telegram = makeTelegram({
    liveCaptions: new Map([
      [91, PROMOTIONAL],
      [92, 'Naruto S22 E480 1080p already clean'],
      [93, undefined],
      [96, '@AnimeXEmpire owned by someone else'],
      [97, '@AnimeXEmpire flood limited']
    ]),
    edits: (messageId) => {
      if (messageId === 96) throw error('Forbidden: bots can only edit their own messages');
      if (messageId === 97) throw error('Too Many Requests: retry after 5', 5);
      return { message_id: messageId };
    },
    forwardError: (messageId) => (messageId === 95 ? error('Bad Request: message can\'t be forwarded') : null)
  });
  const waits = [];
  const result = await scrubStorageCaptions({
    telegram,
    targets: [
      target({ messageId: 91 }),
      target({ messageId: 92 }),
      target({ messageId: 93 }),
      // a message /batch is holding: its caption is already in hand, so no preview is needed
      target({ messageId: 94, caption: '@AnimeXEmpire Bleach 007 1080p' }),
      target({ messageId: 95 }),
      target({ messageId: 96, title: 'Other Sender' }),
      target({ messageId: 97 })
    ],
    options: { spacingMs: 1_100, wait: async (ms) => { waits.push(ms); }, attempts: 1, inspectChatId: '-100publisher' }
  });

  assert.deepEqual(
    telegram.calls.forwards.map((entry) => `${entry.chat}←${entry.from}:${entry.messageId}`),
    ['-100publisher←-100db:91', '-100publisher←-100db:92', '-100publisher←-100db:93', '-100publisher←-100db:95', '-100publisher←-100db:96', '-100publisher←-100db:97'],
    'each message is read through a one-time preview, and a caption already in hand is not read again'
  );
  assert.deepEqual(telegram.calls.deletions.map((entry) => entry.messageId), [5_091, 5_092, 5_093, 5_096, 5_097], 'every preview that arrived is deleted again');
  assert.deepEqual(telegram.calls.edits.map((entry) => entry.messageId), [91, 94, 96, 97], 'a clean caption and a captionless post are never edited');
  assert.equal(telegram.calls.edits[0].caption, 'Naruto S22 E480 1080p', 'the message is set to the cleaned form of its own caption');
  assert.equal(telegram.calls.edits[1].caption, 'Bleach 007 1080p', 'the same sanitizer /batch uses on import');
  assert.equal(telegram.calls.edits[0].inlineId, undefined, 'a channel message has no inline id to pass');
  assert.equal(telegram.calls.edits[0].chat, '-100db', 'the edit goes back to the database channel, not the publisher chat');

  assert.equal(result.updated, 2);
  assert.equal(result.alreadyClean, 1, 'read and found clean, so nothing was sent');
  assert.equal(result.noCaption, 1, 'a file post with no caption is not given one');
  assert.equal(result.unreadable, 1, 'a message this bot cannot read is named, not counted as clean');
  assert.equal(result.blocked, 1, 'a post this bot did not send is named as uneditable');
  assert.equal(result.failed, 1, 'a flood refusal is a real leftover, not a silent skip');
  assert.equal(result.inspected, 5, 'only the reads that arrived count, and the refused forward is reported as unreadable instead');
  assert.equal(result.messages, 7);
  assert.deepEqual(result.blockedCards.map((entry) => entry.messageId), [96]);
  assert.deepEqual(listStorageCaptionBlockers().map((entry) => entry.key), ['-100db:96']);
  assert.ok(waits.every((value) => value === 1_100), 'the lane paces itself between messages');

  // A second sweep in the same process does not pay for what it already read.
  const again = makeTelegram({ liveCaptions: new Map([[91, PROMOTIONAL]]) });
  const second = await scrubStorageCaptions({
    telegram: again,
    targets: [target({ messageId: 91 }), target({ messageId: 92 }), target({ messageId: 96 })],
    options: { spacingMs: 0, wait: async () => {} }
  });
  assert.deepEqual(again.calls.forwards, [], 'nothing is forwarded a second time');
  assert.deepEqual(again.calls.edits, [], 'nothing is edited a second time');
  assert.equal(second.knownClean, 2, 'the messages read and found clean are remembered');
  assert.equal(second.blocked, 1, 'and the refusal is remembered too, so it costs no API call');
});

test('a sweep never forwards a message into the channel it is cleaning', async () => {
  const telegram = makeTelegram({ liveCaptions: new Map([[91, PROMOTIONAL]]) });
  const result = await scrubStorageCaptions({
    telegram,
    targets: [target({ messageId: 91 })],
    // the automation context is the storage channel: a "preview" there would be a second post
    options: { spacingMs: 0, wait: async () => {}, inspectChatId: '-100db' }
  });
  assert.deepEqual(telegram.calls.forwards, [], 'no preview is created in the channel');
  assert.equal(result.unreadable, 1, 'and the message is reported as unread rather than guessed at');
  assert.deepEqual(telegram.calls.edits, [], 'the record is never written back over a message it was not read from');
});

test('a caption Telegram refuses at first is retried within the run, at the wait it asked for', async () => {
  const waits = [];
  let refusals = 0;
  const telegram = makeTelegram({
    liveCaptions: new Map([[91, PROMOTIONAL]]),
    edits: () => {
      refusals += 1;
      if (refusals <= 2) throw error('Too Many Requests: retry after 5', 5);
      return { message_id: 91 };
    }
  });
  const result = await scrubStorageCaptions({
    telegram,
    targets: [target({ messageId: 91 })],
    options: { spacingMs: 1_100, wait: async (ms) => { waits.push(ms); }, attempts: 3, inspectChatId: '-100publisher' }
  });
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.retryAfterMs, 5_000);
  assert.ok(waits.includes(5_000), 'the wait Telegram asked for is obeyed between attempts');
  assert.equal(telegram.calls.edits.length, 3, 'two refusals and the edit that got through');
});

test('a queued sweep rides the announcement lane and reports what never got through', async () => {
  const sent = [];
  let attempts = 0;
  const telegram = {
    async editMessageCaption() { attempts += 1; throw error('Too Many Requests: retry after 9', 9); },
    async sendMessage(chatIdArg, text) { sent.push({ chatId: chatIdArg, text }); return {}; }
  };
  const job = queueStorageCaptionScrub({
    telegram,
    targets: [target({ messageId: 91, caption: PROMOTIONAL })],
    notifyChatId: '-100admin'
  }, { spacingMs: 0, wait: async () => {}, rounds: 2, attempts: 1 });
  const result = await job;

  assert.equal(attempts, 2, 'two rounds, one call each, spaced by the lane');
  assert.equal(result.failed, 1, 'the last round names what is still outstanding');
  assert.equal(announcementSyncStatus().totals.retried, 1, 'and the retry is counted, not hidden');
  assert.equal(announcementSyncStatus().pending, 0);
  assert.ok(announcementSyncStatus().stale.some((entry) => entry.key === 'storage-captions'), 'the leftover is listed for /sync');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Database channel captions \(1\)/);
  assert.match(sent[0].text, /\/sync db go retries the edit/);
  assert.match(sent[0].text, /website labels were already clean/, 'the report must not sound like a card is broken');
});

test('a file post is never blocked by a caption the channel will not accept yet', async () => {
  const telegram = makeTelegram({
    liveCaptions: new Map([[91, PROMOTIONAL]]),
    edits: () => { throw error('Too Many Requests: retry after 30', 30); }
  });
  const queued = queueStorageCaptionScrub({ telegram, targets: [target({ messageId: 91, caption: PROMOTIONAL })] }, {
    detached: true,
    spacingMs: 0,
    wait: async () => {},
    rounds: 1,
    attempts: 1
  });
  // A bulk import hands the fix over and moves on to matching metadata and publishing.
  assert.equal(queued, null, 'a detached job is deliberately not a promise the import can await');
  await announcementLaneDrained();
  assert.equal(telegram.calls.edits.length, 1, 'the edit was attempted on the lane, after the release moved on');
  assert.ok(announcementSyncStatus().stale.some((entry) => entry.key === 'storage-captions'), 'and the refusal stays on the list /sync reports');
  assert.equal(announcementSyncStatus().totals.captions, 0, 'nothing counts as rewritten unless it was written');
});

test('the report says what was read, and the preview promises a read rather than a write', async () => {
  assert.equal(captionNeedsScrub(PROMOTIONAL), true);
  assert.equal(captionNeedsScrub('Naruto S22 E480 1080p'), false, 'a clean caption costs no forward and no edit');
  assert.equal(captionNeedsScrub('   '), false, 'whitespace is not a caption');
  assert.equal(captionNeedsScrub(undefined), false);

  assert.match(
    storageScrubNote({ updated: 3, unchanged: 2, alreadyClean: 1, noCaption: 1, unreadable: 1, inspected: 6, gone: 1, blocked: 4, failed: 0, messages: 10 }),
    /Database channel: 3 captions rewritten, 2 already carrying it, 1 read from Telegram and already clean, so nothing was sent, 1 file post with no caption at all, left without one, 1 message this bot could not read \(protected or deleted\), 6 read through a one-time preview, 1 deleted or captionless message left alone, 4 not editable by a bot \(sent by another account\)/
  );
  assert.match(storageScrubNote({ updated: 0, unchanged: 0, failed: 2, messages: 2 }), /2 refused by Telegram, still queued for a later round/);
  assert.match(storageScrubNote({ messages: 0 }), /was read and already carries a clean caption/);
  assert.match(storageScrubNote({ messages: 0, blocked: 3 }), /Telegram only lets a bot edit its own messages/);

  const preview = storageScrubPreviewText({
    targets: [target(), target({ messageId: 92, adminId: 'SB-BBB222', title: 'Bleach' })],
    cards: 2,
    blocked: 5
  });
  assert.match(preview, /^▸ Preview · 2 database-channel messages on 2 cards listed for a caption check\./m);
  assert.match(preview, /SB-AAA111 · Naruto Shippuden — message 91/);
  assert.match(preview, /Each one is read from Telegram first — the same one-time preview \/batch uses/);
  assert.match(preview, /a message is set to the cleaned form of its own caption/);
  assert.match(preview, /5 messages were refused before because this bot did not send them/);
  assert.match(preview, /To apply it: \/sync db go/);

  const applied = storageScrubPreviewText({ targets: [target()], cards: 1, apply: true, single: true, spacingMs: 1_100 });
  assert.ok(!applied.includes('Preview'), 'an applied run does not call itself a preview');
  assert.match(applied, /One read and, if needed, one edit per 1\.1s on the announcement lane/);
  assert.match(applied, /safe to run twice and the second run is cheap/);
  assert.ok(!applied.includes('/sync db SB-0123ABCDEF for one card'), 'a single-card run has nothing left to name');
});

test('the import hands its caption fixes to the lane instead of stalling on them', () => {
  assert.equal(batchCaptionQueueNote(0), null, 'an uneventful import says nothing about captions');
  const note = batchCaptionQueueNote(3);
  assert.match(note, /3 storage posts arrived with an @channel prefix in its caption/);
  assert.match(note, /The files were imported as usual and nothing new was created for it/);
  assert.match(note, /a Telegram limit delays the edit and never the release/);
  assert.match(note, /\/sync db lists what is left/);
  assert.match(batchCaptionQueueNote(1), /1 storage post arrived/);
});

test('a file post saved before the channel was tracked is still reachable', async () => {
  const legacy = new MemoryCatalogRepository([
    {
      slug: 'bleach',
      title: 'Bleach',
      category: 'anime',
      // exactly what an old record looks like: a storage message ID and no channel of its own
      files: [{ name: 'Bleach.007.mkv', storageMessageId: 300 }]
    },
    {
      slug: 'private',
      title: 'Grown Only',
      category: 'adult',
      files: [{ name: 'Grown.001.mkv', storageMessageId: 400 }]
    }
  ]);
  await legacy.init();

  const bare = await listStorageCaptionTargets(legacy, {});
  assert.deepEqual(bare.targets, [], 'with no database channel configured there is genuinely nothing to address');
  assert.equal(bare.stats.noChannel, 2);

  const configured = await listStorageCaptionTargets(legacy, {
    config: { telegram: { storageChannelId: '-100db', adultStorageChannelId: '-100adult' } }
  });
  assert.deepEqual(configured.targets.map((entry) => `${entry.channel}:${entry.messageId}`).sort(), ['-100adult:400', '-100db:300'], 'each category resolves to its own database channel, the way /batch does');
  assert.equal(configured.stats.legacyChannel, 2);
  assert.equal(configured.targets.find((entry) => entry.messageId === 300).legacyChannel, true);

  const preview = storageScrubPreviewText({ targets: configured.targets, cards: 2, stats: configured.stats });
  assert.match(preview, /2 of them are a file post saved before the catalog tracked which channel it went to — resolved through the configured database channel, the same way \/batch reaches them/);
  assert.match(preview, /2 file records in this catalog point at a database message — 2 cards with something to check/);

  const unaddressable = storageScrubPreviewText({ targets: bare.targets, cards: 0, stats: bare.stats });
  assert.match(unaddressable, /name no database channel and TELEGRAM_STORAGE_CHANNEL_ID is not configured for them/);
});

test('only a refusal that can never change is remembered, and retry forgets all of it', async () => {
  const telegram = makeTelegram({
    liveCaptions: new Map([
      [95, '@AnimeXEmpire one'],
      [97, '@AnimeXEmpire two'],
      [98, '@AnimeXEmpire three']
    ]),
    edits: (messageId) => {
      if (messageId === 95) throw error('Forbidden: bots can only edit their own messages');
      if (messageId === 97) throw error('Too Many Requests: retry after 3', 3);
      if (messageId === 98) throw error('Forbidden: bot is not a member of the channel');
      return { message_id: messageId };
    }
  });
  const options = { spacingMs: 0, wait: async () => {}, attempts: 1, inspectChatId: '-100publisher' };
  const first = await scrubStorageCaptions({
    telegram,
    targets: [target({ messageId: 95 }), target({ messageId: 97 }), target({ messageId: 98 })],
    options
  });
  assert.equal(first.blocked, 1, 'a message that belongs to another sender is a permanent answer');
  assert.equal(first.failed, 2, 'a flood wait and a missing admin right are not — they are real leftovers');
  assert.deepEqual(listStorageCaptionBlockers().map((entry) => entry.key), ['-100db:95']);
  assert.match(storageScrubNote(first), /1 not editable by a bot \(sent by another account\)/);
  assert.match(storageScrubNote(first), /2 refused by Telegram, still queued for a later round/);

  telegram.calls.edits.length = 0;
  telegram.calls.forwards.length = 0;
  const again = await scrubStorageCaptions({
    telegram,
    targets: [target({ messageId: 95 }), target({ messageId: 98 })],
    options
  });
  assert.deepEqual(telegram.calls.edits.map((entry) => entry.messageId), [98], 'the refused message costs nothing next time, the fixable one is tried again');
  assert.equal(again.blocked, 1);

  const forgotten = clearStorageCaptionMemory();
  assert.deepEqual(forgotten, { blocked: 1, clean: 0 }, 'retry reports what it forgot');
  assert.deepEqual(listStorageCaptionBlockers(), [], 'and the cache is genuinely empty after it');
  telegram.calls.edits.length = 0;
  await scrubStorageCaptions({ telegram, targets: [target({ messageId: 95 })], options });
  assert.deepEqual(telegram.calls.edits.map((entry) => entry.messageId), [95], 'after a retry the message is attempted again, because the bot may have been made an editor since');
  assert.deepEqual(listStorageCaptionBlockers().map((entry) => entry.key), ['-100db:95'], 'a refusal that happens again is remembered again, not forgiven forever');
});

test('a card window can be walked, and it says whether the archive continues', async () => {
  const repository = new MemoryCatalogRepository(
    Array.from({ length: 6 }, (_, index) => ({
      slug: `show-${index}`,
      title: `Show ${index}`,
      category: 'anime',
      publishedAt: new Date(Date.UTC(2026, 8, 20 - index)).toISOString(),
      files: [{ name: `Show.${index}.mkv`, storageMessageId: 1_000 + index, storageChannelId: '-100db' }]
    }))
  );
  await repository.init();

  const seen = [];
  const windows = [];
  let skip = 0;
  for (let page = 0; page < 10; page += 1) {
    const listed = await repository.listStorageCaptionTargets({ limit: 80, skip, cards: 2, storageChannelId: '-100db' });
    seen.push(...listed.targets.map((entry) => entry.messageId));
    windows.push({ scanned: listed.stats.scanned, more: listed.more });
    if (!listed.more) break;
    skip += listed.stats.scanned;
  }
  assert.deepEqual(seen, [1_000, 1_001, 1_002, 1_003, 1_004, 1_005], 'every card is reached exactly once, newest first');
  assert.deepEqual(windows, [
    { scanned: 2, more: true },
    { scanned: 2, more: true },
    { scanned: 2, more: false }
  ], 'the window is honest about how far it got, so no card is skipped and none is read twice');
});

test('one command walks the whole archive instead of stopping at the first page', async () => {
  const pages = [
    { targets: [target({ messageId: 91 }), target({ messageId: 92 })], more: true, stats: { scanned: 2, more: true, capped: false } },
    { targets: [target({ messageId: 93 })], more: false, stats: { scanned: 1, more: false, capped: false } }
  ];
  const asked = [];
  const repository = {
    async listStorageCaptionTargets(options) {
      asked.push({ skip: options.skip, cards: options.cards, channel: options.storageChannelId });
      const page = pages[asked.length - 1] || { targets: [], more: false, stats: { scanned: 0, more: false, capped: false } };
      return { ...page, targets: page.targets.map((entry) => ({ ...entry, caption: PROMOTIONAL })) };
    }
  };
  const telegram = makeTelegram({ edits: () => ({}) });
  const result = await runStorageCaptionSweep({
    telegram,
    repository,
    config: { telegram: { storageChannelId: '-100db' } },
    inspectChatId: '-100publisher',
    options: { spacingMs: 0, wait: async () => {} }
  });

  assert.equal(result.pages, 2, 'it moves on to the next window instead of reporting a cap');
  assert.equal(result.messages, 3);
  assert.equal(result.updated, 3);
  assert.equal(result.cards, 3);
  assert.equal(result.stoppedFor, null);
  assert.deepEqual(asked.map((entry) => entry.skip), [0, 2], 'the card window advances by what was scanned');
  assert.deepEqual(asked.map((entry) => entry.channel), ['-100db', '-100db'], 'the configured database channel is passed down on every page');
  assert.match(storageSweepReport(result), /Database channel sweep: 2 pages, 3 messages read from Telegram\./);
  assert.match(storageSweepReport(result), /3 captions rewritten/);
});

test('a page cut off by its own ceiling is read wider rather than losing files', async () => {
  const big = Array.from({ length: 6 }, (_, index) => target({ messageId: 200 + index, caption: PROMOTIONAL }));
  const asked = [];
  const repository = {
    async listStorageCaptionTargets(options) {
      asked.push(options.limit);
      const capped = asked.length === 1;
      return {
        targets: capped ? big.slice(0, 2) : big,
        more: false,
        stats: { scanned: 1, more: false, capped }
      };
    }
  };
  const telegram = makeTelegram({ edits: () => ({}) });
  const result = await runStorageCaptionSweep({
    telegram,
    repository,
    options: { spacingMs: 0, wait: async () => {}, limit: 2 }
  });
  assert.deepEqual(asked, [2, 6], 'the same window is re-listed with room for the whole pack');
  assert.equal(result.messages, 6, 'so a 100-episode season pack is not cleaned 80 files at a time forever');
});

test('a channel whose posts cannot be read is stopped at, and the reason is said out loud', async () => {
  const repository = {
    async listStorageCaptionTargets() {
      return { targets: [target({ messageId: 91 })], more: true, stats: { scanned: 1, more: true, capped: false } };
    }
  };
  const telegram = makeTelegram({ forwardError: () => error("Bad Request: message can't be forwarded") });
  const result = await runStorageCaptionSweep({
    telegram,
    repository,
    inspectChatId: '-100publisher',
    options: { spacingMs: 0, wait: async () => {} }
  });
  assert.equal(result.pages, 1, 'no further page is spent on a channel that cannot be read at all');
  assert.equal(result.stoppedFor, 'unreadable');
  assert.match(storageSweepReport(result), /does not allow its posts to be forwarded/);
  assert.match(storageSweepReport(result), /edit the posts there yourself/);
});

test('a run has a ceiling, and says so instead of looking finished', async () => {
  const repository = {
    async listStorageCaptionTargets(options) {
      const first = 300 + (Number(options.skip) || 0) * 3;
      return {
        targets: [target({ messageId: first, caption: PROMOTIONAL }), target({ messageId: first + 1, caption: PROMOTIONAL })],
        more: true,
        stats: { scanned: 1, more: true, capped: false }
      };
    }
  };
  const telegram = makeTelegram({ edits: () => ({}) });
  const result = await runStorageCaptionSweep({ telegram, repository, options: { spacingMs: 0, wait: async () => {}, limit: 2, totalCeiling: 4 } });
  assert.equal(result.messages, 4);
  assert.equal(result.pages, 2);
  assert.equal(result.stoppedFor, 'total');
  assert.match(storageSweepReport(result), /Stopped at the run ceiling/);
  assert.match(storageSweepReport(result), /\/sync db go picks up with the next set/);
});

test('the command that starts a sweep never waits for it, and the sweep answers when it finishes', async () => {
  const sent = [];
  const telegram = {
    async editMessageCaption(chatIdArg, messageId, inlineId, caption) { sent.push({ kind: 'edit', messageId, caption }); return {}; },
    async sendMessage(chatIdArg, text) { sent.push({ kind: 'note', chat: chatIdArg, text }); return {}; }
  };
  const repository = {
    async listStorageCaptionTargets() {
      return { targets: [target({ messageId: 91, caption: PROMOTIONAL })], more: false, stats: { scanned: 1, more: false, capped: false } };
    }
  };
  const job = queueStorageCaptionSweep({ telegram, repository, notifyChatId: '-100admin', inspectChatId: '-100publisher' }, { spacingMs: 0, wait: async () => {} });
  assert.match(storageSweepStatusText(), /A database-channel sweep is (running|queued on the lane)/, 'while the lane is busy, /sync db status is the answer');
  assert.equal(queueStorageCaptionSweep({ telegram, repository, notifyChatId: '-100admin' }, { spacingMs: 0 }), null, 'and the command knows not to start it twice');
  await job;
  assert.match(storageSweepStatusText(), /Last sweep finished/);

  assert.deepEqual(sent.map((entry) => entry.kind), ['edit', 'note'], 'the edit happens on the lane and the summary arrives afterwards');
  assert.match(sent[1].text, /Database channel sweep: 1 page, 1 message read from Telegram\./);
  assert.match(sent[1].text, /Database channel: 1 caption rewritten/);
  assert.equal(sent[1].chat, '-100admin');
  assert.match(storageSweepStatusText(), /Last sweep finished/);
  assert.match(storageSweepStatusText(), /1 caption rewritten/);
});

test('a sweep is not queued twice at once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const telegram = {
    async editMessageCaption() { await gate; return {}; },
    async sendMessage() { return {}; }
  };
  const repository = {
    async listStorageCaptionTargets() {
      return { targets: [target({ messageId: 91, caption: PROMOTIONAL })], more: false, stats: { scanned: 1, more: false, capped: false } };
    }
  };
  const options = { spacingMs: 0, wait: async () => {} };
  const first = queueStorageCaptionSweep({ telegram, repository, notifyChatId: '-100admin' }, options);
  assert.ok(first, 'the first command starts it');
  assert.equal(queueStorageCaptionSweep({ telegram, repository, notifyChatId: '-100admin' }, options), null, 'a second one does not queue a duplicate sweep');
  release();
  await first;
  assert.ok(queueStorageCaptionSweep({ telegram, repository, notifyChatId: '-100admin' }, options), 'and once it is finished, another run can be started');
  await announcementLaneDrained();
});

test('a command never sits on the lane waiting for a channel', async () => {
  // The job is deliberately slower than the grace period, which is the whole point: a command
  // that outlives Telegram's own request timeout turns finished work into an error message.
  let resolveSlow;
  const slow = new Promise((resolve) => { resolveSlow = resolve; });
  setTimeout(() => resolveSlow({ updated: 3 }), 25);
  const bounded = await settleQueuedJob(slow, { graceMs: 1 });
  assert.equal(bounded.settled, false, 'once the grace period passes, the command answers on its own');
  assert.equal(bounded.result, null);
  await slow;

  assert.deepEqual(await settleQueuedJob(Promise.resolve({ updated: 2 }), { graceMs: 1_000 }), { settled: true, result: { updated: 2 } }, 'an idle lane is still reported exactly');
  assert.deepEqual(await settleQueuedJob(Promise.reject(new Error('channel refused')), { graceMs: 1_000 }), { settled: true, result: null }, 'a rejected job is an answer, not a thrown error in the handler');
  assert.deepEqual(await settleQueuedJob(null, { graceMs: 1_000 }), { settled: false, result: null }, 'a detached job was never something to await');
});
