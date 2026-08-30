import { MongoClient } from 'mongodb';
import { demoContent } from './demo-content.js';
import { CATEGORY_IDS, cleanText, makeShareCode, slugify } from './lib/strings.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 48;

function clone(value) {
  return structuredClone(value);
}

function sessionKey(chatId, ownerId) {
  return `${String(chatId)}:${String(ownerId)}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchPredicate(item, query) {
  if (!query) return true;
  const haystack = [
    item.title,
    item.description,
    ...(item.genres || []),
    ...(item.languages || []),
    item.category
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function sortByPublishedAt(items) {
  return [...items].sort(
    (first, second) => new Date(second.publishedAt || 0).getTime() - new Date(first.publishedAt || 0).getTime()
  );
}

function normalizeContent(input) {
  const now = new Date().toISOString();
  const title = cleanText(input.title, 180) || 'Untitled release';
  const category = CATEGORY_IDS.has(input.category) ? input.category : 'movie';
  const files = Array.isArray(input.files) ? input.files : [];
  const parsedYear = Number.parseInt(input.year, 10);

  return {
    title,
    category,
    year: Number.isInteger(parsedYear) && parsedYear >= 1888 && parsedYear <= new Date().getFullYear() + 5 ? parsedYear : null,
    languages: Array.isArray(input.languages)
      ? input.languages.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 8)
      : [],
    genres: Array.isArray(input.genres)
      ? input.genres.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 8)
      : [],
    description: cleanText(input.description, 1400),
    status: cleanText(input.status, 60) || 'New release',
    releaseLabel: cleanText(input.releaseLabel, 80) || (files.length === 1 ? 'Feature' : `${files.length} files`),
    posterUrl: input.posterUrl || null,
    backdropUrl: input.backdropUrl || input.posterUrl || null,
    poster: input.poster || null,
    tmdbId: input.tmdbId || null,
    art: input.art || null,
    files,
    filesCount: files.length || (Number.isInteger(Number(input.filesCount)) ? Number(input.filesCount) : 0),
    hasDelivery: files.length > 0 || Boolean(input.hasDelivery),
    featured: Boolean(input.featured),
    published: true,
    publishedAt: input.publishedAt || now,
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

export class MemoryCatalogRepository {
  constructor(seed = demoContent) {
    this.kind = 'memory';
    this.persistent = false;
    this.contents = new Map(
      seed.map((item) => {
        const normalized = normalizeContent(item);
        return [item.slug, {
          ...normalized,
          id: item.id || `memory-${item.slug}`,
          slug: item.slug,
          shareCode: item.shareCode || makeShareCode(),
          deliveryCount: item.deliveryCount || 0
        }];
      })
    );
    this.sessions = new Map();
  }

  async init() {}

  async listContent({ category, query, limit = 60 } = {}) {
    const normalizedCategory = CATEGORY_IDS.has(category) ? category : null;
    const normalizedQuery = cleanText(query, 100);
    return sortByPublishedAt([...this.contents.values()])
      .filter((item) => !normalizedCategory || item.category === normalizedCategory)
      .filter((item) => searchPredicate(item, normalizedQuery))
      .slice(0, Math.max(1, Math.min(Number(limit) || 60, 100)))
      .map(clone);
  }

  async findContentBySlug(slug) {
    const item = this.contents.get(slug);
    return item ? clone(item) : null;
  }

  async findContentByShareCode(shareCode) {
    const item = [...this.contents.values()].find((entry) => entry.shareCode === shareCode);
    return item ? clone(item) : null;
  }

  async createContent(input) {
    const baseSlug = slugify(input.title);
    let suffix = 0;
    let slug = baseSlug;
    while (this.contents.has(slug)) {
      suffix += 1;
      slug = `${baseSlug}-${suffix + 1}`;
    }

    const content = {
      ...normalizeContent(input),
      id: `memory-${makeShareCode()}`,
      slug,
      shareCode: makeShareCode()
    };
    this.contents.set(slug, content);
    return clone(content);
  }

  async incrementDelivery(shareCode) {
    const item = [...this.contents.values()].find((entry) => entry.shareCode === shareCode);
    if (!item) return;
    item.deliveryCount = (item.deliveryCount || 0) + 1;
    item.updatedAt = new Date().toISOString();
  }

  async startSession({ chatId, ownerId, category, title = '' }) {
    const key = sessionKey(chatId, ownerId);
    const now = new Date().toISOString();
    const session = {
      chatId: String(chatId),
      ownerId: String(ownerId),
      category: CATEGORY_IDS.has(category) ? category : 'movie',
      title: cleanText(title, 180),
      metadata: null,
      posterOriginalUrl: null,
      files: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    };
    this.sessions.set(key, session);
    return clone(session);
  }

  async findSession(chatId, ownerId) {
    const item = this.sessions.get(sessionKey(chatId, ownerId));
    if (!item) return null;
    if (new Date(item.expiresAt).getTime() < Date.now()) {
      this.sessions.delete(sessionKey(chatId, ownerId));
      return null;
    }
    return clone(item);
  }

  async updateSession(chatId, ownerId, patch) {
    const key = sessionKey(chatId, ownerId);
    const item = this.sessions.get(key);
    if (!item) return null;
    Object.assign(item, clone(patch), {
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });
    this.sessions.set(key, item);
    return clone(item);
  }

  async appendSessionFile(chatId, ownerId, file) {
    const key = sessionKey(chatId, ownerId);
    const item = this.sessions.get(key);
    if (!item) return null;
    item.files.push(clone(file));
    item.updatedAt = new Date().toISOString();
    item.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    return clone(item);
  }

  async deleteSession(chatId, ownerId) {
    this.sessions.delete(sessionKey(chatId, ownerId));
  }

  async close() {}
}

export class MongoCatalogRepository {
  constructor(client, db) {
    this.kind = 'mongodb';
    this.persistent = true;
    this.client = client;
    this.db = db;
    this.contents = db.collection('content');
    this.sessions = db.collection('upload_sessions');
  }

  async init() {
    await Promise.all([
      this.contents.createIndex({ slug: 1 }, { unique: true }),
      this.contents.createIndex({ shareCode: 1 }, { unique: true }),
      this.contents.createIndex({ publishedAt: -1 }),
      this.contents.createIndex({ category: 1, publishedAt: -1 }),
      this.sessions.createIndex({ chatId: 1, ownerId: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]);
  }

  async listContent({ category, query, limit = 60 } = {}) {
    const filter = { published: true };
    if (CATEGORY_IDS.has(category)) filter.category = category;

    const normalizedQuery = cleanText(query, 100);
    if (normalizedQuery) {
      const expression = new RegExp(escapeRegex(normalizedQuery), 'i');
      filter.$or = [
        { title: expression },
        { description: expression },
        { genres: expression },
        { languages: expression }
      ];
    }

    return this.contents
      .find(filter, { projection: { files: 0, 'poster.deleteUrl': 0 } })
      .sort({ featured: -1, publishedAt: -1 })
      .limit(Math.max(1, Math.min(Number(limit) || 60, 100)))
      .toArray();
  }

  async findContentBySlug(slug) {
    return this.contents.findOne(
      { slug, published: true },
      { projection: { files: 0, 'poster.deleteUrl': 0 } }
    );
  }

  async findContentByShareCode(shareCode) {
    return this.contents.findOne({ shareCode, published: true });
  }

  async createContent(input) {
    const baseSlug = slugify(input.title);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const document = {
        ...normalizeContent(input),
        slug: `${baseSlug}${suffix}`,
        shareCode: makeShareCode()
      };

      try {
        const result = await this.contents.insertOne(document);
        return { ...document, _id: result.insertedId };
      } catch (error) {
        if (error?.code !== 11000 || attempt === 15) throw error;
      }
    }
    throw new Error('Could not create a unique content record.');
  }

  async incrementDelivery(shareCode) {
    await this.contents.updateOne(
      { shareCode },
      { $inc: { deliveryCount: 1 }, $set: { updatedAt: new Date().toISOString() } }
    );
  }

  async startSession({ chatId, ownerId, category, title = '' }) {
    const now = new Date().toISOString();
    const result = await this.sessions.findOneAndUpdate(
      { chatId: String(chatId), ownerId: String(ownerId) },
      {
        $set: {
          category: CATEGORY_IDS.has(category) ? category : 'movie',
          title: cleanText(title, 180),
          metadata: null,
          posterOriginalUrl: null,
          files: [],
          updatedAt: now,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS)
        },
        $setOnInsert: {
          chatId: String(chatId),
          ownerId: String(ownerId),
          createdAt: now
        }
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false }
    );
    return result;
  }

  async findSession(chatId, ownerId) {
    return this.sessions.findOne({ chatId: String(chatId), ownerId: String(ownerId) });
  }

  async updateSession(chatId, ownerId, patch) {
    const safePatch = { ...patch };
    delete safePatch.chatId;
    delete safePatch.ownerId;
    delete safePatch.files;
    safePatch.updatedAt = new Date().toISOString();
    safePatch.expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const result = await this.sessions.findOneAndUpdate(
      { chatId: String(chatId), ownerId: String(ownerId) },
      { $set: safePatch },
      { returnDocument: 'after', includeResultMetadata: false }
    );
    return result;
  }

  async appendSessionFile(chatId, ownerId, file) {
    const result = await this.sessions.findOneAndUpdate(
      { chatId: String(chatId), ownerId: String(ownerId) },
      {
        $push: { files: file },
        $set: {
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS)
        }
      },
      { returnDocument: 'after', includeResultMetadata: false }
    );
    return result;
  }

  async deleteSession(chatId, ownerId) {
    await this.sessions.deleteOne({ chatId: String(chatId), ownerId: String(ownerId) });
  }

  async close() {
    await this.client.close();
  }
}

export async function createCatalogRepository(config) {
  if (!config.mongodbUri) {
    const repository = new MemoryCatalogRepository();
    await repository.init();
    return repository;
  }

  const client = new MongoClient(config.mongodbUri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 10
  });
  await client.connect();
  const repository = new MongoCatalogRepository(client, client.db(config.mongodbDb));
  await repository.init();
  return repository;
}
