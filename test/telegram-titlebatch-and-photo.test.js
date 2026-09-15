import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MongoCatalogRepository } from '../src/server/catalog.repository.js';
import { parseBulkPostEdits, editAnnouncementPhoto, applyBulkTitleEdits } from '../src/server/services/telegram-bot.js';

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
