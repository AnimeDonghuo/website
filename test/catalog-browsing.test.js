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
  assert.match(header, /<p className="mobile-menu__label">Explore<\/p>/, 'the section is labelled, so it reads as part of the menu');
  assert.match(header, /className=\{`mobile-menu__row \$\{shelvesOpen \? 'is-active' : ''\}`\}/);
  assert.match(header, /aria-controls="mobile-shelf-panel"/);
  assert.doesNotMatch(header, /mobile-menu__shelf-toggle/, 'no bordered boxes waiting at the foot of a plain list');
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
  const selectors = ['.catalog-pager', '.catalog-pager__more', '.catalog-pager__end', '.genre-grid', '.genre-tile', '.shelf-grid', '.shelf-tile', '.collection-grid', '.collection-card', '.collection-chip', '.collection-titles', '.mobile-menu__shelf-panel', '.mobile-menu__genre-chips', '.mobile-menu__row', '.mobile-menu__label', '.browse-results__actions', '.shelf-button', '.browse-shelf-panel'];
  for (const selector of selectors) {
    const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`);
    assert.match(styles, pattern, `${selector} needs its own rule`);
  }
});

test('the row under a listing heading is one control shape, in one line', () => {
  // Three pills of the same height and weight. What it replaced was two links and a differently
  // styled button wrapping into a ragged column on the right of the count.
  assert.match(styles, /\.shelf-button \{[^}]*height: 31px[^}]*white-space: nowrap/);
  assert.match(styles, /\.shelf-button\.is-active \{ color: #172109; border-color: var\(--lime\); background: var\(--lime\); \}/, 'an active shelf is lit, not underlined');
  assert.match(app, /className=\{`shelf-button \$\{genre \? 'is-active' : ''\}\`\}/, 'a genre page lights the Genres button');
  // A shelf with nothing on it is dimmed and dashed, so a dead end is visible before the tap.
  assert.match(styles, /\.shelf-tile--empty \{[^}]*border-style: dashed/);
  assert.match(app, /shelf-tile \$\{category\.count \? '' : 'shelf-tile--empty'\}/);
  // On a phone the three share one row of equal widths instead of crowding the count line.
  assert.match(styles, /\.browse-results__actions \{ display: grid; grid-template-columns: repeat\(3, minmax\(0,1fr\)\); gap: 7px; \}/);
  assert.match(styles, /@media \(max-width: 410px\) \{\s*\/\* Three equal buttons[\s\S]*?\.browse-results__actions \.shelf-button > svg:first-child \{ display: none; \}/, 'the icons step aside before the labels get clipped');
});

test('the category control only exists where the hero rail is hidden, and expands in place', () => {
  assert.match(styles, /\.browse-results__actions \.shelf-button--categories \{ display: none; \}/);
  assert.match(styles, /\.browse-results__actions \.shelf-button--categories \{ display: inline-flex; \}/);
  // A popover floating over the grid it is meant to change became the second ugly thing on the page.
  assert.match(styles, /\.browse-shelf-panel\.is-open \{ max-height: 120px; visibility: visible; margin: 13px 0 20px/);
  assert.match(app, /className=\{`browse-shelf-panel \$\{filterOpen \? 'is-open' : ''\}\`\} id="browse-shelf-panel" aria-hidden=\{!filterOpen\}/);
  assert.doesNotMatch(styles, /\.filter-button|\.browse-filter-popover/, 'the popover it replaced is gone, not left behind as dead CSS');
  assert.doesNotMatch(app, /filter-button|browse-filter-popover/);
});

test('the drawer is a solid surface that follows the theme, not a panel fading the page through it', () => {
  // Two things made the open menu look unfinished in a screenshot: it faded in over 160ms, so the
  // cards behind it showed through the rows, and it was painted with night colours hardcoded inside
  // a narrow media block — which the theme generator cannot re-colour, so Day mode got a black slab
  // with dark text. It is gated by visibility now, and painted from --menu-* tokens.
  assert.match(styles, /--menu-surface: #0a0d15;/);
  assert.match(styles, /--menu-ink: #b7bfca;/);
  assert.match(styles, /\.mobile-menu \{ display: none; border-bottom: 1px solid transparent; background: var\(--menu-surface\); box-shadow: var\(--menu-shadow\); visibility: hidden; pointer-events: none/);
  assert.match(styles, /\.mobile-menu--open \{ visibility: visible; pointer-events: auto; border-color: var\(--menu-line\); \}/);
  assert.doesNotMatch(styles, /\.mobile-menu \{[^}]*opacity: 0/);
  const layout = styles.match(/\.mobile-menu \{ position: absolute;[^}]*\}/)[0];
  assert.doesNotMatch(layout, /#[0-9a-f]{3,8}|rgba?\(/i, 'no hardcoded colour inside the drawer layout rule, because nothing out there gets re-mapped');
  assert.match(read('scripts/build-light-theme.mjs'), /--menu-surface: #f1f2f4;/, 'and Day mode has a light drawer, so the light ink has something under it');
  // The two new rows keep the nav list's rhythm instead of wearing their own box.
  assert.match(styles, /\.mobile-menu__row \{[^}]*border-bottom: 1px solid var\(--menu-line\)/);
  assert.match(styles, /\.mobile-menu__label \{[^}]*border-top: 1px solid var\(--menu-line\)/, 'and the section is labelled, so they read as part of the menu');
  assert.match(styles, /\.mobile-menu__shelf-panel \{[^}]*border-left: 1px solid var\(--menu-line\)/, 'an opened panel nests under its row instead of being pasted after it');
});

test('a shelf line never pastes half of the hero headline into a count', () => {
  // `188 releases in Anime worth crossing worlds for` was the old sentence: it took the first
  // clause of the hero title as the category name.
  assert.match(app, /category \? `in \$\{categoryLabels\[category\]\}` : 'in the catalog'/);
  assert.doesNotMatch(app, /categoryCopy\[category\]\.title\.split/);
  assert.match(styles, /\.browse-results__top p strong \{[^}]*font-variant-numeric: tabular-nums/, 'and the number does not jitter as pages arrive');
});
