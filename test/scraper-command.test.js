import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import {
  cleanScrapedTitle,
  decodeHtmlEntities,
  enhancePosterUrl,
  extractJsonLd,
  extractMetaTags,
  extractYearFromScraped,
  normalizeScrapedLanguage,
  parseMetadataFromHtml,
  parseScrapeArguments,
  scrapeMetadataFromUrl
} from '../src/server/services/scraper-service.js';
import {
  handleScrapeCommand
} from '../src/server/services/telegram-bot.js';
import {
  clearPosterUploadCache,
  configurePosterKeys,
  configurePosterUploadOptions,
  resetPosterUploadPace
} from '../src/server/services/poster-service.js';

const originalFetch = globalThis.fetch;

test('cleanScrapedTitle removes site branding, TV indicators, and decodes HTML entities', () => {
  assert.equal(
    cleanScrapedTitle('Solo Leveling &amp; Friends - IMDb', 'imdb.com'),
    'Solo Leveling & Friends'
  );
  assert.equal(
    cleanScrapedTitle('Stranger Things | Netflix Official Site', 'netflix.com'),
    'Stranger Things'
  );
  assert.equal(
    cleanScrapedTitle('Frieren: Beyond Journey&#39;s End - MyAnimeList.net', 'myanimelist.net'),
    "Frieren: Beyond Journey's End"
  );
  assert.equal(
    cleanScrapedTitle('Demon Slayer · AniList', 'anilist.co'),
    'Demon Slayer'
  );
  assert.equal(
    cleanScrapedTitle('Watch Jujutsu Kaisen - Watch on Crunchyroll', 'crunchyroll.com'),
    'Jujutsu Kaisen'
  );
  assert.equal(
    cleanScrapedTitle('Dune: Part Two - Wikipedia', 'wikipedia.org'),
    'Dune: Part Two'
  );
  assert.equal(
    cleanScrapedTitle('House of the Dragon (TV Series 2022– ) - IMDb', 'imdb.com'),
    'House of the Dragon'
  );
  assert.equal(
    cleanScrapedTitle('Arcane: League of Legends | Fandom', 'fandom.com'),
    'Arcane: League of Legends'
  );
  assert.equal(
    cleanScrapedTitle('Spider-Man: Across the Spider-Verse — The Movie Database (TMDB)', 'themoviedb.org'),
    'Spider-Man: Across the Spider-Verse'
  );
});

test('extractYearFromScraped correctly parses valid 4-digit release years', () => {
  assert.equal(extractYearFromScraped({ dateStr: '2024-03-01T00:00:00Z' }), 2024);
  assert.equal(extractYearFromScraped({ dateStr: 'November 5, 2021' }), 2021);
  assert.equal(extractYearFromScraped({ title: 'Blade Runner 2049 (2017)' }), 2017);
  assert.equal(extractYearFromScraped({ title: '2001: A Space Odyssey' }), 2001);
  assert.equal(extractYearFromScraped({ text: 'A science fiction movie released in 2023.' }), 2023);
  assert.equal(extractYearFromScraped({ dateStr: '1850-01-01' }), null); // too old (< 1888)
  assert.equal(extractYearFromScraped({ dateStr: '3050-01-01' }), null); // too far in future
  assert.equal(extractYearFromScraped({}), null);
});

test('normalizeScrapedLanguage standardizes ISO codes and language names', () => {
  assert.equal(normalizeScrapedLanguage('ja'), 'Japanese');
  assert.equal(normalizeScrapedLanguage('hi'), 'Hindi');
  assert.equal(normalizeScrapedLanguage('en'), 'English');
  assert.equal(normalizeScrapedLanguage('ko'), 'Korean');
  assert.equal(normalizeScrapedLanguage('zh'), 'Chinese');
  assert.equal(normalizeScrapedLanguage('french'), 'French');
  assert.equal(normalizeScrapedLanguage(null), null);
});

