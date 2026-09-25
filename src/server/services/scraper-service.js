import { cleanText } from '../lib/strings.js';

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

/**
 * Extract meta tag contents from raw HTML.
 */
export function extractMetaTags(html) {
  const tags = new Map();
  const metaRegex = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/(?:name|property|itemprop)=["']([^"']+)["']/i);
    const contentMatch = tag.match(/content=["']([^"']*)["']/i);
    if (nameMatch && contentMatch) {
      const key = nameMatch[1].toLowerCase().trim();
      const content = decodeHtmlEntities(contentMatch[1]);
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
  const meta = extractMetaTags(html);

  // 1. Title
  let rawTitle = mediaEntity?.name || mediaEntity?.headline || meta.get('og:title') || meta.get('twitter:title') || meta.get('page_title') || '';
  const title = cleanScrapedTitle(rawTitle, domain);

  // 2. Description / Synopsis
  let rawDescription = mediaEntity?.description || mediaEntity?.abstract || meta.get('og:description') || meta.get('twitter:description') || meta.get('description') || '';
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
  const dateStr = mediaEntity?.datePublished || mediaEntity?.dateCreated || mediaEntity?.copyrightYear || mediaEntity?.releaseDate || meta.get('video:release_date') || null;
  const year = extractYearFromScraped({ dateStr, title: rawTitle, text: rawDescription });

  // 4. Genres
  const genresSet = new Set();
  const rawGenre = mediaEntity?.genre;
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

  // 5. Languages
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

  // 6. Poster / Artwork
  let rawPosterUrl = null;
  const rawImg = mediaEntity?.image;
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
    rawPosterUrl = meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('twitter:image:src') || meta.get('twitter:image') || null;
  }
  if (!rawPosterUrl) {
    const infoboxImgMatch = html.match(/<table\b[^>]*class=["'][^"']*infobox[^"']*["'][\s\S]*?<img\b[^>]*src=["']([^"']+)["']/i);
    if (infoboxImgMatch) {
      rawPosterUrl = infoboxImgMatch[1];
    }
  }
  let posterUrl = null;
  if (rawPosterUrl) {
    try {
      posterUrl = new URL(rawPosterUrl, pageUrl).href;
      posterUrl = enhancePosterUrl(posterUrl);
    } catch {
      posterUrl = null;
    }
  }

  // 7. Release Label / Type
  let releaseLabel = null;
  const entityType = mediaEntity?.['@type'];
  const isSeries = entityType === 'TVSeries' || entityType === 'Series' || meta.get('og:type') === 'video.tv_show';
  const isMovie = entityType === 'Movie' || meta.get('og:type') === 'video.movie';
  if (isSeries) {
    releaseLabel = 'TV Series';
  } else if (isMovie) {
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

  return {
    url: pageUrl,
    domain,
    provider,
    title: title || null,
    year,
    description: description || null,
    genres,
    languages,
    posterUrl,
    releaseLabel
  };
}

/**
 * Fetch and scrape media metadata from a given web URL.
 */
export async function scrapeMetadataFromUrl(url, { html = null, timeoutMs = 15_000, config = null } = {}) {
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
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
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

  // If HTML was obtained, parse it
  if (pageHtml) {
    const parsed = parseMetadataFromHtml(pageHtml, parsedUrl.href);
    if (parsed.title || parsed.description || parsed.posterUrl) {
      return parsed;
    }
  }

  // Fallback for IMDb URLs if direct fetch failed or was blocked, and OMDb API key is configured
  const imdbIdMatch = parsedUrl.pathname.match(/\/title\/(tt\d+)/i);
  if (imdbIdMatch && config?.omdbApiKey) {
    try {
      const omdbRes = await fetch(`https://www.omdbapi.com/?i=${imdbIdMatch[1]}&apikey=${encodeURIComponent(config.omdbApiKey)}`, {
        signal: AbortSignal.timeout(10_000)
      });
      if (omdbRes.ok) {
        const data = await omdbRes.json();
        if (data.Response !== 'False' && data.Title) {
          return {
            url: parsedUrl.href,
            domain: 'imdb.com',
            provider: 'imdb',
            title: cleanText(data.Title, 180),
            year: Number.parseInt(data.Year, 10) || null,
            description: cleanText(data.Plot !== 'N/A' ? data.Plot : '', 1400),
            genres: data.Genre && data.Genre !== 'N/A' ? data.Genre.split(',').map((g) => cleanText(g, 40)).filter(Boolean).slice(0, 6) : [],
            languages: data.Language && data.Language !== 'N/A' ? data.Language.split(',').map((l) => cleanText(l, 40)).filter(Boolean).slice(0, 4) : [],
            posterUrl: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
            releaseLabel: data.Type ? (data.Type === 'series' ? 'TV Series' : 'Movie') : null
          };
        }
      }
    } catch {}
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

