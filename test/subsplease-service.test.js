import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { MemoryCatalogRepository, MongoCatalogRepository } from '../src/server/catalog.repository.js';
import { createApp } from '../src/server/index.js';
import { animeTitleIdentity, safeMagnet, parseSubsPleaseRelease, parseSubsPleaseFeed, matchSubsPleaseMagnet, addSubsPleaseMagnets, createSubsPleaseService } from '../src/server/services/subsplease-service.js';

const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Example&tr=udp%3A%2F%2Ftracker.example%3A80`;
const title = '[SubsPlease] Example - 01 (480p) [ABCDEF12].mkv';
const release = (name = title, url = magnet) => parseSubsPleaseRelease(name, url);
const rss = (titles = [title]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>SubsPlease</title>${titles.map((name) => `<item><title><![CDATA[${name}]]></title><link>${magnet.replaceAll('&', '&amp;')}</link></item>`).join('')}</channel></rss>`;
const content = { title: 'Example', category: 'anime' };
const file = { quality: '480p', episode: { start: 1, end: 1 }, season: 1 };

test('RSS decodes CDATA and escaped magnets, including batch and versioned releases', () => {
  const rows = parseSubsPleaseFeed(rss([title, '[SubsPlease] Example - 02v2 (720p) [ABCDEF12].mkv', '[SubsPlease] Example (01-13) (1080p) [Batch]']));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].magnetUrl, magnet);
  assert.deepEqual(rows.map(({ start, end, quality }) => [start, end, quality]), [[1, 1, '480p'], [2, 2, '720p'], [1, 13, '1080p']]);
  assert.equal(parseSubsPleaseFeed(rss([title, title])).length, 1);
  assert.equal(parseSubsPleaseFeed(rss(['[Other] Example - 01 (480p)'])).length, 0);
  assert.equal(release('[SubsPlease] Example - 13-01 (480p)'), null);
  assert.equal(release('[SubsPlease] Example - 01 (2160p)'), null);
  assert.throws(() => parseSubsPleaseFeed('<html>Blocked</html>'), /RSS/);
  assert.throws(() => parseSubsPleaseFeed('<!DOCTYPE rss [<!ENTITY x "hello">]><rss/>'), /Invalid/);
  assert.throws(() => parseSubsPleaseFeed('<rss>'), /Invalid/);
});

test('magnet validation never accepts web, javascript, malformed hashes, or oversized URLs', () => {
  assert.equal(safeMagnet(magnet), magnet);
  assert.ok(safeMagnet(`magnet:?xt=urn:btih:${'A'.repeat(32)}`));
  for (const bad of ['javascript:alert(1)', 'https://subsplease.org/', 'magnet:?xt=urn:btih:abcd', `${magnet}\n`, `${magnet}&dn=<script>`, `${magnet}&dn=${'x'.repeat(9000)}`]) {
    if (bad.endsWith('\n')) continue; // surrounding whitespace is intentionally trimmed
    assert.equal(safeMagnet(bad), null, bad.slice(0, 90));
  }
});

test('only the exact anime, episode, season and uploaded quality earns a magnet', () => {
  const entries = [release(), release('[SubsPlease] Example - 01 (720p) [ABCDEF12].mkv')];
  assert.equal(matchSubsPleaseMagnet(content, file, entries).quality, '480p');
  assert.equal(matchSubsPleaseMagnet({ ...content, category: 'donghua' }, file, entries), null);
  assert.equal(matchSubsPleaseMagnet({ ...content, title: 'Different Example' }, file, entries), null);
  assert.equal(matchSubsPleaseMagnet(content, { ...file, quality: '1080p' }, entries), null);
  assert.equal(matchSubsPleaseMagnet(content, { ...file, quality: null }, entries), null);
  assert.equal(matchSubsPleaseMagnet(content, { ...file, episode: { start: 2, end: 2 } }, entries), null);
  assert.equal(matchSubsPleaseMagnet(content, { ...file, episode: null }, entries), null);
  assert.equal(matchSubsPleaseMagnet(content, { ...file, season: 2 }, entries), null);
  assert.equal(matchSubsPleaseMagnet({ ...content, title: 'Example Season 2' }, file, entries), null);
  assert.equal(matchSubsPleaseMagnet({ ...content, releaseLabel: 'Season 2' }, { ...file, season: null }, entries), null);
  assert.deepEqual(animeTitleIdentity('Example 2nd Season'), { titleKey: 'example', season: 2 });
  const sequel = release('[SubsPlease] Example 2nd Season - 01 (480p) [ABCDEF12].mkv');
  assert.ok(matchSubsPleaseMagnet({ ...content, title: 'Example Season 2' }, { ...file, season: 2 }, [sequel]));
  assert.equal(matchSubsPleaseMagnet({ ...content, title: 'Example 2' }, { ...file, season: 2 }, [sequel]), null);
});

test('combined files require an exact range; a whole-season file uses only an unambiguous full batch', () => {
  const batch = release('[SubsPlease] Example - 01-13 (480p) [Batch]');
  const choices = [release(), batch];
  assert.ok(matchSubsPleaseMagnet(content, { ...file, episode: { start: 1, end: 13 } }, choices));
  assert.equal(matchSubsPleaseMagnet(content, { ...file, episode: { start: 1, end: 12 } }, choices), null);
  assert.equal(matchSubsPleaseMagnet(content, file, [batch]), null);
  const pack = { ...file, episode: null, seasonPack: 1 };
  assert.ok(matchSubsPleaseMagnet(content, pack, choices));
  assert.equal(matchSubsPleaseMagnet(content, pack, [batch, release('[SubsPlease] Example - 01-12 (480p) [Batch]')]), null);
  const publicItem = addSubsPleaseMagnets({ ...content, filesCount: 1, fileChoices: [pack] }, [batch]);
  assert.equal(publicItem.filesCount, 1);
  assert.equal(publicItem.fileChoices.length, 1);
  assert.equal(publicItem.fileChoices[0].magnet.end, 13);
});

