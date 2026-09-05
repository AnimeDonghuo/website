/**
 * Generates src/client/styles-light.css — the light ("Day") theme layer.
 *
 * styles.css was authored dark-first and hardcodes its palette, so re-theming it by
 * hand would mean rewriting every rule and risking the dark look people know. Instead
 * this script walks the dark stylesheet, maps every colour literal through a
 * role-aware table (text colours darken, surface colours lighten, brand fills and
 * scrims over artwork stay put), and emits the same declarations prefixed with
 * `[data-theme='light']`. Nothing in styles.css is modified, so the dark theme renders
 * exactly as before and light mode is purely additive.
 *
 *   node scripts/build-light-theme.mjs          # write the layer
 *   node scripts/build-light-theme.mjs --check  # fail if it drifted (run by npm test)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'src/client/styles.css');
const TARGET = join(root, 'src/client/styles-light.css');

/* Accent tokens that work as *both* text and fill: on a white page the bright brand
 * green is unreadable as text but still right as a button fill, so `color:` uses an
 * ink variant while backgrounds keep the original token. */
const INK_ALIASES = new Map([
  ['--lime', '--lime-ink'],
  ['--violet', '--violet-ink'],
  ['--cyan', '--cyan-ink'],
  ['--orange', '--orange-ink'],
  ['--rose', '--rose-ink'],
  ['--blue', '--blue-ink']
]);

// Panels behind poster artwork, glows, and grain stay dark in both themes: the art is
// authored for a cinema-black surround, and washing it out is the "messy" look to avoid.
// The video surround is a third exception: letterbox bars are black in every player UI,
// and the framed provider keeps its own controls tuned for a dark bezel.
const KEEP_AS_IS = /(^|[\s,])(::selection|\.[\w-]*(art|glow|grain|noise|scrim|backdrop|poster|logo|player-shell)[\w-]*)/;

const COLOR = /#[0-9a-f]{3,8}\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)/gi;
const VAR = /var\(\s*(--[\w-]+)\s*\)/gi;

function parseHex(hex) {
  let value = hex.toLowerCase().replace('#', '');
  if (value.length === 3 || value.length === 4) value = value.split('').map((c) => c + c).join('');
  if (value.length < 6) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
    a: value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1
  };
}

function channels(color) {
  const [max, min] = [Math.max(color.r, color.g, color.b), Math.min(color.r, color.g, color.b)];
  const l = (max + min) / 2 / 255;
  const d = (max - min) / 255;
  const s = max === min ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max !== min) {
    const delta = max - min;
    h = color.r === max ? ((color.g - color.b) / delta) % 6 : color.g === max ? (color.b - color.r) / delta + 2 : (color.r - color.g) / delta + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value) => Math.round(value * 1000) / 1000;

