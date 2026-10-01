/**
 * Day/night choice for the site chrome.
 *
 * The dark palette is what `styles.css` paints, so "dark" means *no* extra layer at all;
 * the light palette is a generated override (`scripts/build-light-theme.mjs` →
 * `styles-light.css`) keyed off `data-theme='light'` on `<html>`. An inline script in
 * index.html applies the stored choice before the first paint, so a visitor who picked
 * Day never gets a black flash on the way, and nothing here is needed to render the dark
 * default — a visitor with JavaScript off simply gets the dark site.
 */
export const THEME_STORAGE_KEY = 'sorabox:theme';
export const THEME_EVENT = 'sorabox:themechange';
export const THEME_COLORS = { dark: '#080b12', light: '#f7f8f5' };

/** Only two themes exist; anything else (absent, corrupt, a stale value) is the default. */
export function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

export function readStoredTheme() {
  if (typeof window === 'undefined') return 'dark';
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'dark'; // private mode or storage disabled by browser policy
  }
}

export function currentTheme() {
  if (typeof document === 'undefined') return 'dark';
  return normalizeTheme(document.documentElement.dataset.theme);
}

/**
 * Paints the choice and, with `remember`, keeps it for the next visit. `theme-color`
 * follows because mobile browsers paint the address bar from it, and leaving it dark
 * under a white page is the part that would look unfinished.
 */
export function applyTheme(theme, { remember = true } = {}) {
  const next = normalizeTheme(theme);
  if (typeof document === 'undefined') return next;
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[next]);
  if (remember) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch { /* the choice then lasts for this visit only, which is fine */ }
  }
  return next;
}