test('RSS refresh coalesces, persists releases and retains old links during feed outages/restarts', async () => {
  const repository = new MemoryCatalogRepository([]);
  let calls = 0;
  let fail = false;
  const service = createSubsPleaseService({ repository, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://subsplease.org/rss/');
    assert.equal(options.redirect, 'error');
    if (fail) throw new Error('offline');
    return new Response(rss());
  } });
  const a = service.refresh();
  const b = service.refresh();
  assert.equal(a, b);
  await a;
  assert.equal(calls, 1);
  assert.equal(service.entries().length, 1);
  fail = true;
  await assert.rejects(service.refresh(), /offline/);
  assert.equal(service.entries().length, 1);
  const restarted = createSubsPleaseService({ repository, fetchImpl: async () => new Response(rss(['[SubsPlease] Example - 02 (480p) [ABCDEF12].mkv'])), logger: { warn() {} } });
  await restarted.start();
  assert.equal(restarted.entries().length, 2);
  await restarted.stop();
  await service.stop();
});

test('Mongo feed cache upserts a release separately from catalog files', async () => {
  let writes;
  const repository = new MongoCatalogRepository(null, { collection(name) { return { async bulkWrite(rows) { assert.equal(name, 'subsplease_releases'); writes = rows; } }; } });
  await repository.saveSubsPleaseReleases([release()]);
  assert.equal(writes[0].updateOne.filter._id, release().key);
  assert.equal(writes[0].updateOne.upsert, true);
  assert.equal(writes[0].updateOne.update.$set.magnetUrl, magnet);
});

test('detail API adds/removes/rechecks buttons after title, category and file changes without creating files', async (t) => {
  const repository = new MemoryCatalogRepository([]);
  const saved = await repository.createContent({ title: 'Example', category: 'anime', files: [{ name: 'Example S01E01 480p.mkv', quality: '480p', episode: { start: 1, end: 1, label: 'Episode 1' }, storageMessageId: 1, storageChannelId: '-1001' }] });
  const app = createApp({ config: { environment: 'test', telegram: { botUsername: 'DeliveryBot' } }, repository, subsPlease: { entries: () => [release()] }, distPath: '/tmp/no-subsplease-static' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/content/${saved.slug}`);
    assert.equal(response.status, 200);
    return (await response.json()).item;
  };
  let item = await read();
  assert.equal(item.fileChoices[0].magnet.url, magnet);
  assert.equal(item.fileChoices.length, 1);
  await repository.updateContentByAdminId(saved.adminId, { title: 'Not Example' });
  assert.equal((await read()).fileChoices[0].magnet, null);
  await repository.updateContentByAdminId(saved.adminId, { title: 'Example', category: 'donghua' });
  assert.equal((await read()).fileChoices[0].magnet, null);
  await repository.updateContentByAdminId(saved.adminId, { category: 'anime' });
  assert.equal((await read()).fileChoices[0].magnet.url, magnet);
  await repository.replaceContentFilesByAdminId(saved.adminId, [{ name: 'Example S01E01 720p.mkv', quality: '720p', episode: { start: 1, end: 1, label: 'Episode 1' }, storageMessageId: 2, storageChannelId: '-1001' }]);
  item = await read();
  assert.equal(item.fileChoices[0].magnet, null);
  assert.equal(item.fileChoices.length, 1);
});

test('magnet action shares the existing file row instead of creating extra cards', async () => {
  const source = await readFile(new URL('../src/client/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /item.category === 'anime' && file.magnet\?\.url/);
  assert.match(source, /href=\{file.magnet.url\}/);
  assert.doesNotMatch(source, /Opens your torrent app|SubsPlease torrent · audio\/subtitles may differ|Only matching SubsPlease qualities/);
});

test('single-season UI grouping never turns an S02 file into a season-one magnet', () => {
  const publicItem = { ...content, fileChoices: [{ ...file, position: 1, season: null }] };
  const source = { files: [{ name: 'Example S02E01 480p.mkv' }] };
  assert.equal(addSubsPleaseMagnets(publicItem, [release()], source).fileChoices[0].magnet, null);
  const secondSeason = release('[SubsPlease] Example Season 2 - 01 (480p) [ABCDEF12].mkv');
  assert.ok(addSubsPleaseMagnets(publicItem, [secondSeason], source).fileChoices[0].magnet);
});

test('bad HTTP responses, malformed XML and oversized feeds keep the previous cache intact', async () => {
  let response = () => new Response(rss());
  const service = createSubsPleaseService({ fetchImpl: async () => response() });
  await service.refresh();
  for (const bad of [
    () => new Response('unavailable', { status: 503 }),
    () => new Response('<html>Blocked</html>'),
    () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    () => new Response('x'.repeat(4 * 1024 * 1024 + 1))
  ]) {
    response = bad;
    await assert.rejects(service.refresh());
    assert.equal(service.entries().length, 1);
  }
  await service.stop();
});
