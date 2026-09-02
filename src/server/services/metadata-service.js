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

const TITLE_NOISE = /\b(?:mkv|mp4|avi|webm|mov|m4v|ts|zip|rar|7z|season|series|episode|episodes|ep|e|part|volume|vol|complete|collection|web[ .-]?dl|web[ .-]?rip|blu[ .-]?ray|brrip|webrip|hdtv|amzn|nf|netflix|prime|dsnp|ddp(?:\d(?:\.\d)?)?|aac|x26[45]|hevc|av1|hdr|proper|repack|remux|dub(?:bed)?|sub(?:title)?s?|multi(?:\s+audio)?|dual\s+audio|hindi|english|japanese|korean|chinese)\b/gi;
const TITLE_STOP_WORDS = new Set(['the', 'a', 'an']);
const MIN_TITLE_MATCH_SCORE = 0.56;

/**
 * A provider search may return a popular but unrelated first result. Keep a
 * small, shared canonical form for input names and provider candidates so the
 * result we save (and its poster) demonstrably resembles the release name.
 */
export function canonicalMetadataTitle(value) {
  return cleanText(value, 180)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[._~|]+/g, ' ')
    // Remove package markers while their adjacent number is still visible;
    // otherwise a "Season 1" upload would leave a misleading lone "1".
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, ' ')
    .replace(/\bS(?:EASON)?\s*\d{1,2}\b/gi, ' ')
    .replace(/\b(?:EPISODES?|EPS?|EP|E)\s*\d{1,3}\b/gi, ' ')
    .replace(TITLE_NOISE, ' ')
    .replace(/\b(?:360|480|576|720|1080|1440|2160|4320)\s*p?\b/gi, ' ')
    .replace(/\b(?:4k|8k|uhd|fhd|hd)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function titleTokens(value) {
  return canonicalMetadataTitle(value)
    .split(' ')
    .filter((token) => token && !TITLE_STOP_WORDS.has(token));
}

function numberTokens(tokens) {
  return tokens.filter((token) => /^\d+$/.test(token));
}

/**
 * Returns a conservative 0..1 confidence score. Numeric sequel markers are
 * intentionally significant: "Cocktail 2" must not silently become
 * "Cocktail" simply because that older title has a poster.
 */
export function metadataTitleMatchScore(inputTitle, candidateTitle) {
  const input = canonicalMetadataTitle(inputTitle);
  const candidate = canonicalMetadataTitle(candidateTitle);
  if (!input || !candidate) return 0;
  if (input === candidate) return 1;

  const inputTokens = titleTokens(input);
  const candidateTokens = titleTokens(candidate);
  if (!inputTokens.length || !candidateTokens.length) return 0;
  const inputSet = new Set(inputTokens);
  const candidateSet = new Set(candidateTokens);
  const shared = [...inputSet].filter((token) => candidateSet.has(token)).length;
  if (!shared) return 0;

  const precision = shared / candidateSet.size;
  const recall = shared / inputSet.size;
  const f1 = (2 * precision * recall) / (precision + recall);
  const isContained = input.includes(candidate) || candidate.includes(input);
  let score = Math.max(f1, isContained ? 0.82 * recall + 0.12 : 0);

  const wantedNumbers = numberTokens(inputTokens);
  const candidateNumbers = numberTokens(candidateTokens);
  if (wantedNumbers.length && wantedNumbers.some((number) => !candidateNumbers.includes(number))) score -= 0.42;
  if (!wantedNumbers.length && candidateNumbers.length) score -= 0.08;
  return Math.max(0, Math.min(1, score));
}

function bestTitleMatch(inputTitle, candidates = []) {
  return candidates
    .filter(Boolean)
    .map((candidate) => ({ candidate: cleanText(candidate, 180), score: metadataTitleMatchScore(inputTitle, candidate) }))
    .sort((first, second) => second.score - first.score || first.candidate.length - second.candidate.length)[0] || null;
}

function metadataKey(provider, id, type = '') {
  const safeProvider = cleanText(provider, 20).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const safeType = cleanText(type, 20).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const safeId = cleanText(id, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return safeProvider && safeId ? [safeProvider, safeType, safeId].filter(Boolean).join('-') : null;
}

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
    tmdbId: null,
    metadataKey: null,
    matchScore: 0
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

  const scoredResults = (Array.isArray(payload?.results) ? payload.results : [])
    .map((entry) => {
      const titleMatch = bestTitleMatch(title, [entry?.title, entry?.name, entry?.original_title, entry?.original_name]);
      return {
        entry,
        titleMatch,
        // Popularity is only a tie-breaker after title similarity. It must not
        // turn the first popular poster-bearing result into this release.
        popularity: Number(entry?.popularity) || 0,
        votes: Number(entry?.vote_count) || 0
      };
    })
    .filter(({ titleMatch }) => titleMatch?.score >= MIN_TITLE_MATCH_SCORE)
    .sort((first, second) => second.titleMatch.score - first.titleMatch.score
      || second.popularity - first.popularity
      || second.votes - first.votes);
  const selected = scoredResults[0];
  const result = selected?.entry;
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
    tmdbId: result.id ? String(result.id) : null,
    metadataKey: result.id ? metadataKey('tmdb', result.id, type) : null,
    matchScore: selected.titleMatch.score
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
  const titleMatch = bestTitleMatch(title, [result.Title]);
  if (!titleMatch || titleMatch.score < MIN_TITLE_MATCH_SCORE) return null;

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
    tmdbId: null,
    metadataKey: result.imdbID ? metadataKey('omdb', result.imdbID, result.Type) : null,
    matchScore: titleMatch.score
  };
}