test('enhancePosterUrl converts Amazon and IMDb thumbnails to full-resolution images', () => {
  const thumbUrl = 'https://m.media-amazon.com/images/M/MV5BMDFkYTc0MGEtdeg..._V1_QL75_UX380_CR0,0,380,562_.jpg';
  assert.equal(
    enhancePosterUrl(thumbUrl),
    'https://m.media-amazon.com/images/M/MV5BMDFkYTc0MGEtdeg..._V1_.jpg'
  );

  const regularUrl = 'https://images.unsplash.com/photo-1534447677768-be436bb09401.jpg';
  assert.equal(enhancePosterUrl(regularUrl), regularUrl);
});

test('extractJsonLd and extractMetaTags parse complex web pages', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Sample Movie (2024) - IMDb</title>
        <meta property="og:title" content="Sample Movie" />
        <meta property="og:description" content="A great movie about heroes." />
        <meta property="og:image" content="https://example.com/poster.jpg" />
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Movie",
          "name": "Sample Movie",
          "image": "https://m.media-amazon.com/images/M/sample._V1_UX300.jpg",
          "description": "An undercover agent embarks on a high-stakes mission.",
          "datePublished": "2024-05-10",
          "genre": ["Action", "Sci-Fi"],
          "inLanguage": "en",
          "contentRating": "PG-13"
        }
        </script>
      </head>
      <body></body>
    </html>
  `;

  const parsed = parseMetadataFromHtml(html, 'https://www.imdb.com/title/tt43056433/');
  assert.equal(parsed.title, 'Sample Movie');
  assert.equal(parsed.year, 2024);
  assert.equal(parsed.description, 'An undercover agent embarks on a high-stakes mission.');
  assert.deepEqual(parsed.genres, ['Action', 'Sci-Fi']);
  assert.deepEqual(parsed.languages, ['English']);
  assert.equal(parsed.releaseLabel, 'Movie · PG-13');
  assert.equal(parsed.provider, 'imdb');
  assert.equal(parsed.posterUrl, 'https://m.media-amazon.com/images/M/sample._V1_.jpg');
});

test('parseMetadataFromHtml falls back to OpenGraph and Twitter meta tags', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Stranger Things | Netflix Official Site</title>
        <meta property="og:title" content="Stranger Things" />
        <meta property="og:description" content="When a young boy vanishes, a small town uncovers a mystery." />
        <meta property="og:image" content="https://occ.a.nflxso.net/dnm/api/v6/stranger-things.jpg" />
        <meta property="og:type" content="video.tv_show" />
        <meta property="og:locale" content="en_US" />
        <meta name="keywords" content="Supernatural, Drama, Mystery" />
      </head>
      <body></body>
    </html>
  `;

  const parsed = parseMetadataFromHtml(html, 'https://www.netflix.com/title/80057281');
  assert.equal(parsed.title, 'Stranger Things');
  assert.equal(parsed.description, 'When a young boy vanishes, a small town uncovers a mystery.');
  assert.equal(parsed.posterUrl, 'https://occ.a.nflxso.net/dnm/api/v6/stranger-things.jpg');
  assert.equal(parsed.releaseLabel, 'TV Series');
  assert.deepEqual(parsed.genres, ['Supernatural', 'Drama', 'Mystery']);
  assert.deepEqual(parsed.languages, ['English']);
  assert.equal(parsed.provider, 'netflix');
});

