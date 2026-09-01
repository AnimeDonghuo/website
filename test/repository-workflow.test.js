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
  // A direct channel burst can retain a large episode run in one auto group.
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

test('memory repository updates published metadata by private post ID without changing its stable delivery identity', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Original title',
    category: 'movie',
    languages: ['English'],
    files: [{ storageMessageId: 20, name: 'original.mkv' }]
  });
  const updated = await repository.updateContentByAdminId(created.adminId, {
    title: 'Corrected title',
    year: 2026,
    languages: ['Hindi', 'English', 'hindi'],
    subtitleLanguages: ['English'],
    genres: ['Action', 'action'],
    description: 'Corrected synopsis',
    status: 'Updated',
    releaseLabel: 'Season 2',
    category: 'web-series'
  });
  assert.equal(updated.adminId, created.adminId);
  assert.equal(updated.slug, created.slug);
  assert.equal(updated.shareCode, created.shareCode);
  assert.equal(updated.title, 'Corrected title');
  assert.equal(updated.year, 2026);
  assert.deepEqual(updated.languages, ['Hindi', 'English']);
  assert.deepEqual(updated.subtitleLanguages, ['English']);
  assert.equal(updated.subtitleLanguageSource, 'manual');
  assert.deepEqual(updated.genres, ['Action']);
  assert.equal(updated.category, 'web-series');
  assert.equal(updated.art.tone, 'blue');
  assert.equal(updated.titleKey, 'corrected-title');
  assert.ok(updated.automationKeys.includes('original-title'));
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

test('category-scoped merge keys append to the matching same-title catalog card only', async () => {
  const repository = new MemoryCatalogRepository([]);
  const movie = await repository.createContent({
    title: 'Shared Release',
    category: 'movie',
    files: [{ storageMessageId: 10, name: 'Shared.Release.movie.mkv' }]
  });
  const series = await repository.createContent({
    title: 'Shared Release',
    category: 'web-series',
    files: [{ storageMessageId: 20, name: 'Shared.Release.S01E01.mkv' }]
  });

  const matchingSeries = await repository.findContentByMergeKey('shared-release', 'web-series');
  assert.equal(matchingSeries.adminId, series.adminId);
  const merged = await repository.appendFilesToContentByMergeKey(
    'shared-release',
    [{ storageMessageId: 21, name: 'Shared.Release.S01E02.mkv' }],
    [],
    'web-series'
  );

  assert.equal(merged.adminId, series.adminId);
  assert.equal(merged.filesCount, 2);
  assert.equal((await repository.findContentBySlug(movie.slug)).filesCount, 1);
  assert.equal((await repository.findContentBySlug(series.slug)).filesCount, 2);
});

