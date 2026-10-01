import { cleanText } from '../lib/strings.js';
import { categoryFromHints, findMetadata } from './metadata-service.js';

const ISO_LANG_MAP = {
  en: 'English',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  ru: 'Russian',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  kn: 'Kannada',
  bn: 'Bengali',
  mr: 'Marathi',
  pa: 'Punjabi',
  ur: 'Urdu',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ar: 'Arabic',
  pt: 'Portuguese',
  tr: 'Turkish'
};

/**
 * Decode common HTML entities from scraped attribute values and text.
 */
export function decodeHtmlEntities(value) {
  if (!value) return '';
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .trim();
}

/**
 * Clean common site branding and packaging out of page titles.
 */
export function cleanScrapedTitle(rawTitle, domain = '') {
  let title = decodeHtmlEntities(rawTitle || '');
  title = title.replace(/^Watch\s+/i, '');
  title = title
    .replace(/\s*-\s*IMDb$/i, '')
    .replace(/\s*\|\s*Netflix\s*(?:Official\s*Site)?$/i, '')
    .replace(/\s*-\s*MyAnimeList\.net$/i, '')
    .replace(/\s*[·•-]\s*AniList$/i, '')
    .replace(/\s*-\s*Watch\s*on\s*Crunchyroll$/i, '')
    .replace(/\s*-\s*Crunchyroll$/i, '')
    .replace(/\s*-\s*Wikipedia$/i, '')
    .replace(/\s*-\s*Rotten\s*Tomatoes$/i, '')
    .replace(/\s*—\s*The\s*Movie\s*Database\s*\(TMDB\)$/i, '')
    .replace(/\s*\|\s*Fandom$/i, '')
    .replace(/\s*\|\s*Prime\s*Video$/i, '')
    .replace(/\s*\|\s*Disney\+?$/i, '');

  if (domain) {
    const cleanDomain = domain.replace(/^www\./, '').split('.')[0];
    if (cleanDomain.length > 2) {
      const domainPattern = new RegExp(`\\s*[-|–—:]\\s*${cleanDomain}.*$`, 'i');
      title = title.replace(domainPattern, '');
    }
  }

  // Remove TV Series indicators from title if embedded e.g. "Title (TV Series 2024– )"
  title = title.replace(/\s*\((?:TV\s*Series\s*)?(?:19|20)\d{2}[^)]*\)/i, '');
  title = title.replace(/\s*[-|]\s*Official\s*(?:Trailer|Site|Page).*$/i, '');
  return cleanText(title, 180);
}

/**
 * Extract a reasonable 4-digit release year from date strings, titles, or page content.
 */
export function extractYearFromScraped({ dateStr = null, title = null, text = null } = {}) {
  const currentYear = new Date().getFullYear();
  const isValidYear = (y) => y >= 1888 && y <= currentYear + 5;

  if (dateStr) {
    const matches = String(dateStr).match(/\b(19\d{2}|20\d{2})\b/g);
    if (matches) {
      for (const m of matches) {
        const y = Number.parseInt(m, 10);
        if (isValidYear(y)) return y;
      }
    }
  }

  if (title) {
    // Check parentheses first e.g. "Blade Runner 2049 (2017)" -> 2017
    const parenMatch = String(title).match(/\b\((19\d{2}|20\d{2})\)/);
    if (parenMatch) {
      const y = Number.parseInt(parenMatch[1], 10);
      if (isValidYear(y)) return y;
    }
    // Check all matches, preferring the last one if it looks like a release year
    const matches = String(title).match(/\b(19\d{2}|20\d{2})\b/g);
    if (matches) {
      for (let i = matches.length - 1; i >= 0; i--) {
        const y = Number.parseInt(matches[i], 10);
        if (isValidYear(y)) return y;
      }
    }
  }

  if (text) {
    const matches = String(text).match(/\b(19\d{2}|20\d{2})\b/g);
    if (matches) {
      for (const m of matches) {
        const y = Number.parseInt(m, 10);
        if (isValidYear(y)) return y;
      }
    }
  }

  return null;
}

/**
 * Standardize language strings or ISO language codes to title-cased English names.
 */
export function normalizeScrapedLanguage(val) {
  if (!val) return null;
  const str = String(val).trim();
  const lower = str.toLowerCase();
  if (ISO_LANG_MAP[lower]) return ISO_LANG_MAP[lower];
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Enhance poster image URLs (e.g. Amazon/IMDb CDN thumbnails to full-res originals).
 */
export function enhancePosterUrl(url) {
  if (!url) return null;
  const str = String(url).trim();
  if (str.includes('media-amazon.com') || str.includes('imdb.com')) {
    return str.replace(/\.?_V1_.*?(\.(?:jpe?g|png|webp))$/i, '._V1_$1');
  }
  return str;
}

/**
 * Extract and parse all Schema.org JSON-LD scripts from HTML.
 */
export function extractJsonLd(html) {
  const scripts = [];
  const regex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        scripts.push(...parsed);
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed['@graph'])) {
          scripts.push(...parsed['@graph']);
        } else {
          scripts.push(parsed);
        }
      }
    } catch {
      // Ignore invalid JSON chunks
    }
  }
  return scripts;
}

