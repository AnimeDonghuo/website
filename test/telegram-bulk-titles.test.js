import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import {
  announcementLaneDrained,
  applyBulkTitleEdits,
  parseBulkPostEdits,
  resetAnnouncementLane,
  tidyTypedTitle,
  updatePublishedPost
} from '../src/server/services/telegram-bot.js';

const BULK_COUNT = 36;

const seedCards = (count) => Array.from({ length: count }, (unused, index) => ({
  slug: `card-${index}`,
  title: `Old Title ${index}`,
  category: 'anime',
  year: 2024,
  adminId: `SB-${String(index).padStart(10, '0')}`,
  posterUrl: 'https://i.ibb.co/existing.png',
  announcementRefs: index === 0
    ? [{ channel: '@sora_releases', channelId: '-1001', messageId: 501, kind: 'photo', caption: 'Old Title 0' }]
    : []
}));

function makeContext(telegram = {}, replies = []) {
  return {
    chat: { id: -1001 },
    from: { id: 7, is_bot: false, username: 'publisher' },
    telegram: {
      editMessageMedia: async () => ({ message_id: 501 }),
      editMessageCaption: async () => ({ message_id: 501 }),
      editMessageText: async () => ({ message_id: 501 }),
      ...telegram
    },
    reply: async (text) => { replies.push(text); return { message_id: 900 + replies.length }; }
  };
}

async function waitFor(assertion, limit = 40) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (assertion()) return true;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  return assertion();
}

beforeEach(() => {
  resetAnnouncementLane();
});

test('a pasted block of one-line renames is read as one request', () => {
  const block = Array.from({ length: BULK_COUNT }, (unused, index) => `/title SB-${String(index).padStart(10, '0')} Title Number ${index}`).join('\n\n');
  const parsed = parseBulkPostEdits(block, { commands: ['title', 't', 'rename'] });
  assert.equal(parsed.entries.length, BULK_COUNT, 'every line became an edit, with no per-message limit to walk');
  assert.equal(parsed.invalid.length, 0);
  assert.deepEqual(parsed.entries.slice(0, 2).map((entry) => [entry.adminId, entry.value]), [
    ['SB-0000000000', 'Title Number 0'],
    ['SB-0000000001', 'Title Number 1']
  ]);
  assert.equal(parsed.replaced, 0);

  // The same list without the repeated prefix, because only the first line is a real command.
  const bare = Array.from({ length: 5 }, (unused, index) => `SB-${String(index).padStart(10, '0')} Title Number ${index}`).join('\n');
  assert.equal(parseBulkPostEdits(bare, { commands: ['title'] }).entries.length, 5);
  assert.equal(parseBulkPostEdits('/title SB-0000000000 First\ntitle SB-1111111111 Second', { commands: ['title', 't'] }).entries.length, 2);
  assert.equal(parseBulkPostEdits('/title SB-0000000000 First\nSB-0000000000 Second', { commands: ['title'] }).entries.length, 1, 'a card listed twice is edited once');
  assert.equal(parseBulkPostEdits('/title My draft title', { commands: ['title'] }).entries.length, 0, 'a draft title is not a published-post edit');
});

test('a line that cannot be a rename is said out loud instead of guessed', () => {
  const parsed = parseBulkPostEdits([
    '/title SB-0000000000 Good Line',
    '/title this one has no post id at all',
    '/title SB-1111111111',
    '/title SB-2222222222, SB-3333333333 One title for two cards',
    '/title'
  ].join('\n'), { commands: ['title'] });
  assert.deepEqual(parsed.entries.map((entry) => entry.adminId), ['SB-0000000000']);
  assert.deepEqual(parsed.invalid.map((entry) => entry.reason), [
    'no Post ID on that line',
    'no title after the post ID',
    '2 post IDs share one title; a title belongs to one release, so give each ID its own line',
    'no Post ID on that line'
  ]);
});

test('the last line for a card wins, and a title a human typed is not rewritten', () => {
  const repeated = parseBulkPostEdits('/title SB-0000000000 First guess\ntitle SB-0000000000 Final name', { commands: ['title', 't'] });
  assert.equal(repeated.entries.length, 1, 'one card is one edit, not two');
  assert.equal(repeated.entries[0].value, 'Final name');
  assert.equal(repeated.replaced, 1);

  assert.deepEqual(tidyTypedTitle('Vampires.Of.The.Velvet.Lounge.1080p.x264'), { title: 'Vampires Of The Velvet Lounge', changed: true });
  assert.deepEqual(tidyTypedTitle('Balan_The_Boy_[Etah].mkv'), { title: 'Balan The Boy', changed: true });
  assert.deepEqual(tidyTypedTitle('- Gold |'), { title: 'Gold', changed: true });
  for (const typed of ['Dr. No', 'O.R.Y.X', 'Despicable Me (2010)', 'Reacher Season 4', 'D E B S AKA DEBS', 'Our Hero, Balthazar', 'Top Gunner America vs Russia', 'Don\u2019t Say Good Luck']) {
    assert.deepEqual(tidyTypedTitle(typed), { title: typed, changed: false }, `a title someone chose is stored as written: ${typed}`);
  }
});