function toHsl(h, s, l, alpha) {
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  const a = alpha === undefined ? 1 : round(alpha);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x]
    : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const parts = [r + m, g + m, b + m].map((value) => Math.round(clamp(value, 0, 1) * 255));
  return a < 1 ? `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})` : `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Text on paper: the dark theme stacks ink in three bands (headline white, secondary
 * silver, muted grey), so the light theme mirrors the bands instead of flattening every
 * colour to black — a placeholder rendered near-black looks broken on white.
 */
function mapText(color) {
  const { h, s } = channels(color);
  const l = colorL(color);
  if (s < 0.18) {
    if (l > 0.78) return toHsl(h, s * 0.5, 0.13);
    if (l > 0.58) return toHsl(h, s * 0.5, 0.26);
    if (l > 0.38) return toHsl(h, s * 0.45, 0.4);
    return null; // already dark: it was ink on a bright chip, and it stays ink
  }
  if (l > 0.58) return toHsl(h, Math.min(s * 1.2, 0.85), 0.27);
  if (l > 0.4) return toHsl(h, s * 1.05, 0.34);
  return null;
}

/**
 * Panels, borders, and fills: dark surfaces lighten, brand fills and near-white stay.
 * Translucent values keep their role — a half-alpha panel is a real surface, so it
 * becomes an opaque light one, while a low-alpha wash becomes a subtle dark tint so it
 * does not vanish against the page.
 */
function mapSurface(color, property) {
  const { h, s } = channels(color);
  const l = colorL(color);
  if (l > 0.82) return null;
  if (s > 0.3 && l > 0.5) return null; // a bright accent fill keeps its punch
  const alpha = color.a;
  if (alpha < 0.5) {
    const wash = clamp(alpha * (l < 0.2 ? 0.5 : 0.75), 0.025, 0.1);
    return `rgba(18, 24, 36, ${round(wash)})`;
  }
  const lightness = (99 - (clamp(l, 0, 0.82) / 0.82) * 13) / 100;
  const saturation = s > 0.3 ? Math.min(s * 0.55, 0.4) : s * 0.6;
  if (property.includes('shadow')) return toHsl(h, saturation * 0.4, Math.min(lightness, 0.42), round(Math.min(alpha, 0.28)));
  if (alpha < 1) return toHsl(h, saturation, lightness, 0.94);
  return toHsl(h, saturation, lightness);
}

function colorL(color) {
  return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
}

function mapValue(property, value) {
  const isText = /^(color|caret-color|-webkit-text-fill-color|text-fill-color)$/.test(property.trim());
  let changed = false;

  let next = value.replace(VAR, (match, token) => {
    if (!isText || !INK_ALIASES.has(token)) return match;
    changed = true;
    return `var(${INK_ALIASES.get(token)})`;
  });

  const mapOne = (match) => {
    const color = match.startsWith('#') ? parseHex(match) : (() => {
      const parts = match.match(/[\d.]+/g) || [];
      if (parts.length < 3) return null;
      return { r: +parts[0], g: +parts[1], b: +parts[2], a: parts.length > 3 ? +parts[3] : 1 };
    })();
    if (!color) return match;
    // white washes (tints, hairlines) become dark washes; black washes over artwork are
    // scrims, so they are kept or softened rather than inverted
    const nearWhite = color.r > 246 && color.g > 246 && color.b > 246;
    if (nearWhite && !isText) {
      changed = true;
      // a hairline or tint over a light page has to become a *subtle* dark wash, while a
      // frosted panel keeps its glass: it usually sits over artwork, which stays dark
      if (property.includes('border') || property.includes('outline') || color.a < 0.3) {
        return `rgba(18, 24, 36, ${round(clamp(color.a * (property.includes('border') ? 0.42 : 1.85), 0.05, property.includes('border') ? 0.24 : 0.32))})`;
      }
      return `rgba(252, 253, 255, ${round(Math.min(0.92, color.a))})`;
    }
    if (nearWhite) {
      const mapped = mapText({ ...color, r: 250, g: 250, b: 252 });
      if (mapped) changed = true;
      return mapped ?? match;
    }
    const nearBlack = color.r < 14 && color.g < 14 && color.b < 14;
    if (nearBlack && color.a >= 0.95 && isText) {
      const mapped = mapText(color);
      if (mapped) { changed = true; return mapped; }
      return match;
    }
    const mapped = isText ? mapText(color) : mapSurface(color, property);
    if (!mapped) return match;
    changed = true;
    return mapped;
  };

  next = next.replace(COLOR, mapOne);

  if (!changed || next === value) return null;
  return next.replace(/\s{2,}/g, ' ');
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
}

function splitDeclarations(block) {
  return block.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const index = entry.indexOf(':');
    return { property: entry.slice(0, index), value: entry.slice(index + 1).trim(), raw: entry };
  });
}

/** Brace-aware walk so @media wrappers keep their shape in the generated layer. */
function rules(css) {
  const out = [];
  let depth = 0;
  let buffer = '';
  let media = null;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') {
      const head = buffer.trim();
      if (head.startsWith('@media') || head.startsWith('@supports')) { media = head; buffer = ''; depth += 1; continue; }
      depth += 1;
      if (depth === 1) out.push({ selector: head, block: '', media });
      else if (out.length) out[out.length - 1].block += `{${head.slice(0, 0)}`;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        if (out.length) out[out.length - 1].block += buffer;
        buffer = '';
        if (media) media = null;
        continue;
      }
    }
    if (depth >= 1 && out.length) out[out.length - 1].block += char;
    else if (depth === 0) buffer += char;
  }
  return out.filter((rule) => rule.selector && !rule.selector.startsWith('@'));
}

function generate(css) {
  const emitted = [];
  let skipped = 0;
  for (const rule of rules(css)) {
    const selector = stripComments(rule.selector);
    if (!selector || KEEP_AS_IS.test(selector)) { skipped += 1; continue; }
    if (/@keyframes|@font-face|@import/.test(selector)) continue;
    rule.selector = selector;
    const declarations = [];
    for (const declaration of splitDeclarations(stripComments(rule.block))) {
      if (!declaration.value || /url\(/i.test(declaration.value)) continue;
      const mapped = mapValue(declaration.property, declaration.value);
      if (mapped) declarations.push(`${declaration.property.trim()}: ${mapped}`);
    }
    if (!declarations.length) continue;
    const selectors = stripComments(rule.selector).split(',').map((selector) => selector.trim()).filter(Boolean);
    for (const selector of selectors) {
      if (KEEP_AS_IS.test(selector)) continue;
      // html/body/:root take their colours from the tokens, which the block above
      // already redefines — and a `[data-theme] html` descendant selector could not match
      if (/^(html|body|:root)(\s|$|[,{])/.test(selector)) continue;
      emitted.push({ media: rule.media, selector: `[data-theme='light'] ${selector}`, declarations });
    }
  }

  const lines = [
    '/* GENERATED FILE — do not edit by hand.',
    ' * Built from styles.css by scripts/build-light-theme.mjs (npm run theme:build).',
    ' * The dark theme lives entirely in styles.css; this layer only adds the light one. */',
    '',
    "[data-theme='light'] {",
    '  color-scheme: light;',
    '  --ink: #151a22;',
    '  --muted: #5c6675;',
    '  --muted-strong: #3e485a;',
    '  --background: #f7f8f5;',
    '  --background-deep: #edeef0;',
    '  --surface: #ffffff;',
    '  --surface-raised: #f3f4f1;',
    '  --line: rgba(18, 24, 36, 0.13);',
    '  --line-strong: rgba(18, 24, 36, 0.2);',
    '  --shadow: 0 20px 55px rgba(18, 24, 36, 0.1);',
    '  --lime-ink: #3c7a12;',
    '  --violet-ink: #5b3fb8;',
    '  --cyan-ink: #0d6f66;',
    '  --orange-ink: #9c5310;',
    '  --rose-ink: #a53a68;',
    '  --blue-ink: #2a5aa8;',
    '}',
    ''
  ];
  let media = null;
  for (const rule of emitted) {
    if (rule.media !== media) {
      if (media) lines.push('}', '');
      if (rule.media) lines.push(`${rule.media} {`, '');
      media = rule.media;
    }
    lines.push(`${rule.selector} { ${rule.declarations.join('; ')}; }`);
  }
  if (media) lines.push('}');
  lines.push('', '/* Hand-tuned on top of the mapped layer. */');
  for (const [at, selector, declaration] of CURATED) {
    const target = selector.startsWith("[data-theme='light']") ? selector : `[data-theme='light'] ${selector}`;
    lines.push(`${target} { ${declaration}; }`);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/* Things a colour map cannot judge: the scrim behind a modal still has to dim the page,
 * and the page's own scrollbars want a light track. Appended last so it wins the cascade. */
const CURATED = [
  [null, ".delivery-dialog", "background: rgba(18, 24, 36, 0.44)"],
  [null, ".adult-gate__dialog", "box-shadow: 0 26px 80px rgba(18, 24, 36, 0.2)"],
  [null, ".site-header", "box-shadow: 0 1px 0 rgba(18, 24, 36, 0.05), 0 14px 30px rgba(18, 24, 36, 0.05)"],
  [null, ".theme-toggle svg", "transition: transform 260ms ease"],
  [null, "[data-theme='light'] ::-webkit-scrollbar-thumb", "background: rgba(18, 24, 36, 0.22)"],
  [null, "[data-theme='light'] ::-webkit-scrollbar-track", "background: rgba(18, 24, 36, 0.05)"]
];

const css = readFileSync(SOURCE, 'utf8');
const output = generate(css);
const current = (() => { try { return readFileSync(TARGET, 'utf8'); } catch { return null; } })();
if (process.argv.includes('--check')) {
  if (current !== output) {
    console.error('src/client/styles-light.css is out of date with styles.css — run: npm run theme:build');
    process.exit(1);
  }
  console.log('styles-light.css is up to date.');
} else {
  writeFileSync(TARGET, output);
  console.log(`wrote ${TARGET.split('/').pop()} (${(output.length / 1024).toFixed(1)} kB, ${output.split('\n').length} lines, from ${(css.length / 1024).toFixed(1)} kB dark)`);
}
