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

test('anonymous HTML visits are counted with a first-party random cookie, without API or static traffic', async (t) => {
  const repository = new MemoryCatalogRepository([]);
  const app = createApp({
    config: { environment: 'test', telegram: { botUsername: 'DeliveryBot' } },
    repository,
    distPath: '/tmp/sorabox-no-static-files'
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const url = `http://127.0.0.1:${server.address().port}`;
  const first = await fetch(`${url}/`, { headers: { accept: 'text/html' } });
  const cookie = first.headers.get('set-cookie').split(';')[0];
  await fetch(`${url}/`, { headers: { accept: 'text/html', cookie } });
  await fetch(`${url}/api/health`, { headers: { accept: 'text/html', cookie } });
  await fetch(`${url}/assets/app.js`, { headers: { accept: 'text/html', cookie } });

  const stats = await repository.getPublisherStats();
  assert.equal(stats.site.visitors, 1);
  assert.equal(stats.site.visits, 2);
  assert.equal(stats.site.activeVisitors24h, 1);
});

test('18+ catalog records stay out of ordinary APIs until an age-confirmed browser session', async (t) => {
  const repository = new MemoryCatalogRepository([]);
  await repository.createContent({
    title: 'Everyday release',
    category: 'movie',
    files: [{ storageMessageId: 1, storageChannelId: '-100normal', name: 'everyday.mkv' }]
  });
  const adult = await repository.createContent({
    title: 'Restricted release',
    category: 'adult',
    description: 'Private adult catalog data',
    files: [{ storageMessageId: 1, storageChannelId: '-100adult', name: 'restricted.mkv' }]
  });
  const app = createApp({
    config: { environment: 'test', telegram: { botUsername: 'DeliveryBot', adultStorageChannelId: '-100adult' } },
    repository,
    distPath: '/tmp/sorabox-no-static-files'
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const url = `http://127.0.0.1:${server.address().port}`;
  const ordinary = await fetch(`${url}/api/content`);
  const ordinaryBody = await ordinary.json();
  assert.equal(ordinaryBody.items.length, 1);
  assert.equal(ordinaryBody.items[0].title, 'Everyday release');

  const anonymousCategories = await fetch(`${url}/api/categories`);
  assert.equal((await anonymousCategories.json()).categories.find((entry) => entry.id === 'adult').count, 0);
  const blockedCategory = await fetch(`${url}/api/content?category=adult`);
  assert.equal(blockedCategory.status, 403);
  assert.equal((await blockedCategory.text()).includes('Restricted release'), false);
  const blockedDetail = await fetch(`${url}/api/content/${adult.slug}`);
  assert.equal(blockedDetail.status, 403);
  const blockedDelivery = await fetch(`${url}/deliver/${adult.shareCode}`, { redirect: 'manual' });
  assert.equal(blockedDelivery.status, 403);

  const confirmation = await fetch(`${url}/api/adult-access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true })
  });
  assert.equal(confirmation.status, 200);
  const adultCookie = confirmation.headers.get('set-cookie').split(';')[0];
  const confirmedCategories = await fetch(`${url}/api/categories`, { headers: { cookie: adultCookie } });
  assert.equal((await confirmedCategories.json()).categories.find((entry) => entry.id === 'adult').count, 1);
  const allowedCategory = await fetch(`${url}/api/content?category=adult`, { headers: { cookie: adultCookie } });
  assert.equal(allowedCategory.status, 200);
  assert.equal(allowedCategory.headers.get('cache-control'), 'private, no-store');
  const allowedBody = await allowedCategory.json();
  assert.equal(allowedBody.items.length, 1);
  assert.equal(allowedBody.items[0].title, 'Restricted release');
  const allowedDelivery = await fetch(`${url}/deliver/${adult.shareCode}`, { headers: { cookie: adultCookie }, redirect: 'manual' });
  assert.equal(allowedDelivery.status, 302);
  assert.equal(allowedDelivery.headers.get('location'), `https://t.me/DeliveryBot?start=get-${adult.shareCode}`);
});
