import crypto from 'node:crypto';

export const CATEGORIES = [
  { id: 'anime', label: 'Anime', shortLabel: 'Anime', tone: 'violet' },
  { id: 'cartoon', label: 'Cartoons', shortLabel: 'Cartoon', tone: 'orange' },
  { id: 'donghua', label: 'Donghua', shortLabel: 'Donghua', tone: 'cyan' },
  { id: 'kdrama', label: 'K-Drama', shortLabel: 'K-Drama', tone: 'rose' },
  { id: 'movie', label: 'Movies', shortLabel: 'Movie', tone: 'lime' },
  { id: 'web-series', label: 'Web Series', shortLabel: 'Series', tone: 'blue' },
  // Adult releases are intentionally a first-class category so their private
  // storage source and public age gate can be enforced consistently.
  { id: 'adult', label: '18+', shortLabel: '18+', tone: 'crimson' }
];

export const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));

export function categoryDetails(category) {
  return CATEGORIES.find((entry) => entry.id === category) || {
    id: category,
    label: 'Collection',
    shortLabel: 'Collection',
    tone: 'violet'
  };
}

export function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);

  return slug || 'untitled-release';
}

export function makeShareCode() {
  return crypto.randomBytes(7).toString('base64url');
}

export function makeReference(prefix = 'SB') {
  return `${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

export function cleanText(value, maxLength = 280) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function parseCommandArgument(text, maxLength = 180) {
  return cleanText(String(text || '').replace(/^\/\S+\s*/, ''), maxLength);
}

/**
 * The same argument, but with the publisher's line breaks kept: a player paste
 * names its episode on each line, and collapsing the lines would move every
 * link after the first label onto that one episode.
 */
export function cleanMultilineText(value, maxLength = 2_000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

export function parseMultilineCommandArgument(text, maxLength = 2_000) {
  return cleanMultilineText(String(text || '').replace(/^\/\S+\s*/, ''), maxLength);
}

export function titleInitials(title) {
  const initials = String(title || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0])
    .join('');

  return initials.toUpperCase() || 'SB';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}
