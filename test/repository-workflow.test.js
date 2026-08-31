import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { toPublicContent } from '../src/server/index.js';

const config = { telegram: { botUsername: 'DeliveryBot' } };

test('catalog posts receive private admin IDs and safe episode index data', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Perfect World',
    category: 'donghua',
    files: [
      { storageMessageId: 1, telegramFileId: 'private-1', episode: { start: 1, end: 5, label: 'Episodes 01–05' } },
      { storageMessageId: 2, telegramFileId: 'private-2', episode: { start: 6, end: 10, label: 'Episodes 06–10' } }
    ]
  });

  assert.match(created.adminId, /^SB-[A-F0-9]{10}$/);
  const publicPost = toPublicContent(created, config);
  assert.equal(publicPost.episodeCount, 10);
  assert.deepEqual(publicPost.episodeGroups.map((group) => group.label), ['Episodes 01–05', 'Episodes 06–10']);
  assert.equal(publicPost.fileChoices.length, 2);
  assert.match(publicPost.fileChoices[0].telegramUrl, /^https:\/\/t\.me\/DeliveryBot\?start=file-/);
  assert.equal(publicPost.fileChoices[0].storageMessageId, undefined);
  assert.equal(publicPost.adminId, undefined);
  assert.equal(publicPost.files, undefined);

  const removed = await repository.deleteContentByAdminId(created.adminId);
  assert.equal(removed.slug, created.slug);
  assert.equal(await repository.findContentByShareCode(created.shareCode), null);
});

test('every uploaded file has a separate public Telegram choice', async () => {
  const repository = new MemoryCatalogRepository([]);
  const files = Array.from({ length: 101 }, (_, index) => ({
    storageMessageId: index + 1,
    telegramFileId: `private-${index + 1}`,
    name: `Release.Episode.${index + 1}.720p.mkv`,
    kind: 'video'
  }));
  const created = await repository.createContent({ title: 'Long release', category: 'anime', files });
  const publicPost = toPublicContent(created, config);

  assert.equal(publicPost.fileChoices.length, 101);
  assert.equal(publicPost.fileChoices.at(-1).position, 101);
  assert.match(publicPost.fileChoices.at(-1).telegramUrl, new RegExp(`file-${created.shareCode}-101$`));
  assert.equal(JSON.stringify(publicPost).includes('private-101'), false);
});

test('memory repository persists login sessions, requests and announcement destinations for its process lifetime', async () => {
  const repository = new MemoryCatalogRepository([]);
  const expiresAt = new Date(Date.now() + 60_000);
  await repository.createAdminSession({ chatId: 100, ownerId: 200, expiresAt });
  assert.ok(await repository.findAdminSession(100, 200));

  const request = await repository.createRequest({
    requestText: 'A requested series',
    requester: { id: 300, username: 'viewer', first_name: 'Viewer' }
  });
  assert.match(request.id, /^REQ-[A-F0-9]{10}$/);
  assert.equal((await repository.listRequests())[0].requestText, 'A requested series');

  await repository.addAnnouncementChannel({ channelId: '-100123', title: 'Release notices', addedBy: 200 });
  assert.equal((await repository.listAnnouncementChannels()).length, 1);
  assert.equal((await repository.removeAnnouncementChannel('-100123')).title, 'Release notices');
  await repository.deleteAdminSession(100, 200);
  assert.equal(await repository.findAdminSession(100, 200), null);
});
