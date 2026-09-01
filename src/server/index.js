import crypto from 'node:crypto';
import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCatalogRepository } from './catalog.repository.js';
import { getDeliveryRedirectPath, getTelegramDeliveryUrl, getTelegramFileDeliveryUrl, loadConfig } from './config.js';
import { CATEGORIES, CATEGORY_IDS, categoryDetails, cleanText, formatBytes } from './lib/strings.js';
import { cleanDeliveryFileName, cleanMediaName, detectMediaQuality, summarizeSubtitleLanguages, summarizeUploadLanguages } from './services/episode-service.js';
import { publicStreamingData, streamingFrameSources } from './services/streaming-service.js';
import { launchTelegramBot } from './services/telegram-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDistPath = path.resolve(__dirname, '../../dist');
const VISITOR_COOKIE_NAME = 'sorabox_visitor';
const VISITOR_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365;

function cookieValue(request, name) {
  const cookieHeader = String(request.headers.cookie || '');
  const prefix = `${name}=`;
  for (const item of cookieHeader.split(';')) {
    const trimmed = item.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(trimmed.slice(prefix.length));
    } catch {
      return null;
    }
  }
  return null;
}

function anonymousVisitorId(request, response, config) {
  const existing = cookieValue(request, VISITOR_COOKIE_NAME);
  if (/^[A-Za-z0-9_-]{24,128}$/.test(existing || '')) return existing;
  // A random first-party cookie counts returning visits without collecting an
  // IP address, user agent, query string, or any public profile information.
  const visitorId = crypto.randomBytes(24).toString('base64url');
  response.cookie(VISITOR_COOKIE_NAME, visitorId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.environment === 'production',
    maxAge: VISITOR_COOKIE_MAX_AGE_MS,
    path: '/'
  });
  return visitorId;
}

function isTrackableSiteVisit(request) {
  if (request.method !== 'GET') return false;
  if (request.path === '/api' || request.path.startsWith('/api/') || request.path === '/deliver' || request.path.startsWith('/deliver/')) return false;
  if (/\.[A-Za-z0-9]{1,8}$/.test(request.path)) return false;
  return String(request.headers.accept || '').includes('text/html');
}

function serializeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicEpisodeGroups(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((group) => ({
      start: Number(group?.start),
      end: Number(group?.end),
      label: cleanText(group?.label, 50),
      fileCount: Math.max(1, Number(group?.fileCount) || 1)
    }))
    .filter((group) => Number.isInteger(group.start) && Number.isInteger(group.end) && group.start >= 1 && group.end >= group.start && group.end <= 999 && group.label);
}

function publicLanguages(content) {
  const savedLanguages = Array.isArray(content?.languages)
    ? content.languages
      .map((language) => cleanText(language, 40))
      .filter((language) => language && !/^multi(?:\s+language)?$/i.test(language) && !/\b(?:sub|subs|subtitle|subtitles|cc)$/i.test(language))
    : [];
  const uploadLanguages = content?.languageSource === 'manual' ? [] : summarizeUploadLanguages(content?.files || []);
  const languages = uploadLanguages.length ? uploadLanguages : savedLanguages;
  const uniqueLanguages = [];
  const seen = new Set();
  for (const language of languages) {
    const key = language.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLanguages.push(language);
    if (uniqueLanguages.length === 8) break;
  }
  return uniqueLanguages;
}

function publicSubtitleLanguages(content) {
  const savedLanguages = Array.isArray(content?.subtitleLanguages)
    ? content.subtitleLanguages.map((language) => cleanText(language, 40)).filter(Boolean)
    : [];
  // Older cards put labels such as "English Sub" in the one shared language
  // array. Present those accurately without requiring a risky data migration.
  const legacySubtitleLanguages = Array.isArray(content?.languages)
    ? content.languages
      .map((language) => cleanText(language, 40).replace(/\s*(?:sub|subs|subtitle|subtitles|cc)$/i, ''))
      .filter((language, index) => /\b(?:sub|subs|subtitle|subtitles|cc)$/i.test(String(content.languages[index] || '')) && language)
    : [];
  const uploadLanguages = content?.subtitleLanguageSource === 'manual'
    ? []
    : summarizeSubtitleLanguages(content?.files || []);
  const languages = uploadLanguages.length ? uploadLanguages : savedLanguages.length ? savedLanguages : legacySubtitleLanguages;
  return [...new Map(languages.map((language) => [language.toLowerCase(), language])).values()].slice(0, 8);
}

