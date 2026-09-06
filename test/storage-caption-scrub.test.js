import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import {
  announcementSyncStatus,
  clearStorageCaptionBlockers,
  listStorageCaptionBlockers,
  listStorageCaptionTargets,
  queueStorageCaptionScrub,
  resetAnnouncementLane,
  scrubStorageCaptions,
  storageScrubNote,
  storageScrubPreviewText
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
  label: 'Naruto Shippuden S22 E480 - 486 Combined 1080p HEVC BluRay [English + Japanese]',
  ...overrides
});

beforeEach(() => {
  resetAnnouncementLane();
});

test('the catalog offers only captions it actually stored for a database message', async () => {
  const repository = new MemoryCatalogRepository([
    {
      slug: 'naruto',
      title: 'Naruto Shippuden',
      category: 'anime',
      publishedAt: '2026-09-02T10:00:00.000Z',
      files: [
        // a copied post whose stored label is the sanitized caption
        { name: 'Naruto.S22E480.mkv', sourceLabel: 'Naruto Shippuden S22 E480 - 486 Combined 1080p', storageMessageId: 91, storageChannelId: '-100db' },
        // a second quality of the same message: one sweep, one edit
        { name: 'Naruto.S22E480.720p.mkv', sourceLabel: 'Naruto Shippuden S22 E480 720p', storageMessageId: 91, storageChannelId: '-100db' },
        // a message that never had a caption, so writing one back would be inventing it
        { name: 'Naruto.S22E481.mkv', sourceLabel: 'Naruto.S22E481.mkv', storageMessageId: 92, storageChannelId: '-100db' },
        // a file with no database reference at all
        { name: 'Naruto.S22E482.mkv', sourceLabel: 'Naruto Shippuden S22 E482' }
      ]
    },
    {
      slug: 'older',
      title: 'Older Show',
      category: 'anime',
      publishedAt: '2026-01-01T10:00:00.000Z',
      files: [{ name: 'Older.001.mkv', sourceLabel: 'Older Show 01 Hindi', storageMessageId: 40, storageChannelId: '-100db' }]
    }
  ]);
  await repository.init();

  const { targets, available, blocked } = await listStorageCaptionTargets(repository, { limit: 10 });
  assert.equal(available, true);
  assert.equal(blocked, 0, 'nothing has been refused yet');
  assert.deepEqual(targets.map((entry) => entry.messageId), [91, 40], 'one entry per database message, newest card first');
  assert.equal(targets[0].label, 'Naruto Shippuden S22 E480 - 486 Combined 1080p', 'the first stored label of that message is written back');
  assert.match(targets[0].adminId, /^SB-[A-F0-9]{10}$/, 'the card is named, so a reply can say whose message it is');

  const scoped = await listStorageCaptionTargets(repository, { adminId: targets[1].adminId });
  assert.deepEqual(scoped.targets.map((entry) => entry.messageId), [40]);
  const capped = await listStorageCaptionTargets(repository, { limit: 1 });
  assert.equal(capped.targets.length, 1, 'a sweep is bounded, so the lane is not asked to spend an hour on an archive');
});

