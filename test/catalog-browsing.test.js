import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
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
test('a browse listing names its page in the URL and asks for one screen of cards', () => {
  assert.match(api, /export async function getContent\(\{ category, query, genre, page = 1, limit = 60 \}/);
  assert.match(api, /params\.set\('page', page\)/);
  assert.match(api, /params\.set\('limit', limit\)/);
  assert.match(api, /params\.set\('genre', genre\)/);
  // Nothing asks for a fixed hundred any more: the cap is what hid older posts, and a grid that
  // grows to hundreds of posters is what made an appended shelf crawl on a phone.
  assert.doesNotMatch(app, /getContent\(\{[^}]*limit: 100/);
  assert.match(app, /getContent\(\{ category, genre, page: requested, limit: 30 \}\)/);
  assert.match(app, /getContent\(\{ query, page: requested, limit: 30 \}\)/);
  assert.match(app, /const page = Math\.max\(1, Number\.parseInt\(params\.get\('page'\), 10\) \|\| 1\);/, 'the page lives in the URL, so a listing can be shared and Back works');
  assert.match(app, /if \(next <= 1\) params\.delete\('page'\);/, 'and page one is the plain listing URL rather than ?page=1');
});

test('a page number replaces the grid instead of stacking another page under it', () => {
  assert.match(app, /function useCatalog\(fetchPage, dependencies = \[\], page = 1\)/);
  assert.match(app, /fetchPage\(page\)/);
  // No append, so the page holds one screen of cards however deep into the shelf the reader is.
  assert.doesNotMatch(app, /items: \[\.\.\.previous\.items/);
  assert.doesNotMatch(app, /loadMore|loadingMore|catalog-pager__more|catalog-pager__end/, 'there is no "load more" left to grow the grid');
  // The count line states which slice is on screen, using the numbers the store produced.
  assert.match(app, /Showing <strong>\{from\}&ndash;\{to\}<\/strong> of <strong>\{catalog\.total\}<\/strong>/);
  assert.match(app, /const size = catalog\.limit \|\| catalog\.items\.length;/);
  // Navigating to a page lands the reader at the top of the grid they asked for, clear of the header,
  // and it happens on the way out so the new page arrives there rather than swapping under their feet.
  assert.match(app, /if \(rendered\.current !== 0 && rendered\.current !== page\) scrollToListingTop\(\);/);
  assert.match(app, /const near = Math\.abs\(target - window\.scrollY\) < window\.innerHeight \* 1\.5;/);
  assert.match(app, /behavior: !reduced && near \? 'smooth' : 'auto'/, 'a long jump is a jump, not a glide');
  assert.match(app, /data-listing-top>/, 'a listing marks its own top so the scroll has somewhere to land');
  // Page numbers are links, so a middle click, a back press and a copied URL behave like pages.
  assert.match(app, /function pageNumbers\(current, pages\)/);
  assert.match(app, /aria-label=\{`Page \$\{step\}`\}>\{step\}<\/Link>/);
  assert.match(app, /aria-current="page"/);
  // A page still in flight when the reader moves on is dropped rather than painted over the new one.
  assert.match(app, /if \(!active \|\| !data \|\| listing !== listingId\.current\) return;/);
  assert.equal(app.match(/<CatalogPager /g).length, 2, 'browse and search each end in a pager');
});

test('a page that fails to load leaves the page that did load on screen', () => {
  assert.match(app, /setState\(\(previous\) => \(\{ \.\.\.previous, loading: false, error, errorPage: page \}\)\)/);
  assert.match(app, /Page \{catalog\.errorPage \|\| current\} did not load — the cards above are the page that did\./);
  assert.match(app, /className="catalog-pager__retry" onClick=\{catalog\.retry\}>Try again</);
  assert.match(app, /catalog\.error && !catalog\.items\.length \? <ErrorBlock/, 'only an empty grid turns into an error block');
});

test('the listing surfaces all have their own rule, and none of them is a rewrite', () => {
  const selectors = ['.catalog-pager', '.catalog-pager__count', '.catalog-pager__pages', '.catalog-pager__step', '.catalog-pager__num', '.catalog-pager__gap', '.catalog-pager__retry', '.catalog-pager__error', '.genre-grid', '.genre-tile', '.shelf-grid', '.shelf-tile', '.shelf-tile--empty', '.mobile-menu__shelf-panel', '.mobile-menu__genre-chips', '.mobile-menu__row', '.browse-results__actions', '.shelf-button', '.browse-shelf-panel'];
  for (const selector of selectors) {
    // Some rules are shared by two selectors, so a comma is allowed before the brace.
    const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:,\\s*[^{]+)?\\s*\\{`);
    assert.match(styles, pattern, `${selector} needs its own rule`);
  }
  // A thumb has to be able to hit a page number, and the page you are on has to be obvious.
  assert.match(styles, /\.catalog-pager__step, \.catalog-pager__num \{ min-width: 38px; height: 38px; \}/);
  assert.match(styles, /\.catalog-pager__num\.is-current \{ color: #172109; border-color: var\(--lime\); background: var\(--lime\); \}/);
  assert.match(styles, /\.catalog-pager__step\.is-off \{ pointer-events: none; opacity: \.38; \}/, 'a step that leads nowhere does not react to a tap');
});

// ── categories and genres, from the menu ─────────────────────────────────────────────────────
test('the hamburger menu opens the shelves a visitor can click, and never lists 18+', () => {
  assert.match(header, /import \{ getCategories, getGenres \} from '\.\.\/api\.js';/);
  assert.match(header, /onClick=\{toggleShelves\}/);
  assert.match(header, /className=\{`mobile-menu__row \$\{shelvesOpen \? 'is-active' : ''\}`\}/);
  assert.match(header, /aria-controls="mobile-shelf-panel"/);
  assert.doesNotMatch(header, /mobile-menu__shelf-toggle/, 'no bordered boxes waiting at the foot of a plain list');
  assert.match(header, /Genres &amp; categories/);
  // Fetched when the panel is opened, not on every page load.
  assert.match(header, /if \(!next \|\| shelvesFetched\.current\) return;/);
  assert.match(header, /categories: \(categoryData\.categories \|\| \[\]\)\.filter\(\(category\) => category\.id !== 'adult'\)/);
  assert.match(header, /setShelvesOpen\(false\);\s*\}, \[location\.pathname\]\)/, 'a navigation closes the panel with the menu');
  // A fetch that failed has to be retryable rather than an empty panel forever.
  assert.match(header, /shelvesFetched\.current = false;/);
  // Both the drawer and the genre page hand the reader the same kind of link.
  assert.match(header, /key=\{genre\.name\} to=\{`\/browse\?genre=\$\{encodeURIComponent\(genre\.name\)\}`\}/);
  assert.match(app, /className="genre-tile"[^`]*`\/browse\?genre=\$\{encodeURIComponent\(genre\.name\)}`/);
});

test('a genre page is a shelf across categories, and 18+ is left out of it server-side too', () => {
  assert.match(app, /const genre = params\.get\('genre'\)\?\.trim\(\) \|\| '';/);
  assert.match(app, /\/browse\?genre=/, 'the drawer and the genre page use the same route shape');
  assert.match(app, /<Route path="\/genres" element=\{<GenresPage \/>\} \/>/);
  // Adult content is never listed by the endpoints a public menu reads: both stores skip the
  // category inside the listing itself, so a genre page cannot be reached into from the menu and
  // cannot be asked for by URL either.
  assert.match(read('src/server/index.js'), /app\.get\('\/api\/genres'/);
  assert.match(read('src/server/catalog.repository.js'), /if \(item\.category === 'adult'\) continue;/);
  assert.match(read('src/server/catalog.repository.js'), /category: \{ \$ne: 'adult' \}, genres/);
});

// ── the shelf row under a listing heading ─────────────────────────────────────────────────────
test('the row under a listing heading is one control shape, in one line', () => {
  // Pills of the same height and weight. What it replaced was two links and a differently
  // styled button wrapping into a ragged column on the right of the count.
  assert.match(styles, /\.shelf-button \{[^}]*height: 31px[^}]*white-space: nowrap/);
  assert.match(styles, /\.shelf-button\.is-active \{ color: #172109; border-color: var\(--lime\); background: var\(--lime\); \}/, 'an active shelf is lit, not underlined');
  assert.match(app, /className=\{`shelf-button \$\{genre \? 'is-active' : ''\}`\}/, 'a genre page lights the Genres button');
  // A shelf with nothing on it is dimmed and dashed, so a dead end is visible before the tap.
  assert.match(styles, /\.shelf-tile--empty \{[^}]*border-style: dashed/);
  assert.match(app, /shelf-tile \$\{category\.count \? '' : 'shelf-tile--empty'\}/);
  // On a phone they share one row of equal widths instead of crowding the count line.
  assert.match(styles, /\.browse-results__actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0,1fr\)\); gap: 7px; \}/);
  assert.match(styles, /@media \(max-width: 410px\) \{\s*\/\* Equal-width buttons[\s\S]*?\.browse-results__actions \.shelf-button > svg:first-child \{ display: none; \}/, 'the icons step aside before the labels get clipped');
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

test('a shelf line never pastes half of the hero headline into a count', () => {
  // `188 releases in Anime worth crossing worlds for` was the old sentence: it took the first
  // clause of the hero title as the category name.
  assert.match(app, /category \? `in \$\{categoryLabels\[category\]\}` : 'in the catalog'/);
  assert.doesNotMatch(app, /categoryCopy\[category\]\.title\.split/);
  assert.match(styles, /\.browse-results__top p strong \{[^}]*font-variant-numeric: tabular-nums/, 'and the number does not jitter as pages arrive');
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
  // The one row the section is made of keeps the nav list's rhythm instead of wearing its own box.
  assert.match(styles, /\.mobile-menu__row \{[^}]*border-bottom: 1px solid var\(--menu-line\)/);
  assert.match(styles, /\.mobile-menu__shelf-panel \{[^}]*border-left: 1px solid var\(--menu-line\)/, 'an opened panel nests under its row instead of being pasted after it');
});

// ── collections: removed on purpose ───────────────────────────────────────────────────────────
test('the catalog has no collection feature left in it, at any layer', () => {
  // A derived franchise group was tried and taken out again at the publisher's request, so this
  // guards the removal itself: a half-wired feature (a link to a route that no longer exists, a
  // field nobody reads, a rule in a stylesheet) is worse than either choice made cleanly.
  assert.doesNotMatch(api, /collection/i, 'the client API asks for no collection');
  assert.doesNotMatch(app, /\/collections|collection-chip|CollectionsPage|CollectionPage/, 'no page, no route, and no chip on a release');
  assert.doesNotMatch(header, /\/collections/, 'and the drawer does not advertise one');
  assert.doesNotMatch(styles, /\.collection-/, 'no dead CSS rule kept for a page that is gone');
  assert.doesNotMatch(read('src/client/styles-light.css'), /\.collection-/, 'and the generated light layer agrees');

  const server = read('src/server/index.js');
  const repository = read('src/server/catalog.repository.js');
  assert.doesNotMatch(server, /collectionKey|\/api\/collections|publicCollection/, 'the API serves no collection endpoint');
  assert.doesNotMatch(repository, /collectionKey|listCollections|findCollection|collectionEntries/, 'neither store groups or filters by it');
  assert.doesNotMatch(repository, /deriveCollection|resolveCollection|normalizeCollection/, 'and a card stores no franchise field at all');
  assert.equal(
    server.match(/^\s*collection: /m),
    null,
    'a public card carries no collection key for a client to read'
  );

  const bot = read('src/server/services/telegram-bot.js');
  assert.doesNotMatch(bot, /bot\.command\('collection'/, 'publishers are not offered a command for it');
  assert.doesNotMatch(bot, /'category', 'languages', 'subtitleLanguages', 'genres', 'status', 'releaseLabel', 'year', 'collection'/, 'and it is not a bulk-editable field either');
  assert.doesNotMatch(repository, /'collection', 'collectionManual'/, 'so /repair re-derives nothing about it');
  assert.equal(existsSync(join(root, 'src/server/services/collection-service.js')), false, 'and the module that derived it is gone');
});
