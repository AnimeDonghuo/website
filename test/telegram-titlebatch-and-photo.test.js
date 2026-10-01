import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MemoryCatalogRepository, MongoCatalogRepository } from '../src/server/catalog.repository.js';
import { parseBulkPostEdits, editAnnouncementPhoto, applyBulkTitleEdits, applyMergePlan } from '../src/server/services/telegram-bot.js';

test('Mongo bot search includes IDs without changing the public projection', async () => {
  const projections = [];
  const cursor = { sort() { return this; }, skip() { return this; }, limit() { return this; }, async toArray() { return []; } };
  const repo = new MongoCatalogRepository(null, { collection: () => ({ find(filter, { projection }) { projections.push(projection); return cursor; } }) });
  await repo.listContent({ query: 'Shield Hero', includeAdminId: true });
  await repo.listContent({ query: 'Shield Hero' });
  assert.equal(projections[0].adminId, 1);
  assert.equal(projections[1].adminId, undefined);
});

test('titlebatch uses spaced commas or newlines, preserving commas within names', () => {
  const parsed = parseBulkPostEdits('/titlebatch\nSB-0000000001 RRR , SB-0000000002 Hello, World\nSB-0000000003 PK', { commands: ['titlebatch', 'title'] });
  assert.equal(parsed.invalid.length, 0);
  assert.deepEqual(parsed.entries.map((e) => e.value), ['RRR', 'Hello, World', 'PK']);
  const bad = parseBulkPostEdits('/titlebatch SB-0000000001 RRR, SB-0000000002 PK', { commands: ['titlebatch'] });
  assert.equal(bad.entries.length, 0);
  assert.match(bad.invalid[0].reason, /separate entries/);
});

test('empty titlebatch gives usage instead of entering the draft flow', async () => {
  const replies = [];
  assert.equal(await applyBulkTitleEdits({ ctx: { reply: async (text) => replies.push(text) }, repository: {}, text: '/titlebatch', commands: ['titlebatch'], force: true }), true);
  assert.match(replies[0], /Usage: \/titlebatch/);
});

test('Telegram URL failure retries the same edit using downloaded image bytes', async () => {
  const calls = [];
  const buffer = Buffer.from('poster');
  const result = await editAnnouncementPhoto({
    telegram: { editMessageMedia: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error('Bad Request: failed to get HTTP URL content');
      return { message_id: 42 };
    } },
    reference: { channelId: '-1001', messageId: 42 }, posterUrl: 'https://i.ibb.co/poster.png', caption: 'Corrected title', replyMarkup: { inline_keyboard: [] },
    download: async (url) => { assert.equal(url, 'https://i.ibb.co/poster.png'); return { buffer, contentType: 'image/png' }; }
  });
  assert.equal(result.message_id, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][3].media.source, buffer);
  assert.equal(calls[1][3].caption, 'Corrected title');
  assert.deepEqual(calls[1].slice(0, 3), calls[0].slice(0, 3));
  assert.deepEqual(calls[1][4], calls[0][4]);
});

test('rights errors do not download a poster; download failures remain failures', async () => {
  const base = { reference: { channelId: '-1001', messageId: 42 }, posterUrl: 'https://i.ibb.co/poster.png', caption: 'Title' };
  await assert.rejects(editAnnouncementPhoto({ ...base, telegram: { editMessageMedia: async () => { throw new Error('Forbidden'); } }, download: async () => assert.fail('should not download') }), /Forbidden/);
  await assert.rejects(editAnnouncementPhoto({ ...base, telegram: { editMessageMedia: async () => { throw new Error('failed to get HTTP URL content'); } }, download: async () => { throw new Error('Download unavailable'); } }), /Download unavailable/);
});

function makeBatchContext(replies = []) {
  return {
    chat: { id: 100 },
    from: { id: 100, is_bot: false, username: 'publisher' },
    telegram: {
      editMessageMedia: async () => ({ message_id: 1 }),
      editMessageCaption: async () => ({ message_id: 1 }),
      editMessageText: async () => ({ message_id: 1 }),
      deleteMessage: async () => true
    },
    reply: async (text, keyboard) => {
      replies.push({ text, keyboard });
      return { message_id: 200 + replies.length };
    }
  };
}

test('titlebatch detects duplicate titles within the batch and offers merge confirmation', async () => {
  const repository = new MemoryCatalogRepository([
    {
      slug: 'card-1',
      title: 'Old Title 1',
      category: 'anime',
      adminId: 'SB-0000000001',
      files: [{ name: 'Solo.Leveling.E01.mkv' }]
    },
    {
      slug: 'card-2',
      title: 'Old Title 2',
      category: 'anime',
      adminId: 'SB-0000000002',
      files: [{ name: 'Solo.Leveling.E02.mkv' }]
    }
  ]);
  const replies = [];
  const ctx = makeBatchContext(replies);

  const result = await applyBulkTitleEdits({
    ctx,
    repository,
    text: '/titlebatch SB-0000000001 Solo Leveling , SB-0000000002 Solo Leveling',
    commands: ['titlebatch', 'title'],
    force: true
  });

  assert.equal(result.handled, true);
  assert.equal((await repository.findContentByAdminId('SB-0000000001')).title, 'Solo Leveling');
  assert.equal((await repository.findContentByAdminId('SB-0000000002')).title, 'Solo Leveling');

  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /Title updated for 2 posts/);
  assert.match(replies[1].text, /“Solo Leveling” is already published as SB-0000000001/);
  assert.match(replies[1].text, /Merge them\?/);
  assert.ok(replies[1].keyboard);

  const pending = await repository.findMergePlan(100, 100);
  assert.ok(pending);
  assert.equal(pending.plan.targetAdminId, 'SB-0000000001');
  assert.equal(pending.plan.sources.length, 1);
  assert.equal(pending.plan.sources[0].adminId, 'SB-0000000002');

  const outcome = await applyMergePlan({ bot: ctx, repository, plan: pending.plan });
  assert.equal(outcome.filesMoved, 1);
  assert.equal(await repository.findContentByAdminId('SB-0000000002'), null);
  const target = await repository.findContentByAdminId('SB-0000000001');
  assert.equal(target.files.length, 2);
});

