import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCatalogRepository } from './catalog.repository.js';
import { getTelegramDeliveryUrl, getTelegramFileDeliveryUrl, loadConfig } from './config.js';
import { CATEGORIES, CATEGORY_IDS, categoryDetails, cleanText, formatBytes } from './lib/strings.js';
import { cleanMediaName, detectMediaQuality } from './services/episode-service.js';
import { launchTelegramBot } from './services/telegram-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDistPath = path.resolve(__dirname, '../../dist');

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

function publicFileChoices(files, config, shareCode) {
  if (!Array.isArray(files)) return [];
  // A published detail page intentionally lists every uploaded file: selecting
  // one must never force a visitor to receive a different quality or episode.
  return files.map((file, index) => {
    const episode = publicEpisodeGroups([file?.episode])[0] || null;
    const quality = cleanText(file?.quality, 20) || detectMediaQuality({ filename: file?.name, caption: file?.displayName });
    const label = cleanMediaName(file?.displayName || file?.name) || `Delivery file ${index + 1}`;
    const telegramUrl = getTelegramFileDeliveryUrl(config, shareCode, index + 1);

    return {
      id: `file-${index + 1}`,
      position: index + 1,
      label,
      quality: quality || null,
      size: formatBytes(Number(file?.size) || 0),
      kind: ['document', 'video', 'audio', 'animation', 'photo'].includes(file?.kind) ? file.kind : 'file',
      episode,
      telegramUrl,
      deliveryReady: Boolean(telegramUrl)
    };
  });
}

export function toPublicContent(content, config) {
  if (!content) return null;
  const category = categoryDetails(content.category);
  const shareCode = content.shareCode || null;
  const deliveryUrl = content.hasDelivery ? getTelegramDeliveryUrl(config, shareCode) : null;
  const fileChoices = content.hasDelivery ? publicFileChoices(content.files, config, shareCode) : [];

  return {
    id: String(content._id || content.id || content.slug),
    slug: content.slug,
    title: content.title,
    category: content.category,
    categoryLabel: category.label,
    tone: content.art?.tone || category.tone,
    art: content.art || { tone: category.tone },
    year: content.year || null,
    languages: Array.isArray(content.languages) ? content.languages : [],
    genres: Array.isArray(content.genres) ? content.genres : [],
    description: content.description || '',
    status: content.status || 'New release',
    releaseLabel: content.releaseLabel || null,
    posterUrl: content.posterUrl || null,
    backdropUrl: content.backdropUrl || content.posterUrl || null,
    filesCount: Number(content.filesCount) || 0,
    fileChoices,
    episodeGroups: publicEpisodeGroups(content.episodeGroups),
    episodeCount: Math.max(0, Number(content.episodeCount) || 0),
    featured: Boolean(content.featured),
    publishedAt: serializeDate(content.publishedAt),
    telegramUrl: deliveryUrl,
    deliveryReady: Boolean(deliveryUrl)
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
          frameAncestors: null,
          upgradeInsecureRequests: config.environment === 'production' ? [] : null
        }
      }
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({
      ok: true,
      catalogStore: repository.kind,
      persistent: repository.persistent,
      telegramPolling: Boolean(config.telegram.botToken && config.telegram.mode === 'polling'),
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
        items: items.map((item) => toPublicContent(item, config)),
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
      return response.json({ item: toPublicContent(featured, config) });
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