/**
 * Find the most relevant media entity from JSON-LD blocks.
 */
function findMediaEntity(jsonLdList) {
  const priorityTypes = ['Movie', 'TVSeries', 'Series', 'TVEpisode', 'VisualArtwork', 'VideoObject', 'CreativeWork'];
  for (const type of priorityTypes) {
    const found = jsonLdList.find((item) => {
      const itemType = item?.['@type'];
      return Array.isArray(itemType) ? itemType.includes(type) : itemType === type;
    });
    if (found) return found;
  }
  return jsonLdList[0] || null;
}

function readHtmlAttribute(tag, attrPattern) {
  const regex = new RegExp(`(?:${attrPattern})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i');
  const match = tag.match(regex);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Extract meta tag contents from raw HTML.
 */
export function extractMetaTags(html) {
  const tags = new Map();
  const metaRegex = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const nameVal = readHtmlAttribute(tag, 'name|property|itemprop');
    const contentVal = readHtmlAttribute(tag, 'content');
    if (nameVal && contentVal !== null) {
      const key = nameVal.toLowerCase().trim();
      const content = decodeHtmlEntities(contentVal);
      if (!tags.has(key)) tags.set(key, content);
    }
  }
  // Title tag fallback
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    tags.set('page_title', decodeHtmlEntities(titleMatch[1]));
  }
  return tags;
}

function extractNextDataMedia(html) {
  const match = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    const pageProps = parsed?.props?.pageProps;
    if (!pageProps || typeof pageProps !== 'object') return null;
    const aboveTheFold = pageProps.aboveTheFoldData || pageProps.mainColumnData || pageProps.media || pageProps.title || pageProps.show || pageProps.movie || null;
    if (!aboveTheFold || typeof aboveTheFold !== 'object') return null;

    const title = aboveTheFold.titleText?.text || aboveTheFold.originalTitleText?.text || aboveTheFold.name || aboveTheFold.title || null;
    const description = aboveTheFold.plot?.plotText?.plainText || aboveTheFold.description || aboveTheFold.synopsis || aboveTheFold.overview || null;
    const year = Number(aboveTheFold.releaseYear?.year || aboveTheFold.releaseDate?.year || aboveTheFold.year) || null;
    const posterUrl = aboveTheFold.primaryImage?.url || aboveTheFold.posterUrl || aboveTheFold.image?.url || (typeof aboveTheFold.image === 'string' ? aboveTheFold.image : null);
    const genres = Array.isArray(aboveTheFold.genres?.genres)
      ? aboveTheFold.genres.genres.map((g) => cleanText(g?.text || g?.name || g, 40)).filter(Boolean)
      : Array.isArray(aboveTheFold.genres)
        ? aboveTheFold.genres.map((g) => cleanText(typeof g === 'string' ? g : g?.name || g?.text, 40)).filter(Boolean)
        : [];
    const countries = Array.isArray(aboveTheFold.countriesOfOrigin?.countries)
      ? aboveTheFold.countriesOfOrigin.countries.map((c) => cleanText(c?.id || c?.text || c, 12)).filter(Boolean)
      : [];
    const isSeries = Boolean(aboveTheFold.titleType?.isSeries || /series|tv/i.test(String(aboveTheFold.titleType?.id || aboveTheFold.type || '')));
    return { title, description, year, posterUrl, genres, countries, isSeries };
  } catch {
    return null;
  }
}

export function inferScrapedCategory({ domain = '', provider = '', genres = [], countries = [], languages = [], isSeries = false, isMovie = false, title = '', description = '' } = {}) {
  const lowerDomain = String(domain || '').toLowerCase();
  const genreText = (Array.isArray(genres) ? genres : []).join(' ').toLowerCase();
  const countryText = (Array.isArray(countries) ? countries : []).join(' ').toLowerCase();
  const langText = (Array.isArray(languages) ? languages : []).join(' ').toLowerCase();
  const bodyText = `${title || ''} ${description || ''}`.toLowerCase();

  const isAnimated = /\b(animation|animated|anime|cartoon|donghua)\b/i.test(genreText)
    || /\b(anime|donghua|animated\s+film|animated\s+series|cartoon)\b/i.test(bodyText);
  const isChinese = /\b(cn|chn|china|chinese|mandarin|cantonese|donghua)\b/i.test(`${countryText} ${langText} ${genreText}`);
  const isJapanese = /\b(jp|jpn|japan|japanese|anime)\b/i.test(`${countryText} ${langText} ${genreText}`);
  const isKorean = /\b(kr|kor|korea|korean|k-drama|kdrama)\b/i.test(`${countryText} ${langText} ${genreText}`);
  const isIndian = /\b(in|ind|india|hindi|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi)\b/i.test(`${countryText} ${langText}`);

  if (lowerDomain.includes('myanimelist.net') || lowerDomain.includes('crunchyroll.com')) {
    return isChinese ? 'donghua' : 'anime';
  }
  if (lowerDomain.includes('anilist.co')) {
    return isChinese ? 'donghua' : 'anime';
  }
  if (/\bdonghua\b/i.test(genreText) || /\bdonghua\b/i.test(bodyText)) return 'donghua';
  if (/\banime\b/i.test(genreText)) return 'anime';

  if (isAnimated) {
    if (isChinese) return 'donghua';
    if (isJapanese) return 'anime';
    return 'cartoon';
  }

  if (lowerDomain.includes('mydramalist.com')) {
    if (isChinese && !isMovie) return 'donghua';
    if (isKorean && !isMovie) return 'kdrama';
    return isMovie ? 'movie' : 'kdrama';
  }

  if (isKorean && isSeries) return 'kdrama';
  if (isChinese && isSeries) return 'donghua';
  if (isSeries) return isIndian ? 'tv' : 'web-series';
  if (isMovie) return 'movie';
  return null;
}

/**
 * Parse structured metadata from HTML text and base URL.
 */
export function parseMetadataFromHtml(html, pageUrl) {
  let domain = '';
  try {
    domain = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    domain = '';
  }

  const jsonLdList = extractJsonLd(html);
  const mediaEntity = findMediaEntity(jsonLdList);
  const nextData = extractNextDataMedia(html);
  const meta = extractMetaTags(html);

  // 1. Title
  let rawTitle = mediaEntity?.name || mediaEntity?.headline || nextData?.title || meta.get('og:title') || meta.get('twitter:title') || meta.get('page_title') || '';
  const title = cleanScrapedTitle(rawTitle, domain);

  // 2. Description / Synopsis
  let rawDescription = mediaEntity?.description || mediaEntity?.abstract || nextData?.description || meta.get('og:description') || meta.get('twitter:description') || meta.get('description') || '';
  if (!rawDescription) {
    const pMatch = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (pMatch) {
      const strippedP = pMatch[1].replace(/<[^>]+>/g, ' ').replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
      if (strippedP.length > 25) {
        rawDescription = strippedP;
      }
    }
  }
  // Strip any lingering HTML tags inside the description
  rawDescription = rawDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const description = cleanText(decodeHtmlEntities(rawDescription), 1400);

  // 3. Year
  const dateStr = mediaEntity?.datePublished || mediaEntity?.dateCreated || mediaEntity?.copyrightYear || mediaEntity?.releaseDate || meta.get('video:release_date') || (nextData?.year ? String(nextData.year) : null) || null;
  const year = extractYearFromScraped({ dateStr, title: rawTitle, text: rawDescription });

  // 4. Genres
  const genresSet = new Set();
  const rawGenre = mediaEntity?.genre || nextData?.genres;
  if (Array.isArray(rawGenre)) {
    for (const g of rawGenre) {
      if (typeof g === 'string') {
        for (const item of g.split(',')) {
          const cleaned = cleanText(item, 40);
          if (cleaned) genresSet.add(cleaned);
        }
      }
    }
  } else if (typeof rawGenre === 'string') {
    for (const item of rawGenre.split(',')) {
      const cleaned = cleanText(item, 40);
      if (cleaned) genresSet.add(cleaned);
    }
  }
  if (!genresSet.size) {
    const metaKeywords = meta.get('keywords') || meta.get('video:tag') || '';
    for (const item of metaKeywords.split(',')) {
      const cleaned = cleanText(item, 40);
      if (cleaned && !/^(watch|online|free|stream|download|hd|full|episode|season)\b/i.test(cleaned)) {
        genresSet.add(cleaned);
      }
    }
  }
  const genres = [...genresSet].slice(0, 6);

  // 5. Languages (extracted for inspection; /scrape will not overwrite actual file audio/sub tracks)
  const languagesSet = new Set();
  const rawLang = mediaEntity?.inLanguage;
  if (Array.isArray(rawLang)) {
    for (const l of rawLang) {
      const norm = normalizeScrapedLanguage(typeof l === 'object' ? l?.name : l);
      if (norm) languagesSet.add(norm);
    }
  } else if (rawLang) {
    const norm = normalizeScrapedLanguage(typeof rawLang === 'object' ? rawLang?.name : rawLang);
    if (norm) languagesSet.add(norm);
  }
  if (!languagesSet.size) {
    const locale = meta.get('og:locale');
    if (locale) {
      const code = locale.split('_')[0];
      const norm = normalizeScrapedLanguage(code);
      if (norm) languagesSet.add(norm);
    }
  }
  const languages = [...languagesSet].slice(0, 4);

  // Countries of origin if present in JSON-LD or NextData
  const countries = [];
  const rawCountry = mediaEntity?.countryOfOrigin || nextData?.countries;
  if (Array.isArray(rawCountry)) {
    for (const c of rawCountry) {
      const val = typeof c === 'object' ? (c?.name || c?.identifier || c?.id) : c;
      if (val) countries.push(String(val));
    }
  } else if (rawCountry) {
    const val = typeof rawCountry === 'object' ? (rawCountry?.name || rawCountry?.identifier) : rawCountry;
    if (val) countries.push(String(val));
  }

  // 6. Poster / Artwork
  let rawPosterUrl = null;
  const rawImg = mediaEntity?.image || mediaEntity?.thumbnailUrl || nextData?.posterUrl;
  if (typeof rawImg === 'string') {
    rawPosterUrl = rawImg;
  } else if (rawImg && typeof rawImg === 'object') {
    if (typeof rawImg.url === 'string') {
      rawPosterUrl = rawImg.url;
    } else if (Array.isArray(rawImg)) {
      const first = rawImg[0];
      rawPosterUrl = typeof first === 'string' ? first : first?.url || null;
    }
  }
  if (!rawPosterUrl) {
    rawPosterUrl = meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('og:image:url') || meta.get('twitter:image:src') || meta.get('twitter:image') || meta.get('image') || null;
  }
  if (!rawPosterUrl) {
    const linkImgMatch = html.match(/<link\b[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["']/i);
    if (linkImgMatch) rawPosterUrl = linkImgMatch[1];
  }
  if (!rawPosterUrl) {
    const infoboxImgMatch = html.match(/<table\b[^>]*class=["'][^"']*infobox[^"']*["'][\s\S]*?<img\b[^>]*src=["']([^"']+)["']/i);
    if (infoboxImgMatch) {
      rawPosterUrl = infoboxImgMatch[1];
    }
  }
  if (!rawPosterUrl) {
    const posterImgMatch = html.match(/<img\b[^>]*class=["'][^"']*poster[^"']*["'][^>]*?(?:data-src|src)=["']([^"']+)["']/i);
    if (posterImgMatch) {
      rawPosterUrl = posterImgMatch[1];
    }
  }
  let posterUrl = null;
  const posterFallbackUrls = [];
  if (rawPosterUrl) {
    try {
      const resolvedUrl = new URL(decodeHtmlEntities(rawPosterUrl), pageUrl).href;
      posterUrl = enhancePosterUrl(resolvedUrl);
      if (resolvedUrl && resolvedUrl !== posterUrl) {
        posterFallbackUrls.push(resolvedUrl);
      }
      if ((posterUrl.includes('media-amazon.com') || posterUrl.includes('imdb.com')) && /\._V1_/i.test(posterUrl)) {
        posterFallbackUrls.push(posterUrl.replace(/\.?_V1_.*?(\.(?:jpe?g|png|webp))$/i, '._V1_FMjpg_UX1000_.jpg'));
      }
    } catch {
      posterUrl = null;
    }
  }

  // 7. Release Label / Type
  let releaseLabel = null;
  const rawType = mediaEntity?.['@type'];
  const entityTypes = Array.isArray(rawType) ? rawType : [rawType].filter(Boolean);
  const isSeries = entityTypes.some((t) => ['TVSeries', 'Series', 'TVSeason', 'TVEpisode'].includes(t))
    || meta.get('og:type') === 'video.tv_show'
    || Boolean(nextData?.isSeries)
    || /\b(?:tv\s*series|tv\s*mini\s*series|web\s*series)\b/i.test(rawTitle);
  const isMovie = entityTypes.includes('Movie')
    || meta.get('og:type') === 'video.movie'
    || (!isSeries && Boolean(title));
  if (isSeries) {
    releaseLabel = 'TV Series';
  } else if (isMovie && (entityTypes.includes('Movie') || meta.get('og:type') === 'video.movie')) {
    releaseLabel = 'Movie';
  }
  if (mediaEntity?.contentRating) {
    releaseLabel = releaseLabel ? `${releaseLabel} · ${mediaEntity.contentRating}` : mediaEntity.contentRating;
  }

  // Provider
  let provider = 'web';
  if (domain.includes('imdb.com')) provider = 'imdb';
  else if (domain.includes('netflix.com')) provider = 'netflix';
  else if (domain.includes('myanimelist.net')) provider = 'myanimelist';
  else if (domain.includes('anilist.co')) provider = 'anilist';
  else if (domain.includes('crunchyroll.com')) provider = 'crunchyroll';
  else if (domain.includes('wikipedia.org')) provider = 'wikipedia';
  else if (domain.includes('themoviedb.org')) provider = 'tmdb';
  else if (domain.includes('thetvdb.com')) provider = 'tvdb';
  else if (domain.includes('fandom.com')) provider = 'fandom';
  else if (domain.includes('mydramalist.com')) provider = 'mydramalist';

  const category = inferScrapedCategory({
    domain,
    provider,
    genres,
    countries,
    languages,
    isSeries,
    isMovie: entityTypes.includes('Movie') || meta.get('og:type') === 'video.movie' || (!isSeries && Boolean(title)),
    title,
    description
  });

  return {
    url: pageUrl,
    domain,
    provider,
    category,
    title: title || null,
    year,
    description: description || null,
    genres,
    languages,
    posterUrl,
    posterFallbackUrls,
    releaseLabel
  };
}

const TMDB_GENRE_NAMES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10765: 'Sci-Fi & Fantasy'
};

async function scrapeImdbViaApis(imdbId, pageUrl, config = null) {
  // 1. Try TMDB /find/{imdb_id} if TMDB credentials are configured
  if (config?.tmdbApiKey || config?.tmdbReadAccessToken) {
    try {
      const findUrl = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
      findUrl.searchParams.set('external_source', 'imdb_id');
      if (config.tmdbApiKey && !config.tmdbReadAccessToken) {
        findUrl.searchParams.set('api_key', config.tmdbApiKey);
      }
      const headers = config.tmdbReadAccessToken
        ? { Authorization: `Bearer ${config.tmdbReadAccessToken}`, Accept: 'application/json' }
        : { Accept: 'application/json' };
      const res = await fetch(findUrl, { headers, signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const data = await res.json();
        const movie = Array.isArray(data?.movie_results) ? data.movie_results[0] : null;
        const tv = Array.isArray(data?.tv_results) ? data.tv_results[0] : null;
        const item = movie || tv;
        const type = movie ? 'movie' : 'tv';
        if (item) {
          const genreIds = (Array.isArray(item.genre_ids) ? item.genre_ids : []).map(Number).filter(Number.isInteger);
          const genres = genreIds.map((id) => TMDB_GENRE_NAMES[id]).filter(Boolean).slice(0, 6);
          const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w780${item.poster_path}` : null;
          const dateStr = item.release_date || item.first_air_date || '';
          const year = extractYearFromScraped({ dateStr });
          const category = categoryFromHints({
            hints: {
              provider: 'tmdb',
              score: 1,
              type,
              originCountry: Array.isArray(item.origin_country) && item.origin_country[0]
                ? item.origin_country[0]
                : (item.original_language === 'ja' ? 'JP' : item.original_language === 'zh' ? 'CN' : item.original_language === 'ko' ? 'KR' : item.original_language === 'hi' ? 'IN' : 'US'),
              genreIds,
              genres
            }
          });
          return {
            url: pageUrl,
            domain: 'imdb.com',
            provider: 'imdb',
            category,
            title: cleanText(item.title || item.name || item.original_title || item.original_name, 180),
            year,
            description: cleanText(item.overview, 1400) || null,
            genres,
            languages: [],
            posterUrl,
            posterFallbackUrls: item.backdrop_path ? [`https://image.tmdb.org/t/p/w780${item.backdrop_path}`] : [],
            releaseLabel: type === 'tv' ? 'TV Series' : 'Movie'
          };
        }
      }
    } catch {}
  }

  // 2. Try OMDb API if configured
  if (config?.omdbApiKey) {
    try {
      const omdbRes = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&plot=full&apikey=${encodeURIComponent(config.omdbApiKey)}`, {
        signal: AbortSignal.timeout(8_000)
      });
      if (omdbRes.ok) {
        const data = await omdbRes.json();
        if (data.Response !== 'False' && data.Title) {
          const genres = data.Genre && data.Genre !== 'N/A' ? data.Genre.split(',').map((g) => cleanText(g, 40)).filter(Boolean).slice(0, 6) : [];
          const countries = data.Country && data.Country !== 'N/A' ? data.Country.split(',').map((c) => cleanText(c, 40)).filter(Boolean) : [];
          const languages = data.Language && data.Language !== 'N/A' ? data.Language.split(',').map((l) => cleanText(l, 40)).filter(Boolean).slice(0, 4) : [];
          const isSeries = data.Type === 'series';
          const rawPoster = data.Poster && data.Poster !== 'N/A' ? data.Poster : null;
          const posterUrl = rawPoster ? enhancePosterUrl(rawPoster) : null;
          return {
            url: pageUrl,
            domain: 'imdb.com',
            provider: 'imdb',
            category: inferScrapedCategory({ domain: 'imdb.com', provider: 'imdb', genres, countries, languages, isSeries, isMovie: !isSeries, title: data.Title, description: data.Plot }),
            title: cleanText(data.Title, 180),
            year: Number.parseInt(data.Year, 10) || null,
            description: cleanText(data.Plot !== 'N/A' ? data.Plot : '', 1400) || null,
            genres,
            languages,
            posterUrl,
            posterFallbackUrls: rawPoster && rawPoster !== posterUrl ? [rawPoster] : [],
            releaseLabel: data.Type ? (isSeries ? 'TV Series' : 'Movie') : null
          };
        }
      }
    } catch {}
  }

  // 3. Try Cinemeta public metadata API (works without API key for any tt* IMDb ID)
  for (const metaType of ['movie', 'series']) {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${metaType}/${encodeURIComponent(imdbId)}.json`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6_000)
      });
      if (res.ok) {
        const payload = await res.json();
        const meta = payload?.meta;
        if (meta && meta.name) {
          const genres = Array.isArray(meta.genres) ? meta.genres.map((g) => cleanText(g, 40)).filter(Boolean).slice(0, 6) : [];
          const countries = meta.country ? String(meta.country).split(',').map((c) => cleanText(c, 40)).filter(Boolean) : [];
          const isSeries = metaType === 'series' || meta.type === 'series';
          const rawPoster = meta.poster || null;
          const posterUrl = rawPoster ? enhancePosterUrl(rawPoster) : null;
          return {
            url: pageUrl,
            domain: 'imdb.com',
            provider: 'imdb',
            category: inferScrapedCategory({ domain: 'imdb.com', provider: 'imdb', genres, countries, isSeries, isMovie: !isSeries, title: meta.name, description: meta.description }),
            title: cleanText(meta.name, 180),
            year: extractYearFromScraped({ dateStr: String(meta.year || meta.releaseInfo || '') }),
            description: cleanText(meta.description, 1400) || null,
            genres,
            languages: [],
            posterUrl,
            posterFallbackUrls: [rawPoster, meta.background].filter((u) => u && u !== posterUrl),
            releaseLabel: isSeries ? 'TV Series' : 'Movie'
          };
        }
      }
    } catch {}
  }

  // 4. Try IMDb's own public suggestion JSON CDN API (works without WAF for any tt* ID)
  try {
    const sugUrl = `https://v3.sg.media-imdb.com/suggestion/t/${encodeURIComponent(imdbId)}.json`;
    const res = await fetch(sugUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6_000)
    });
    if (res.ok) {
      const data = await res.json();
      const entry = (Array.isArray(data?.d) ? data.d : []).find((item) => item?.id === imdbId) || data?.d?.[0];
      if (entry && entry.l) {
        const isSeries = /series|tv/i.test(String(entry.q || entry.qid || ''));
        const rawPoster = entry.i?.imageUrl || null;
        const posterUrl = rawPoster ? enhancePosterUrl(rawPoster) : null;
        return {
          url: pageUrl,
          domain: 'imdb.com',
          provider: 'imdb',
          category: isSeries ? 'web-series' : 'movie',
          title: cleanText(entry.l, 180),
          year: Number.isInteger(Number(entry.y)) ? Number(entry.y) : null,
          description: null,
          genres: [],
          languages: [],
          posterUrl,
          posterFallbackUrls: rawPoster && rawPoster !== posterUrl ? [rawPoster] : [],
          releaseLabel: isSeries ? 'TV Series' : 'Movie'
        };
      }
    }
  } catch {}

  return null;
}