test('titlebatch detects duplicate with existing catalog post and offers merge', async () => {
  const repository = new MemoryCatalogRepository([
    {
      slug: 'card-1',
      title: 'Solo Leveling',
      category: 'anime',
      adminId: 'SB-0000000001',
      publishedAt: '2025-01-01T00:00:00.000Z',
      files: [{ name: 'Solo.Leveling.E01.mkv' }]
    },
    {
      slug: 'card-2',
      title: 'Old Title 2',
      category: 'anime',
      adminId: 'SB-0000000002',
      publishedAt: '2025-01-02T00:00:00.000Z',
      files: [{ name: 'Solo.Leveling.E02.mkv' }]
    },
    {
      slug: 'card-3',
      title: 'Old Title 3',
      category: 'anime',
      adminId: 'SB-0000000003',
      publishedAt: '2025-01-03T00:00:00.000Z',
      files: [{ name: 'Demon.Slayer.E01.mkv' }]
    }
  ]);
  const replies = [];
  const ctx = makeBatchContext(replies);

  const result = await applyBulkTitleEdits({
    ctx,
    repository,
    text: '/titlebatch SB-0000000002 Solo Leveling , SB-0000000003 Demon Slayer',
    commands: ['titlebatch', 'title'],
    force: true
  });

  assert.equal(result.handled, true);
  const pending = await repository.findMergePlan(100, 100);
  assert.ok(pending);
  assert.equal(pending.plan.targetAdminId, 'SB-0000000001');
  assert.equal(pending.plan.sources.length, 1);
  assert.equal(pending.plan.sources[0].adminId, 'SB-0000000002');

  const outcome = await applyMergePlan({ bot: ctx, repository, plan: pending.plan });
  assert.equal(outcome.filesMoved, 1);
  assert.equal(await repository.findContentByAdminId('SB-0000000002'), null);
  const target = await repository.findContentByAdminId('SB-0000000001');
  assert.equal(target.files.length, 2);
  const distinctCard = await repository.findContentByAdminId('SB-0000000003');
  assert.ok(distinctCard);
  assert.equal(distinctCard.title, 'Demon Slayer');
});

test('titlebatch --merge automatically merges duplicates without waiting for confirmation', async () => {
  const repository = new MemoryCatalogRepository([
    {
      slug: 'card-1',
      title: 'Old Title 1',
      category: 'anime',
      adminId: 'SB-0000000001',
      files: [{ name: 'Solo.Leveling.E01.mkv' }]
    },
    {
      slug: 'card-2',
      title: 'Old Title 2',
      category: 'anime',
      adminId: 'SB-0000000002',
      files: [{ name: 'Solo.Leveling.E02.mkv' }]
    }
  ]);
  const replies = [];
  const ctx = makeBatchContext(replies);

  const result = await applyBulkTitleEdits({
    ctx,
    repository,
    text: '/titlebatch --merge SB-0000000001 Solo Leveling , SB-0000000002 Solo Leveling',
    commands: ['titlebatch', 'title'],
    force: true
  });

  assert.equal(result.handled, true);
  assert.equal(await repository.findContentByAdminId('SB-0000000002'), null);
  const target = await repository.findContentByAdminId('SB-0000000001');
  assert.equal(target.files.length, 2);
  assert.ok(replies.some((r) => /Merged 1 post into SB-0000000001/.test(r.text)));
});

test('titlebatch detects multiple duplicate groups in one batch and merges all groups', async () => {
  const repository = new MemoryCatalogRepository([
    { slug: 'card-1', title: 'Old 1', category: 'anime', adminId: 'SB-0000000001', files: [{ name: 's1.mkv' }] },
    { slug: 'card-2', title: 'Old 2', category: 'anime', adminId: 'SB-0000000002', files: [{ name: 's2.mkv' }] },
    { slug: 'card-3', title: 'Old 3', category: 'anime', adminId: 'SB-0000000003', files: [{ name: 'b1.mkv' }] },
    { slug: 'card-4', title: 'Old 4', category: 'anime', adminId: 'SB-0000000004', files: [{ name: 'b2.mkv' }] }
  ]);
  const replies = [];
  const ctx = makeBatchContext(replies);

  const result = await applyBulkTitleEdits({
    ctx,
    repository,
    text: '/titlebatch SB-0000000001 Solo Leveling , SB-0000000002 Solo Leveling , SB-0000000003 Bleach , SB-0000000004 Bleach',
    commands: ['titlebatch', 'title'],
    force: true
  });

  assert.equal(result.handled, true);
  const pending = await repository.findMergePlan(100, 100);
  assert.ok(pending);
  assert.equal(pending.plan.groups.length, 2);

  const outcome = await applyMergePlan({ bot: ctx, repository, plan: pending.plan });
  assert.equal(outcome.filesMoved, 2);
  assert.equal(await repository.findContentByAdminId('SB-0000000002'), null);
  assert.equal(await repository.findContentByAdminId('SB-0000000004'), null);
  assert.equal((await repository.findContentByAdminId('SB-0000000001')).files.length, 2);
  assert.equal((await repository.findContentByAdminId('SB-0000000003')).files.length, 2);
});

