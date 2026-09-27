import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLowestQualityTelegramStreamEntries,
  mergeContentStreamWithTelegramFiles
} from '../src/server/services/streaming-service.js';
import { toPublicContent } from '../src/server/index.js';
import {
  applyMergePlan,
  clearPublisherSessionCache,
  resolveMergePlan,
  parseMergeCommand
} from '../src/server/services/telegram-bot.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';

test('deriveLowestQualityTelegramStreamEntries selects lowest quality for standalone movie', () => {
  const content = {
    category: 'movie',
    files: [
      { storageMessageId: 101, name: 'Epic.Movie.2024.1080p.WEBRip.mkv', size: 2_500_000_000 },
      { storageMessageId: 102, name: 'Epic.Movie.2024.720p.WEBRip.mkv', size: 1_200_000_000 },
      { storageMessageId: 103, name: 'Epic.Movie.2024.480p.WEBRip.mkv', size: 600_000_000 }
    ]
  };
  const config = {
    telegram: { storageChannelId: '-1002617067511' }
  };

  const entries = deriveLowestQualityTelegramStreamEntries(content, config);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].embedUrl, 'https://t.me/c/2617067511/103');
  assert.equal(entries[0].provider, 'Telegram');
});

test('deriveLowestQualityTelegramStreamEntries falls back to 1080p if only single quality exists', () => {
  const content = {
    category: 'movie',
    files: [
      { storageMessageId: 201, name: 'Epic.Movie.2024.1080p.WEBRip.mkv', size: 2_500_000_000 }
    ]
  };
  const config = {
    telegram: { storageChannelId: '-1002617067511' }
  };

  const entries = deriveLowestQualityTelegramStreamEntries(content, config);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].embedUrl, 'https://t.me/c/2617067511/201');
});

test('deriveLowestQualityTelegramStreamEntries respects adult storage channel for adult content', () => {
  const content = {
    category: 'adult',
    files: [
      { storageMessageId: 301, name: 'Adult.Special.1080p.mp4', size: 1_800_000_000 },
      { storageMessageId: 302, name: 'Adult.Special.480p.mp4', size: 450_000_000 }
    ]
  };
  const config = {
    telegram: {
      storageChannelId: '-1002617067511',
      adultStorageChannelId: '-1002999888777'
    }
  };

  const entries = deriveLowestQualityTelegramStreamEntries(content, config);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].embedUrl, 'https://t.me/c/2999888777/302');
});

test('deriveLowestQualityTelegramStreamEntries separates episodic content and picks lowest quality per episode', () => {
  const content = {
    category: 'anime',
    episodeCount: 2,
    files: [
      // Episode 1 (1080p & 720p)
      {
        storageMessageId: 401,
        name: 'Show.S01E01.1080p.mkv',
        episode: { start: 1, end: 1, label: 'Episode 01' },
        size: 1_200_000_000
      },
      {
        storageMessageId: 402,
        name: 'Show.S01E01.720p.mkv',
        episode: { start: 1, end: 1, label: 'Episode 01' },
        size: 600_000_000
      },
      // Episode 2 (1080p, 720p, 480p)
      {
        storageMessageId: 403,
        name: 'Show.S01E02.1080p.mkv',
        episode: { start: 2, end: 2, label: 'Episode 02' },
        size: 1_150_000_000
      },
      {
        storageMessageId: 404,
        name: 'Show.S01E02.720p.mkv',
        episode: { start: 2, end: 2, label: 'Episode 02' },
        size: 580_000_000
      },
      {
        storageMessageId: 405,
        name: 'Show.S01E02.480p.mkv',
        episode: { start: 2, end: 2, label: 'Episode 02' },
        size: 280_000_000
      }
    ]
  };
  const config = {
    telegram: { storageChannelId: '-1002617067511' }
  };

  const entries = deriveLowestQualityTelegramStreamEntries(content, config);
  assert.equal(entries.length, 2);

  // Episode 1 chose 720p (message 402)
  assert.equal(entries[0].episode?.start, 1);
  assert.equal(entries[0].embedUrl, 'https://t.me/c/2617067511/402');

  // Episode 2 chose 480p (message 405)
  assert.equal(entries[1].episode?.start, 2);
  assert.equal(entries[1].embedUrl, 'https://t.me/c/2617067511/405');
});

