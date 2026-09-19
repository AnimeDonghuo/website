import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { createApp } from '../src/server/index.js';
import { animeTitleIdentity, parseSubsPleaseSearch, selectAnimeAliases, createSubsPleaseService } from '../src/server/services/subsplease-service.js';

// Shape and release names verified against SubsPlease's public search response.
// Tiny tracker-free magnets keep the fixture focused on episode/quality identity.
function archiveRow(show, episode, qualities = [480, 720, 1080]) {
  return { show, episode, downloads: qualities.map((res) => ({
    res: String(res),
    magnet: `magnet:?xt=urn:btih:${'A'.repeat(32)}&dn=${encodeURIComponent(`[SubsPlease] ${show} - ${episode} (${res}p) [ABCDEF12].mkv`)}`
  })) };
}
const aliases = { data: { Page: { media: [{ id: 123, title: { english: "The Ogre's Bride", romaji: 'Oni no Hanayome', native: '鬼の花嫁' }, synonyms: [] }] } } };
const content = { category: 'anime', title: "S01EP11 The Ogre's Bride", fileChoices: [480, 720, 1080].map((quality, index) => ({ id: `file-${index + 1}`, position: index + 1, quality: `${quality}p`, episode: { start: 11, end: 11 } })) };
const source = { files: [480, 720, 1080].map((quality) => ({ name: `S01EP11 The Ogre's Bride ${quality}p.mkv` })) };
const quiet = { warn() {} };
const asResponse = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

function archiveFetch(calls) {
  return async (url, options) => {
    calls.push(url);
    if (url === 'https://graphql.anilist.co') {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).variables.search, "The Ogre's Bride");
      return asResponse(aliases);
    }
    const search = new URL(url);
    assert.equal(search.origin, 'https://subsplease.org');
    assert.equal(search.searchParams.get('f'), 'search');
    return asResponse(search.searchParams.get('s') === 'Oni no Hanayome'
      ? { 'Oni no Hanayome - 11': archiveRow('Oni no Hanayome', '11') }
      : []);
  };
}

test('archive parser handles older episodes and batches, but never substitutes quality', () => {
  const rows = parseSubsPleaseSearch({ old: archiveRow('Horimiya', '01-13', [540, 720, 1080]) });
  assert.deepEqual(rows.map((row) => [row.start, row.end, row.quality]), [[1, 13, '540p'], [1, 13, '720p'], [1, 13, '1080p']]);
  const wrong = archiveRow('Example', '11', [720]);
  wrong.downloads[0].res = '480';
  assert.equal(parseSubsPleaseSearch({ wrong }).length, 0, 'resolution must agree with the magnet display name');
  assert.deepEqual(parseSubsPleaseSearch([]), []);
  assert.throws(() => parseSubsPleaseSearch({ error: 'Rate limited' }), /Invalid/);
  assert.throws(() => parseSubsPleaseSearch('not json'), /Invalid/);
});

test('exact English/romaji aliases are verified; ambiguous or merely similar results are rejected', () => {
  assert.deepEqual(animeTitleIdentity("S01EP11 The Ogre’s Bride"), { titleKey: 'the ogre s bride', season: 1 });
  assert.equal(selectAnimeAliases(aliases, content.title)[0], 'Oni no Hanayome');
  assert.deepEqual(selectAnimeAliases(aliases, 'The Bride'), []);
  assert.deepEqual(selectAnimeAliases(aliases, "The Ogre's Bride Season 2"), []);
  const ambiguous = structuredClone(aliases);
  ambiguous.data.Page.media.push({ ...ambiguous.data.Page.media[0], id: 456 });
  assert.deepEqual(selectAnimeAliases(ambiguous, content.title), []);
  assert.throws(() => selectAnimeAliases({ errors: [{ message: 'Rate limit' }] }, content.title), /unavailable/);
});

test('screenshot regression: episode 11 gets all three exact-quality buttons from archive, without RSS', async () => {
  const repository = new MemoryCatalogRepository([]);
  const calls = [];
  const service = createSubsPleaseService({ repository, fetchImpl: archiveFetch(calls), logger: quiet });
  const [first, second] = await Promise.all([service.resolve(content, source), service.resolve(content, source)]);
  assert.equal(first.state, 'ready');
  assert.equal(second.state, 'ready');
  assert.equal(calls.length, 3, 'one direct search, one alias lookup, one romaji archive search for all qualities and visitors');
  assert.deepEqual(first.item.fileChoices.map((file) => file.magnet.quality), ['480p', '720p', '1080p']);
  assert.ok(first.item.fileChoices.every((file) => file.magnet.start === 11 && file.magnet.end === 11));
  assert.equal(first.item.fileChoices.length, 3, 'no extra file rows');
  await service.resolve(content, source);
  assert.equal(calls.length, 3, 'repeat requests reuse cached archive discovery');
  assert.equal((await repository.loadSubsPleaseReleases()).length, 3);
  assert.ok((await repository.findSubsPleaseAliases('the ogre s bride|1')).aliases.includes('Oni no Hanayome'));
  await service.stop();
});

