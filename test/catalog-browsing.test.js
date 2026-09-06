import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const api = read('src/client/api.js');
const app = read('src/client/App.jsx');
const header = read('src/client/components/Header.jsx');
const styles = read('src/client/styles.css');

// ── paging ──────────────────────────────────────────────────────────────────────────────────
test('a browse request asks for a page instead of the whole catalog', () => {
  assert.match(api, /export async function getContent\(\{ category, query, genre, collection, page = 1, limit = 60 \}/);
  assert.match(api, /params\.set\('page', page\)/);
  assert.match(api, /params\.set\('limit', limit\)/);
  assert.match(api, /params\.set\('genre', genre\)/);
  assert.match(api, /params\.set\('collection', collection\)/);
  // Nothing in the client asks for a fixed hundred any more — that was the cap that hid older posts.
  assert.doesNotMatch(app, /getContent\(\{[^}]*limit: 100/);
  assert.match(app, /getContent\(\{ category, genre, page, limit: 60 \}\)/);
});

test('the results grid keeps its pages and offers the next one', () => {
  assert.match(app, /function useCatalog\(fetchPage, dependencies = \[\]\)/);
  // The pager speaks in counts the store produced, not in the length of the array on screen.
  assert.match(app, /Showing <strong>\{catalog\.items\.length\}<\/strong> of <strong>\{catalog\.total\}<\/strong>/);
  assert.match(app, /Load \$\{Math\.min\(remaining, 60\)\} more/);
  assert.match(app, /That is the whole shelf — nothing is waiting past this page\./);
  // An append, never a replace: what the reader scrolled past stays on screen.
  assert.match(app, /items: \[\.\.\.previous\.items, \.\.\.\(Array\.isArray\(data\.items\) \? data\.items : \[\]\)\]/);
  // And a page that arrives after the reader moved on is dropped, not appended to the new listing.
  assert.match(app, /if \(!data \|\| listing !== listingId\.current\) return;/);
  assert.match(app, /const catalog = useCatalog\(/, 'the browse page pages through the category');
  assert.equal(app.match(/<CatalogPager /g).length, 3, 'browse, search, and a collection page all end in a pager');
});

test('a failed page leaves the cards already shown where they are', () => {
  assert.match(app, /loadingMore: false, error \}\)/);
  assert.match(app, /The cards above are still here — press the button to try again\./);
  assert.match(app, /catalog\.error && !catalog\.items\.length \? <ErrorBlock/, 'only an empty grid turns into an error block');
});

// ── categories and genres, from the menu ─────────────────────────────────────────────────────
test('the hamburger menu opens the shelves a visitor can click, and never lists 18+', () => {
  assert.match(header, /import \{ getCategories, getGenres \} from '\.\.\/api\.js';/);
  assert.match(header, /onClick=\{toggleShelves\}/);
  assert.match(header, /Genres &amp; categories/);
  assert.match(header, /to="\/collections"/);
  // Fetched when the panel is opened, not on every page load.
  assert.match(header, /if \(!next \|\| shelvesFetched\.current\) return;/);
  assert.match(header, /categories: \(categoryData\.categories \|\| \[\]\)\.filter\(\(category\) => category\.id !== 'adult'\)/);
  assert.match(header, /setShelvesOpen\(false\);\s*\}, \[location\.pathname\]\)/, 'a navigation closes the panel with the menu');
  // A fetch that failed has to be retryable rather than an empty panel forever.
  assert.match(header, /shelvesFetched\.current = false;/);
  // Both the drawer and the genre page hand the reader the same kind of link.
  assert.match(header, /key=\{genre\.name\} to=\{`\/browse\?genre=\$\{encodeURIComponent\(genre\.name\)\}`\}/);
  assert.match(app, /className="genre-tile"[^`]*`\/browse\?genre=\$\{encodeURIComponent\(genre\.name\)\}`/);
});

test('a genre page is a shelf across categories, and 18+ is left out of it server-side too', () => {
  assert.match(app, /const genre = params\.get\('genre'\)\?\.trim\(\) \|\| '';/);
  assert.match(app, /\/browse\?genre=/, 'the drawer and the genre page use the same route shape');
  assert.match(app, /<Route path="\/genres" element=\{<GenresPage \/>} \/>/);
  // Adult content is never listed by the endpoints a public menu reads: both stores skip the
  // category inside the listing itself, so a genre page cannot be reached into from the menu and
  // cannot be asked for by URL either (see catalog-collections.test.js for the behaviour).
  assert.match(read('src/server/index.js'), /app\.get\('\/api\/genres'/);
  assert.match(read('src/server/catalog.repository.js'), /if \(item\.category === 'adult'\) continue;/);
  assert.match(read('src/server/catalog.repository.js'), /category: \{ \$ne: 'adult' \}, genres/);
});

// ── collections ───────────────────────────────────────────────────────────────────────────────
test('collections are browsable, and a release points at the rest of its series', () => {
  assert.match(api, /export async function getCollections\(\)/);
  assert.match(api, /export async function getCollection\(key, \{ page = 1, limit = 60 \} = \{\}\)/);
  assert.match(app, /<Route path="\/collections" element=\{<CollectionsPage \/>\} \/>/);
  assert.match(app, /<Route path="\/collection\/:key" element=\{<CollectionPage \/>\} \/>/);
  // A detail page links its group, and only when it has one.
  assert.match(app, /\{item\.collection \? \(\s*<Link className="collection-chip"/);
  assert.match(app, /Part of the <strong>\{item\.collection\.name\}<\/strong> collection/);
  // The index page offers a group only for what the store says has more than one title.
  assert.match(api, /return request\('\/collections'\)/);
});

test('the new surfaces are styled, and none of them is a rewrite', () => {
  const selectors = ['.catalog-pager', '.catalog-pager__more', '.catalog-pager__end', '.genre-grid', '.genre-tile', '.shelf-grid', '.shelf-tile', '.collection-grid', '.collection-card', '.collection-chip', '.collection-titles', '.mobile-menu__shelf-panel', '.mobile-menu__genre-chips', '.browse-results__actions'];
  for (const selector of selectors) {
    const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`);
    assert.match(styles, pattern, `${selector} needs its own rule`);
  }
  // The Collections button stays on the page at every width, where the category filter is a
  // narrow-screen control; the base rule is what it is added to.
  assert.match(styles, /\.browse-results__actions \.collections-button, \.browse-results__actions \.genres-button \{ display: inline-flex; \}/);
  assert.match(styles, /\.filter-button \{ display: none;/, 'the category popover keeps its old breakpoint');
});
