import { categoryDetails, cleanText } from '../lib/strings.js';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w780';
const OMDB_URL = 'https://www.omdbapi.com/';
const ANILIST_URL = 'https://graphql.anilist.co';

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

function yearFromDate(value) {
  const match = String(value || '').match(/^([0-9]{4})/);
  return match ? Number(match[1]) : null;
}

function listFromValue(value, max = 8) {
  return String(value || '')
    .split(/[,|/]/)
    .map((entry) => cleanText(entry, 40))
    .filter(Boolean)
    .slice(0, max);
}

function tmdbHeaders(config) {
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

export function fallbackMetadata(title, category) {
  return {
    matched: false,
    provider: 'fallback',
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

async function findTmdbMetadata(title, category, config) {
  if (!config.tmdbApiKey && !config.tmdbReadAccessToken) return null;
  const type = tmdbTypeForCategory(category);

  let response;
  try {
    response = await fetch(
      tmdbUrl(`/search/${type}`, config, { query: title, include_adult: 'false', language: 'en-US' }),
      { headers: tmdbHeaders(config), signal: AbortSignal.timeout(10_000) }
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const result = payload?.results?.find((entry) => entry.poster_path) || payload?.results?.[0];
  if (!result) return null;

  const genres = (result.genre_ids || [])
    .map((genreId) => (type === 'movie' ? MOVIE_GENRES[genreId] : TV_GENRES[genreId]))
    .filter(Boolean)
    .slice(0, 4);

  return {
    matched: true,
    provider: 'tmdb',
    title: cleanText(result.title || result.name || title, 180),
    year: yearFromDate(result.release_date || result.first_air_date),
    description: cleanText(result.overview, 1400),
    genres,
    languages: [],
    status: type === 'tv' ? 'Series' : 'Feature film',
    releaseLabel: type === 'tv' ? 'Series' : 'Feature film',
    posterOriginalUrl: result.poster_path ? `${TMDB_IMAGE_BASE}${result.poster_path}` : null,
    backdropOriginalUrl: result.backdrop_path ? `${TMDB_IMAGE_BASE}${result.backdrop_path}` : null,
    tmdbId: result.id ? String(result.id) : null
  };
}

async function findOmdbMetadata(title, category, config) {
  if (!config.omdbApiKey) return null;
  const url = new URL(OMDB_URL);
  url.searchParams.set('apikey', config.omdbApiKey);
  url.searchParams.set('t', title);
  url.searchParams.set('plot', 'full');
  if (category === 'movie') url.searchParams.set('type', 'movie');
  if (['kdrama', 'web-series', 'cartoon'].includes(category)) url.searchParams.set('type', 'series');

  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let result;
  try {
    result = await response.json();
  } catch {
    return null;
  }
  if (result?.Response !== 'True' || !result.Title) return null;

  const totalSeasons = Number.parseInt(result.totalSeasons, 10);
  const isSeries = result.Type === 'series';
  return {
    matched: true,
    provider: 'omdb',
    title: cleanText(result.Title, 180),
    year: yearFromDate(result.Year),
    description: cleanText(result.Plot === 'N/A' ? '' : result.Plot, 1400),
    genres: listFromValue(result.Genre, 5),
    languages: listFromValue(result.Language, 8),
    status: isSeries ? 'Series' : 'Feature film',
    releaseLabel: Number.isInteger(totalSeasons) ? `${totalSeasons} season${totalSeasons === 1 ? '' : 's'}` : isSeries ? 'Series' : 'Feature film',
    posterOriginalUrl: result.Poster && result.Poster !== 'N/A' ? result.Poster : null,
    backdropOriginalUrl: null,
    tmdbId: null
  };
}

const ANILIST_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title { romaji english native }
      description(asHtml: false)
      genres
      episodes
      status
      startDate { year }
      coverImage { extraLarge large medium }
      bannerImage
    }
  }
`;

function anilistStatus(status) {
  if (status === 'FINISHED') return 'Complete';
  if (status === 'RELEASING' || status === 'NOT_YET_RELEASED') return 'Ongoing';
  return 'Anime release';
}

async function findAniListMetadata(title, category = 'anime') {
  let response;
  try {
    response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: title } }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const result = payload?.data?.Media;
  if (!result?.id) return null;

  const resolvedTitle = result.title?.english || result.title?.romaji || result.title?.native || title;
  const episodes = Number.parseInt(result.episodes, 10);
  return {
    matched: true,
    provider: 'anilist',
    title: cleanText(resolvedTitle, 180),
    year: Number.isInteger(result.startDate?.year) ? result.startDate.year : null,
    description: cleanText(result.description, 1400),
    genres: Array.isArray(result.genres) ? result.genres.map((genre) => cleanText(genre, 40)).filter(Boolean).slice(0, 5) : [],
    languages: [category === 'donghua' ? 'Chinese' : 'Japanese'],
    status: anilistStatus(result.status),
    releaseLabel: Number.isInteger(episodes) ? `${episodes} episode${episodes === 1 ? '' : 's'}` : 'Anime series',
    posterOriginalUrl: result.coverImage?.extraLarge || result.coverImage?.large || result.coverImage?.medium || null,
    backdropOriginalUrl: result.bannerImage || null,
    tmdbId: null
  };
}

// Provider order is category-aware. This lets anime/donghua benefit from AniList
// while movies and TV categories prefer TMDB/OMDb metadata. Each provider is a
// fallback, so one outage or incomplete catalogue does not block publication.
export async function findMetadata(title, category, config) {
  const fallback = fallbackMetadata(title, category);
  if (!title) return fallback;

  const providers = ['anime', 'donghua'].includes(category)
    ? [() => findAniListMetadata(title, category), () => findTmdbMetadata(title, category, config), () => findOmdbMetadata(title, category, config)]
    : category === 'cartoon'
      ? [() => findTmdbMetadata(title, category, config), () => findAniListMetadata(title, category), () => findOmdbMetadata(title, category, config)]
      : [() => findTmdbMetadata(title, category, config), () => findOmdbMetadata(title, category, config)];

  let firstMatch = null;
  for (const provider of providers) {
    const metadata = await provider();
    if (!metadata?.matched) continue;
    // Keep metadata even if its artwork is unavailable, but continue through
    // the provider chain so OMDb/TMDB/AniList can still supply a poster.
    if (!firstMatch) firstMatch = metadata;
    if (metadata.posterOriginalUrl) return metadata;
  }
  return firstMatch || fallback;
}