test('renames and category changes do not reuse old English aliases; mismatched episodes stay hidden', async () => {
  const service = createSubsPleaseService({ fetchImpl: archiveFetch([]), logger: quiet });
  await service.resolve(content, source);
  assert.equal((await service.resolve({ ...content, category: 'movie' }, source)).state, 'not-applicable');
  const changed = await service.resolve({ ...content, title: 'Something Completely Different' }, source);
  assert.ok(changed.item.fileChoices.every((file) => !file.magnet));
  const wrongEpisode = await service.resolve({ ...content, fileChoices: [{ ...content.fileChoices[0], episode: { start: 10, end: 10 } }] }, source);
  assert.equal(wrongEpisode.state, 'not-found');
  await service.stop();
});

test('persisted aliases and releases survive restart and provider outages', async () => {
  const repository = new MemoryCatalogRepository([]);
  const first = createSubsPleaseService({ repository, fetchImpl: archiveFetch([]), logger: quiet });
  await first.resolve(content, source);
  await first.stop();
  let attempts = 0;
  const restarted = createSubsPleaseService({ repository, fetchImpl: async () => { attempts += 1; throw new Error('offline'); }, logger: quiet });
  await restarted.start();
  const result = await restarted.resolve(content, source);
  assert.equal(result.state, 'ready');
  assert.ok(result.item.fileChoices.every((file) => file.magnet));
  await restarted.resolve(content, source);
  assert.equal(attempts, 2, 'one RSS attempt and one archive attempt, errors are cached briefly');
  await restarted.stop();
});

test('old batch search is independent of RSS history and keeps 480p separate from 540p', async () => {
  const service = createSubsPleaseService({ fetchImpl: async (url) => {
    assert.equal(new URL(url).searchParams.get('s'), 'Horimiya');
    return asResponse({ batch: archiveRow('Horimiya', '01-13', [540, 720, 1080]) });
  }, logger: quiet });
  const result = await service.resolve({ category: 'anime', title: 'Horimiya Season 1', fileChoices: [480, 720].map((quality, index) => ({ id: String(index), quality: `${quality}p`, episode: { start: 1, end: 13 } })) });
  assert.equal(result.item.fileChoices[0].magnet, null);
  assert.equal(result.item.fileChoices[1].magnet.quality, '720p');
  await service.stop();
});

async function httpCatalog(t, service) {
  const repository = new MemoryCatalogRepository([]);
  const saved = await repository.createContent({ title: "The Ogre's Bride", category: 'anime', files: source.files.map((file) => ({ ...file, episode: { start: 11, end: 11, label: 'Episode 11' }, storageChannelId: '-1001', storageMessageId: 1 })) });
  const app = createApp({ config: { environment: 'test', telegram: { botUsername: 'DeliveryBot' } }, repository, subsPlease: service, distPath: '/tmp/no-subsplease-static' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { repository, saved, url: `http://127.0.0.1:${server.address().port}/api/content/${saved.slug}` };
}

test('detail files load independently; separate archive endpoint returns matching magnets and revision', async (t) => {
  const calls = [];
  const service = createSubsPleaseService({ fetchImpl: archiveFetch(calls), logger: quiet });
  t.after(() => service.stop());
  const { url } = await httpCatalog(t, service);
  const detail = await (await fetch(url)).json();
  assert.equal(calls.length, 0, 'normal detail response does not wait for remote search');
  assert.equal(detail.item.fileChoices.length, 3);
  const magnets = await (await fetch(`${url}/magnets`)).json();
  assert.equal(magnets.state, 'ready');
  assert.equal(magnets.revision, detail.item.magnetRevision);
  assert.ok(magnets.files.every((file) => file.magnet?.start === 11));
});

test('a rename/category change during lookup suppresses the old links, not just the next request', async (t) => {
  let started;
  let finish;
  const began = new Promise((resolve) => { started = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const service = { resolve: async (item) => { started(); await waiting; return { item, state: 'ready' }; } };
  const { url, repository, saved } = await httpCatalog(t, service);
  const response = fetch(`${url}/magnets`);
  await began;
  await repository.updateContentByAdminId(saved.adminId, { category: 'donghua' });
  finish();
  assert.deepEqual(await (await response).json(), { state: 'stale', files: [] });
  assert.deepEqual(await (await fetch(`${url}/magnets`)).json(), { state: 'not-applicable', files: [] });
});

test('provider failures are explicit rather than silent and do not break delivery responses', async (t) => {
  const service = createSubsPleaseService({ fetchImpl: async () => { throw new Error('provider down'); }, logger: quiet });
  t.after(() => service.stop());
  const { url } = await httpCatalog(t, service);
  const magnets = await (await fetch(`${url}/magnets`)).json();
  assert.equal(magnets.state, 'unavailable');
  const detail = await (await fetch(url)).json();
  assert.ok(detail.item.fileChoices.every((file) => file.deliveryReady));
});