async function scrapePlatformApiByUrl(parsedUrl, config = null) {
  const host = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();

  // AniList direct GraphQL lookup by anime ID: https://anilist.co/anime/151807/...
  const anilistMatch = host.includes('anilist.co') ? parsedUrl.pathname.match(/\/anime\/(\d+)/i) : null;
  if (anilistMatch) {
    try {
      const mediaId = Number.parseInt(anilistMatch[1], 10);
      const query = `
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id
            format
            countryOfOrigin
            title { english romaji native }
            description(asHtml: false)
            genres
            startDate { year }
            coverImage { extraLarge large medium }
            bannerImage
          }
        }
      `;
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: { id: mediaId } }),
        signal: AbortSignal.timeout(8_000)
      });
      if (res.ok) {
        const payload = await res.json();
        const media = payload?.data?.Media;
        if (media) {
          const country = cleanText(media.countryOfOrigin, 4).toUpperCase();
          const category = country === 'CN' ? 'donghua' : 'anime';
          const posterUrl = media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || null;
          return {
            url: parsedUrl.href,
            domain: 'anilist.co',
            provider: 'anilist',
            category,
            title: cleanText(media.title?.english || media.title?.romaji || media.title?.native, 180),
            year: Number.isInteger(media.startDate?.year) ? media.startDate.year : null,
            description: cleanText(String(media.description || '').replace(/<[^>]+>/g, ' '), 1400) || null,
            genres: Array.isArray(media.genres) ? media.genres.map((g) => cleanText(g, 40)).filter(Boolean).slice(0, 6) : [],
            languages: [],
            posterUrl,
            posterFallbackUrls: [media.coverImage?.large, media.bannerImage].filter((u) => u && u !== posterUrl),
            releaseLabel: media.format === 'MOVIE' ? 'Movie' : 'Anime Series'
          };
        }
      }
    } catch {}
  }

  // MyAnimeList via Jikan API: https://myanimelist.net/anime/52991/...
  const malMatch = host.includes('myanimelist.net') ? parsedUrl.pathname.match(/\/anime\/(\d+)/i) : null;
  if (malMatch) {
    try {
      const res = await fetch(`https://api.jikan.moe/v4/anime/${encodeURIComponent(malMatch[1])}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000)
      });
      if (res.ok) {
        const payload = await res.json();
        const data = payload?.data;
        if (data && (data.title_english || data.title)) {
          const genres = [
            ...(Array.isArray(data.genres) ? data.genres : []),
            ...(Array.isArray(data.themes) ? data.themes : [])
          ].map((g) => cleanText(g?.name, 40)).filter(Boolean).slice(0, 6);
          const posterUrl = data.images?.jpg?.large_image_url || data.images?.jpg?.image_url || null;
          return {
            url: parsedUrl.href,
            domain: 'myanimelist.net',
            provider: 'myanimelist',
            category: 'anime',
            title: cleanText(data.title_english || data.title, 180),
            year: Number(data.year || data.aired?.prop?.from?.year) || null,
            description: cleanText(data.synopsis, 1400) || null,
            genres,
            languages: [],
            posterUrl,
            posterFallbackUrls: [data.images?.jpg?.image_url].filter((u) => u && u !== posterUrl),
            releaseLabel: data.type === 'Movie' ? 'Movie' : 'Anime Series'
          };
        }
      }
    } catch {}
  }

  // TMDB direct API: https://www.themoviedb.org/movie/12345 or /tv/12345
  const tmdbMatch = host.includes('themoviedb.org') ? parsedUrl.pathname.match(/\/(movie|tv)\/(\d+)/i) : null;
  if (tmdbMatch && (config?.tmdbApiKey || config?.tmdbReadAccessToken)) {
    try {
      const type = tmdbMatch[1].toLowerCase();
      const id = tmdbMatch[2];
      const apiUrl = new URL(`https://api.themoviedb.org/3/${type}/${encodeURIComponent(id)}`);
      if (config.tmdbApiKey && !config.tmdbReadAccessToken) {
        apiUrl.searchParams.set('api_key', config.tmdbApiKey);
      }
      const headers = config.tmdbReadAccessToken
        ? { Authorization: `Bearer ${config.tmdbReadAccessToken}`, Accept: 'application/json' }
        : { Accept: 'application/json' };
      const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const data = await res.json();
        const genres = (Array.isArray(data?.genres) ? data.genres : []).map((g) => cleanText(g?.name, 40)).filter(Boolean).slice(0, 6);
        const genreIds = (Array.isArray(data?.genres) ? data.genres : []).map((g) => Number(g?.id)).filter(Number.isInteger);
        const originCountry = (Array.isArray(data?.origin_country) && data.origin_country[0])
          || (Array.isArray(data?.production_countries) && data.production_countries[0]?.iso_3166_1)
          || null;
        const posterUrl = data?.poster_path ? `https://image.tmdb.org/t/p/w780${data.poster_path}` : null;
        const category = categoryFromHints({
          hints: { provider: 'tmdb', score: 1, type, originCountry, genreIds, genres }
        });
        return {
          url: parsedUrl.href,
          domain: 'themoviedb.org',
          provider: 'tmdb',
          category,
          title: cleanText(data.title || data.name || data.original_title || data.original_name, 180),
          year: extractYearFromScraped({ dateStr: data.release_date || data.first_air_date }),
          description: cleanText(data.overview, 1400) || null,
          genres,
          languages: [],
          posterUrl,
          posterFallbackUrls: data?.backdrop_path ? [`https://image.tmdb.org/t/p/w780${data.backdrop_path}`] : [],
          releaseLabel: type === 'tv' ? 'TV Series' : 'Movie'
        };
      }
    } catch {}
  }

  return null;
}