test('memory repository persists login sessions, requests, announcement destinations, and auto-publish settings for its process lifetime', async () => {
  const repository = new MemoryCatalogRepository([]);
  const expiresAt = new Date(Date.now() + 60_000);
  await repository.createAdminSession({ chatId: 100, ownerId: 200, expiresAt });
  assert.ok(await repository.findAdminSession(100, 200));
  assert.deepEqual((await repository.listActiveAdminSessions()).map((session) => session.chatId), ['100']);
  await repository.startStreamImport({ chatId: 100, ownerId: 200, targetAdminId: 'SB-0123ABCDEF', expiresAt });
  assert.equal((await repository.findStreamImport(100, 200)).targetAdminId, 'SB-0123ABCDEF');
  await repository.deleteStreamImport(100, 200);
  assert.equal(await repository.findStreamImport(100, 200), null);

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

test('request selections support multi-request completed and rejected status changes', async () => {
  const repository = new MemoryCatalogRepository([]);
  const first = await repository.createRequest({ requestText: 'Perfect World', requester: { id: 301, first_name: 'First' } });
  const second = await repository.createRequest({ requestText: 'Soul Land', requester: { id: 302, first_name: 'Second' } });
  const third = await repository.createRequest({ requestText: 'A movie', requester: { id: 303, first_name: 'Third' } });

  await repository.startRequestSelection({ chatId: 100, ownerId: 200 });
  await repository.toggleRequestSelection(100, 200, first.id);
  await repository.toggleRequestSelection(100, 200, second.id);
  assert.deepEqual((await repository.findRequestSelection(100, 200)).requestIds.sort(), [first.id, second.id].sort());

  const completed = await repository.resolveRequests({
    requestIds: (await repository.findRequestSelection(100, 200)).requestIds,
    status: 'completed',
    resolvedBy: 200,
    resolvedAt: '2026-09-01T10:00:00.000Z'
  });
  assert.equal(completed.length, 2);
  assert.ok(completed.every((request) => request.status === 'completed' && request.resolvedBy === '200'));
  assert.deepEqual((await repository.listRequests()).map((request) => request.id), [third.id]);

  const rejected = await repository.resolveRequests({ requestIds: [third.id], status: 'rejected', resolvedBy: 200 });
  assert.equal(rejected[0].status, 'rejected');
  assert.equal((await repository.listRequests({ status: 'completed', limit: 10 })).length, 2);
  assert.equal((await repository.listRequests({ status: 'rejected', limit: 10 }))[0].id, third.id);
});

test('admin date windows and private analytics aggregate catalog, requests, bot users, and anonymous visits', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.createContent({
    title: 'Yesterday post', category: 'movie', files: [{ storageMessageId: 1 }], publishedAt: '2026-08-31T10:00:00.000Z'
  });
  await repository.createContent({
    title: 'Today post', category: 'donghua', files: [{ storageMessageId: 2, episode: { start: 1, end: 2 } }], publishedAt: '2026-09-01T10:00:00.000Z'
  });
  const today = await repository.listAdminContent({
    startAt: '2026-09-01T00:00:00.000Z',
    endAt: '2026-09-02T00:00:00.000Z',
    limit: 100
  });
  assert.deepEqual(today.map((post) => post.title), ['Today post']);

  const request = await repository.createRequest({ requestText: 'Requested title', requester: { id: 400 } });
  await repository.resolveRequests({ requestIds: [request.id], status: 'completed', resolvedBy: 200 });
  await repository.recordSiteVisit({ visitorId: 'anonymous-one', path: '/', visitedAt: '2026-09-01T11:00:00.000Z' });
  await repository.recordSiteVisit({ visitorId: 'anonymous-one', path: '/content/today-post', visitedAt: '2026-09-01T11:30:00.000Z' });
  await repository.recordSiteVisit({ visitorId: 'anonymous-two', path: '/', visitedAt: '2026-08-20T11:00:00.000Z' });
  await repository.recordBotUser({ id: 500, username: 'active_user', first_name: 'Active' }, { seenAt: '2026-09-01T11:00:00.000Z' });
  await repository.recordBotUser({ id: 501, username: 'older_user', first_name: 'Older' }, { seenAt: '2026-08-20T11:00:00.000Z' });

  const stats = await repository.getPublisherStats({ now: '2026-09-01T12:00:00.000Z' });
  assert.equal(stats.catalog.posts, 2);
  assert.equal(stats.catalog.files, 2);
  assert.equal(stats.catalog.episodes, 2);
  assert.equal(stats.catalog.deliveries, 0);
  assert.equal(stats.catalog.byCategory.donghua, 1);
  assert.deepEqual(stats.requests, { total: 1, open: 0, completed: 1, rejected: 0 });
  assert.equal(stats.site.visitors, 2);
  assert.equal(stats.site.visits, 3);
  assert.equal(stats.site.activeVisitors24h, 1);
  assert.equal(stats.site.visits24h, 2);
  assert.equal(stats.bot.users, 2);
  assert.equal(stats.bot.activeUsers24h, 1);
});