function isUsableTelegramFileName(value) {
  const filename = cleanText(value, 180);
  return Boolean(filename) && !/^(?:document|video|audio|animation|photo|file)-\d+$/i.test(filename);
}

function catalogFileTitle(content) {
  let title = cleanDeliveryFileName(content?.title);
  const releaseLabel = cleanText(content?.releaseLabel, 80);
  // Older native-video uploads only retained a shortened display name. If the
  // catalog metadata knows this is a season, use it to restore the meaningful
  // file title rather than exposing a leftover tag such as "ESubs".
  if (title && /^season\s*\d+\b/i.test(releaseLabel) && !/\bseason\s*\d+\b/i.test(title)) {
    title = `${title} ${releaseLabel}`;
  }
  return title;
}

function publicFileChoiceLabel(file, content, index) {
  const rawLabel = isUsableTelegramFileName(file?.sourceLabel)
    ? file.sourceLabel
    : isUsableTelegramFileName(file?.name)
      ? file.name
      : file?.displayName;
  const sourceTitle = cleanDeliveryFileName(rawLabel);
  const catalogTitle = catalogFileTitle(content);
  if (!sourceTitle) return catalogTitle || `Delivery file ${index + 1}`;

  // Prefer a richer canonical title when a legacy file record only retained a
  // shortened prefix. For example, `The Gentlemen ESubs` becomes
  // `The Gentlemen Season 1` when the catalog title contains the season.
  const sourceKey = sourceTitle.toLowerCase();
  const catalogKey = catalogTitle?.toLowerCase() || '';
  if (catalogTitle && (sourceKey === catalogKey || catalogKey.startsWith(`${sourceKey} `))) return catalogTitle;
  return sourceTitle;
}

function publicFileChoices(files, config, shareCode, content) {
  if (!Array.isArray(files)) return [];
  // A published detail page intentionally lists every uploaded file: selecting
  // one must never force a visitor to receive a different quality or episode.
  return files.map((file, index) => {
    const episode = publicEpisodeGroups([file?.episode])[0] || null;
    const quality = cleanText(file?.quality, 20) || detectMediaQuality({ filename: file?.name, caption: file?.sourceLabel || file?.displayName });
    const label = publicFileChoiceLabel(file, content, index);
    const telegramUrl = getTelegramFileDeliveryUrl(config, shareCode, index + 1);
    const deliveryUrl = getDeliveryRedirectPath(shareCode, index + 1);

    return {
      id: `file-${index + 1}`,
      position: index + 1,
      label,
      quality: quality || null,
      size: formatBytes(Number(file?.size) || 0),
      kind: ['document', 'video', 'audio', 'animation', 'photo'].includes(file?.kind) ? file.kind : 'file',
      episode,
      telegramUrl,
      deliveryUrl,
      deliveryReady: Boolean(telegramUrl && deliveryUrl)
    };
  });
}

