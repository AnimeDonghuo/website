import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { normalizeTheme, readStoredTheme, THEME_COLORS, THEME_STORAGE_KEY } from '../src/client/theme.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dark = readFileSync(join(root, 'src/client/styles.css'), 'utf8');
const light = readFileSync(join(root, 'src/client/styles-light.css'), 'utf8');
const rule = (selector) => {
  const match = light.match(new RegExp(`\\[data-theme='light'\\] ${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
  return match ? match[1] : null;
};
const luminance = (hex) => {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

test('the light layer is regenerated from styles.css, never edited by hand', () => {
  // a rule added to styles.css with no matching light rule is the failure this guards:
  // the site would silently go white-on-white in Day mode for exactly that component
  assert.doesNotThrow(
    () => execFileSync(process.execPath, [join(root, 'scripts/build-light-theme.mjs'), '--check'], { encoding: 'utf8' }),
    'styles-light.css has drifted from styles.css'
  );
});

test('Day mode keeps the page dark-on-light instead of inverting the brand', () => {
  const ink = ['#151a22', '#5c6675', '#3e485a'];
  ink.forEach((hex) => assert.ok(luminance(hex) < 0.45, `${hex} is too light for ink on white`));
  for (const token of ['--ink', '--muted', '--background', '--surface', '--line']) {
    assert.match(light, new RegExp(`${token}:`), `the light layer must redefine ${token}`);
  }
  assert.match(dark, /--background: #080b12/, 'night remains the default palette');
  assert.match(dark, /color-scheme: dark/, 'native controls and scrollbars follow the theme');

  // the accent doubles as text and as a fill, so `color:` gets an ink sibling
  assert.match(rule('.eyebrow'), /color: var\(--lime-ink\)/);
  assert.match(rule('.desktop-nav__link'), /color: #/);
  assert.ok(luminance(rule('.desktop-nav__link').match(/#([0-9a-f]{6})/)[0]) < 0.4);
});

test('nothing in the generated layer paints light text or re-themes the video surround', () => {
  const offenders = [];
  for (const [selector, body] of light.matchAll(/\[data-theme='light'\] ([^{]+)\{([^}]*)\}/g)) {
    for (const [, value] of body.matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)) {
      for (const hex of value.match(/#[0-9a-f]{6}\b/g) || []) {
        if (luminance(hex) > 0.6) offenders.push(`${selector.trim()} → color: ${hex}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'light-on-light text in Day mode');
  assert.equal(rule('.watch-player-shell'), null, 'the player surround stays black in both themes');
  assert.equal(rule('.hero__art'), null, 'art panels keep their cinema-black wash');
});

test('an unreadable stored theme falls back to night rather than a half-applied Day mode', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme(null), 'dark');
  assert.equal(normalizeTheme('os-light'), 'dark');
  assert.equal(readStoredTheme(), 'dark', 'no window means the server-side default');
  assert.deepEqual(Object.keys(THEME_COLORS).sort(), ['dark', 'light']);
  assert.equal(THEME_STORAGE_KEY, 'sorabox:theme');
});