test('parseMetadataFromHtml extracts Wikipedia infobox images and paragraph description', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Dune: Part Two - Wikipedia</title>
      </head>
      <body>
        <table class="infobox vevent">
          <tr><td class="infobox-image"><img src="//upload.wikimedia.org/wikipedia/en/5/52/Dune_Part_Two_poster.jpeg" /></td></tr>
        </table>
        <p><i><b>Dune: Part Two</b></i> is a 2024 American epic science fiction film directed by Denis Villeneuve.</p>
      </body>
    </html>
  `;

  const parsed = parseMetadataFromHtml(html, 'https://en.wikipedia.org/wiki/Dune:_Part_Two');
  assert.equal(parsed.title, 'Dune: Part Two');
  assert.equal(parsed.year, 2024);
  assert.ok(parsed.description.includes('2024 American epic science fiction film'));
  assert.equal(parsed.posterUrl, 'https://upload.wikimedia.org/wikipedia/en/5/52/Dune_Part_Two_poster.jpeg');
  assert.equal(parsed.provider, 'wikipedia');
});

test('parseScrapeArguments extracts Post ID and URL in any order or format', () => {
  // Post ID first, URL second
  const p1 = parseScrapeArguments('/scrape SB-0123ABCDEF https://www.imdb.com/title/tt43056433/');
  assert.equal(p1.adminId, 'SB-0123ABCDEF');
  assert.equal(p1.url, 'https://www.imdb.com/title/tt43056433/');
  assert.equal(p1.empty, false);

  // URL first, Post ID second
  const p2 = parseScrapeArguments('/scrape https://www.imdb.com/title/tt43056433/ SB-0123ABCDEF');
  assert.equal(p2.adminId, 'SB-0123ABCDEF');
  assert.equal(p2.url, 'https://www.imdb.com/title/tt43056433/');

  // Bare hex ID
  const p3 = parseScrapeArguments('/scrape 0123ABCDEF https://www.netflix.com/title/80057281');
  assert.equal(p3.adminId, 'SB-0123ABCDEF');
  assert.equal(p3.url, 'https://www.netflix.com/title/80057281');

  // URL only (for draft session)
  const p4 = parseScrapeArguments('/scrape https://myanimelist.net/anime/52299/Solo_Leveling');
  assert.equal(p4.adminId, null);
  assert.equal(p4.url, 'https://myanimelist.net/anime/52299/Solo_Leveling');
  assert.equal(p4.empty, false);

  // Markdown link
  const p5 = parseScrapeArguments('/scrape SB-1122334455 [Crunchyroll](https://www.crunchyroll.com/series/GEXH3W298/solo-leveling)');
  assert.equal(p5.adminId, 'SB-1122334455');
  assert.equal(p5.url, 'https://www.crunchyroll.com/series/GEXH3W298/solo-leveling');

  // Trailing punctuation trimmed
  const p6 = parseScrapeArguments('/scrape SB-0123ABCDEF <https://www.imdb.com/title/tt43056433/>.');
  assert.equal(p6.url, 'https://www.imdb.com/title/tt43056433/');

  // Empty command
  const p7 = parseScrapeArguments('/scrape');
  assert.equal(p7.empty, true);
  assert.equal(p7.adminId, null);
  assert.equal(p7.url, null);
});

test('scrapeMetadataFromUrl falls back to OMDb API for IMDb URLs when page fetch fails', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('imdb.com')) {
      // Simulate IMDb blocking bot fetch with 403 Forbidden
      return { ok: false, status: 403, text: async () => '' };
    }
    if (urlStr.includes('omdbapi.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Title: 'Inception',
          Year: '2010',
          Plot: 'A thief who steals corporate secrets through the use of dream-sharing technology.',
          Genre: 'Action, Sci-Fi',
          Language: 'English, Japanese, French',
          Poster: 'https://m.media-amazon.com/images/M/inception.jpg',
          Type: 'movie',
          Response: 'True'
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const result = await scrapeMetadataFromUrl('https://www.imdb.com/title/tt1375666/', {
    config: { omdbApiKey: 'test-omdb-key' }
  });

  assert.equal(result.title, 'Inception');
  assert.equal(result.year, 2010);
  assert.equal(result.releaseLabel, 'Movie');
  assert.ok(result.description.includes('dream-sharing'));
  assert.deepEqual(result.genres, ['Action', 'Sci-Fi']);
  assert.deepEqual(result.languages, ['English', 'Japanese', 'French']);
  assert.equal(result.posterUrl, 'https://m.media-amazon.com/images/M/inception.jpg');
});

test('handleScrapeCommand displays usage instructions when called with no URL', async () => {
  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass',
    siteUrl: 'https://sorabox.in'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  const replies = [];
  const ctx = {
    chat: { id: 123 },
    from: { id: 123 },
    message: { text: '/scrape' },
    reply: async (text) => replies.push(text)
  };

  const outcome = await handleScrapeCommand(ctx, repository, config);
  assert.equal(outcome.handled, true);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes('Usage: /scrape <Post ID> <URL>'));
  assert.ok(replies[0].includes('tt43056433'));
});

test('handleScrapeCommand updates an active draft session when no Post ID is given', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['test-key']);
  configurePosterUploadOptions({
    spacingMs: 0,
    attempts: 3,
    backoffMs: 1_000,
    wait: async () => {},
    now: () => 1_000
  });

  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass',
    siteUrl: 'https://sorabox.in',
    imgbbApiKey: 'test-key'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  // Setup active draft session
  await repository.startSession({
    chatId: 123,
    ownerId: 123,
    title: 'Draft Title',
    category: 'movie'
  });

  // Mock fetch: page HTML and ImgBB upload
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('imdb.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <head>
              <title>Scraped Movie (2024) - IMDb</title>
              <meta property="og:title" content="Scraped Movie" />
              <meta property="og:description" content="A marvelous adventure across worlds." />
              <meta property="og:image" content="https://example.com/poster.jpg" />
              <script type="application/ld+json">
              {
                "@type": "Movie",
                "name": "Scraped Movie",
                "datePublished": "2024-01-01",
                "genre": ["Action", "Adventure"],
                "inLanguage": "en",
                "image": "https://m.media-amazon.com/images/M/scraped._V1_UX300.jpg"
              }
              </script>
            </head>
          </html>
        `
      };
    }
    if (urlStr.includes('api.imgbb.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            url: 'https://i.ibb.co/abc/scraped-mirrored.png',
            display_url: 'https://i.ibb.co/abc/scraped-mirrored.png',
            delete_url: 'https://ibb.co/delete/abc'
          }
        })
      };
    }
    if (urlStr.includes('scraped._V1_.jpg') || urlStr.includes('18.172.165.19')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    return { ok: false, status: 404 };
  };

  const replies = [];
  const ctx = {
    chat: { id: 123 },
    from: { id: 123 },
    message: { text: '/scrape https://www.imdb.com/title/tt43056433/' },
    reply: async (text) => replies.push(text)
  };

  const result = await handleScrapeCommand(ctx, repository, config);
  assert.equal(result.handled, true);
  assert.equal(result.isDraft, true);

  const updatedSession = await repository.findSession(123, 123);
  assert.equal(updatedSession.title, 'Scraped Movie');
  assert.equal(updatedSession.year, 2024);
  assert.deepEqual(updatedSession.genres, ['Action', 'Adventure']);
  assert.deepEqual(updatedSession.languages, ['English']);
  assert.equal(updatedSession.posterUrl, 'https://i.ibb.co/abc/scraped-mirrored.png');

  assert.ok(replies.some((r) => r.includes('Scraped from imdb.com and updated active draft')));
  assert.ok(replies.some((r) => r.includes('Title: Scraped Movie')));
});

