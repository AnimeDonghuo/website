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