function mergeScrapedResults(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const fallbacks = new Set([
    ...(Array.isArray(primary.posterFallbackUrls) ? primary.posterFallbackUrls : []),
    ...(Array.isArray(secondary.posterFallbackUrls) ? secondary.posterFallbackUrls : [])
  ]);
  if (primary.posterUrl && secondary.posterUrl && primary.posterUrl !== secondary.posterUrl) {
    fallbacks.add(secondary.posterUrl);
  }
  return {
    ...primary,
    title: primary.title || secondary.title || null,
    year: primary.year || secondary.year || null,
    description: primary.description || secondary.description || null,
    genres: primary.genres?.length ? primary.genres : (secondary.genres || []),
    languages: primary.languages?.length ? primary.languages : (secondary.languages || []),
    posterUrl: primary.posterUrl || secondary.posterUrl || null,
    posterFallbackUrls: [...fallbacks].filter(Boolean),
    releaseLabel: primary.releaseLabel || secondary.releaseLabel || null,
    category: primary.category || secondary.category || null
  };
}

/**
 * Fetch and scrape media metadata from a given web URL.
 */
export async function scrapeMetadataFromUrl(url, { html = null, timeoutMs = 12_000, config = null } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { error: 'Invalid URL. Only HTTP and HTTPS links are supported.' };
    }
  } catch {
    return { error: 'Invalid URL format. Please provide a full link (e.g. https://www.imdb.com/title/tt43056433/).' };
  }

  let pageHtml = html;
  if (!pageHtml) {
    try {
      const response = await fetch(parsedUrl.href, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/'
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) {
        pageHtml = await response.text();
      }
    } catch {
      // Network fetch failure
    }
  }

  let htmlResult = null;
  if (pageHtml) {
    const parsed = parseMetadataFromHtml(pageHtml, parsedUrl.href);
    if (parsed.title || parsed.description || parsed.posterUrl) {
      htmlResult = parsed;
    }
  }

  // If HTML was provided directly (e.g. in unit tests) or already has complete info, return early unless missing key fields
  if (html && htmlResult) {
    return htmlResult;
  }

  // Check IMDb APIs if URL is an IMDb title link and HTML either failed or missed poster/description/title
  const imdbIdMatch = parsedUrl.pathname.match(/\/title\/(tt\d+)/i);
  if (imdbIdMatch && (!htmlResult || !htmlResult.title || !htmlResult.posterUrl || !htmlResult.description)) {
    const apiResult = await scrapeImdbViaApis(imdbIdMatch[1], parsedUrl.href, config);
    htmlResult = mergeScrapedResults(htmlResult, apiResult);
  }

  // Check platform-specific APIs (AniList, MyAnimeList, TMDB) if HTML failed or missed fields
  if (!htmlResult || !htmlResult.title || !htmlResult.posterUrl || !htmlResult.description) {
    const platformResult = await scrapePlatformApiByUrl(parsedUrl, config);
    htmlResult = mergeScrapedResults(htmlResult, platformResult);
  }

  // If we have a title from the page (or URL slug) but still lack posterUrl or description, enrich via findMetadata
  if (htmlResult?.title && (!htmlResult.posterUrl || !htmlResult.description) && config) {
    try {
      const providerMeta = await findMetadata(htmlResult.title, htmlResult.category || 'movie', config);
      if (providerMeta?.matched) {
        htmlResult = mergeScrapedResults(htmlResult, {
          title: providerMeta.title,
          year: providerMeta.year,
          description: providerMeta.description,
          genres: providerMeta.genres,
          posterUrl: providerMeta.posterOriginalUrl,
          releaseLabel: providerMeta.releaseLabel,
          category: providerMeta.inferredCategory || htmlResult.category || null
        });
      }
    } catch {}
  }

  if (htmlResult && (htmlResult.title || htmlResult.description || htmlResult.posterUrl)) {
    return htmlResult;
  }

  return {
    error: pageHtml
      ? 'No recognizable media metadata (title, poster, synopsis) could be extracted from that page.'
      : 'Could not access that web page. Make sure the link is public and accessible.'
  };
}