test('mergeContentStreamWithTelegramFiles preserves third-party external streams', () => {
  const existingStream = {
    provider: 'Streamtape',
    entries: [
      {
        id: 'external-01',
        label: 'Episode 01',
        episode: { start: 1, end: 1 },
        provider: 'Streamtape',
        server: 'Streamtape server',
        embedUrl: 'https://streamtape.to/e/abc123xyz'
      }
    ]
  };
  const content = {
    category: 'anime',
    files: [
      {
        storageMessageId: 501,
        name: 'Show.E01.480p.mkv',
        episode: { start: 1, end: 1, label: 'Episode 01' },
        size: 300_000_000
      }
    ]
  };
  const config = {
    telegram: { storageChannelId: '-1002617067511' }
  };

  const merged = mergeContentStreamWithTelegramFiles(existingStream, content, config);
  assert.equal(merged.entries.length, 2);

  const tgEntry = merged.entries.find((e) => e.provider === 'Telegram');
  const extEntry = merged.entries.find((e) => e.provider === 'Streamtape');

  assert.ok(tgEntry, 'Telegram entry should be present');
  assert.equal(tgEntry.embedUrl, 'https://t.me/c/2617067511/501');
  assert.ok(extEntry, 'External Streamtape entry should be preserved');
  assert.equal(extEntry.embedUrl, 'https://streamtape.to/e/abc123xyz');
});

test('toPublicContent automatically synthesizes lowest quality Telegram player on-the-fly for all posts', () => {
  const rawPost = {
    id: 'post-100',
    title: 'Demon Slayer Season 1',
    category: 'anime',
    episodeCount: 1,
    hasDelivery: true,
    files: [
      {
        storageMessageId: 601,
        name: 'Demon.Slayer.S01E01.1080p.mkv',
        episode: { start: 1, end: 1, label: 'Episode 01' },
        size: 1_200_000_000
      },
      {
        storageMessageId: 602,
        name: 'Demon.Slayer.S01E01.480p.mkv',
        episode: { start: 1, end: 1, label: 'Episode 01' },
        size: 350_000_000
      }
    ]
  };
  const config = {
    siteUrl: 'https://example.com',
    telegram: { storageChannelId: '-1002617067511' },
    streaming: { allowedHosts: ['t.me'] }
  };

  const publicPost = toPublicContent(rawPost, config);
  assert.ok(publicPost.stream, 'Public post should have stream');
  assert.equal(publicPost.stream.entries.length, 1);
  assert.equal(publicPost.stream.entries[0].embedUrl, 'https://t.me/c/2617067511/602');
  assert.equal(publicPost.stream.entries[0].provider, 'Telegram');
});

test('clearPublisherSessionCache clears cached sessions without error', () => {
  assert.doesNotThrow(() => {
    clearPublisherSessionCache('chat-1', 'user-1');
    clearPublisherSessionCache();
  });
});

test('applyMergePlan re-evaluates and selects lowest quality from combined files into target stream', async () => {
  const repository = new MemoryCatalogRepository([]);
  const target = await repository.createContent({
    title: 'Solo Leveling',
    category: 'anime',
    files: [
      {
        storageMessageId: 10,
        name: 'Solo.Leveling.S01E01.1080p.mkv',
        episode: { start: 1, end: 1, label: 'Episode 01' },
        size: 1_200_000_000
      }
    ],
    stream: {
      provider: 'Telegram',
      entries: [
        {
          id: 'tg-2617067511-10',
          label: 'Episode 01',
          episode: { start: 1, end: 1 },
          provider: 'Telegram',
          server: 'Telegram server',
          embedUrl: 'https://t.me/c/2617067511/10'
        }
      ]
    }
  });

  const source = await repository.createContent({
    title: 'Solo Leveling 480p Batch',
    category: 'anime',
    files: [
      {
        storageMessageId: 20,
        name: 'Solo.Leveling.S01E01.480p.mkv',
        episode: { start: 1, end: 1, label: 'Episode 01' },
        size: 300_000_000
      }
    ]
  });

  const bot = {
    telegram: {
      async editMessageText() { return true; },
      async deleteMessage() { return true; }
    }
  };
  const config = {
    siteUrl: 'https://site.test',
    telegram: { storageChannelId: '-1002617067511' }
  };

  const { plan } = await resolveMergePlan({
    repository,
    parsed: parseMergeCommand(`${target.adminId} ${source.adminId}`)
  });

  const outcome = await applyMergePlan({ bot, repository, config, plan });
  assert.equal(outcome.error, undefined);

  const merged = await repository.findContentByAdminId(target.adminId);
  assert.equal(merged.files.length, 2);

  // The stream stored in repository must now point to message 20 (480p) instead of 10 (1080p)
  assert.ok(merged.stream);
  const ep1 = merged.stream.entries.find((e) => e.episode?.start === 1);
  assert.ok(ep1);
  assert.equal(ep1.embedUrl, 'https://t.me/c/2617067511/20');
});