export function toPublicContent(content, config, { includeFileChoices = true } = {}) {
  if (!content) return null;
  const category = categoryDetails(content.category);
  const shareCode = content.shareCode || null;
  const telegramUrl = content.hasDelivery ? getTelegramDeliveryUrl(config, shareCode) : null;
  const deliveryUrl = content.hasDelivery ? getDeliveryRedirectPath(shareCode) : null;
  const fileChoices = includeFileChoices && content.hasDelivery ? publicFileChoices(content.files, config, shareCode, content) : [];

  return {
    id: String(content._id || content.id || content.slug),
    slug: content.slug,
    title: content.title,
    category: content.category,
    categoryLabel: category.label,
    tone: content.art?.tone || category.tone,
    art: content.art || { tone: category.tone },
    year: content.year || null,
    languages: publicLanguages(content),
    subtitleLanguages: publicSubtitleLanguages(content),
    genres: Array.isArray(content.genres) ? content.genres : [],
    description: content.description || '',
    status: content.status || 'New release',
    releaseLabel: content.releaseLabel || null,
    posterUrl: content.posterUrl || null,
    backdropUrl: content.backdropUrl || content.posterUrl || null,
    filesCount: Number(content.filesCount) || 0,
    fileChoices,
    // This contains only previously validated provider URLs. It deliberately
    // has no upload token, dashboard URL, or private storage data.
    stream: publicStreamingData(content.stream, config.streaming || {}),
    episodeGroups: publicEpisodeGroups(content.episodeGroups),
    episodeCount: Math.max(0, Number(content.episodeCount) || 0),
    featured: Boolean(content.featured),
    publishedAt: serializeDate(content.publishedAt),
    telegramUrl,
    deliveryUrl,
    deliveryReady: Boolean(telegramUrl && deliveryUrl)
  };
}

function apiError(res, status, message) {
  res.status(status).json({ error: message });
}