test('a bulk rename applies each title to its own card and never waits on the channel', async () => {
  const repository = new MemoryCatalogRepository(seedCards(4));
  const seen = [];
  let allowEdit = false;
  const telegram = {
    editMessageMedia: async () => {
      seen.push('called');
      // Bounded so a failed assertion cannot leave the lane spinning at the end of the run.
      for (let waited = 0; waited < 100 && !allowEdit; waited += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
      seen.push('media');
      return { message_id: 501 };
    }
  };
  const replies = [];
  const ctx = makeContext(telegram, replies);

  const result = await updatePublishedPost({
    ctx,
    repository,
    field: 'title',
    fieldLabel: 'Title',
    edits: [
      { adminId: 'SB-0000000000', value: 'Vampires Of The Velvet Lounge' },
      { adminId: 'SB-0000000001', value: 'Gold' },
      { adminId: 'SB-9999999999', value: 'Never Published' }
    ]
  });

  assert.equal(result.handled, true);
  assert.equal((await repository.findContentByAdminId('SB-0000000000')).title, 'Vampires Of The Velvet Lounge');
  assert.equal((await repository.findContentByAdminId('SB-0000000001')).title, 'Gold');
  assert.equal(seen.includes('media'), false, 'the rename answers while the channel edit is still open, so a slow channel cannot stall a title fix');
  assert.match(replies[0], /Title updated for 2 posts:/);
  assert.match(replies[0], /SB-0000000000 · Vampires Of The Velvet Lounge \u2014 was Old Title 0/);
  assert.match(replies[0], /SB-0000000001 · Gold/);
  assert.match(replies[0], /Not found and skipped: SB-9999999999/);
  assert.match(replies[0], /2 channel posts queued on the lane/);

  allowEdit = true;
  assert.equal(await waitFor(() => seen.includes('media')), true, 'the announcement is edited in place afterwards');
  await announcementLaneDrained();
});

test('a whole page of renames is applied line by line, and a tidied title says so', async () => {
  const repository = new MemoryCatalogRepository(seedCards(BULK_COUNT));
  const replies = [];
  const ctx = makeContext({}, replies);
  const parsed = parseBulkPostEdits(Array.from({ length: BULK_COUNT }, (unused, index) => `/title SB-${String(index).padStart(10, '0')} Renamed.card.${index < 10 ? '0' : ''}${index}`).join('\n'), { commands: ['title'] });
  assert.equal(parsed.entries.length, BULK_COUNT);
  const result = await updatePublishedPost({ ctx, repository, field: 'title', fieldLabel: 'Title', edits: parsed.entries });

  assert.equal(result.contents.length, BULK_COUNT, 'a long paste is not cut down to the first few');
  assert.equal((await repository.findContentByAdminId('SB-0000000035')).title, 'Renamed card 35');
  assert.equal((await repository.findContentByAdminId('SB-0000000000')).title, 'Renamed card 00');
  assert.match(replies.at(-1), new RegExp(`${BULK_COUNT} of those titles were tidied from the pasted text`));
  await announcementLaneDrained();
});

test('an unusable store or a lost card is reported rather than answered with silence', async () => {
  const replies = [];
  const ctx = makeContext({}, replies);
  const refused = await updatePublishedPost({
    ctx,
    repository: {},
    field: 'title',
    fieldLabel: 'Title',
    edits: [{ adminId: 'SB-0000000000', value: 'Gold' }]
  });
  assert.equal(refused.handled, true);
  assert.match(replies[0], /not available in this catalog store/);

  const missingReplies = [];
  const missing = await updatePublishedPost({
    ctx: makeContext({}, missingReplies),
    repository: { findContentByAdminId: async () => null, updateContentByAdminId: async () => null },
    field: 'title',
    fieldLabel: 'Title',
    edits: [{ adminId: 'SB-0000000000', value: 'Gold' }]
  });
  assert.equal(missing.content, null);
  assert.match(missingReplies[0], /No published catalog post was found for SB-0000000000/);
});

test('the command knows a batch rename when it sees one, and steps aside otherwise', async () => {
  const repository = new MemoryCatalogRepository(seedCards(3));
  const replies = [];
  const ctx = makeContext({}, replies);
  assert.equal(await applyBulkTitleEdits({ ctx, repository, text: '/title My draft title' }), false, 'a draft title is still the ordinary flow');
  assert.equal(await applyBulkTitleEdits({ ctx, repository, text: '/title SB-0000000001 One fine title' }), false, 'one line still gets the exact single-post reply');
  assert.equal((await repository.findContentByAdminId('SB-0000000001')).title, 'Old Title 1');

  const block = [
    '/title SB-0000000000 Vampires Of The Velvet Lounge',
    '/title SB-0000000001 Gold',
    '/title SB-0000000002 Oculus',
    '/title a line with no id'
  ].join('\n');
  const result = await applyBulkTitleEdits({ ctx, repository, text: block });
  assert.equal(result.handled, true);
  assert.equal((await repository.findContentByAdminId('SB-0000000000')).title, 'Vampires Of The Velvet Lounge');
  assert.equal((await repository.findContentByAdminId('SB-0000000002')).title, 'Oculus');
  assert.match(replies.at(-1), /1 line was left out because it makes no sense as a rename/);
  assert.match(replies.at(-1), /a line with no id — no Post ID on that line/);
  await announcementLaneDrained();
});
