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

const TITLE_NOISE = /\b(?:mkv|mp4|avi|webm|mov|m4v|ts|zip|rar|7z|season|series|episode|episodes|epi|ep|e|part|volume|vol|complete|collection|web[ .-]?dl|web[ .-]?rip|web[ .-]?hd|webdl|webrip|webhd|blu[ .-]?ray|bdrip|brrip|brip|hdrip|dvdrip|dvdscr|hdtv|hdts|hdcam|cam|predvd|telesync|telecine|amzn|amazon|nf|netflix|prime(?:video)?|dsnp|dsnk|disney\+?|hotstar|jiohotstar|jiocinema|zee5?|sonyliv|sliv|sunnxt|snxt|aha|hoichoi|voot|ullu|chaupal|stage|hulu|hbomax|hmax|atvp|pcok|peacock|pmtp|paramount\+?|lionsgate(?:play)?|lgp|crunchyroll|cr|bilibili|b-global|bglobal|wetv|iqiyi|youku|mgtv|tencent|viki|viu|wavve|tving|hidive|funimation|muse|anione|ddp?(?:\d(?:\.\d)?)?|dd\+?(?:\d(?:\.\d)?)?|eac3|ac3|truehd|dts(?:[- ]?hd)?|aac(?:\d(?:\.\d)?)?|opus|flac|mp3|x26[45]|h\.?26[45]|hevc|av1|avc1?|vp9|10[- ]?bit|8[- ]?bit|hi10p|hdr10(?:\+)?|hdr|dovi|dv|atmos|hlg|sdr|proper|repack|rerip|remux|uncut|extended|unrated|remastered|rarbg|yts|yify|psa|pahe|tgx|kayoanime|animekayo|subsplease|erai-raws|horriblesubs|nyaa|ember|judas|flux|ntb|dub(?:bed)?|sub(?:bed|title)?s?|esubs?|msubs?|multisubs?|korsub|multi(?:\s+audio)?|dual(?:\s+audio)?|org|original|hq|hc|hindi|english|japanese|korean|chinese|mandarin|cantonese|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|gujarati|urdu|indonesian|thai|vietnamese|spanish|french|german|portuguese|arabic|russian)\b/gi;
const TITLE_STOP_WORDS = new Set(['the', 'a', 'an']);
const MIN_TITLE_MATCH_SCORE = 0.56;

const LANGUAGE_TO_COUNTRY = new Map([
  ['ja', 'JP'],
  ['zh', 'CN'], ['cn', 'CN'], ['zho', 'CN'], ['chi', 'CN'], ['yue', 'CN'],
  ['ko', 'KR'], ['kor', 'KR'],
  ['hi', 'IN'], ['ta', 'IN'], ['te', 'IN'], ['ml', 'IN'], ['kn', 'IN'], ['bn', 'IN'], ['mr', 'IN'], ['pa', 'IN'], ['gu', 'IN'], ['or', 'IN'], ['as', 'IN'],
  ['ur', 'PK'],
  ['tl', 'PH'], ['fil', 'PH'],
  ['id', 'ID'], ['ms', 'MY'], ['th', 'TH'], ['vi', 'VN']
]);

function resolveTmdbOriginCountry(entry) {
  const fromList = (Array.isArray(entry?.origin_country) ? entry.origin_country : [])
    .map((code) => cleanText(code, 4).toUpperCase())
    .find(Boolean);
  if (fromList) return fromList;
  const origLang = cleanText(entry?.original_language, 8).toLowerCase();
  if (origLang && LANGUAGE_TO_COUNTRY.has(origLang)) {
    return LANGUAGE_TO_COUNTRY.get(origLang);
  }
  return null;
}

function resolveCountryCodeFromName(value) {
  const first = cleanText(String(value || '').split(',')[0], 40).toLowerCase();
  if (!first) return null;
  if (first === 'japan' || first === 'jp') return 'JP';
  if (first === 'china' || first === 'cn' || first === 'hong kong' || first === 'taiwan') return 'CN';
  if (first === 'south korea' || first === 'korea' || first === 'kr') return 'KR';
  if (first === 'india' || first === 'in') return 'IN';
  if (first === 'united states' || first === 'usa' || first === 'us' || first === 'united kingdom' || first === 'uk') return 'US';
  return first.length === 2 ? first.toUpperCase() : null;
}

/**
 * A provider search may return a popular but unrelated first result. Keep a
 * small, shared canonical form for input names and provider candidates so the
 * result we save (and its poster) demonstrably resembles the release name.
 */
