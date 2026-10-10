import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, toPublicContent } from '../src/server/index.js';
import { MemoryCatalogRepository, MongoCatalogRepository } from '../src/server/catalog.repository.js';
import {
  buildTelegramPlayerApiUrl,
  normalizePlayerApiBaseUrl,
  normalizePlayerApiQuality,
  normalizePlayerApiSettings,
  playerApiFrameSources
} from '../src/server/services/player-api-service.js';
import { getPlayerIframeUrl, getProtectedPlaybackTarget } from '../src/client/watch-utils.js';
import {
  clearPublisherSessionCache,
  handlePlayerApiCommand,
  PUBLISHER_COMMANDS,
  parsePlayerApiCommand
} from '../src/server/services/telegram-bot.js';
import { loadConfig } from '../src/server/config.js';

test('player API settings normalize quality labels and endpoint prefixes', () => {
  assert.equal(normalizePlayerApiQuality('720p'), '720P');
  assert.equal(normalizePlayerApiQuality('4k'), '4K');
  assert.equal(normalizePlayerApiBaseUrl('http://node2-it.botkeep.cloud:30172/'), 'http://node2-it.botkeep.cloud:30172');
  assert.equal(normalizePlayerApiBaseUrl('https://player.example/embed/'), 'https://player.example/embed');
  assert.equal(normalizePlayerApiBaseUrl('javascript:alert(1)'), null);
  assert.equal(normalizePlayerApiBaseUrl('https://user:secret@player.example/'), null);
  assert.equal(normalizePlayerApiBaseUrl('https://player.example/?token=x'), null);
  assert.deepEqual(normalizePlayerApiSettings({ '720p': 'https://720.example/', 'bad key/': 'https://bad.example', '480p': 'file:///tmp/player' }), {
    '720P': 'https://720.example'
  });
});

test('player API URL follows the Telegram-post path format and exposes only configured origins to CSP', () => {
  const apis = { '720p': 'http://node2-it.botkeep.cloud:30172/' };
  assert.equal(
    buildTelegramPlayerApiUrl(apis, '720P', 'https://t.me/c/2617067511/25962'),
    'http://node2-it.botkeep.cloud:30172/https://t.me/c/2617067511/25962'
  );
  assert.equal(buildTelegramPlayerApiUrl(apis, '1080p', 'https://t.me/c/2617067511/25962'), null);
  assert.equal(buildTelegramPlayerApiUrl(apis, '720p', 'https://t.me/example/25962'), null);
  assert.deepEqual(playerApiFrameSources({
    '720p': 'https://node2.example:30172/',
    '1080p': 'https://node2.example:30172/another-prefix',
    '480p': 'http://legacy.example:8080/'
  }), ['https://node2.example:30172', 'http://legacy.example:8080']);
});

test('Telegram command supports list, set, show, and remove forms', () => {
  assert.deepEqual(parsePlayerApiCommand(''), { action: 'list' });
  assert.deepEqual(parsePlayerApiCommand('720p http://node2-it.botkeep.cloud:30172/'), {
    action: 'set', quality: '720P', url: 'http://node2-it.botkeep.cloud:30172'
  });
  assert.deepEqual(parsePlayerApiCommand('1080p'), { action: 'show', quality: '1080P' });
  assert.deepEqual(parsePlayerApiCommand('remove 480p'), { action: 'remove', quality: '480P' });
  assert.deepEqual(parsePlayerApiCommand('480p off'), { action: 'remove', quality: '480P' });
  assert.ok(parsePlayerApiCommand('720p javascript:alert(1)').error);
  assert.ok(PUBLISHER_COMMANDS.some((item) => item.command === 'playerapi'));
});

test('publisher can set and remove a player API and it is saved to database-backed settings', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.createAdminSession({ chatId: 'player-api-chat', ownerId: '123456789', expiresAt: Date.now() + 60_000 });
  const config = loadConfig({
    ADMIN_LOGIN_CODE: 'player-api-test-pass',
    TELEGRAM_ADMIN_IDS: '123456789'
  });
  const replies = [];
  const ctx = {
    from: { id: '123456789' },
    chat: { id: 'player-api-chat' },
    message: { text: '/playerapi 720p http://node2-it.botkeep.cloud:30172/' },
    async reply(text) { replies.push(text); }
  };

  try {
    clearPublisherSessionCache();
    await handlePlayerApiCommand(ctx, repository, config);
    assert.deepEqual((await repository.getPlayerApiSettings()).apis, {
      '720P': 'http://node2-it.botkeep.cloud:30172'
    });
    assert.equal(config.playback.playerApis['720P'], 'http://node2-it.botkeep.cloud:30172');
    assert.match(replies[0], /Saved: 720P/);
    assert.match(replies[0], /browsers may block the player frame/);

    const backup = await repository.exportBackupData();
    const restored = new MemoryCatalogRepository([]);
    await restored.restoreBackupData(backup);
    assert.deepEqual((await restored.getPlayerApiSettings()).apis, {
      '720P': 'http://node2-it.botkeep.cloud:30172'
    });

    ctx.message.text = '/playerapi remove 720p';
    await handlePlayerApiCommand(ctx, repository, config);
    assert.deepEqual((await repository.getPlayerApiSettings()).apis, {});
    assert.deepEqual(config.playback.playerApis, {});
    assert.match(replies[1], /Removed the 720P player API/);
  } finally {
    clearPublisherSessionCache();
  }
});

