import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { createApp, isBlockedScraperRequest, verifySameSiteApiRequest } from '../src/server/index.js';
import { cleanMediaName, compareQualityAscending, detectMediaQuality, fileReplacementKey, normalizeQualityLabel } from '../src/server/services/episode-service.js';
import { canonicalMetadataTitle, categoryFromHints, findMetadata } from '../src/server/services/metadata-service.js';
import { clearPosterUploadCache, configurePosterKeys, configurePosterUploadOptions, downloadPosterImage, mirrorPosterToImgBB, resetPosterUploadPace } from '../src/server/services/poster-service.js';
import { extractMetaTags, scrapeMetadataFromUrl } from '../src/server/services/scraper-service.js';
import { deriveLowestQualityTelegramStreamEntries, publicStreamingData } from '../src/server/services/streaming-service.js';
import {
  HELP_TOPICS,
  formatRemoveFileButtonLabel,
  handleHelpAction,
  handleHelpCommand,
  handleRemoveFileAction,
  handleRemoveFileCommand,
  handleScrapeCommand,
  inferBatchTitle,
  isPlausibleReleaseTitle,
  queuePosterRematchForTitle,
  resetAnnouncementLane,
  syncPublishedAnnouncements,
  tidyReleaseTitle
} from '../src/server/services/telegram-bot.js';
import { getEntryQualities, getPlayerIframeUrl, getProtectedPlaybackTarget, resolveActiveQualityOption } from '../src/client/watch-utils.js';

const originalFetch = globalThis.fetch;

test('uncommon video qualities (144p, 240p, 288p, 544p, dimensions, height) are detected and kept distinct', () => {
  assert.equal(detectMediaQuality({ filename: 'Movie.2024.144p.WEB-DL.mkv' }), '144P');
  assert.equal(detectMediaQuality({ filename: 'Movie.2024.240p.WEB-DL.mkv' }), '240P');
  assert.equal(detectMediaQuality({ filename: 'Movie.2024.288p.WEB-DL.mkv' }), '288P');
  assert.equal(detectMediaQuality({ filename: 'Movie.2024.544p.WEB-DL.mkv' }), '544P');
  assert.equal(detectMediaQuality({ filename: 'Movie.2024.854x480.mkv' }), '480P');
  assert.equal(detectMediaQuality({ filename: 'video-101.mp4', height: 288, width: 512 }), '288P');

  assert.equal(normalizeQualityLabel('144p'), '144P');
  assert.equal(normalizeQualityLabel('288p'), '288P');
  assert.equal(normalizeQualityLabel('544p'), '544P');

  const qualities = ['1080p', '544p', '144p', '720p', '288p'].sort(compareQualityAscending);
  assert.deepEqual(qualities, ['144p', '288p', '544p', '720p', '1080p']);

  // Distinct uncommon qualities for the same episode must produce distinct replacement keys so all files are added
  const ep1_144 = { name: 'Show.S01E01.144p.mkv', episode: { start: 1, end: 1 }, quality: '144P' };
  const ep1_288 = { name: 'Show.S01E01.288p.mkv', episode: { start: 1, end: 1 }, quality: '288P' };
  const ep1_544 = { name: 'Show.S01E01.544p.mkv', episode: { start: 1, end: 1 }, quality: '544P' };
  assert.notEqual(fileReplacementKey(ep1_144), fileReplacementKey(ep1_288));
  assert.notEqual(fileReplacementKey(ep1_288), fileReplacementKey(ep1_544));
});

test('filename and batch title cleaning strips random release tokens (dsnk, dsnp, 4k, sizes, uncommon qualities)', () => {
  assert.equal(cleanMediaName('Loki.S02E01.2023.dsnk.4k.WEB-DL.Hindi.544p.700MB.mkv'), 'Loki S02E01 Hindi');
  assert.equal(inferBatchTitle([{ name: 'Guardians.of.the.Galaxy.2023.dsnk.4k.288p.Hindi.WEB-DL.mkv' }]), 'Guardians of the Galaxy');
  assert.equal(tidyReleaseTitle('Moana 2 2024 dsnk 4K 544p Hindi DDP5.1 1.4GB.mkv'), 'Moana 2');
  assert.equal(canonicalMetadataTitle('Moana 2 2024 dsnk 4K 544p'), 'moana 2');
  assert.equal(isPlausibleReleaseTitle('dsnk'), false);
  assert.equal(isPlausibleReleaseTitle('RRR'), true);
});

