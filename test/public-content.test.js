import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { toPublicContent } from '../src/server/index.js';

const config = {
  telegram: { botUsername: 'ExampleDeliveryBot' }
};

test('public serialization creates a deep link and hides storage file metadata', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Private release',
    category: 'movie',
    languages: ['Multi language'],
    subtitleLanguages: ['English'],
    files: [{ storageMessageId: 33, telegramFileId: 'very-private-file-id', name: 'clip.Multi.Hindi.Malayalam.mp4' }]
  });
  const publicRecord = toPublicContent(created, config);

  assert.match(publicRecord.telegramUrl, /^https:\/\/t\.me\/ExampleDeliveryBot\?start=get-/);
  assert.match(publicRecord.deliveryUrl, /^\/deliver\//);
  assert.equal(publicRecord.files, undefined);
  assert.equal(publicRecord.telegramFileId, undefined);
  assert.equal(publicRecord.adminId, undefined);
  assert.equal(publicRecord.filesCount, 1);
  assert.deepEqual(publicRecord.languages, ['Hindi', 'Malayalam']);
  assert.deepEqual(publicRecord.subtitleLanguages, ['English']);
  assert.equal(publicRecord.fileChoices.length, 1);
  assert.match(publicRecord.fileChoices[0].telegramUrl, /^https:\/\/t\.me\/ExampleDeliveryBot\?start=file-/);
  assert.match(publicRecord.fileChoices[0].deliveryUrl, /^\/deliver\/.*\/file\/1$/);
  assert.equal(publicRecord.fileChoices[0].storageMessageId, undefined);
  assert.equal(publicRecord.fileChoices[0].telegramFileId, undefined);

  const listRecord = toPublicContent(created, config, { includeFileChoices: false });
  assert.deepEqual(listRecord.languages, ['Hindi', 'Malayalam']);
  assert.deepEqual(listRecord.fileChoices, []);
  assert.equal(listRecord.files, undefined);
});


test('stored file labels and public delivery output never retain Telegram source attribution', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Clean release',
    category: 'movie',
    files: [{
      storageMessageId: 91,
      storageChannelId: '-100normal',
      name: 'Clean.Release.1080p.mkv @promotion_source',
      displayName: 'Clean Release @promotion_source',
      sourceLabel: 'Clean Release Hindi 1080p @promotion_source https://t.me/promotion_source',
      kind: 'video'
    }]
  });
  const publicRecord = toPublicContent(created, config);

  assert.equal(created.files[0].sourceLabel.includes('@promotion_source'), false);
  assert.equal(created.files[0].sourceLabel.includes('t.me/promotion_source'), false);
  assert.equal(JSON.stringify(publicRecord).includes('promotion_source'), false);
  // The useful language label remains, but no source-channel attribution does.
  assert.equal(publicRecord.fileChoices[0].label, 'Clean Release Hindi');
});

test('public serialization exposes only approved manual player links for the in-site Watch page', () => {
  const record = toPublicContent({
    id: 'watch-release', slug: 'watch-release', title: 'Watch release', category: 'web-series',
    hasDelivery: false,
    stream: {
      provider: 'SeekStreaming',
      privateDashboardToken: 'never-public',
      entries: [
        { label: 'Episode 01', episode: { start: 1, end: 1, label: 'Episode 01' }, embedUrl: 'https://soraboxs.embedseek.com/#58yvk', watchUrl: null },
        { label: 'Blocked', embedUrl: 'https://untrusted.example/embed/x' }
      ]
    }
  }, config);
  assert.equal(record.stream.available, true);
  assert.equal(record.stream.entries.length, 1);
  assert.equal(record.stream.entries[0].embedUrl, 'https://soraboxs.embedseek.com/#58yvk');
  assert.equal(record.stream.privateDashboardToken, undefined);
  assert.equal(record.adminId, undefined);
});

test('legacy “English Sub” labels are shown as subtitles rather than audio', () => {
  const record = toPublicContent({
    id: 'legacy', slug: 'legacy', title: 'Legacy release', category: 'anime',
    shareCode: 'legacyCode', hasDelivery: false, languages: ['Japanese', 'English Sub'], files: []
  }, config);
  assert.deepEqual(record.languages, ['Japanese']);
  assert.deepEqual(record.subtitleLanguages, ['English']);
});

test('manual subtitle metadata remains public when later files carry other caption labels', () => {
  const record = toPublicContent({
    id: 'manual-subs', slug: 'manual-subs', title: 'Manual subtitles', category: 'anime',
    shareCode: 'manualCode', hasDelivery: false, subtitleLanguages: ['Hindi'], subtitleLanguageSource: 'manual',
    files: [{ name: 'episode.mkv', displayName: 'Episode 1 English Subtitles', subtitleLanguages: ['English'] }]
  }, config);
  assert.deepEqual(record.subtitleLanguages, ['Hindi']);
});

