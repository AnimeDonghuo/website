import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { createApp } from '../src/server/index.js';

// A listing is the one part of the site every visitor touches, and its paging contract used to be
// verified by hand against a running server. These tests boot the real app over the memory store so
// the envelope — which page you got, how big the shelf is, whether more exists — is checked rather
// than assumed.
const config = { telegram: { botUsername: 'ExampleDeliveryBot' }, streaming: {} };
const SHELF = 45;

let server;
let base;

async function listing(path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

before(async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  for (let index = 1; index <= SHELF; index += 1) {
    await repository.createContent({
      title: `Paged Title ${String(index).padStart(2, '0')}`,
      category: 'anime',
      slug: `paged-${index}`,
      genres: index % 3 === 0 ? ['Action'] : ['Drama'],
      files: [{ name: `Paged.Title.${String(index).padStart(2, '0')}.1080p.mkv` }]
    });
  }
  await repository.createContent({
    title: 'Grown Up Release',
    category: 'adult',
    slug: 'grown-up-release',
    files: [{ name: 'Grown.Up.1080p.mkv' }]
  });
  server = createApp({ config, repository }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('a listing answers with one page and the size of the whole shelf', async () => {
  const { body } = await listing('/api/content?category=anime&limit=30');
  assert.equal(body.items.length, 30, 'a page holds the thirty cards it was asked for');
  assert.equal(body.total, SHELF, 'the count is the shelf, not the page');
  assert.equal(body.page, 1);
  assert.equal(body.pages, 2);
  assert.equal(body.hasMore, true);
  assert.ok(!body.items.some((item) => item.category === 'adult'), '18+ is nowhere in a public listing');
});

test('a page number past the end lands on the last page that has cards', async () => {
  const { body } = await listing('/api/content?category=anime&limit=30&page=99');
  assert.equal(body.page, 2, 'a mistyped address is not an empty catalog');
  assert.equal(body.items.length, SHELF - 30, 'and the grid still holds the remainder of the shelf');
  assert.equal(body.pages, 2);
  assert.equal(body.hasMore, false, 'so the pager can say the shelf ends here');
});

test('the pages of a shelf cover every card exactly once', async () => {
  const seen = [];
  for (let page = 1; page <= 4; page += 1) {
    const { body } = await listing(`/api/content?category=anime&limit=20&page=${page}`);
    assert.equal(body.page, Math.min(page, body.pages), 'page three of two is page two');
    seen.push(...body.items.map((item) => item.slug));
    if (!body.hasMore) break;
  }
  const unique = [...new Set(seen)].sort();
  assert.equal(seen.length, unique.length, 'no card was shown twice across the pages');
  // The store derives the slug from the title, so that is what a listing has to hand back.
  assert.deepEqual(unique, Array.from({ length: SHELF }, (_, index) => `paged-title-${String(index + 1).padStart(2, '0')}`).sort());
});

test('a genre listing pages the same way, and the limit stays inside its cap', async () => {
  const genre = await listing('/api/content?genre=Action&limit=30');
  assert.equal(genre.body.total, 15, 'every third card carries the tag');
  assert.equal(genre.body.pages, 1);
  assert.equal(genre.body.hasMore, false);
  const capped = await listing('/api/content?category=anime&limit=500');
  assert.equal(capped.body.limit, 100, 'the API will not be asked to hand over the whole catalog');
});