test('handleScrapeCommand updates an existing published post with scraped metadata and mirrors artwork', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['test-key']);
  configurePosterUploadOptions({
    spacingMs: 0,
    attempts: 3,
    backoffMs: 1_000,
    wait: async () => {},
    now: () => 1_000
  });

  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass',
    siteUrl: 'https://sorabox.in',
    imgbbApiKey: 'test-key'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  // Insert existing published post
  const initialPost = await repository.createContent({
    title: 'Old Title',
    category: 'movie',
    slug: 'old-title',
    year: 2020,
    languages: ['Hindi'],
    genres: ['Drama'],
    description: 'Old synopsis'
  });
  const adminId = initialPost.adminId;
  assert.ok(adminId);

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('netflix.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <head>
              <title>Cyberpunk: Edgerunners | Netflix</title>
              <meta property="og:title" content="Cyberpunk: Edgerunners" />
              <meta property="og:description" content="A street kid trying to survive in a technology and body modification-obsessed city of the future." />
              <meta property="og:image" content="https://occ.a.nflxso.net/cyberpunk.jpg" />
              <meta property="og:type" content="video.tv_show" />
              <meta name="keywords" content="Anime, Sci-Fi, Action" />
            </head>
          </html>
        `
      };
    }
    if (urlStr.includes('api.imgbb.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            url: 'https://i.ibb.co/xyz/cyberpunk-mirrored.png',
            display_url: 'https://i.ibb.co/xyz/cyberpunk-mirrored.png',
            delete_url: 'https://ibb.co/delete/xyz'
          }
        })
      };
    }
    if (urlStr.includes('cyberpunk.jpg')) {
      return new Response(new Uint8Array([4, 5, 6, 7]), {
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    return { ok: false, status: 404 };
  };

  const replies = [];
  const ctx = {
    chat: { id: 123 },
    from: { id: 123 },
    telegram: {
      editMessageMedia: async () => {},
      editMessageCaption: async () => {}
    },
    message: { text: `/scrape ${adminId} https://www.netflix.com/title/81054853` },
    reply: async (text) => replies.push(text)
  };

  const result = await handleScrapeCommand(ctx, repository, config);
  assert.equal(result.handled, true);
  assert.equal(result.isDraft, false);

  const updated = await repository.findContentByAdminId(adminId);
  assert.equal(updated.title, 'Cyberpunk: Edgerunners');
  assert.equal(updated.releaseLabel, 'TV Series');
  assert.ok(updated.description.includes('body modification-obsessed'));
  assert.deepEqual(updated.genres, ['Anime', 'Sci-Fi', 'Action']);
  assert.equal(updated.posterUrl, 'https://i.ibb.co/xyz/cyberpunk-mirrored.png');
  assert.equal(updated.poster?.provider, 'imgbb');
  assert.equal(updated.poster?.originalUrl, 'https://occ.a.nflxso.net/cyberpunk.jpg');

  assert.ok(replies.some((r) => r.includes(`Scraped from netflix.com and updated ${adminId}`)));
  assert.ok(replies.some((r) => r.includes('Card: https://sorabox.in/movie/')));
});

