import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { createApp } from '../src/server/index.js';
import {
  PosterRateLimitError,
  addPosterApiKey,
  clearPosterUploadCache,
  configurePosterKeys,
  configurePosterUploadOptions,
  getAllPosterKeyStats,
  getNoImageFoundPosterPng,
  getSharedFallbackPosterUrl,
  hostPosterImage,
  isPosterRateLimit,
  posterKeyPoolStatus,
  preparePosterImage,
  removePosterApiKey,
  resetPosterUploadPace,
  setSharedFallbackPosterUrl,
  uploadImageToImgBB
} from '../src/server/services/poster-service.js';
import {
  handleAddImgApiCommand,
  handleImgApisCommand,
  handleMaintenanceAction,
  handleMaintenanceCommand,
  handleRemoveImgApiCommand,
  handleRestartCommand,
  maskApiKey
} from '../src/server/services/telegram-bot.js';

const originalFetch = globalThis.fetch;

const reply = (body, { ok = true, status = 200, headers = {} } = {}) => ({
  ok,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body
});

const accepted = (name) => reply({
  success: true,
  data: {
    url: `https://i.ibb.co/x/${name}.png`,
    display_url: `https://i.ibb.co/y/${name}.png`,
    id: name
  }
});

test('ImgBB auto-rotation cycles through keys when rate limited and remembers the working one', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['key-1', 'key-2', 'key-3']);
  configurePosterUploadOptions({
    spacingMs: 0,
    attempts: 3,
    backoffMs: 1_000,
    wait: async () => {},
    now: () => 1_000
  });

  const calls = [];
  globalThis.fetch = async (url, options) => {
    const key = options?.body?.get('key');
    calls.push(key);
    if (key === 'key-1' || key === 'key-2') {
      return reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429 });
    }
    return accepted('hosted-artwork');
  };

  const hosted = await uploadImageToImgBB({
    buffer: Buffer.from('distinct image bytes 1'),
    title: 'Solo Leveling'
  });

  assert.equal(hosted.url, 'https://i.ibb.co/y/hosted-artwork.png');
  assert.deepEqual(calls, ['key-1', 'key-2', 'key-3'], 'rotated from key-1 to key-2 and then to key-3 on refusal');

  let stats = getAllPosterKeyStats();
  const k1 = stats.find((s) => s.key === 'key-1');
  const k2 = stats.find((s) => s.key === 'key-2');
  const k3 = stats.find((s) => s.key === 'key-3');
  assert.equal(k1.refusals, 1);
  assert.equal(k1.isCooling, true);
  assert.equal(k2.refusals, 1);
  assert.equal(k2.isCooling, true);
  assert.equal(k3.uploads, 1);
  assert.equal(k3.isCooling, false);
  assert.equal(k3.isSticky, true);

  // Next upload uses sticky key-3 without touching cooling key-1 or key-2
  calls.length = 0;
  await uploadImageToImgBB({
    buffer: Buffer.from('distinct image bytes 2'),
    title: 'Solo Leveling 2'
  });
  assert.deepEqual(calls, ['key-3'], 'healthy key-3 was kept as sticky');
  stats = getAllPosterKeyStats();
  assert.equal(stats.find((s) => s.key === 'key-3').uploads, 2);
});

test('when all ImgBB keys are rate-limited, it defers with at least 1 hour wait for the queue', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['busy-a', 'busy-b']);
  configurePosterUploadOptions({
    spacingMs: 0,
    attempts: 2,
    backoffMs: 1_000,
    wait: async () => {},
    now: () => 1_000
  });

  const calls = [];
  globalThis.fetch = async (url, options) => {
    const key = options?.body?.get('key');
    calls.push(key);
    return reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429 });
  };

  await assert.rejects(
    () => uploadImageToImgBB({ buffer: Buffer.from('bytes for busy test'), title: 'Naruto' }),
    (error) => {
      assert.equal(isPosterRateLimit(error), true);
      assert.equal(error.allKeysCooling, true);
      assert.equal(error.poolSize, 2);
      assert.ok(error.retryAfterMs >= 3_600_000, `Expected >= 1 hour (3600000ms), got ${error.retryAfterMs}`);
      return true;
    }
  );
  assert.equal(calls.length, 2);
});