/**
 * Parse `/scrape [Post ID] <URL>` arguments supporting plain URLs, markdown links, and swapped order.
 */
export function parseScrapeArguments(text) {
  const raw = String(text || '').trim();
  const body = raw.replace(/^\s*[/!]?scrape(?:@[A-Za-z0-9_]{3,64})?\b/i, '').trim();
  if (!body) return { adminId: null, url: null, empty: true };

  // 1. Check for explicit Post ID with SB- prefix: SB-[A-F0-9]{10}
  const idMatch = body.match(/\b(SB-[A-F0-9]{10})\b/i);
  let adminId = idMatch ? idMatch[1].toUpperCase() : null;

  // 2. Check for URL (plain or markdown [label](url) or <url>)
  let url = null;
  const mdMatch = body.match(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/i);
  if (mdMatch) {
    url = mdMatch[1].trim().replace(/[.,;>)]+$/, '');
  } else {
    const urlMatch = body.match(/https?:\/\/[^\s)\]>"']+/i);
    if (urlMatch) url = urlMatch[0].trim().replace(/[.,;>)]+$/, '');
  }

  // 3. If no SB- ID was found, check if a bare 10-hex-digit ID was provided
  if (!adminId) {
    const withoutUrl = url ? body.replace(url, ' ') : body;
    const bareIdMatch = withoutUrl.match(/\b([A-F0-9]{10})\b/i);
    if (bareIdMatch) adminId = `SB-${bareIdMatch[1].toUpperCase()}`;
  }

  return { adminId, url, empty: !adminId && !url };
}

