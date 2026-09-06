import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryCatalogRepository, reindexContentRecord } from '../src/server/catalog.repository.js';
import { createApp } from '../src/server/index.js';
import { collectionBaseTitle, deriveCollection, manualCollection, resolveCollection } from '../src/server/services/collection-service.js';

// ── helpers ────────────────────────────────────────────────────────────────────────────────
const card = (title, overrides = {}) => ({
  title,
  category: overrides.category || 'movie',
  files: [{ name: `${title.replace(/\s+/g, '.')}.1080p.mkv` }],
  ...overrides
});

async function seeded(contents) {
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  for (const content of contents) await repository.createContent(content);
  return repository;
}

async function withApi(repository, run) {
  const app = createApp({
    config: { environment: 'test', telegram: { botUsername: 'ExampleDeliveryBot' } },
    repository,
    distPath: '/tmp/sorabox-no-static-files'
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

// ── the derivation itself ──────────────────────────────────────────────────────────────────
test('a numbered or subtitled entry names the group it belongs to', () => {
  assert.equal(deriveCollection('Iron Man 3').name, 'Iron Man');
  assert.equal(deriveCollection('Iron Man 2').name, 'Iron Man');
  assert.equal(deriveCollection('Iron Man').name, 'Iron Man', 'the first entry belongs to its own group too, or a collection starts at two');
  assert.equal(deriveCollection('Iron Man: The Final Cut').name, 'Iron Man', 'a colon subtitle is a version of the work, not a different one');
  assert.equal(deriveCollection('John Wick: Chapter 4').name, 'John Wick');
  assert.equal(deriveCollection('Avatar Part 2').name, 'Avatar');
  assert.equal(deriveCollection('Kill Bill Vol. 1').name, 'Kill Bill');
  assert.equal(deriveCollection('Extraction 2 (2025)').name, 'Extraction', 'a trailing year is packaging, not a franchise');
  assert.equal(deriveCollection('Rocky IV').name, 'Rocky', 'roman numerals count too');
  // A title nobody cut in half keeps its own name as the group it would found — that is what lets
  // "Iron Man" sit in the same collection as "Iron Man 2" instead of beside it. The repository is
  // what refuses to call one title a franchise.
  assert.equal(deriveCollection('Shin Godzilla').name, 'Shin Godzilla', 'a title with nothing to strip is its own group, not a piece of "Shin"');
  assert.equal(deriveCollection('In the Grey').name, 'In the Grey', 'two ordinary words are a whole title, not a series');
  assert.equal(deriveCollection('Godzilla 1998').name, 'Godzilla', 'a year is packaging, so a dated release joins the undated one');
});

test('a group never swallows a title that only looks numbered', () => {
  // "7" alone, or a lone digit, has nothing to attach to: the base would be an empty string, and an
  // empty base would pull every file named "3" into one giant imaginary collection.
  assert.equal(deriveCollection('7'), null);
  assert.equal(deriveCollection('2012'), null, 'a year is a title here, not a part number');
  assert.equal(deriveCollection('Part 2'), null);
  assert.equal(deriveCollection('Movie 3'), null, 'packaging words alone never found a franchise');
});

test('the manual override wins, and clearing it is remembered', () => {
  assert.equal(manualCollection('MCU Phase One').name, 'MCU Phase One');
  assert.equal(manualCollection('  ').name, null);
  for (const value of ['none', 'clear', 'remove', 'unset', 'off', '-', 'no collection']) {
    const cleared = manualCollection(value);
    assert.equal(cleared.name, null, `"/collection SB-1 ${value}" has to mean take it out`);
    assert.equal(cleared.cleared, true, 'and say so, so a later title edit cannot quietly re-add the group');
  }

  const locked = resolveCollection({ title: 'Iron Man 3', stored: { name: 'Marvel Saga', key: 'marvel-saga' }, requested: undefined, locked: true });
  assert.equal(locked.collection.name, 'Marvel Saga', 'a name a publisher set survives the title it disagreed with');
  assert.equal(locked.collectionManual, true);

  const edited = resolveCollection({ title: 'Ant-Man 2', stored: { name: 'Iron Man', key: 'iron-man' }, requested: undefined, locked: false });
  assert.equal(edited.collection.name, 'Ant-Man', 'and a derived group follows /title the moment the title changes');

  const cleared = resolveCollection({ title: 'Iron Man 3', stored: { name: 'Iron Man', key: 'iron-man' }, requested: 'none', locked: false });
  assert.equal(cleared.collection, null);
  assert.equal(cleared.collectionManual, true, 'a hand-cleared card stays out even though its title still says Iron Man');
});

test('collectionBaseTitle leaves the work a viewer would search for', () => {
  assert.equal(collectionBaseTitle('Iron Man 3: Extended'), 'Iron Man');
  assert.equal(collectionBaseTitle('Dhoom 2'), 'Dhoom', 'a short franchise name is still a franchise name');
  assert.equal(collectionBaseTitle('K.G.F Chapter 2'), 'K.G.F');
  assert.equal(collectionBaseTitle('The Dark Knight'), 'The Dark Knight');
  assert.equal(collectionBaseTitle('Deadpool 2 DUAL -KyoGo mkv 🔊 #'), 'Deadpool', 'an upload caption reduces to the film inside it');
  assert.equal(collectionBaseTitle('Night of the Living Dead'), 'Night of the Living Dead', 'words that merely look trailing are left alone');
});

// ── grouping in the store ───────────────────────────────────────────────────────────────────
test('a collection needs two different titles before it is a collection', async () => {
  const repository = await seeded([
    card('Iron Man'),
    card('Iron Man 2'),
    card('Iron Man 2', { slug: 'iron-man-2-copy' }),
    card('Solo Film')
  ]);
  const collections = await repository.listCollections();
  assert.deepEqual(collections.map((entry) => entry.name), ['Iron Man'], 'a lone title is never listed as a franchise, and a duplicated card does not make one');
  assert.equal(collections[0].count, 3, 'the duplicate card is still inside the group when it is opened');
  assert.deepEqual(collections[0].titles, ['Iron Man', 'Iron Man 2']);
  assert.equal((await repository.findCollection('iron-man'))?.name, 'Iron Man');
  assert.equal(await repository.findCollection('solo-film'), null);
});

test('18+ never joins a collection or a genre shelf', async () => {
  const repository = await seeded([
    card('Iron Man'),
    card('Iron Man 2'),
    card('Iron Man 3', { category: 'adult', slug: 'adult-entry' })
  ]);
  const collections = await repository.listCollections();
  assert.equal(collections[0].count, 2, 'the adult entry is not in the group');
  const listed = await repository.listContent({ collectionKey: 'iron-man', hideAdult: true });
  // Sorted because a page is ordered by publish time, and cards made in one breath share it.
  assert.deepEqual(listed.map((item) => item.title).sort(), ['Iron Man', 'Iron Man 2']);
  const genres = await repository.listGenres();
  assert.deepEqual(genres, [], 'no genre is counted out of an adult card');
});

test('a genre shelf is cut across categories and matches whatever case was typed', async () => {
  const repository = await seeded([
    card('Action Movie', { genres: ['Action', 'Comedy'] }),
    card('Action Donghua', { category: 'donghua', genres: ['action'] }),
    card('Quiet Drama', { genres: ['Drama'] }),
    card('Action Adult', { category: 'adult', genres: ['Action'] })
  ]);
  const listed = await repository.listContent({ genre: 'ACTION', hideAdult: true });
  assert.deepEqual(listed.map((item) => item.title).sort(), ['Action Donghua', 'Action Movie'], 'a genre page holds every format, and never the adult one');
  assert.equal(await repository.countContent({ genre: 'Action', hideAdult: true }), 2);
  assert.equal((await repository.listContent({ genre: 'action', hideAdult: true })).length, 2, 'the letters alone decide the shelf, not the case they were typed in');
  // "Action" and "action" are one shelf: the list merges the spellings rather than offering two
  // tiles that open the same two cards.
  const genres = await repository.listGenres();
  assert.deepEqual(genres.map((entry) => `${entry.name}:${entry.count}`), ['Action:2', 'Comedy:1', 'Drama:1']);
});

test('/repair backfill puts already-published cards into their group', async () => {
  const published = await seeded([card('Iron Man'), card('Iron Man 2')]);
  const [first] = await published.listContent({ limit: 1 });
  // The stored copy is what it would have been before collections existed: no group at all.
  const legacy = { ...first, collection: null, collectionManual: false, files: first.files };
  const result = reindexContentRecord(legacy);
  assert.equal(result.changed, true);
  assert.equal(result.patch.collection.name, 'Iron Man', 'the card joins its franchise from the title it already had');
  assert.match(result.notes.join(' · '), /joins the “Iron Man” collection/);
});

// ── the API a browse page calls ─────────────────────────────────────────────────────────────
test('a category is paged to its end, and the count is the catalog’s, not the page’s', async () => {
  const many = Array.from({ length: 7 }, (_, index) => card(`Release ${index + 1}`, { slug: `release-${index + 1}` }));
  const repository = await seeded(many);
  await withApi(repository, async (url) => {
    const first = await fetch(`${url}/api/content?limit=2`).then((response) => response.json());
    assert.equal(first.total, 7, 'the shelf reports every card it holds, not the two on this page');
    assert.equal(first.items.length, 2);
    assert.equal(first.pages, 4);
    assert.equal(first.page, 1);
    assert.equal(first.hasMore, true);

    const last = await fetch(`${url}/api/content?limit=2&page=4`).then((response) => response.json());
    assert.equal(last.items.length, 1);
    assert.equal(last.total, 7);
    assert.equal(last.hasMore, false);

    const seen = new Set();
    for (const page of [1, 2, 3, 4]) {
      const body = await fetch(`${url}/api/content?limit=2&page=${page}`).then((response) => response.json());
      for (const item of body.items) seen.add(item.title);
    }
    assert.equal(seen.size, 7, 'walking the pages reaches every release — nothing past the first screen is lost');

    const categories = await fetch(`${url}/api/categories`).then((response) => response.json());
    const movie = categories.categories.find((entry) => entry.id === 'movie');
    assert.equal(movie.count, 7, 'the count on a category tile is counted in the store too');
  });
});

test('the collection endpoints list groups, one group’s cards, and refuse an unknown key', async () => {
  const repository = await seeded([
    card('Iron Man'),
    card('Iron Man 2'),
    card('Iron Man 3', { slug: 'iron-man-3' }),
    card('Unrelated')
  ]);
  await withApi(repository, async (url) => {
    const list = await fetch(`${url}/api/collections`).then((response) => response.json());
    assert.equal(list.collections.length, 1);
    assert.equal(list.collections[0].name, 'Iron Man');
    assert.equal(list.collections[0].count, 3);
    assert.ok(list.collections[0].posterUrls.length >= 0);

    const page = await fetch(`${url}/api/collections/iron-man?limit=2`).then((response) => response.json());
    assert.equal(page.collection.name, 'Iron Man');
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, true);
    const rest = await fetch(`${url}/api/collections/iron-man?limit=2&page=2`).then((response) => response.json());
    assert.equal(rest.items.length, 1);

    const missing = await fetch(`${url}/api/collections/no-such-series`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /collection is not available/i);

    const viaContent = await fetch(`${url}/api/content?collection=iron-man`).then((response) => response.json());
    assert.equal(viaContent.total, 3, 'a collection is also a normal paged listing, so it pages the same way');

    const detail = await fetch(`${url}/api/content/${viaContent.items[0].slug}`).then((response) => response.json());
    assert.equal(detail.item.collection.name, 'Iron Man', 'the release card can point at its group');
    assert.ok(detail.item.collection.key);
  });
});

test('a manual collection name posted to the API is kept, and a cleared one is dropped', async () => {
  const repository = await seeded([card('Iron Man 3', { slug: 'set-by-hand' })]);
  const [target] = await repository.listContent({ limit: 1 });
  const patched = await repository.updateContentByAdminId(target.adminId, { collection: 'Marvel Saga' });
  assert.equal(patched.collection.name, 'Marvel Saga');
  assert.equal(patched.collectionManual, true, 'the hand-set name must not be recomputed away by the next edit');

  const renamed = await repository.updateContentByAdminId(target.adminId, { title: 'Ant-Man 2' });
  assert.equal(renamed.collection.name, 'Marvel Saga', '/title does not silently undo what a publisher typed');

  const released = await repository.updateContentByAdminId(target.adminId, { collection: 'none' });
  assert.equal(released.collection, null);
  const after = await repository.updateContentByAdminId(target.adminId, { title: 'Iron Man 4' });
  assert.equal(after.collection, null, 'a card taken out of its group by hand stays out');
});