test('findMetadata falls back to progressive prefix query when a trailing unknown token is present', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('api.themoviedb.org/3/search/movie')) {
      const parsed = new URL(urlStr);
      const q = (parsed.searchParams.get('query') || '').toLowerCase();
      if (q === 'the wild robot') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{
              id: 1184918,
              title: 'The Wild Robot',
              release_date: '2024-09-12',
              overview: 'After a shipwreck, an intelligent robot called Roz is stranded on an uninhabited island.',
              poster_path: '/wild-robot.jpg',
              genre_ids: [16, 878, 10751],
              original_language: 'en'
            }]
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    return { ok: false, status: 404 };
  };

  const metadata = await findMetadata('The Wild Robot xzyq12', 'movie', { tmdbApiKey: 'test-tmdb' });
  assert.equal(metadata.matched, true);
  assert.equal(metadata.title, 'The Wild Robot');
  assert.equal(metadata.inferredCategory, 'cartoon');
});

test('extractMetaTags handles apostrophes inside double-quoted attributes without truncating', () => {
  const html = `
    <meta property="og:title" content="Howl's Moving Castle (2004)" />
    <meta property="og:description" content="A young woman's curse leads her to a wizard's walking castle." />
    <meta property="og:image" content="https://m.media-amazon.com/images/M/howl._V1_UX500_.jpg" />
  `;
  const meta = extractMetaTags(html);
  assert.equal(meta.get('og:title'), "Howl's Moving Castle (2004)");
  assert.equal(meta.get('og:description'), "A young woman's curse leads her to a wizard's walking castle.");
});

test('scrapeMetadataFromUrl falls back to IMDb suggestion & Cinemeta APIs when IMDb blocks page HTML and OMDb is unconfigured', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('www.imdb.com')) {
      return { ok: false, status: 403, text: async () => '' };
    }
    if (urlStr.includes('v3.sg.media-imdb.com/suggestion/t/tt1375666.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          d: [{
            id: 'tt1375666',
            l: 'Inception',
            y: 2010,
            qid: 'movie',
            i: { imageUrl: 'https://m.media-amazon.com/images/M/MV5BMjAx._V1_.jpg' }
          }]
        })
      };
    }
    if (urlStr.includes('v3-cinemeta.strem.io/meta/movie/tt1375666.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          meta: {
            name: 'Inception',
            year: '2010',
            description: 'A thief who steals corporate secrets through dream-sharing technology.',
            genres: ['Action', 'Sci-Fi'],
            poster: 'https://m.media-amazon.com/images/M/MV5BMjAx._V1_.jpg'
          }
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const scraped = await scrapeMetadataFromUrl('https://www.imdb.com/title/tt1375666/', { config: {} });
  assert.equal(scraped.error, undefined);
  assert.equal(scraped.title, 'Inception');
  assert.equal(scraped.year, 2010);
  assert.ok(scraped.description.includes('dream-sharing'));
  assert.ok(scraped.posterUrl.includes('MV5BMjAx'));
});

test('downloadPosterImage and mirrorPosterToImgBB retry resized Amazon URL when master ._V1_.jpg fails', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['test-key']);
  configurePosterUploadOptions({ spacingMs: 0, attempts: 2, backoffMs: 10, wait: async () => {}, now: () => 1_000 });

  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    requestedUrls.push(urlStr);
    if (urlStr.endsWith('._V1_.jpg')) {
      return { ok: false, status: 404 };
    }
    if (urlStr.includes('._V1_FMjpg_UX1000_.jpg')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    if (urlStr.includes('api.imgbb.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            url: 'https://i.ibb.co/resized/poster.jpg',
            display_url: 'https://i.ibb.co/resized/poster.jpg'
          }
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const downloaded = await downloadPosterImage('https://m.media-amazon.com/images/M/MV5BTEST._V1_.jpg');
  assert.equal(downloaded.contentType, 'image/jpeg');
  assert.ok(requestedUrls.some((u) => u.includes('._V1_FMjpg_UX1000_.jpg')));

  const mirrored = await mirrorPosterToImgBB({
    sourceUrl: 'https://m.media-amazon.com/images/M/MV5BTEST2._V1_.jpg',
    sourceIsManual: true,
    title: 'Test Movie',
    category: 'movie',
    config: { imgbbApiKey: 'test-key' }
  });
  assert.equal(mirrored.url, 'https://i.ibb.co/resized/poster.jpg');
});