export function createApp({ config, repository, distPath = defaultDistPath }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      // The catalog is intentionally embeddable in the Arena/Koyeb live preview.
      frameguard: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          imgSrc: ["'self'", 'https:', 'data:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
          connectSrc: ["'self'"],
          // /watch embeds only approved HTTPS player hosts. Koyeb serves the
          // page; the video itself remains at the provider and never transits
          // this process.
          frameSrc: ["'self'", ...streamingFrameSources(config.streaming || {})],
          frameAncestors: null,
          upgradeInsecureRequests: config.environment === 'production' ? [] : null
        }
      }
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '32kb' }));
  app.use(async (request, response, next) => {
    if (!isTrackableSiteVisit(request) || typeof repository.recordSiteVisit !== 'function') return next();
    try {
      await repository.recordSiteVisit({
        visitorId: anonymousVisitorId(request, response, config),
        path: request.path
      });
    } catch (error) {
      // Catalog browsing must remain available if optional analytics storage is
      // temporarily unavailable.
      console.warn('[server] anonymous visit was not recorded:', error?.message || 'Unknown error');
    }
    return next();
  });

  app.get('/api/health', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({
      ok: true,
      catalogStore: repository.kind,
      persistent: repository.persistent,
      telegramPolling: Boolean(config.telegram.botToken && config.telegram.mode === 'polling'),
      deliveryBotUsername: config.telegram.botUsername || null,
      announcementSiteUrl: config.siteUrl || null,
      now: new Date().toISOString()
    });
  });

  app.get('/api/config', (_request, response) => {
    response.set('Cache-Control', 'public, max-age=300');
    response.json({
      catalogName: 'SoraBox',
      categories: CATEGORIES,
      deliveryConfigured: Boolean(config.telegram.botUsername),
      announcementSiteConfigured: Boolean(config.siteUrl),
      demoMode: !repository.persistent
    });
  });

  app.get('/api/categories', async (_request, response, next) => {
    try {
      const items = await repository.listContent({ limit: 100 });
      const counts = items.reduce((result, item) => {
        result[item.category] = (result[item.category] || 0) + 1;
        return result;
      }, {});
      response.set('Cache-Control', 'public, max-age=60, s-maxage=120');
      response.json({
        categories: CATEGORIES.map((category) => ({ ...category, count: counts[category.id] || 0 }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/content', async (request, response, next) => {
    try {
      const rawCategory = cleanText(request.query.category, 40);
      const category = CATEGORY_IDS.has(rawCategory) ? rawCategory : undefined;
      const query = cleanText(request.query.q, 100);
      const items = await repository.listContent({ category, query, limit: 100 });
      response.set('Cache-Control', 'public, max-age=45, s-maxage=90');
      response.json({
        items: items.map((item) => toPublicContent(item, config, { includeFileChoices: false })),
        total: items.length
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/content/featured', async (_request, response, next) => {
    try {
      const items = await repository.listContent({ limit: 100 });
      const featured = items.find((item) => item.featured) || items[0] || null;
      if (!featured) return apiError(response, 404, 'No featured release is available.');
      response.set('Cache-Control', 'public, max-age=45, s-maxage=90');
      return response.json({ item: toPublicContent(featured, config, { includeFileChoices: false }) });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/content/:slug', async (request, response, next) => {
    try {
      const slug = cleanText(request.params.slug, 80);
      const item = await repository.findContentBySlug(slug);
      if (!item) return apiError(response, 404, 'This release is unavailable.');
      response.set('Cache-Control', 'public, max-age=60, s-maxage=120');
      return response.json({ item: toPublicContent(item, config) });
    } catch (error) {
      return next(error);
    }
  });

  function redirectToCurrentDeliveryBot(request, response, filePosition = null) {
    const shareCode = cleanText(request.params.shareCode, 48);
    const redirectPath = getDeliveryRedirectPath(shareCode, filePosition);
    if (!redirectPath) return response.status(404).type('text').send('That delivery link is invalid.');
    const telegramUrl = filePosition === null
      ? getTelegramDeliveryUrl(config, shareCode)
      : getTelegramFileDeliveryUrl(config, shareCode, filePosition);
    if (!telegramUrl) return response.status(503).type('text').send('Telegram delivery is being configured. Please try again shortly.');
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return response.redirect(302, telegramUrl);
  }

  // These first-party URLs are intentionally stable. They redirect to the
  // currently active Telegram bot at click time, so a replacement bot/token
  // does not require rewriting every existing catalog page.
  app.get('/deliver/:shareCode', (request, response) => redirectToCurrentDeliveryBot(request, response));
  app.get('/deliver/:shareCode/file/:filePosition', (request, response) => redirectToCurrentDeliveryBot(request, response, request.params.filePosition));

  app.use('/api', (_request, response) => apiError(response, 404, 'API route not found.'));

  if (fs.existsSync(distPath)) {
    app.use(
      express.static(distPath, {
        etag: true,
        maxAge: '1h',
        immutable: false
      })
    );
    app.use((request, response, next) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return next();
      if (!request.accepts('html')) return next();
      return response.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    app.get('/', (_request, response) => {
      response.type('html').send('<p>SoraBox API is running. Start the Vite client with <code>npm run dev:client</code>.</p>');
    });
  }

  app.use((request, response) => {
    if (request.path.startsWith('/api/')) return apiError(response, 404, 'API route not found.');
    return response.status(404).type('text').send('Not found');
  });

  app.use((error, _request, response, _next) => {
    console.error('[server] request failed:', error?.message || error);
    if (response.headersSent) return;
    return apiError(response, 500, 'Something went wrong. Please try again shortly.');
  });

  return app;
}

export async function startServer() {
  const config = loadConfig();
  const repository = await createCatalogRepository(config);
  const app = createApp({ config, repository });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.info(`[server] SoraBox listening on 0.0.0.0:${config.port} (${repository.kind} catalog)`);
    console.info(`[server] Announcement site URL: ${config.siteUrl || 'not configured'}`);
    if (!repository.persistent) {
      console.warn('[server] MongoDB is not configured: using non-persistent demo content.');
    }
  });

  let bot = null;
  try {
    bot = await launchTelegramBot({ config, repository });
  } catch (error) {
    console.error('[telegram] Bot did not start:', error?.message || error);
  }

  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    console.info(`[server] ${signal} received; shutting down.`);
    if (bot) bot.stop(signal);
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));

  return { app, server, repository, bot };
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (launchedDirectly) {
  startServer().catch((error) => {
    console.error('[server] Startup failed:', error?.message || error);
    process.exit(1);
  });
}