test('delivery choices retain a meaningful season title and remove ESubs release noise', () => {
  const record = toPublicContent({
    id: 'gentlemen', slug: 'the-gentlemen', title: 'The Gentlemen Season 1', category: 'web-series',
    releaseLabel: 'Season 1', shareCode: 'gentlemenCode', hasDelivery: true,
    files: [
      {
        name: 'video-77',
        // This is what historical native-video records retained after the old
        // cleaner had stripped the season and left only an ESubs suffix.
        displayName: 'The Gentlemen ESubs', quality: '720P', kind: 'video'
      },
      {
        name: 'The Gentlemen Season 1 (2024) [Hindi-English] 720p HEVC Netflix WEB-DL ESubs.mkv',
        displayName: 'The Gentlemen ESubs',
        sourceLabel: 'The Gentlemen Season 1 (2024) [Hindi-English] 720p HEVC Netflix WEB-DL ESubs.mkv',
        quality: '720P', kind: 'video'
      }
    ]
  }, config);
  assert.deepEqual(record.fileChoices.map((file) => file.label), ['The Gentlemen Season 1', 'The Gentlemen Season 1']);
});

test('quality choices are ordered small file to 4K without disturbing their delivery index', () => {
  const record = toPublicContent({
    id: 'ordering', slug: 'ordering', title: 'Perfect World', category: 'donghua',
    shareCode: 'orderCode', hasDelivery: true,
    files: [
      { storageMessageId: 1, name: 'Perfect.World.S01E05.1080p.mkv', sourceLabel: 'Perfect World S01E05 1080p', quality: '1080P', episode: { start: 5, end: 5 } },
      { storageMessageId: 2, name: 'Perfect.World.S01E05.480p.mkv', sourceLabel: 'Perfect World S01E05 480p', quality: '480P', episode: { start: 5, end: 5 } },
      { storageMessageId: 3, name: 'Perfect.World.S01E05.720p.mkv', sourceLabel: 'Perfect World S01E05 720p', quality: '720P', episode: { start: 5, end: 5 } },
      { storageMessageId: 4, name: 'Perfect.World.S01E06.no-quality.mkv', sourceLabel: 'Perfect World S01E06', episode: { start: 6, end: 6 } }
    ]
  }, config);

  assert.deepEqual(record.fileChoices.map((file) => file.quality), ['480P', '720P', '1080P', null]);
  // Every row still points at its own Telegram file position after reordering.
  assert.deepEqual(record.fileChoices.map((file) => file.position), [2, 3, 1, 4]);
  assert.deepEqual(record.fileChoices.map((file) => file.deliveryUrl), [
    '/deliver/orderCode/file/2',
    '/deliver/orderCode/file/3',
    '/deliver/orderCode/file/1',
    '/deliver/orderCode/file/4'
  ]);
});

test('public file rows keep the complete upload wording so a name is never half-shown', () => {
  const record = toPublicContent({
    id: 'names', slug: 'names', title: 'Perfect World', category: 'anime',
    shareCode: 'nameCode', hasDelivery: true,
    files: [{
      storageMessageId: 7,
      name: `Perfect.World.S01E05.1080p.${'WEB-DL.Hindi.Dual.Audio.'.repeat(6)}mkv`,
      sourceLabel: 'Perfect World S01E05 1080p WEB-DL Hindi @promo_channel',
      kind: 'video'
    }]
  }, config);

  assert.equal(record.fileChoices[0].fileName, 'Perfect World S01E05 1080p WEB-DL Hindi');
  assert.equal(record.fileChoices[0].fileName.includes('@promo_channel'), false);
  assert.match(record.fileChoices[0].label, /Perfect World/);
});

test('episode groups mark combined uploads so packs can be listed apart', () => {
  const record = toPublicContent({
    id: 'packs', slug: 'packs', title: 'Solo Leveling', category: 'anime',
    shareCode: 'packCode', hasDelivery: true,
    episodeGroups: [
      { start: 1, end: 5, label: 'Episodes 01–05', fileCount: 2 },
      { start: 6, end: 6, label: 'Episode 06', fileCount: 1 }
    ],
    files: [{ storageMessageId: 8, name: 'Solo.Leveling.EP.1-5.1080p.mkv', episode: { start: 1, end: 5, label: 'Episodes 01\u201305' } }]
  }, config);

  assert.deepEqual(record.episodeGroups.map((group) => group.combined), [true, false]);
  assert.equal(record.fileChoices[0].episode.combined, true);
});