test('/scrape does not overwrite file audio/subtitle languages with website languages and auto-updates category + announcement', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  resetAnnouncementLane();
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys(['test-key']);
  configurePosterUploadOptions({ spacingMs: 0, attempts: 2, backoffMs: 10, wait: async () => {}, now: () => 1_000 });

  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass',
    siteUrl: 'https://sorabox.in',
    imgbbApiKey: 'test-key'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  const post = await repository.createContent({
    title: 'Toy Story 4',
    category: 'movie',
    slug: 'toy-story-4',
    languages: ['English'],
    subtitleLanguages: ['Spanish'],
    files: [
      {
        storageMessageId: 501,
        storageChannelId: '-1002617067511',
        name: 'Toy.Story.4.2019.544p.Hindi.mkv',
        displayName: 'Toy Story 4 (2019) 544p Hindi',
        sourceLabel: 'Toy Story 4 (2019) 544p Hindi',
        audioLanguages: ['Hindi'],
        languages: ['Hindi'],
        subtitleLanguages: []
      }
    ],
    announcementRefs: [
      {
        channelId: '-100999888',
        messageId: 42,
        kind: 'photo',
        posterUrl: 'https://i.ibb.co/old/poster.jpg',
        syncError: { reason: 'Old error', blocked: true, signature: 'old' }
      }
    ]
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('imdb.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <head>
              <script type="application/ld+json">
              {
                "@type": "Movie",
                "name": "Toy Story 4",
                "datePublished": "2019-06-21",
                "description": "Woody, Buzz Lightyear and the rest of the gang embark on a road trip.",
                "genre": ["Animation", "Adventure", "Comedy"],
                "inLanguage": ["English", "French"],
                "countryOfOrigin": { "name": "United States" },
                "image": "https://m.media-amazon.com/images/M/toystory4._V1_.jpg"
              }
              </script>
            </head>
          </html>
        `
      };
    }
    if (urlStr.includes('toystory4')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    if (urlStr.includes('api.imgbb.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            url: 'https://i.ibb.co/new/toystory4.jpg',
            display_url: 'https://i.ibb.co/new/toystory4.jpg'
          }
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const editedMedia = [];
  const replies = [];
  const ctx = {
    chat: { id: 123 },
    from: { id: 123 },
    telegram: {
      editMessageMedia: async (chatIdArg, msgIdArg, inlineId, media) => {
        editedMedia.push({ chatId: chatIdArg, messageId: msgIdArg, media });
        return {};
      },
      editMessageReplyMarkup: async () => ({})
    },
    message: { text: `/scrape ${post.adminId} https://www.imdb.com/title/tt1979376/` },
    reply: async (text) => replies.push(text)
  };

  await handleScrapeCommand(ctx, repository, config);

  const updated = await repository.findContentByAdminId(post.adminId);
  // Category auto-updated from 'movie' to 'cartoon' because it is an American animated movie!
  assert.equal(updated.category, 'cartoon');
  // Audio language comes ONLY from the file ('Hindi'), NOT 'English'/'French' from IMDb!
  assert.deepEqual(updated.languages, ['Hindi']);
  // Channel announcement was updated with the new poster & cartoon category
  assert.equal(editedMedia.length, 1);
  assert.equal(editedMedia[0].messageId, 42);
  assert.match(editedMedia[0].media.caption, /Cartoon/i);
  assert.match(editedMedia[0].media.caption, /Hindi/);
});

test('reconcileCatalogMediaFromFiles fixes stored posts audio/subtitles/qualities from files and leaves posts without file languages untouched', async () => {
  const repository = new MemoryCatalogRepository();

  // Post 1: Has wrong English language from old scrape, while file actually has Hindi audio and no subtitles, plus 544p quality
  const postWithFileLang = await repository.createContent({
    title: 'Sample Action Film',
    category: 'movie',
    slug: 'sample-action-film',
    languages: ['English', 'Spanish'],
    languageSource: 'metadata',
    subtitleLanguages: ['French'],
    subtitleLanguageSource: 'metadata',
    files: [
      {
        storageMessageId: 101,
        name: 'Sample.Action.Film.2024.544p.Hindi.WEB-DL.mkv',
        displayName: 'Sample Action Film 544p Hindi',
        sourceLabel: 'Sample Action Film 544p Hindi',
        quality: null,
        audioLanguages: [],
        languages: [],
        subtitleLanguages: []
      }
    ]
  });

  // Post 2: File has no language info in filename/caption -> must make NO changes to post languages
  const postWithoutFileLang = await repository.createContent({
    title: 'Mystery Film',
    category: 'movie',
    slug: 'mystery-film',
    languages: ['Hindi'],
    languageSource: 'metadata',
    subtitleLanguages: ['English'],
    subtitleLanguageSource: 'manual',
    files: [
      {
        storageMessageId: 102,
        name: 'video-102.mp4',
        displayName: 'Mystery Film',
        sourceLabel: 'Mystery Film',
        quality: '720p',
        audioLanguages: [],
        languages: [],
        subtitleLanguages: []
      }
    ]
  });

  const report = await repository.reconcileCatalogMediaFromFiles({ dryRun: false });
  assert.equal(report.updated, 1);

  const fixed1 = await repository.findContentByAdminId(postWithFileLang.adminId);
  assert.deepEqual(fixed1.languages, ['Hindi']);
  assert.equal(fixed1.languageSource, 'upload');
  // Non-manual scraped subtitle was cleared because file has no subtitles
  assert.deepEqual(fixed1.subtitleLanguages, []);
  assert.equal(fixed1.files[0].quality, '544P');

  const untouched2 = await repository.findContentByAdminId(postWithoutFileLang.adminId);
  assert.deepEqual(untouched2.languages, ['Hindi']);
  assert.deepEqual(untouched2.subtitleLanguages, ['English']);
  assert.equal(untouched2.subtitleLanguageSource, 'manual');
});

test('player quality options include all release qualities (144p, 288p, 544p, 1080p) and switch Telegram post URL on selection', () => {
  const content = {
    title: 'Solo Leveling',
    category: 'anime',
    storageChannelId: '-1002617067511',
    files: [
      { storageMessageId: 301, storageChannelId: '-1002617067511', name: 'Solo.Leveling.S01E01.1080p.mkv', episode: { start: 1, end: 1, label: 'Episode 01' } },
      { storageMessageId: 302, storageChannelId: '-1002617067511', name: 'Solo.Leveling.S01E01.544p.mkv', episode: { start: 1, end: 1, label: 'Episode 01' } },
      { storageMessageId: 303, storageChannelId: '-1002617067511', name: 'Solo.Leveling.S01E01.288p.mkv', episode: { start: 1, end: 1, label: 'Episode 01' } },
      { storageMessageId: 304, storageChannelId: '-1002617067511', name: 'Solo.Leveling.S01E01.144p.mkv', episode: { start: 1, end: 1, label: 'Episode 01' } }
    ]
  };

  const entries = deriveLowestQualityTelegramStreamEntries(content);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  // Default stream entry uses lowest quality (144P -> message 304)
  assert.equal(entry.quality, '144P');
  assert.equal(entry.watchUrl, 'https://t.me/c/2617067511/304');
  assert.deepEqual(entry.qualities.map((q) => q.quality), ['144P', '288P', '544P', '1080P']);

  // Public streaming data preserves qualities array
  const publicStream = publicStreamingData({ available: true, entries });
  const pubEntry = publicStream.entries[0];
  assert.equal(getEntryQualities(pubEntry).length, 4);

  // Default playback target uses 144P (message 304)
  const defaultTarget = getProtectedPlaybackTarget(pubEntry);
  assert.equal(defaultTarget.url, 'https://t.me/c/2617067511/304');

  // Selecting 544P switches Telegram post link to message 302
  const chosen544 = resolveActiveQualityOption(pubEntry, '544p');
  assert.equal(chosen544.telegramUrl, 'https://t.me/c/2617067511/302');
  const target544 = getProtectedPlaybackTarget(pubEntry, { selectedQuality: '544p' });
  assert.equal(target544.url, 'https://t.me/c/2617067511/302');

  const iframeUrl = getPlayerIframeUrl(target544, {
    title: 'Solo Leveling — Episode 01',
    quality: '544P',
    qualities: pubEntry.qualities,
    subUrl: 'data:text/vtt;base64,V0VCVlRU',
    subLabel: 'English Manual',
    noAudioSelect: true
  });
  assert.ok(iframeUrl.includes('url=https%3A%2F%2Ft.me%2Fc%2F2617067511%2F302'));
  assert.ok(iframeUrl.includes('quality=544P'));
  assert.ok(iframeUrl.includes('audio=0'));
  assert.ok(iframeUrl.includes('subLabel=English+Manual'));
});

test('categoryFromHints and queuePosterRematchForTitle auto-update category when title/artwork is updated', async () => {
  resetAnnouncementLane();
  // Animated feature film -> cartoon (or anime if JP, donghua if CN)
  assert.equal(categoryFromHints({
    hints: { type: 'movie', genres: ['Animation', 'Family'], originCountry: ['US'], score: 0.9 }
  }), 'cartoon');
  assert.equal(categoryFromHints({
    hints: { type: 'movie', genres: ['Animation', 'Fantasy'], originCountry: ['JP'], score: 0.9 }
  }), 'anime');
  assert.equal(categoryFromHints({
    hints: { type: 'movie', genres: ['Animation', 'Action'], originCountry: ['CN'], score: 0.9 }
  }), 'donghua');

  const patches = [];
  const channelCaptions = [];
  const repository = {
    async updateContentByAdminId(adminId, patch) {
      patches.push(patch);
      return {
        adminId,
        title: 'Migration',
        category: patch.category || 'movie',
        posterUrl: patch.posterUrl || 'https://i.ibb.co/new.jpg',
        ...patch,
        announcementRefs: [{ channelId: '-100chan', messageId: 77, kind: 'photo' }]
      };
    }
  };

  const job = queuePosterRematchForTitle({
    repository,
    config: { imgbbApiKey: 'k' },
    content: {
      adminId: 'SB-CARTOON1',
      title: 'Migration',
      category: 'movie',
      posterUrl: null,
      poster: { source: 'generated-fallback', title: 'old' }
    },
    telegram: {
      editMessageMedia: async (_chat, _msg, _inline, media) => {
        channelCaptions.push(media.caption);
        return {};
      }
    },
    find: async () => ({
      matched: true,
      provider: 'tmdb',
      type: 'movie',
      originCountry: ['US'],
      genres: ['Animation', 'Adventure', 'Comedy'],
      inferredCategory: 'cartoon',
      posterOriginalUrl: 'https://image.test/migration.jpg'
    }),
    prepare: async () => ({ buffer: Buffer.from('png'), contentType: 'image/png', sourceUrl: 'https://image.test/migration.jpg' }),
    host: async () => ({ url: 'https://i.ibb.co/migration.png', providerId: 'm1', originalUrl: 'https://image.test/migration.jpg', source: 'remote-mirror' })
  });

  const outcome = await job;
  assert.equal(outcome.updated, 1);
  assert.equal(patches[0].category, 'cartoon');
  assert.equal(channelCaptions.length, 1);
  assert.match(channelCaptions[0], /Cartoon/i);
});

test('syncPublishedAnnouncements falls back to editMessageCaption when photo URL cannot be updated by editMessageMedia', async () => {
  resetAnnouncementLane();
  const captionEdits = [];
  const result = await syncPublishedAnnouncements({
    telegram: {
      editMessageMedia: async () => {
        throw new Error('Bad Request: IMAGE_PROCESS_FAILED');
      },
      editMessageCaption: async (chatIdArg, msgIdArg, _inline, caption) => {
        captionEdits.push({ chatId: chatIdArg, messageId: msgIdArg, caption });
        return {};
      },
      editMessageReplyMarkup: async () => ({})
    },
    repository: { updateContentByAdminId: async () => null },
    content: {
      adminId: 'SB-PHOTO123',
      title: 'Updated Movie Title',
      category: 'movie',
      posterUrl: 'https://unreachable.example.com/poster.jpg',
      announcementRefs: [{ channelId: '-100chan', messageId: 88, kind: 'photo' }]
    },
    options: { spacingMs: 0, wait: async () => {} }
  });

  assert.equal(result.updated, 1);
  assert.equal(captionEdits.length, 1);
  assert.equal(captionEdits[0].messageId, 88);
  assert.match(captionEdits[0].caption, /Updated Movie Title/);
});

test('/removefile command lists posts, shows file/episode buttons, shows Go back or Remove confirmation, and removes selected file', async () => {
  resetAnnouncementLane();
  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass',
    siteUrl: 'https://sorabox.in'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  const post = await repository.createContent({
    title: 'Demon Slayer Season 1',
    category: 'anime',
    slug: 'demon-slayer-s1',
    files: [
      {
        storageMessageId: 901,
        storageChannelId: '-1002617067511',
        name: 'Demon.Slayer.S01E01.720p.Hindi.mkv',
        displayName: 'Demon Slayer S01E01',
        sourceLabel: 'Demon Slayer S01E01 720p Hindi',
        quality: '720p',
        seasonNumber: 1,
        episode: { start: 1, end: 1, label: 'Episode 01' },
        episodeLabel: 'Episode 01',
        audioLanguages: ['Hindi'],
        languages: ['Hindi']
      },
      {
        storageMessageId: 902,
        storageChannelId: '-1002617067511',
        name: 'Demon.Slayer.S01E02.720p.Hindi.mkv',
        displayName: 'Demon Slayer S01E02',
        sourceLabel: 'Demon Slayer S01E02 720p Hindi',
        quality: '720p',
        seasonNumber: 1,
        episode: { start: 2, end: 2, label: 'Episode 02' },
        episodeLabel: 'Episode 02',
        audioLanguages: ['Hindi'],
        languages: ['Hindi']
      },
      {
        storageMessageId: 903,
        storageChannelId: '-1002617067511',
        name: 'Unwanted.Sample.Clip.144p.mkv',
        displayName: 'Unwanted Sample Clip',
        sourceLabel: 'Unwanted Sample Clip 144p',
        quality: '144p',
        audioLanguages: ['English'],
        languages: ['English']
      }
    ]
  });

  const messages = [];
  const makeCtx = (text = '', callbackData = '') => ({
    chat: { id: 123, type: 'private' },
    from: { id: 123 },
    message: text ? { text } : undefined,
    callbackQuery: callbackData ? { data: callbackData, message: { message_id: 55 } } : undefined,
    answerCbQuery: async () => {},
    telegram: {
      editMessageText: async () => ({}),
      editMessageMedia: async () => ({})
    },
    reply: async (msg, extra) => {
      messages.push({ type: 'reply', text: msg, extra });
      return { message_id: 55 };
    },
    editMessageText: async (msg, extra) => {
      messages.push({ type: 'edit', text: msg, extra });
      return { message_id: 55 };
    }
  });

  // 1. /removefile with no args shows post picker buttons
  await handleRemoveFileCommand(makeCtx('/removefile'), repository, config);
  const postPicker = messages.at(-1);
  assert.match(postPicker.text, /Select a post below/);
  const postButton = postPicker.extra.reply_markup.inline_keyboard[0][0];
  assert.match(postButton.text, /Demon Slayer Season 1/);
  assert.equal(postButton.callback_data, `rmfile:post:${post.adminId}:0`);

  // 2. Clicking the post button renders buttons for each episode/file in the post
  await handleRemoveFileAction(makeCtx('', `rmfile:post:${post.adminId}:0`), repository, config);
  const fileListMsg = messages.at(-1);
  const fileButtons = fileListMsg.extra.reply_markup.inline_keyboard.map((row) => row[0]);
  assert.match(fileButtons[0].text, /Episode 01.*\[720p\]/i);
  assert.match(fileButtons[1].text, /Episode 02.*\[720p\]/i);
  assert.match(fileButtons[2].text, /Unwanted Sample Clip \[144p\]/i);

  // 3. Clicking the unwanted file button shows "Go back" and "Remove" buttons
  await handleRemoveFileAction(makeCtx('', `rmfile:pick:${post.adminId}:2:0`), repository, config);
  const confirmMsg = messages.at(-1);
  assert.match(confirmMsg.text, /Unwanted Sample Clip/);
  const confirmRow = confirmMsg.extra.reply_markup.inline_keyboard[0];
  assert.equal(confirmRow.length, 2);
  assert.match(confirmRow[0].text, /Go back/);
  assert.equal(confirmRow[0].callback_data, `rmfile:post:${post.adminId}:0`);
  assert.match(confirmRow[1].text, /Remove/);
  assert.equal(confirmRow[1].callback_data, `rmfile:do:${post.adminId}:2:903:0`);

  // 4. Clicking "Go back" returns to the post's file list without deleting anything
  await handleRemoveFileAction(makeCtx('', confirmRow[0].callback_data), repository, config);
  assert.equal((await repository.findContentByAdminId(post.adminId)).files.length, 3);

  // 5. Clicking "Remove" deletes that specific file, updates post counts/languages, and shows remaining 2 episodes
  await handleRemoveFileAction(makeCtx('', confirmRow[1].callback_data), repository, config);
  const afterRemoveMsg = messages.at(-1);
  assert.match(afterRemoveMsg.text, /Removed "Unwanted Sample Clip \[144p\]"/i);
  assert.match(afterRemoveMsg.text, /2 files remaining/);

  const updatedPost = await repository.findContentByAdminId(post.adminId);
  assert.equal(updatedPost.files.length, 2);
  assert.equal(updatedPost.fileCount, 2);
  assert.equal(updatedPost.episodeCount, 2);
  // Since the English sample clip was removed, the post's audio languages automatically updated to ['Hindi']!
  assert.deepEqual(updatedPost.languages, ['Hindi']);
});

test('/help command displays interactive info buttons for all sections and shows detailed command explanations on click', async () => {
  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  const messages = [];
  const makeCtx = (text = '', callbackData = '') => ({
    chat: { id: 123, type: 'private' },
    from: { id: 123 },
    message: text ? { text } : undefined,
    callbackQuery: callbackData ? { data: callbackData, message: { message_id: 99 } } : undefined,
    answerCbQuery: async () => {},
    reply: async (msg, extra) => {
      messages.push({ type: 'reply', text: msg, extra });
      return { message_id: 99 };
    },
    editMessageText: async (msg, extra) => {
      messages.push({ type: 'edit', text: msg, extra });
      return { message_id: 99 };
    }
  });

  // 1. /help shows overview and buttons for all topic sections
  await handleHelpCommand(makeCtx('/help'), repository, config);
  const overview = messages.at(-1);
  assert.match(overview.text, /SoraBox Publisher Help Center/);
  const allButtons = overview.extra.reply_markup.inline_keyboard.flat();
  const callbackDataList = allButtons.map((b) => b.callback_data);
  for (const topicId of Object.keys(HELP_TOPICS)) {
    assert.ok(callbackDataList.includes(`help:topic:${topicId}`), `Missing button for topic ${topicId}`);
  }
  assert.ok(callbackDataList.includes('help:panel'));

  // 2. Clicking each topic button shows what it is for, commands, and how it works
  for (const [topicId, topic] of Object.entries(HELP_TOPICS)) {
    await handleHelpAction(makeCtx('', `help:topic:${topicId}`), repository, config);
    const topicMsg = messages.at(-1);
    assert.equal(topicMsg.text, topic.text);
    const navCallbacks = topicMsg.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(navCallbacks.includes('help:menu'));
    assert.ok(navCallbacks.includes('help:panel'));
  }

  // 3. Clicking "Help Main Menu" returns to the overview
  await handleHelpAction(makeCtx('', 'help:menu'), repository, config);
  assert.match(messages.at(-1).text, /SoraBox Publisher Help Center/);
});

test('/removefile supports category-wise & recent/updated filters, accurate file counts, quality filters, and bulk quality removal', async () => {
  const repository = new MemoryCatalogRepository();
  const config = {
    telegram: { adminIds: new Set(['123']), channelId: '-100123' },
    adminLoginCode: 'secret-pass'
  };
  await repository.createAdminSession({ chatId: '123', ownerId: '123', expiresAt: Date.now() + 3_600_000 });

  await repository.createContent({
    title: 'Jujutsu Kaisen',
    category: 'anime',
    files: [
      { storageMessageId: 1001, name: 'video-1001', sourceLabel: 'Jujutsu Kaisen S01E01 480p Hindi', quality: '480P' },
      { storageMessageId: 1002, name: 'video-1002', sourceLabel: 'Jujutsu Kaisen S01E01 1080p Hindi', quality: '1080P' },
      { storageMessageId: 1003, name: 'video-1003', sourceLabel: 'Jujutsu Kaisen S01E02 480p Hindi', quality: '480P' }
    ]
  });
  await repository.createContent({
    title: 'Oppenheimer',
    category: 'movie',
    files: [
      { storageMessageId: 2001, name: 'Oppenheimer.2023.1080p.mkv', quality: '1080P' }
    ]
  });

  const messages = [];
  const makeCtx = (text = '', callbackData = '') => ({
    chat: { id: 123, type: 'private' },
    from: { id: 123 },
    message: text ? { text } : undefined,
    callbackQuery: callbackData ? { data: callbackData, message: { message_id: 77 } } : undefined,
    answerCbQuery: async () => {},
    telegram: { editMessageText: async () => ({}) },
    reply: async (msg, extra) => {
      messages.push({ type: 'reply', text: msg, extra });
      return { message_id: 77 };
    },
    editMessageText: async (msg, extra) => {
      messages.push({ type: 'edit', text: msg, extra });
      return { message_id: 77 };
    }
  });

  // 1. Filter by category via /removefile movie
  await handleRemoveFileCommand(makeCtx('/removefile movie'), repository, config);
  const moviePicker = messages.at(-1);
  assert.match(moviePicker.text, /Category: Movies/);
  const firstBtn = moviePicker.extra.reply_markup.inline_keyboard[0][0];
  assert.match(firstBtn.text, /Oppenheimer.*1 file/);

  // 2. Switch category to Anime via category button callback
  await handleRemoveFileAction(makeCtx('', 'rmfile:cat:anime:r:0'), repository, config);
  const animePicker = messages.at(-1);
  assert.match(animePicker.text, /Category: Anime/);
  const jjkBtn = animePicker.extra.reply_markup.inline_keyboard[0][0];
  assert.match(jjkBtn.text, /Jujutsu Kaisen.*3 files · 2 eps/);

  const jjkAdminId = jjkBtn.callback_data.split(':')[2];

  // 3. Bulk remove all 480P files from Jujutsu Kaisen
  await handleRemoveFileAction(makeCtx('', `rmfile:bulkqdo:${jjkAdminId}:480P`), repository, config);
  const afterBulk = messages.at(-1);
  assert.match(afterBulk.text, /Removed 2 480P files/);
  const updatedJjk = await repository.findContentByAdminId(jjkAdminId);
  assert.equal(updatedJjk.files.length, 1);
  assert.equal(updatedJjk.files[0].quality, '1080P');
});

test('anti-scraping security blocks scraper User-Agents, cross-site API requests, hides bulk stream entries, and enforces rate limits', async (t) => {
  assert.equal(isBlockedScraperRequest({ headers: { 'user-agent': 'python-requests/2.31.0' } }), true);
  assert.equal(isBlockedScraperRequest({ headers: { 'user-agent': 'curl/8.5.0' } }), true);
  assert.equal(isBlockedScraperRequest({ headers: { 'user-agent': 'Mozilla/5.0 HeadlessChrome/124.0' } }), true);
  assert.equal(isBlockedScraperRequest({ headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }), false);

  assert.equal(verifySameSiteApiRequest({ headers: { 'sec-fetch-site': 'cross-site' } }).allowed, false);
  assert.equal(verifySameSiteApiRequest({ headers: { origin: 'https://evil-scraper.example', host: 'sorabox.in' } }).allowed, false);
  assert.equal(verifySameSiteApiRequest({ headers: { origin: 'https://sorabox.in', host: 'sorabox.in' } }).allowed, true);

  const repository = new MemoryCatalogRepository([]);
  await repository.createContent({
    title: 'Protected Anime',
    category: 'anime',
    storageChannelId: '-1002617067511',
    files: [
      { storageMessageId: 501, storageChannelId: '-1002617067511', name: 'Protected.Anime.S01E01.720p.mkv', episode: { start: 1, end: 1, label: 'Episode 01' } }
    ]
  });

  const app = createApp({
    config: {
      environment: 'test',
      telegram: { botUsername: 'SoraBoxBot' },
      security: { apiRateLimitMax: 5, detailRateLimitMax: 3, deliveryRateLimitMax: 3 }
    },
    repository,
    distPath: '/tmp/sorabox-no-static-files'
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  // 1. /robots.txt disallows /api/, /deliver/, /watch/ and scraper bots
  const robotsRes = await fetch(`${url}/robots.txt`);
  assert.equal(robotsRes.status, 200);
  const robotsText = await robotsRes.text();
  assert.match(robotsText, /Disallow: \/api\//);
  assert.match(robotsText, /User-agent: Scrapy/);

  // 2. Scraper User-Agent is blocked with 403
  const curlRes = await fetch(`${url}/api/content`, {
    headers: { 'user-agent': 'curl/8.4.0' }
  });
  assert.equal(curlRes.status, 403);

  // 3. Cross-site fetch is blocked with 403
  const crossSiteRes = await fetch(`${url}/api/content`, {
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(crossSiteRes.status, 403);

  // 4. Bulk listing (/api/content) hides stream.entries so internal t.me/c/... links cannot be scraped in bulk
  const listRes = await fetch(`${url}/api/content`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive, nosnippet');
  const listBody = await listRes.json();
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0].stream.available, true);
  assert.deepEqual(listBody.items[0].stream.entries, []);

  // 5. Detail endpoint (/api/content/:slug) returns stream.entries for legitimate viewer, then rate-limits rapid scraping (429)
  const slug = listBody.items[0].slug;
  const detailRes = await fetch(`${url}/api/content/${slug}`);
  assert.equal(detailRes.status, 200);
  const detailBody = await detailRes.json();
  assert.equal(detailBody.item.stream.entries.length, 1);

  await fetch(`${url}/api/content/${slug}`);
  await fetch(`${url}/api/content/${slug}`);
  const rateLimitedRes = await fetch(`${url}/api/content/${slug}`);
  assert.equal(rateLimitedRes.status, 429);
});


