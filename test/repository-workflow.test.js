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
  assert.equal((await repository.findContentByStorageMessageId(1)).slug, created.slug);
  assert.equal(await repository.findContentByStorageMessageId(999), null);

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

test('memory repository persists and atomically claims due automation groups', async () => {
  const repository = new MemoryCatalogRepository([]);
  const receivedAt = new Date().toISOString();
  const scheduledAt = new Date(Date.now() + 1_000).toISOString();
  const maxWaitAt = new Date(Date.now() + 5_000).toISOString();
  // A direct channel burst is not capped at the 100-message /batch safety
  // limit: all matching uploads persist in one auto group.
  for (let index = 1; index <= 101; index += 1) {
    await repository.queueAutomationSession({
      chatId: '-100123',
      ownerId: 'auto-storage-group-raakh',
      category: 'web-series',
      title: 'Raakh',
      file: {
        storageMessageId: 700 + index,
        name: `Raakh.S01E${String(index).padStart(2, '0')}.mkv`,
        episode: { start: index, end: index }
      },
      groupKey: 'raakh',
      scheduledAt,
      maxWaitAt,
      firstReceivedAt: receivedAt,
      receivedAt
    });
  }

  const due = await repository.listDueAutomationSessions({ now: new Date(Date.now() + 2_000).toISOString() });
  assert.equal(due.length, 1);
  assert.equal(due[0].files.length, 101);
  assert.equal(due[0].auto.groupKey, 'raakh');
  const claimed = await repository.claimAutomationSession('-100123', 'auto-storage-group-raakh', { now: new Date(Date.now() + 2_000).toISOString() });
  assert.equal(claimed.auto.status, 'publishing');
  assert.equal(await repository.claimAutomationSession('-100123', 'auto-storage-group-raakh', { now: new Date(Date.now() + 2_000).toISOString() }), null);
  const released = await repository.releaseAutomationClaims();
  assert.equal(released, 1);
  assert.equal((await repository.findSession('-100123', 'auto-storage-group-raakh')).auto.status, 'collecting');
  const reclaimed = await repository.claimAutomationSession('-100123', 'auto-storage-group-raakh', { now: new Date(Date.now() + 2_000).toISOString() });
  assert.equal(reclaimed.auto.status, 'publishing');
  await repository.markAutomationSessionFailed('-100123', 'auto-storage-group-raakh', { error: 'ImgBB unavailable' });
  assert.equal((await repository.findSession('-100123', 'auto-storage-group-raakh')).auto.lastError, 'ImgBB unavailable');
});

test('memory repository merges later files into a same-title content record without duplicates', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Cocktail 2',
    category: 'movie',
    files: [{ storageMessageId: 1, name: 'Cocktail.2.1080p.mkv' }],
    automationKey: 'cocktail-2'
  });
  const merged = await repository.appendFilesToContentByMergeKey('cocktail-2', [
    { storageMessageId: 1, name: 'Cocktail.2.1080p.mkv' },
    { storageMessageId: 2, name: 'Cocktail.2.720p.mkv' }
  ]);
  assert.equal(merged.adminId, created.adminId);
  assert.equal(merged.filesCount, 2);
  assert.deepEqual(merged.files.map((file) => file.storageMessageId), [1, 2]);
  assert.equal(merged.automationKey, 'cocktail-2');
});

test('memory repository persists login sessions, requests, announcement destinations, and auto-publish settings for its process lifetime', async () => {
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

  assert.equal((await repository.getAutoPublishSettings()).enabled, false);
  const autoPublish = await repository.setAutoPublishSettings({ enabled: true, updatedBy: 200 });
  assert.equal(autoPublish.enabled, true);
  assert.ok(autoPublish.enabledAt);
  assert.equal(autoPublish.updatedBy, '200');
  assert.equal((await repository.getAutoPublishSettings()).enabled, true);

  await repository.startSession({ chatId: 100, ownerId: 200, category: 'movie', title: 'Draft' });
  await repository.appendSessionFile(100, 200, { storageMessageId: 700 });
  assert.equal((await repository.findSessionByStorageMessageId(700)).title, 'Draft');

  await repository.deleteAdminSession(100, 200);
  assert.equal(await repository.findAdminSession(100, 200), null);
});