test('Mongo repository stores normalized player API settings in automation settings', async () => {
  const documents = new Map();
  const automationSettings = {
    async findOne({ _id }) { return documents.get(_id) || null; },
    async updateOne({ _id }, { $set }) { documents.set(_id, { _id, ...$set }); }
  };
  const db = { collection: () => automationSettings };
  const repository = new MongoCatalogRepository({ close: async () => {} }, db);

  assert.deepEqual((await repository.getPlayerApiSettings()).apis, {});
  const saved = await repository.setPlayerApiSettings({ '720p': 'https://player.example/' }, 'admin-1');
  assert.deepEqual(saved.apis, { '720P': 'https://player.example' });
  assert.deepEqual((await repository.getPlayerApiSettings()).apis, { '720P': 'https://player.example' });
  assert.equal(documents.get('player-api-settings').updatedBy, 'admin-1');
});

test('quality selector uses a matching API URL and keeps Koyeb as fallback for unmapped qualities', () => {
  const content = {
    id: 'player-api-test',
    slug: 'player-api-test',
    title: 'Player API test',
    category: 'movie',
    shareCode: 'player-api-test',
    hasDelivery: true,
    files: [
      { storageMessageId: 101, storageChannelId: '-1002617067511', name: 'Test.Movie.480p.mkv', kind: 'video', size: 500 },
      { storageMessageId: 102, storageChannelId: '-1002617067511', name: 'Test.Movie.720p.mkv', kind: 'video', size: 700 },
      { storageMessageId: 103, storageChannelId: '-1002617067511', name: 'Test.Movie.1080p.mkv', kind: 'video', size: 1_000 }
    ]
  };
  const config = {
    telegram: { botUsername: 'TestDeliveryBot', storageChannelId: '-1002617067511' },
    playback: {
      playerOrigin: 'https://koyeb-player.example',
      playerApis: {
        '720p': 'https://node2-it.botkeep.cloud:30172/',
        '1080p': 'https://1080-player.example/'
      }
    },
    streaming: {}
  };
  const record = toPublicContent(content, config);
  const entry = record.stream.entries[0];
  const qualityOptions = entry.qualities;
  assert.deepEqual(qualityOptions.map((option) => option.quality), ['480P', '720P', '1080P']);
  assert.equal(qualityOptions[0].playerApiUrl, undefined);
  assert.equal(qualityOptions[1].playerApiUrl, 'https://node2-it.botkeep.cloud:30172/https://t.me/c/2617067511/102');
  assert.equal(qualityOptions[2].playerApiUrl, 'https://1080-player.example/https://t.me/c/2617067511/103');

  const customTarget = getProtectedPlaybackTarget(entry, { selectedQuality: '720P' });
  assert.equal(customTarget.type, 'player-api');
  assert.equal(getPlayerIframeUrl(customTarget), qualityOptions[1].playerApiUrl);

  const fallbackTarget = getProtectedPlaybackTarget(entry, { selectedQuality: '480P' });
  assert.equal(fallbackTarget.type, 'url');
  const fallbackUrl = new URL(getPlayerIframeUrl(fallbackTarget, { origin: config.playback.playerOrigin }));
  assert.equal(fallbackUrl.origin, 'https://koyeb-player.example');
  assert.equal(fallbackUrl.pathname, '/watch');
  assert.equal(fallbackUrl.searchParams.get('url'), 'https://t.me/c/2617067511/101');
});

test('frame policy picks up a player API added after the Express app starts', async () => {
  const config = loadConfig({});
  config.playback.playerApis = {};
  const app = createApp({ config, repository: new MemoryCatalogRepository([]), distPath: '/missing-player-api-test-dist' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    config.playback.playerApis = { '720p': 'https://live-added-player.example:9443/' };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-src[^;]*https:\/\/live-added-player\.example:9443/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