test('a database caption is rewritten to exactly what the catalog stored, and never invented', async () => {
  const calls = [];
  const waits = [];
  const telegram = {
    async editMessageCaption(chatIdArg, messageIdArg, inlineId, caption) {
      calls.push({ chatId: chatIdArg, messageId: messageIdArg, inlineId, caption });
      if (messageIdArg === 92) throw error('Bad Request: message is not modified');
      if (messageIdArg === 93) throw error('Bad Request: there is no caption in the message to edit');
      if (messageIdArg === 94) throw error('Too Many Requests: retry after 5', 5);
      if (messageIdArg === 95) throw error('Forbidden: bots can only edit their own messages');
      if (messageIdArg === 96) return { message_id: messageIdArg };
      return {};
    }
  };
  const options = { spacingMs: 1_100, wait: async (ms) => { waits.push(ms); }, attempts: 3 };
  const result = await scrubStorageCaptions({
    telegram,
    targets: [
      target({ messageId: 92, label: 'already the stored wording' }),
      target({ messageId: 93 }),
      target({ messageId: 94 }),
      target({ messageId: 95, title: 'Other Sender' }),
      target({ messageId: 96, label: '  @AnimeXEmpire still promotional  ' }),
      target({ messageId: 97, label: '   ' }),
      target({ messageId: 91, label: 'Naruto Shippuden S22 E480 - 486 Combined 1080p HEVC BluRay [English + Japanese]' })
    ],
    options
  });

  assert.equal(result.updated, 2, 'the two messages that accepted an edit were both written, the promotional one after sanitizing');
  assert.equal(result.unchanged, 1, 'Telegram saying it changed nothing is a success for a card that did not change');
  assert.equal(result.gone, 1, 'a message with no caption is left alone, not reported as a failure');
  assert.equal(result.blocked, 1, 'a post this bot did not send is named as uneditable');
  assert.equal(result.failed, 1, 'the flood-refused message is a real leftover, not a silent skip');
  assert.equal(result.skipped, 1, 'a label that leaves nothing behind is not a caption, so nothing is sent');
  assert.equal(result.retryAfterMs, 5_000);
  assert.ok(waits.includes(5_000), 'the wait Telegram asked for is obeyed between messages');
  assert.ok(waits.filter((value) => value === 1_100).length >= 5, 'and the lane still paces itself');
  assert.equal(calls.find((entry) => entry.messageId === 91).caption, 'Naruto Shippuden S22 E480 - 486 Combined 1080p HEVC BluRay [English + Japanese]');
  assert.equal(calls.find((entry) => entry.messageId === 91).inlineId, undefined, 'a channel message has no inline id to pass');
  assert.equal(calls.find((entry) => entry.messageId === 96).caption, 'still promotional', 'a stored label that somehow kept its @handle is sanitized on the way out, never written raw');
  assert.equal(result.blockedCards[0].messageId, 95);
  assert.deepEqual(listStorageCaptionBlockers().map((entry) => entry.key), ['-100db:95']);

  // the refusal is remembered, so a second sweep costs that message nothing
  const second = [];
  await scrubStorageCaptions({
    telegram: { async editMessageCaption(chatIdArg, messageIdArg) { second.push(messageIdArg); return {}; } },
    targets: [target({ messageId: 95 })],
    options: { spacingMs: 0, wait: async () => {} }
  });
  assert.deepEqual(second, [], 'a message known to belong to another sender is not retried on every run');
});