const ANILIST_QUERY = `
  query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME) {
        id
        title { romaji english native }
        description(asHtml: false)
        genres
        episodes
        status
        popularity
        startDate { year }
        coverImage { extraLarge large medium }
        bannerImage
      }
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
  const selected = (Array.isArray(payload?.data?.Page?.media) ? payload.data.Page.media : [])
    .map((entry) => ({
      entry,
      titleMatch: bestTitleMatch(title, [entry?.title?.english, entry?.title?.romaji, entry?.title?.native])
    }))
    .filter(({ entry, titleMatch }) => entry?.id && titleMatch?.score >= MIN_TITLE_MATCH_SCORE)
    .sort((first, second) => second.titleMatch.score - first.titleMatch.score
      || Number(second.entry?.popularity || 0) - Number(first.entry?.popularity || 0))[0];
  const result = selected?.entry;
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
    tmdbId: null,
    metadataKey: metadataKey('anilist', result.id, 'anime'),
    matchScore: selected.titleMatch.score
  };
}

/* ---------------------------------------------------------------------------
 * Publisher artwork picker
 * ------------------------------------------------------------------------- */

const PICKER_MIN_MATCH_SCORE = 0.34;

function candidateKey(provider, id, type = '') {
  return [provider, type, id].filter(Boolean).join(':').toLowerCase();
}

async function searchTmdbCandidates(title, type, config) {
  if (!config.tmdbApiKey && !config.tmdbReadAccessToken) return [];
  let response;
  try {
    response = await fetch(
      tmdbUrl(`/search/${type}`, config, { query: title, include_adult: 'false', language: 'en-US' }),
      { headers: tmdbHeaders(config), signal: AbortSignal.timeout(10_000) }
    );
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let payload;
  try {
    payload = await response.json();
  } catch {
    return [];
  }
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map((entry) => {
      const candidateTitle = cleanText(entry?.title || entry?.name || entry?.original_title || entry?.original_name, 180);
      return {
        provider: 'tmdb',
        externalId: entry?.id ? String(entry.id) : null,
        type,
        title: candidateTitle,
        year: yearFromDate(entry?.release_date || entry?.first_air_date),
        posterUrl: entry?.poster_path ? `${TMDB_IMAGE_BASE}${entry.poster_path}` : null,
        backdropUrl: entry?.backdrop_path ? `${TMDB_IMAGE_BASE}${entry.backdrop_path}` : null,
        popularity: Number(entry?.popularity) || 0,
        score: metadataTitleMatchScore(title, candidateTitle)
      };
    })
    .filter((entry) => entry.title && entry.posterUrl);
}

const ANILIST_PICKER_QUERY = `
  query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, sort: POPULARITY_DESC) {
        id
        type
        title { romaji english native }
        startDate { year }
        popularity
        coverImage { extraLarge large medium }
        bannerImage
      }
    }
  }