test('missing image produces single "No Image Found" artwork, hosted once and reused for all titles without an image', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['key-single']);
  configurePosterUploadOptions({
    spacingMs: 0,
    attempts: 1,
    backoffMs: 1_000,
    wait: async () => {},
    now: () => 1_000
  });

  const repository = new MemoryCatalogRepository([]);

  // First item with no image
  const firstPrep = await preparePosterImage({ sourceUrl: null, title: 'Mystery Movie 1', category: 'movie' });
  assert.equal(firstPrep.usedFallback, true);
  assert.equal(firstPrep.isNoImageFallback, true);
  assert.deepEqual(firstPrep.buffer, getNoImageFoundPosterPng(), 'uses shared "No Image Found" buffer');

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return accepted('no-image-found-hosted');
  };

  const firstHosted = await hostPosterImage({
    image: firstPrep,
    title: 'Mystery Movie 1',
    config: { imgbbApiKey: 'key-single' },
    repository
  });
  assert.equal(fetchCalls, 1, 'uploaded once to ImgBB');
  assert.equal(firstHosted.url, 'https://i.ibb.co/y/no-image-found-hosted.png');
  assert.equal(getSharedFallbackPosterUrl(), 'https://i.ibb.co/y/no-image-found-hosted.png');
  assert.equal(await repository.getFallbackPosterUrl(), 'https://i.ibb.co/y/no-image-found-hosted.png');

  // Second item with no image: completely different title and category!
  const secondPrep = await preparePosterImage({ sourceUrl: null, title: 'Completely Different Anime', category: 'anime' });
  assert.equal(secondPrep.usedFallback, true);
  assert.equal(secondPrep.isNoImageFallback, true);

  const secondHosted = await hostPosterImage({
    image: secondPrep,
    title: 'Completely Different Anime',
    config: { imgbbApiKey: 'key-single' },
    repository
  });

  assert.equal(fetchCalls, 1, 'ZERO new upload calls were made to ImgBB!');
  assert.equal(secondHosted.url, firstHosted.url, 'reused the exact same hosted ImgBB URL');
  assert.equal(secondHosted.cached, true);
});

test('dynamically adding and removing ImgBB API keys updates the active pool and survives repository operations', async () => {
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['initial-key']);

  const repository = new MemoryCatalogRepository([]);
  assert.equal(await repository.getPosterApiKeys().then((k) => k.length), 0);

  // Add key to repository & pool
  await repository.addPosterApiKey('key-from-bot', '12345');
  addPosterApiKey('key-from-bot');

  const keys = await repository.getPosterApiKeys();
  assert.deepEqual(keys, ['key-from-bot']);
  assert.equal(posterKeyPoolStatus().configured, 2);

  // Record an upload
  await repository.recordPosterUpload('key-from-bot');
  const stats = await repository.getPosterKeyStats();
  assert.equal(stats['key-from-bot'].uploads, 1);

  // Remove key
  await repository.removePosterApiKey('key-from-bot');
  removePosterApiKey('key-from-bot');
  assert.equal(await repository.getPosterApiKeys().then((k) => k.length), 0);
  assert.equal(posterKeyPoolStatus().configured, 1);
});