test('a queued sweep rides the announcement lane and reports what never got through', async () => {
  const sent = [];
  let attempts = 0;
  const telegram = {
    async editMessageCaption() { attempts += 1; throw error('Too Many Requests: retry after 9', 9); },
    async sendMessage(chatIdArg, text) { sent.push({ chatId: chatIdArg, text }); return {}; }
  };
  const job = queueStorageCaptionScrub({ telegram, targets: [target()], notifyChatId: '-100admin' }, { spacingMs: 0, wait: async () => {}, rounds: 2, attempts: 1 });
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

test('the note and the preview tell the truth about what a sweep touches', async () => {
  assert.match(storageScrubNote({ updated: 3, unchanged: 2, gone: 1, blocked: 4, failed: 0, messages: 10 }), /Database channel: 3 captions rewritten, 2 already clean, 1 deleted or captionless message left alone, 4 not editable by a bot \(sent by another account\)/);
  assert.match(storageScrubNote({ updated: 0, unchanged: 0, failed: 2, messages: 2 }), /2 refused by Telegram, still queued for a later round/);
  assert.match(storageScrubNote({ messages: 0 }), /already reads exactly as the catalog stores it/);
  assert.match(storageScrubNote({ messages: 0, blocked: 3 }), /Telegram only lets a bot edit its own messages/);

  const preview = storageScrubPreviewText({
    targets: [target(), target({ messageId: 92, adminId: 'SB-BBB222', title: 'Bleach' })],
    cards: 2,
    blocked: 5
  });
  assert.match(preview, /^▸ Preview · 2 database-channel messages on 2 cards carry a stored label this bot can write back\./m);
  assert.match(preview, /SB-AAA111 · Naruto Shippuden — message 91/);
  assert.match(preview, /5 messages were refused before because this bot did not send them/);
  assert.match(preview, /To apply it: \/sync db go/);

  const applied = storageScrubPreviewText({ targets: [target()], cards: 1, apply: true, single: true, spacingMs: 1_100 });
  assert.ok(!applied.includes('Preview'), 'an applied run does not call itself a preview');
  assert.match(applied, /One edit per 1\.1s on the announcement lane/);
  assert.match(applied, /safe to run twice/);
  assert.ok(!applied.includes('/sync db SB-0123ABCDEF for one card'), 'a single-card run has nothing left to name');
});

test('a file post saved before the channel was tracked is still reachable', async () => {
  const legacy = new MemoryCatalogRepository([
    {
      slug: 'bleach',
      title: 'Bleach',
      category: 'anime',
      // exactly what an old record looks like: a storage message ID and no channel of its own
      files: [{ name: 'Bleach.007.mkv', sourceLabel: 'Bleach 007 Hindi 1080p', storageMessageId: 300 }]
    },
    {
      slug: 'private',
      title: 'Grown Only',
      category: 'adult',
      files: [{ name: 'Grown.001.mkv', sourceLabel: 'Grown Only 01', storageMessageId: 400 }]
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

  const unaddressable = storageScrubPreviewText({ targets: bare.targets, cards: 0, stats: bare.stats });
  assert.match(unaddressable, /name no database channel and TELEGRAM_STORAGE_CHANNEL_ID is not configured for them/);
});

test('what a sweep could not use is named rather than left unexplained', async () => {
  const repository = new MemoryCatalogRepository([
    {
      slug: 'show',
      title: 'Show',
      category: 'anime',
      files: [
        { name: 'Show.001.mkv', sourceLabel: 'Show.001.mkv', storageMessageId: 11, storageChannelId: '-100db' },
        { name: 'Show.002.mkv', sourceLabel: 'Show 002 clean label', storageMessageId: 12, storageChannelId: '-100db' }
      ]
    }
  ]);
  await repository.init();

  const listed = await listStorageCaptionTargets(repository, { limit: 1 });
  assert.equal(listed.targets.length, 1);
  assert.equal(listed.stats.withoutCaption, 1, 'a file post that only ever had a filename is reported, not silently dropped');
  assert.equal(listed.stats.capped, true, 'and a run that hit its cap says so');

  const preview = storageScrubPreviewText({ targets: listed.targets, cards: 1, stats: listed.stats });
  assert.match(preview, /1 file post stored only a filename, so there is no caption to write back/);
  assert.match(preview, /\/batch cleans it while inspecting each message/);
  assert.match(preview, /The list is capped at 1 message per run/);
  assert.match(storageScrubPreviewText({ targets: listed.targets, cards: 1, stats: listed.stats, apply: true }), /This run is capped at 1 message; \/sync db go again for the next set/);
});

test('only a refusal that can never change is remembered, and retry forgets it', async () => {
  const calls = [];
  const telegram = {
    async editMessageCaption(chatIdArg, messageIdArg) {
      calls.push(messageIdArg);
      if (messageIdArg === 95) throw error('Forbidden: bots can only edit their own messages');
      if (messageIdArg === 97) throw error('Too Many Requests: retry after 3', 3);
      if (messageIdArg === 98) throw error('Forbidden: bot is not a member of the channel');
      return {};
    }
  };
  const options = { spacingMs: 0, wait: async () => {}, attempts: 1 };
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

  calls.length = 0;
  const again = await scrubStorageCaptions({
    telegram,
    targets: [target({ messageId: 95 }), target({ messageId: 98 })],
    options
  });
  assert.deepEqual(calls, [98], 'the refused message costs nothing next time, the fixable one is tried again');
  assert.equal(again.blocked, 1);

  assert.equal(clearStorageCaptionBlockers(), 1, 'retry reports what it forgot');
  assert.deepEqual(listStorageCaptionBlockers(), [], 'and the cache is genuinely empty after it');
  calls.length = 0;
  await scrubStorageCaptions({ telegram, targets: [target({ messageId: 95 })], options });
  assert.deepEqual(calls, [95], 'after a retry the message is attempted again, because the bot may have been made an editor since');
  assert.deepEqual(listStorageCaptionBlockers().map((entry) => entry.key), ['-100db:95'], 'a refusal that happens again is remembered again, not forgiven forever');
});
