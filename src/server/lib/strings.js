import crypto from 'node:crypto';

export const CATEGORIES = [
  { id: 'anime', label: 'Anime', shortLabel: 'Anime', tone: 'violet' },
  { id: 'cartoon', label: 'Cartoons', shortLabel: 'Cartoon', tone: 'orange' },
  { id: 'donghua', label: 'Donghua', shortLabel: 'Donghua', tone: 'cyan' },
  { id: 'kdrama', label: 'K-Drama', shortLabel: 'K-Drama', tone: 'rose' },
  { id: 'movie', label: 'Movies', shortLabel: 'Movie', tone: 'lime' },
  { id: 'web-series', label: 'Web Series', shortLabel: 'Series', tone: 'blue' }
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

export function cleanText(value, maxLength = 280) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function parseCommandArgument(text) {
  return cleanText(String(text || '').replace(/^\/\S+\s*/, ''), 180);
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
