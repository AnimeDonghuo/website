import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { createApp } from '../src/server/index.js';

test('stable catalog delivery URLs redirect to the currently active bot', async (t) => {
  const config = {
    environment: 'test',
    telegram: { botUsername: 'OldDeliveryBot' }
  };
  const app = createApp({
    config,
    repository: new MemoryCatalogRepository([]),
    distPath: '/tmp/sorabox-no-static-files'
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const url = `http://127.0.0.1:${server.address().port}`;
  const oldBotResponse = await fetch(`${url}/deliver/aB-cD_ef/file/2`, { redirect: 'manual' });
  assert.equal(oldBotResponse.status, 302);
  assert.equal(oldBotResponse.headers.get('location'), 'https://t.me/OldDeliveryBot?start=file-aB-cD_ef-2');
  assert.equal(oldBotResponse.headers.get('cache-control'), 'no-store');

  // This is what happens after launch identifies a replacement token's bot.
  config.telegram.botUsername = 'ReplacementDeliveryBot';
  const newBotResponse = await fetch(`${url}/deliver/aB-cD_ef/file/2`, { redirect: 'manual' });
  assert.equal(newBotResponse.status, 302);
  assert.equal(newBotResponse.headers.get('location'), 'https://t.me/ReplacementDeliveryBot?start=file-aB-cD_ef-2');
});
