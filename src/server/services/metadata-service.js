import { categoryDetails, cleanText } from '../lib/strings.js';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w780';

const MOVIE_GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller', 10752: 'War', 37: 'Western'
};

const TV_GENRES = {
  10759: 'Action', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama',
  10751: 'Family', 10762: 'Kids', 9648: 'Mystery', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi',
  10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 37: 'Western'
};

function tmdbTypeForCategory(category) {
  return category === 'movie' ? 'movie' : 'tv';
}

function makeHeaders(config) {
  return config.tmdbReadAccessToken
    ? { Authorization: `Bearer ${config.tmdbReadAccessToken}`, Accept: 'application/json' }
    : { Accept: 'application/json' };
}

function tmdbUrl(path, config, parameters = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(parameters)) {
    if (value) url.searchParams.set(key, value);
  }
  if (config.tmdbApiKey && !config.tmdbReadAccessToken) url.searchParams.set('api_key', config.tmdbApiKey);
  return url;
}

function yearFromDate(value) {
  const match = String(value || '').match(/^([0-9]{4})/);
  return match ? Number(match[1]) : null;
}

export function fallbackMetadata(title, category) {
  return {
    matched: false,
    title: cleanText(title, 180),
    year: null,
    description: '',
    genres: [],
    languages: [],
    status: 'New release',
    releaseLabel: categoryDetails(category).shortLabel,
    posterOriginalUrl: null,
    backdropOriginalUrl: null,
    tmdbId: null
  };
}

export async function findMetadata(title, category, config) {
  const fallback = fallbackMetadata(title, category);
  if (!title || (!config.tmdbApiKey && !config.tmdbReadAccessToken)) return fallback;

  const type = tmdbTypeForCategory(category);
  let response;
  try {
    response = await fetch(
      tmdbUrl(`/search/${type}`, config, { query: title, include_adult: 'false', language: 'en-US' }),
      { headers: makeHeaders(config), signal: AbortSignal.timeout(10_000) }
    );
  } catch {
    return fallback;
  }

  if (!response.ok) return fallback;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return fallback;
  }

  const result = payload?.results?.find((entry) => entry.poster_path) || payload?.results?.[0];
  if (!result) return fallback;

  const genreNames = (result.genre_ids || [])
    .map((genreId) => (type === 'movie' ? MOVIE_GENRES[genreId] : TV_GENRES[genreId]))
    .filter(Boolean)
    .slice(0, 4);
  const originalTitle = result.title || result.name || title;
  const releaseDate = result.release_date || result.first_air_date;

  return {
    matched: true,
    title: cleanText(originalTitle, 180),
    year: yearFromDate(releaseDate),
    description: cleanText(result.overview, 1400),
    genres: genreNames,
    languages: [],
    status: type === 'tv' ? 'Series' : 'Feature film',
    releaseLabel: type === 'tv' ? 'Series' : 'Feature film',
    posterOriginalUrl: result.poster_path ? `${TMDB_IMAGE_BASE}${result.poster_path}` : null,
    backdropOriginalUrl: result.backdrop_path ? `${TMDB_IMAGE_BASE}${result.backdrop_path}` : null,
    tmdbId: result.id ? String(result.id) : null
  };
}
