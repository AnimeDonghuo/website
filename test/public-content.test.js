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
    files: [{ storageMessageId: 33, telegramFileId: 'very-private-file-id', name: 'clip.mp4' }]
  });
  const publicRecord = toPublicContent(created, config);

  assert.match(publicRecord.telegramUrl, /^https:\/\/t\.me\/ExampleDeliveryBot\?start=get-/);
  assert.equal(publicRecord.files, undefined);
  assert.equal(publicRecord.telegramFileId, undefined);
  assert.equal(publicRecord.adminId, undefined);
  assert.equal(publicRecord.filesCount, 1);
  assert.equal(publicRecord.fileChoices.length, 1);
  assert.match(publicRecord.fileChoices[0].telegramUrl, /^https:\/\/t\.me\/ExampleDeliveryBot\?start=file-/);
  assert.equal(publicRecord.fileChoices[0].storageMessageId, undefined);
  assert.equal(publicRecord.fileChoices[0].telegramFileId, undefined);
});