export function canonicalMetadataTitle(value) {
  const cleaned = cleanText(value, 180)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[._~|]+/g, ' ')
    // Remove package markers while their adjacent number is still visible;
    // otherwise a "Season 1" upload would leave a misleading lone "1".
    .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, ' ')
    .replace(/\bS(?:EASON)?\s*\d{1,2}\b/gi, ' ')
    .replace(/\b(?:EPISODES?|EPI|EPS?|EP|E)\s*\d{1,3}\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:gb|mb|kb|gib|mib)\b/gi, ' ')
    .replace(TITLE_NOISE, ' ')
    .replace(/\b(?:[1-3]\d{3}|4[0-3]\d{2}|[1-9]\d{2})\s*[pPiI]\b/g, ' ')
    .replace(/\b(?:144|180|240|270|288|360|400|480|504|540|544|576|640|720|800|900|1080|1440|2160|4320)\s*p?\b/gi, ' ')
    .replace(/\b\d{3,4}\s*[xX×]\s*\d{3,4}\b/g, ' ')
    .replace(/\b(?:2k|4k|5k|6k|8k|uhd|qhd|fhd|hd|sd)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  // Strip trailing consonant-only release group abbreviations (e.g. "dsnk", "crp", "ntb")
  // when there is already a real title in front of them.
  const words = cleaned.split(' ').filter(Boolean);
  while (words.length > 1) {
    const tail = words[words.length - 1];
    if (/^[b-df-hj-np-tv-xz]{3,6}$/i.test(tail) && !/^(?:part|ii|iii|iv|vi|vii|viii|ix|xi|xii)$/i.test(tail)) {
      words.pop();
    } else {
      break;
    }
  }
  return words.join(' ');
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

async function searchTmdbType(title, type, config) {
  let response;
  try {
    response = await fetch(
      tmdbUrl(`/search/${type}`, config, { query: title, include_adult: 'false', language: 'en-US' }),
      { headers: tmdbHeaders(config), signal: AbortSignal.timeout(8_000) }
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

  const genreIds = (Array.isArray(result.genre_ids) ? result.genre_ids : []).map(Number).filter(Number.isInteger);
  const genres = genreIds
    .map((genreId) => (type === 'movie' ? MOVIE_GENRES[genreId] : TV_GENRES[genreId]))
    .filter(Boolean)
    .slice(0, 4);
  const originCountry = resolveTmdbOriginCountry(result);
  const inferredCategory = categoryFromHints({
    hints: {
      provider: 'tmdb',
      score: selected.titleMatch.score,
      type,
      originCountry,
      genreIds,
      genres
    }
  });

  return {
    matched: true,
    provider: 'tmdb',
    type,
    originCountry,
    genreIds,
    inferredCategory,
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

async function findTmdbMetadata(title, category, config) {
  if (!config.tmdbApiKey && !config.tmdbReadAccessToken) return null;
  const primaryType = tmdbTypeForCategory(category);
  const primary = await searchTmdbType(title, primaryType, config);
  if (primary && Number(primary.matchScore) >= 0.85 && primary.posterOriginalUrl) {
    return primary;
  }
  const altType = primaryType === 'movie' ? 'tv' : 'movie';
  const secondary = await searchTmdbType(title, altType, config);
  if (!primary) return secondary;
  if (!secondary) return primary;
  return Number(secondary.matchScore) > Number(primary.matchScore) + 0.05 ? secondary : primary;
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
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
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
  const genres = listFromValue(result.Genre, 5);
  const originCountry = resolveCountryCodeFromName(result.Country);
  const inferredCategory = categoryFromHints({
    hints: {
      provider: 'omdb',
      score: titleMatch.score,
      type: isSeries ? 'tv' : 'movie',
      originCountry,
      genres
    }
  });
  return {
    matched: true,
    provider: 'omdb',
    type: isSeries ? 'tv' : 'movie',
    originCountry,
    inferredCategory,
    title: cleanText(result.Title, 180),
    year: yearFromDate(result.Year),
    description: cleanText(result.Plot === 'N/A' ? '' : result.Plot, 1400),
    genres,
    languages: [],
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
        format
        countryOfOrigin
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
      signal: AbortSignal.timeout(8_000)
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
  const countryOfOrigin = cleanText(result.countryOfOrigin, 4).toUpperCase() || null;
  const inferredCategory = categoryFromHints({
    hints: {
      provider: 'anilist',
      score: selected.titleMatch.score,
      countryOfOrigin,
      type: cleanText(result.format, 16).toLowerCase() || 'anime'
    }
  });
  return {
    matched: true,
    provider: 'anilist',
    type: cleanText(result.format, 16).toLowerCase() || 'anime',
    countryOfOrigin,
    inferredCategory,
    title: cleanText(resolvedTitle, 180),
    year: Number.isInteger(result.startDate?.year) ? result.startDate.year : null,
    description: cleanText(result.description, 1400),
    genres: Array.isArray(result.genres) ? result.genres.map((genre) => cleanText(genre, 40)).filter(Boolean).slice(0, 5) : [],
    languages: [],
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
        // What a category decision needs, and nothing else: TMDB says where a show was made and
        // whether it is a series, which is how a donghua stops being filed as a web series.
        originCountry: resolveTmdbOriginCountry(entry),
        genreIds: (Array.isArray(entry?.genre_ids) ? entry.genre_ids : []).map(Number).filter(Number.isInteger),
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
        format
        countryOfOrigin
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
        format: cleanText(entry?.format, 16).toUpperCase() || null,
        countryOfOrigin: cleanText(entry?.countryOfOrigin, 4).toUpperCase() || null,
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

function progressiveTitleFallbacks(lookupTitle) {
  const queries = [lookupTitle];
  const tokens = String(lookupTitle || '').split(' ').filter(Boolean);
  for (let drop = 1; drop <= 2 && tokens.length - drop >= 1; drop += 1) {
    const dropped = tokens[tokens.length - drop];
    if (/^\d+$/.test(dropped)) break;
    const prefix = tokens.slice(0, tokens.length - drop).join(' ').trim();
    if (prefix.length >= 3 && !queries.includes(prefix)) {
      queries.push(prefix);
    }
  }
  return queries;
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

  const queries = progressiveTitleFallbacks(lookupTitle);
  const seen = new Set();
  const candidates = [];

  for (const query of queries) {
    const providers = ['anime', 'donghua'].includes(category)
      ? [() => searchAniListCandidates(query), () => searchTmdbCandidates(query, 'tv', config), () => searchTmdbCandidates(query, 'movie', config)]
      : category === 'movie'
        ? [() => searchTmdbCandidates(query, 'movie', config), () => searchTmdbCandidates(query, 'tv', config), () => searchAniListCandidates(query)]
        : [() => searchTmdbCandidates(query, 'tv', config), () => searchTmdbCandidates(query, 'movie', config), () => searchAniListCandidates(query)];

    const settled = await Promise.allSettled(providers.map((provider) => provider()));
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
    if (candidates.length > 0) break;
  }

  return candidates
    .sort((first, second) => second.score - first.score || second.popularity - first.popularity)
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 10)));
}

/** TMDB's genre id for Animation, the one tag that separates a cartoon from a live-action show. */
const ANIMATION_GENRE_ID = 16;
/** Countries whose animated output the catalog keeps in its own shelves. */
const ANIME_COUNTRIES = new Set(['JP']);
const DONGHUA_COUNTRIES = new Set(['CN']);
const KOREAN_COUNTRIES = new Set(['KR']);
/** Broadcast/OTT homes whose shows are neither anime, donghua, nor K-Drama — the "TV & OTT" shelf. */
const TV_FIRST_COUNTRIES = new Set(['IN', 'PK', 'BD', 'NP', 'LK', 'PH', 'ID', 'MY', 'TH']);

/**
 * Which catalog category a provider's answer describes, or null when it says nothing useful.
 *
 * This is a *tie-breaker*, not the first word: publisher-typed categories and the words in a
 * caption always win, and this only decides the releases a filename cannot distinguish — where
 * `Peerless Martial Spirit S01E02.mkv` (a donghua) and a Chinese-language web series look
 * identical. A provider that did not match the title well enough is treated as silence, and the
 * caller keeps its own guess, so an outage never misfiles a release.
 */
export function categoryFromHints({ hints = null, minimumScore = 0.62 } = {}) {
  if (!hints || typeof hints !== 'object') return null;
  const score = Number(hints.score ?? hints.matchScore ?? 0) || 0;
  if (score < minimumScore) return null;
  const rawCountry = Array.isArray(hints.originCountry)
    ? hints.originCountry[0]
    : (hints.originCountry || hints.countryOfOrigin || hints.country);
  const country = cleanText(rawCountry, 4).toUpperCase() || null;
  const type = cleanText(hints.type || hints.format, 16).toLowerCase() || null;
  const provider = cleanText(hints.provider, 20).toLowerCase() || null;

  if (provider === 'anilist') {
    // AniList lists Chinese 3D series as anime unless the country says otherwise.
    if (DONGHUA_COUNTRIES.has(country)) return 'donghua';
    return 'anime';
  }
  if (provider && !['tmdb', 'omdb', 'imdb', 'myanimelist', 'mydramalist', 'web'].includes(provider)) return null;

  const genreList = Array.isArray(hints.genres) ? hints.genres.map((g) => String(g || '').toLowerCase()) : [];
  const animated = (Array.isArray(hints.genreIds) && hints.genreIds.includes(ANIMATION_GENRE_ID))
    || genreList.some((g) => /\b(animation|animated|cartoon|anime|donghua)\b/i.test(g));
  const isAnimeGenre = genreList.some((g) => /\banime\b/i.test(g));
  const isDonghuaGenre = genreList.some((g) => /\bdonghua\b/i.test(g));
  const episodic = type === 'tv' || type === 'series' || type === 'miniseries' || type === 'tv_short' || type === 'ona' || type === 'ova';

  if (isDonghuaGenre) return 'donghua';
  if (isAnimeGenre) return 'anime';
  if (animated) {
    if (DONGHUA_COUNTRIES.has(country)) return 'donghua';
    if (ANIME_COUNTRIES.has(country)) return 'anime';
    return 'cartoon';
  }
  if (!type && !country) return null;
  if (KOREAN_COUNTRIES.has(country)) return episodic ? 'kdrama' : 'movie';
  if (DONGHUA_COUNTRIES.has(country)) return episodic ? 'donghua' : 'movie';
  if (!episodic) return 'movie';
  // An Indian/South-East-Asian show is a broadcast or OTT release, and the catalog says so:
  // calling it a "web series" is what had publishers fixing the category after every upload.
  if (TV_FIRST_COUNTRIES.has(country)) return 'tv';
  return 'web-series';
}

/**
 * Ask the providers what kind of release a title is. Every lookup is a fallback and a timeout away
 * from silence, so this never holds a publication open: no key, no network, or no match answers
 * null and the caller keeps the guess it made from the caption.
 */
export async function searchCategoryHints(title, config = {}, { search = searchPosterCandidates, category = 'movie' } = {}) {
  const lookupTitle = canonicalMetadataTitle(title) || cleanText(title, 180);
  if (!lookupTitle) return null;
  if (!config.tmdbApiKey && !config.tmdbReadAccessToken) return null;
  let candidates = [];
  try {
    // `category: 'movie'` puts TMDB-movie and TMDB-tv ahead of AniList in the provider order, which
    // is what a category question needs: the answer is read from whichever candidate matched best.
    candidates = await search(lookupTitle, category, config, { limit: 10 });
  } catch {
    return null;
  }
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .filter((entry) => entry && Number(entry.score) > 0)
    .sort((first, second) => Number(second.score) - Number(first.score) || Number(second.popularity) - Number(first.popularity));
  return ranked[0] || null;
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
  const queries = progressiveTitleFallbacks(lookupTitle);

  for (const query of queries) {
    const providers = ['anime', 'donghua'].includes(category)
      ? [() => findAniListMetadata(query, category), () => findTmdbMetadata(query, category, config), () => findOmdbMetadata(query, category, config)]
      : category === 'cartoon'
        ? [() => findTmdbMetadata(query, category, config), () => findAniListMetadata(query, category), () => findOmdbMetadata(query, category, config)]
        : [() => findTmdbMetadata(query, category, config), () => findAniListMetadata(query, category), () => findOmdbMetadata(query, category, config)];

    const matches = [];
    for (const provider of providers) {
      const metadata = await provider();
      if (!metadata?.matched) continue;
      matches.push(metadata);
      // An exact verified result cannot be improved by a later provider, so do
      // not spend another network round-trip merely to replace its poster.
      if (metadata.posterOriginalUrl && Number(metadata.matchScore) >= 0.99) return metadata;
    }
    if (matches.length > 0) {
      return matches.sort((first, second) => Number(second.matchScore || 0) - Number(first.matchScore || 0)
        || Number(Boolean(second.posterOriginalUrl)) - Number(Boolean(first.posterOriginalUrl)))[0];
    }
  }
  return fallback;
}