`;

async function searchAniListCandidates(title) {
  let response;
  try {
    response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_PICKER_QUERY, variables: { search: title } }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let payload;
  try {
    payload = await response.json();
  } catch {
    return [];
  }
  return (Array.isArray(payload?.data?.Page?.media) ? payload.data.Page.media : [])
    .map((entry) => {
      const titles = [entry?.title?.romaji, entry?.title?.english, entry?.title?.native].filter(Boolean);
      const best = bestTitleMatch(title, titles);
      return {
        provider: 'anilist',
        externalId: entry?.id ? String(entry.id) : null,
        type: cleanText(entry?.type, 12).toLowerCase() || 'anime',
        title: best?.candidate || cleanText(titles[0], 180),
        year: Number.isInteger(entry?.startDate?.year) ? entry.startDate.year : null,
        posterUrl: entry?.coverImage?.extraLarge || entry?.coverImage?.large || entry?.coverImage?.medium || null,
        backdropUrl: entry?.bannerImage || null,
        popularity: Number(entry?.popularity) || 0,
        score: best?.score || 0
      };
    })
    .filter((entry) => entry.title && entry.posterUrl);
}

/**
 * Give the publisher every plausible artwork match instead of silently keeping
 * the single highest-scoring one. Titles are ranked by the same similarity score
 * used during automatic matching, so an unrelated popular show cannot crowd
 * out the actual release, and TMDB/AniList identity is retained so the chosen
 * poster can later be re-resolved without a second search.
 */
export async function searchPosterCandidates(title, category = 'movie', config = {}, { limit = 8 } = {}) {
  const lookupTitle = canonicalMetadataTitle(title) || cleanText(title, 180);
  if (!lookupTitle) return [];

  const providers = ['anime', 'donghua'].includes(category)
    ? [() => searchAniListCandidates(lookupTitle), () => searchTmdbCandidates(lookupTitle, 'tv', config), () => searchTmdbCandidates(lookupTitle, 'movie', config)]
    : category === 'movie'
      ? [() => searchTmdbCandidates(lookupTitle, 'movie', config), () => searchTmdbCandidates(lookupTitle, 'tv', config)]
      : [() => searchTmdbCandidates(lookupTitle, 'tv', config), () => searchTmdbCandidates(lookupTitle, 'movie', config), () => searchAniListCandidates(lookupTitle)];

  const settled = await Promise.allSettled(providers.map((provider) => provider()));
  const seen = new Set();
  const candidates = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const entry of result.value || []) {
      const key = candidateKey(entry.provider, entry.externalId, entry.type);
      if (!key || seen.has(key)) continue;
      if (entry.score < PICKER_MIN_MATCH_SCORE) continue;
      seen.add(key);
      candidates.push(entry);
    }
  }

  return candidates
    .sort((first, second) => second.score - first.score || second.popularity - first.popularity)
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 10)));
}

// Provider order is category-aware. This lets anime/donghua benefit from AniList
// while movies and TV categories prefer TMDB/OMDb metadata. Each provider is a
// fallback, so one outage or incomplete catalogue does not block publication.
export async function findMetadata(title, category, config) {
  const fallback = fallbackMetadata(title, category);
  if (!title) return fallback;
  // Use the same cleanup for provider lookup and verification. The original
  // human-entered title remains the fallback display title if no match wins.
  const lookupTitle = canonicalMetadataTitle(title) || cleanText(title, 180);

  const providers = ['anime', 'donghua'].includes(category)
    ? [() => findAniListMetadata(lookupTitle, category), () => findTmdbMetadata(lookupTitle, category, config), () => findOmdbMetadata(lookupTitle, category, config)]
    : category === 'cartoon'
      ? [() => findTmdbMetadata(lookupTitle, category, config), () => findAniListMetadata(lookupTitle, category), () => findOmdbMetadata(lookupTitle, category, config)]
      : [() => findTmdbMetadata(lookupTitle, category, config), () => findOmdbMetadata(lookupTitle, category, config)];

  const matches = [];
  for (const provider of providers) {
    const metadata = await provider();
    if (!metadata?.matched) continue;
    matches.push(metadata);
    // An exact verified result cannot be improved by a later provider, so do
    // not spend another network round-trip merely to replace its poster.
    if (metadata.posterOriginalUrl && Number(metadata.matchScore) >= 0.99) return metadata;
  }
  return matches.sort((first, second) => Number(second.matchScore || 0) - Number(first.matchScore || 0)
    || Number(Boolean(second.posterOriginalUrl)) - Number(Boolean(first.posterOriginalUrl)))[0] || fallback;
}
