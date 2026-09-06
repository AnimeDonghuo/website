import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const styles = readFileSync(join(root, 'src/client/styles.css'), 'utf8');
const header = readFileSync(join(root, 'src/client/components/Header.jsx'), 'utf8');
const app = readFileSync(join(root, 'src/client/App.jsx'), 'utf8');

// styles.css repeats a breakpoint in several blocks, one per concern, so "what applies at
// this width" is the union of them all rather than whichever was written first
function rulesInside(breakpoint) {
  let found = '';
  const opener = `@media (${breakpoint}) {`;
  let cursor = 0;
  for (;;) {
    const start = styles.indexOf(opener, cursor);
    if (start === -1) break;
    const end = styles.indexOf('\n}', start);
    assert.notEqual(end, -1, `${opener} is never closed`);
    found += styles.slice(start, end);
    cursor = end + 1;
  }
  assert.ok(found, `${breakpoint} has no block`);
  return found;
}

test('search stays in the header at every width instead of hiding in the menu', () => {
  const wide = styles.slice(0, styles.indexOf('@media'));
  assert.match(wide, /\.header-search \{[^}]*display: flex/, 'the desktop header keeps its search pill');
  assert.match(wide, /\.header-search-toggle \{[^}]*display: none/, 'the icon only exists where the pill cannot fit');
  assert.match(wide, /\.header-search-panel \{[^}]*display: none/);

  const narrow = rulesInside('max-width: 760px');
  assert.match(narrow, /\.desktop-nav, \.header-search, \.header-telegram \{ display: none/, 'the pill still steps aside on a narrow screen');
  assert.match(narrow, /\.header-search-toggle \{ display: grid/, 'and the search icon takes its place');
  assert.match(narrow, /\.header-search-panel \{[^}]*position: absolute/, 'the field slides down under the header');
  assert.match(narrow, /\.header-search-panel--open \{[^}]*visibility: visible/);

  // Media-query rules are never mirrored into styles-light.css, so anything inside the
  // 760px block has to be painted from the tokens — otherwise Day mode gets a black strip
  // with white ink on it. That is the whole reason the panel differs from the drawer here.
  const panel = narrow.match(/\.header-search-panel \{([^}]*)\}/)[1];
  assert.match(panel, /background: var\(--background\)/);
  assert.match(panel, /border-bottom: 1px solid var\(--line\)/);
  assert.ok(!/rgba\(10,13,21/.test(panel), 'no hardcoded night colour in a themed strip');
  assert.match(narrow, /\.header-search-panel input \{[^}]*color: var\(--ink\)/);
  assert.match(narrow, /\.header-search-toggle:active \{ background: var\(--surface\)/);
});

test('the header search opens on tap, closes on Escape, and never fights the menu', () => {
  assert.match(header, /const \[searchOpen, setSearchOpen\] = useState\(false\)/);
  assert.match(header, /panelInput\.current\?\.focus\(\)/, 'tapping the icon has to leave the keyboard ready');
  assert.match(header, /event\.key === 'Escape'/);
  assert.match(header, /aria-expanded=\{searchOpen\}/);
  assert.match(header, /tabIndex=\{searchOpen \? 0 : -1\}/, 'a closed strip must not sit in the tab order');
  // opening one closes the other: the strip and the drawer share the same space under the header
  assert.match(header, /onClick=\{\(\) => \{\s*setOpen\(\(value\) => !value\);\s*setSearchOpen\(false\);\s*\}\}/);
  assert.match(header, /setSearchOpen\(false\);\s*\}\}/, 'the search button closes the drawer');
  assert.match(header, /className="header-search"/, 'the desktop pill is still rendered');
});

test('the results page says what search actually covers', () => {
  assert.match(app, /Searches titles, episode numbers, genres and available languages/);
});