test('handleScrapeCommand falls back gracefully when ImgBB is rate limited', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });

  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass',
    siteUrl: 'https://sorabox.in',
    imgbbApiKey: 'rate-limited-key'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  const post = await repository.createContent({
    title: 'Original Title',
    category: 'series',
    slug: 'original-title'
  });
  const adminId = post.adminId;

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('myanimelist.net')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <head>
              <meta property="og:title" content="Bleach: Thousand-Year Blood War - MyAnimeList.net" />
              <meta property="og:description" content="The peace is suddenly broken when warning sirens resound." />
              <meta property="og:image" content="https://cdn.myanimelist.net/images/anime/bleach.jpg" />
            </head>
          </html>
        `
      };
    }
    if (urlStr.includes('api.imgbb.com')) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Rate limit exceeded.', code: 429 } })
      };
    }
    if (urlStr.includes('bleach.jpg')) {
      return new Response(new Uint8Array([7, 8, 9, 10]), {
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    return { ok: false, status: 404 };
  };

  const replies = [];
  const ctx = {
    chat: { id: 123 },
    from: { id: 123 },
    telegram: {
      editMessageMedia: async () => {},
      editMessageCaption: async () => {}
    },
    message: { text: `/scrape ${adminId} https://myanimelist.net/anime/41467/Bleach` },
    reply: async (text) => replies.push(text)
  };

  const result = await handleScrapeCommand(ctx, repository, config);
  assert.equal(result.handled, true);

  const updated = await repository.findContentByAdminId(adminId);
  assert.equal(updated.title, 'Bleach: Thousand-Year Blood War');
  // Since ImgBB was rate limited, it fell back to source poster URL immediately
  assert.equal(updated.posterUrl, 'https://cdn.myanimelist.net/images/anime/bleach.jpg');
});