test('maintenance mode returns 404 with exact notice message on all site routes and reverts with no data loss when disabled', async (t) => {
  const repository = new MemoryCatalogRepository([]);
  await repository.createContent({
    title: 'Important Saved Content',
    category: 'movie',
    files: [{ name: 'file.mkv' }]
  });

  const app = createApp({
    config: {
      environment: 'test',
      siteUrl: 'https://sorabox.test',
      streaming: {},
      telegram: { botUsername: 'TestBot' }
    },
    repository,
    distPath: '/tmp/sorabox-no-static-files'
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Initially maintenance is OFF
  assert.equal(await repository.isMaintenanceActive(), false);
  const onlineResponse = await originalFetch(`${baseUrl}/api/content`);
  assert.equal(onlineResponse.status, 200);

  // Turn maintenance ON
  await repository.setMaintenanceSettings({ enabled: true, updatedBy: 'admin-1' });
  assert.equal(await repository.isMaintenanceActive(), true);

  // 1. HTML request to website
  const htmlResponse = await originalFetch(`${baseUrl}/`, { headers: { accept: 'text/html' } });
  assert.equal(htmlResponse.status, 404);
  const htmlBody = await htmlResponse.text();
  assert.ok(htmlBody.includes('site is under maintenance and will soon be active till then kindly join our tg channel https://t.me/Sora_Box'));
  assert.ok(htmlBody.includes('https://t.me/Sora_Box'));

  // 2. API request
  const apiResponse = await originalFetch(`${baseUrl}/api/content`);
  assert.equal(apiResponse.status, 404);
  const apiJson = await apiResponse.json();
  assert.equal(apiJson.error, 'site is under maintenance and will soon be active till then kindly join our tg channel https://t.me/Sora_Box');

  // 3. Health check still responds 200 with maintenance: true so orchestrator probes pass
  const healthResponse = await originalFetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const healthJson = await healthResponse.json();
  assert.equal(healthJson.maintenance, true);

  // Turn maintenance OFF
  await repository.setMaintenanceSettings({ enabled: false, updatedBy: 'admin-1' });
  assert.equal(await repository.isMaintenanceActive(), false);

  // Site is back online without any data loss!
  const restoredResponse = await originalFetch(`${baseUrl}/api/content`);
  assert.equal(restoredResponse.status, 200);
  const restoredData = await restoredResponse.json();
  assert.equal(restoredData.items.length, 1);
  assert.equal(restoredData.items[0].title, 'Important Saved Content');
});

test('Telegram bot /imgapis, /addimgapi, /removeimgapi, /maintanence and /restart commands work properly', async () => {
  const repository = new MemoryCatalogRepository([]);
  const config = {
    telegram: { adminIds: new Set(['123']) },
    adminLoginCode: 'secret-pass',
    imgbbApiKey: 'first-key-12345678',
    imgbbApiKeys: ['first-key-12345678']
  };
  configurePosterKeys(['first-key-12345678']);

  // Create active admin session for user 123
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  const replies = [];
  const ctx = {
    chat: { id: 123 },
    from: { id: 123 },
    message: { text: '' },
    reply: async (text, markup) => replies.push({ text, markup }),
    answerCbQuery: async () => {},
    editMessageText: async (text, markup) => replies.push({ text, markup })
  };

  // 1. /imgapis command
  replies.length = 0;
  await handleImgApisCommand(ctx, repository, config);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('ImgBB API Keys & Rotation Pool'));
  assert.ok(replies[0].text.includes('firs...5678'));

  // 2. /addimgapi command
  replies.length = 0;
  ctx.message.text = '/addimgapi second-key-99999999, third-key-88888888';
  await handleAddImgApiCommand(ctx, repository, config);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('Added 2 ImgBB API keys'));

  // Verify keys were saved to repository and pool
  const savedKeys = await repository.getPosterApiKeys();
  assert.ok(savedKeys.includes('second-key-99999999'));
  assert.ok(savedKeys.includes('third-key-88888888'));
  assert.equal(posterKeyPoolStatus().configured, 3);

  // 3. /removeimgapi command
  replies.length = 0;
  ctx.message.text = '/removeimgapi third-key-88888888';
  await handleRemoveImgApiCommand(ctx, repository, config);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('Removed ImgBB API key'));
  const remainingKeys = await repository.getPosterApiKeys();
  assert.ok(!remainingKeys.includes('third-key-88888888'));

  // 4. /maintanence command
  replies.length = 0;
  await handleMaintenanceCommand(ctx, repository, config);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('Website Maintenance Mode'));
  assert.ok(replies[0].text.includes('OFF (Site Online)'));
  assert.ok(replies[0].markup); // has inline buttons

  // 5. Action maint:on
  replies.length = 0;
  await handleMaintenanceAction(ctx, repository, config, 'maint:on');
  assert.equal(await repository.isMaintenanceActive(), true);
  assert.ok(replies[0].text.includes('ON (Maintenance Active)'));

  // 6. Action maint:off
  replies.length = 0;
  await handleMaintenanceAction(ctx, repository, config, 'maint:off');
  assert.equal(await repository.isMaintenanceActive(), false);
  assert.ok(replies[0].text.includes('OFF (Site Online)'));

  // 7. /restart command
  let restarted = false;
  replies.length = 0;
  await handleRestartCommand(ctx, repository, config, async () => { restarted = true; });
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes('Restarting SoraBox service now'));
  assert.equal(restarted, true);
});
