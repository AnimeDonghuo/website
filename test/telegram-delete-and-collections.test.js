import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, test } from 'node:test';

import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import {
  announcementLaneDrained,
  queueAnnouncementDeletion,
  resetAnnouncementLane,
  updatePublishedPost
} from '../src/server/services/telegram-bot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const botSource = readFileSync(join(root, 'src/server/services/telegram-bot.js'), 'utf8');

function makeContext(telegram = {}, replies = []) {
  return {
    chat: { id: -1001 },
    from: { id: 7, is_bot: false, username: 'publisher' },
    telegram: {
      editMessageMedia: async () => ({ message_id: 501 }),
      editMessageCaption: async () => ({ message_id: 501 }),
      editMessageText: async () => ({ message_id: 501 }),
      deleteMessage: async (chatId, messageId) => {
        calls.push({ chatId, messageId });
        return true;
      },
      ...telegram
    },
    reply: async (text) => { replies.push(text); return { message_id: 900 + replies.length }; }
  };
}

const calls = [];

function repositoryWith(cards) {
  return new MemoryCatalogRepository(cards.map((card) => ({
    slug: card.slug,
    title: card.title,
    category: 'movie',
    files: [{ name: `${card.slug}.1080p.mkv` }],
    ...card
  })));
}

beforeEach(() => {
  resetAnnouncementLane();
  calls.length = 0;
});

test('deleting a card takes its announcement out of the channel too', async () => {
  const repository = await repositoryWith([
    {
      slug: 'iron-man',
      title: 'Iron Man',
      announcementRefs: [
        { channel: '@sora_releases', channelId: '-10011', messageId: 501, kind: 'photo', caption: 'Iron Man' },
        { channel: '@sora_box', channelId: '-10022', messageId: 777, kind: 'photo', caption: 'Iron Man' }
      ]
    },
    { slug: 'never-announced', title: 'Never Announced' }
  ]);
  await repository.init();
  const [doomed] = (await repository.listContent({ limit: 10 })).filter((item) => item.title === 'Iron Man');
  const references = doomed.announcementRefs;
  assert.equal(references.length, 2);

  // This is what /delete does with every card it removes.
  queueAnnouncementDeletion({ telegram: makeContext().telegram, repository: null, content: doomed, references });
  await announcementLaneDrained();

  assert.deepEqual(
    calls.map((call) => `${call.chatId}:${call.messageId}`).sort(),
    ['-10011:501', '-10022:777'].sort(),
    'each posted copy of the announcement is deleted, one message at a time, in every channel it went to'
  );
});

test('a refused deletion is retried instead of leaving the announcement standing', async () => {
  const repository = await repositoryWith([{ slug: 'iron-man', title: 'Iron Man' }]);
  await repository.init();
  const [card] = await repository.listContent({ limit: 1 });
  assert.ok(card, 'the store handed back the card to delete');
  const content = { ...card, announcementRefs: [{ channel: '@sora_releases', channelId: '-10011', messageId: 501, kind: 'photo' }] };
  let attempt = 0;
  const telegram = {
    deleteMessage: async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('Too Many Requests');
        error.parameters = { retry_after: 0 };
        throw error;
      }
      calls.push({ messageId: 501 });
      return true;
    }
  };

  queueAnnouncementDeletion({ telegram, repository: null, content, references: content.announcementRefs });
  await announcementLaneDrained();
  for (let tick = 0; tick < 60 && !calls.length; tick += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });

  assert.equal(calls.length, 1, 'a rate-limited deletion comes back for the copy rather than forgetting it');
});

test('/delete asks for the announcements of every card it removed, and says so', () => {
  const start = botSource.indexOf("bot.command('delete'");
  assert.notEqual(start, -1);
  const block = botSource.slice(start, botSource.indexOf("\n  bot.", start + 10));
  assert.match(block, /queueAnnouncementDeletion\(/, 'a removed card hands its channel copies to the lane');
  assert.match(block, /announcementRefs/, 'from the references the card was posted with');
  assert.match(block, /channel announcement/, 'and the reply tells the publisher the copies went too');
  // Cards that were never announced must not be reported as channel deletions.
  assert.match(block, /never announced/);
});

test('a collection set by hand is stored, shown on the announcement, and survives a rename', async () => {
  const repository = await repositoryWith([
    { slug: 'iron-man-2', title: 'Iron Man 2' },
    { slug: 'iron-man-3', title: 'Iron Man 3' }
  ]);
  await repository.init();
  const [second, third] = await repository.listContent({ limit: 2 });
  const replies = [];
  const ctx = makeContext({}, replies);

  const set = await updatePublishedPost({
    ctx,
    repository,
    argument: `${second.adminId}, ${third.adminId} Marvel Saga`,
    field: 'collection',
    fieldLabel: 'Collection'
  });
  assert.equal(set.handled, true);
  const storedSecond = await repository.findContentByAdminId(second.adminId);
  const storedThird = await repository.findContentByAdminId(third.adminId);
  assert.equal(storedSecond.collection.name, 'Marvel Saga', 'one command names the group for both posts');
  assert.equal(storedThird.collection.name, 'Marvel Saga');
  assert.equal(storedSecond.collectionManual, true);
  assert.notEqual(storedSecond.collection.key, 'iron-man', 'and the derived group is not used');

  const renamed = await updatePublishedPost({
    ctx,
    repository,
    argument: `${second.adminId} Iron Man: Revived`,
    field: 'title',
    fieldLabel: 'Title'
  });
  assert.equal(renamed.handled, true);
  const afterRename = await repository.findContentByAdminId(second.adminId);
  assert.equal(afterRename.title, 'Iron Man: Revived');
  assert.equal(afterRename.collection.name, 'Marvel Saga', '/title never undoes a collection someone set');

  const cleared = await updatePublishedPost({
    ctx,
    repository,
    argument: `${second.adminId} none`,
    field: 'collection',
    fieldLabel: 'Collection'
  });
  assert.equal(cleared.handled, true);
  assert.equal((await repository.findContentByAdminId(second.adminId)).collection, null);
  const afterClear = await updatePublishedPost({
    ctx,
    repository,
    argument: `${second.adminId} Iron Man 4`,
    field: 'title',
    fieldLabel: 'Title'
  });
  assert.equal(afterClear.handled, true);
  assert.equal(
    (await repository.findContentByAdminId(second.adminId)).collection,
    null,
    'a card taken out of its group by hand stays out, even though its new title looks like a sequel'
  );
});

test('/collection explains the automatic case instead of demanding a name', () => {
  const start = botSource.indexOf("bot.command('collection'");
  assert.notEqual(start, -1, 'publishers need a way to name a group, and to refuse one');
  const block = botSource.slice(start, botSource.indexOf("\n  bot.", start + 10));
  assert.match(block, /field: 'collection'/);
  assert.match(block, /\/repair go/, 'the help has to mention the backfill, or every card published before this waits for a rename');
  assert.match(block, /two different titles/, 'and that a group of one is not shown as a collection');
  assert.match(block, /18\+/, 'and that adult cards are never grouped');
});
