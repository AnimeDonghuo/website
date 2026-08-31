import { MongoClient } from 'mongodb';
import { demoContent } from './demo-content.js';
import { CATEGORY_IDS, cleanText, makeReference, makeShareCode, slugify } from './lib/strings.js';
import { summarizeEpisodes } from './services/episode-service.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 48;

// List cards only need safe display fields plus enough file-label information
// to derive languages from older uploads. Storage message IDs and Telegram file
// IDs are deliberately never selected for a public catalog listing.
const LIST_CONTENT_PROJECTION = {
  slug: 1,
  title: 1,
  category: 1,
  art: 1,
  year: 1,
  languages: 1,
  languageSource: 1,
  genres: 1,
  description: 1,
  status: 1,
  releaseLabel: 1,
  posterUrl: 1,
  backdropUrl: 1,
  filesCount: 1,
  episodeGroups: 1,
  episodeCount: 1,
  featured: 1,
  publishedAt: 1,
  shareCode: 1,
  hasDelivery: 1,
  'files.name': 1,
  'files.displayName': 1,
  'files.languages': 1
};

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
  const haystack = item.searchText || [
    item.title,
    item.description,
    ...(item.genres || []),
    ...(item.languages || []),
    item.category
  ]
    .join(' ')
    .toLowerCase();

  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
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
  const languages = Array.isArray(input.languages)
    ? input.languages.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 8)
    : [];
  const genres = Array.isArray(input.genres)
    ? input.genres.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 8)
    : [];
  const description = cleanText(input.description, 1400);
  const episodeSummary = summarizeEpisodes(files);
  const suppliedEpisodeGroups = Array.isArray(input.episodeGroups)
    ? input.episodeGroups
      .map((group) => ({
        start: Number(group?.start),
        end: Number(group?.end),
        label: cleanText(group?.label, 50),
        fileCount: Math.max(1, Number(group?.fileCount) || 1)
      }))
      .filter((group) => Number.isInteger(group.start) && Number.isInteger(group.end) && group.start >= 1 && group.end >= group.start && group.end <= 999 && group.label)
      .slice(0, 100)
    : [];
  const episodeGroups = episodeSummary.groups.length ? episodeSummary.groups : suppliedEpisodeGroups;
  const suppliedEpisodeCount = Number(input.episodeCount);
  const episodeCount = episodeSummary.count || (Number.isInteger(suppliedEpisodeCount) && suppliedEpisodeCount >= 0 ? suppliedEpisodeCount : 0);
  const suppliedFilesCount = Number.isInteger(Number(input.filesCount)) ? Number(input.filesCount) : 0;
  const filesCount = files.length || suppliedFilesCount;

  return {
    title,
    category,
    year: Number.isInteger(parsedYear) && parsedYear >= 1888 && parsedYear <= new Date().getFullYear() + 5 ? parsedYear : null,
    languages,
    languageSource: ['manual', 'upload', 'metadata'].includes(input.languageSource) ? input.languageSource : null,
    genres,
    description,
    status: cleanText(input.status, 60) || 'New release',
    releaseLabel: cleanText(input.releaseLabel, 80) || episodeSummary.releaseLabel || (files.length === 1 ? 'Feature' : `${files.length} files`),
    posterUrl: input.posterUrl || null,
    backdropUrl: input.backdropUrl || input.posterUrl || null,
    poster: input.poster || null,
    metadataProvider: cleanText(input.metadataProvider, 30) || null,
    tmdbId: input.tmdbId || null,
    art: input.art || null,
    files,
    filesCount,
    hasDelivery: files.length > 0 || Boolean(input.hasDelivery),
    episodeGroups,
    episodeCount,
    searchText: [title, description, category, ...languages, ...genres].join(' ').toLowerCase(),
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
          adminId: item.adminId || makeReference('SB'),
          deliveryCount: item.deliveryCount || 0
        }];
      })
    );
    this.sessions = new Map();
    this.adminSessions = new Map();
    this.requests = new Map();
    this.announcementChannels = new Map();
    this.autoPublishSettings = { enabled: false, enabledAt: null, updatedAt: null, updatedBy: null };
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

  async findContentByStorageMessageId(storageMessageId) {
    const needle = String(storageMessageId);
    const item = [...this.contents.values()].find((entry) =>
      Array.isArray(entry.files) && entry.files.some((file) => String(file.storageMessageId) === needle)
    );
    return item ? clone(item) : null;
  }

  async findContentByAdminId(adminId) {
    const item = [...this.contents.values()].find((entry) => entry.adminId === String(adminId).toUpperCase());
    return item ? clone(item) : null;
  }

  async deleteContentByAdminId(adminId) {
    const item = await this.findContentByAdminId(adminId);
    if (!item) return null;
    this.contents.delete(item.slug);
    return item;
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
      shareCode: makeShareCode(),
      adminId: makeReference('SB')
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
      workflow: 'manual',
      batch: null,
      auto: null,
      overrides: null,
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

  async findSessionByStorageMessageId(storageMessageId) {
    const needle = String(storageMessageId);
    for (const [key, session] of this.sessions.entries()) {
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        this.sessions.delete(key);
        continue;
      }
      if (Array.isArray(session.files) && session.files.some((file) => String(file.storageMessageId) === needle)) {
        return clone(session);
      }
    }
    return null;
  }

  async deleteSession(chatId, ownerId) {
    this.sessions.delete(sessionKey(chatId, ownerId));
  }

  async createAdminSession({ chatId, ownerId, expiresAt }) {
    const session = {
      chatId: String(chatId),
      ownerId: String(ownerId),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString()
    };
    this.adminSessions.set(sessionKey(chatId, ownerId), session);
    return clone(session);
  }

  async findAdminSession(chatId, ownerId) {
    const key = sessionKey(chatId, ownerId);
    const session = this.adminSessions.get(key);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      this.adminSessions.delete(key);
      return null;
    }
    return clone(session);
  }

  async deleteAdminSession(chatId, ownerId) {
    this.adminSessions.delete(sessionKey(chatId, ownerId));
  }

  async createRequest({ requestText, requester }) {
    const request = {
      id: makeReference('REQ'),
      requestText: cleanText(requestText, 500),
      requester: {
        id: String(requester?.id || ''),
        username: cleanText(requester?.username || '', 60),
        name: cleanText([requester?.first_name, requester?.last_name].filter(Boolean).join(' '), 100)
      },
      status: 'open',
      createdAt: new Date().toISOString()
    };
    this.requests.set(request.id, request);
    return clone(request);
  }

  async listRequests(limit = 12) {
    return [...this.requests.values()]
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
      .slice(0, Math.max(1, Math.min(Number(limit) || 12, 30)))
      .map(clone);
  }

  async addAnnouncementChannel({ channelId, title = '', username = '', addedBy = '' }) {
    const channel = {
      channelId: String(channelId),
      title: cleanText(title, 120),
      username: cleanText(username, 80),
      addedBy: String(addedBy),
      addedAt: new Date().toISOString()
    };
    this.announcementChannels.set(channel.channelId, channel);
    return clone(channel);
  }

  async listAnnouncementChannels() {
    return [...this.announcementChannels.values()].sort((first, second) => first.title.localeCompare(second.title)).map(clone);
  }

  async removeAnnouncementChannel(channelId) {
    const key = String(channelId);
    const channel = this.announcementChannels.get(key);
    this.announcementChannels.delete(key);
    return channel ? clone(channel) : null;
  }

  async getAutoPublishSettings() {
    return clone(this.autoPublishSettings);
  }

  async setAutoPublishSettings({ enabled, updatedBy = null }) {
    const now = new Date().toISOString();
    this.autoPublishSettings = {
      enabled: Boolean(enabled),
      enabledAt: enabled ? now : null,
      updatedAt: now,
      updatedBy: updatedBy === null || updatedBy === undefined ? null : String(updatedBy)
    };
    return clone(this.autoPublishSettings);
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
    this.adminSessions = db.collection('admin_sessions');
    this.requests = db.collection('requests');
    this.announcementChannels = db.collection('announcement_channels');
    this.automationSettings = db.collection('automation_settings');
  }

  async init() {
    await Promise.all([
      this.contents.createIndex({ slug: 1 }, { unique: true }),
      this.contents.createIndex({ shareCode: 1 }, { unique: true }),
      this.contents.createIndex({ adminId: 1 }, { unique: true }),
      this.contents.createIndex({ publishedAt: -1 }),
      this.contents.createIndex({ category: 1, publishedAt: -1 }),
      this.contents.createIndex({ 'files.storageMessageId': 1 }),
      this.sessions.createIndex({ chatId: 1, ownerId: 1 }, { unique: true }),
      this.sessions.createIndex({ 'files.storageMessageId': 1 }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.adminSessions.createIndex({ chatId: 1, ownerId: 1 }, { unique: true }),
      this.adminSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.requests.createIndex({ id: 1 }, { unique: true }),
      this.requests.createIndex({ status: 1, createdAt: -1 }),
      this.announcementChannels.createIndex({ channelId: 1 }, { unique: true })
    ]);
  }

  async listContent({ category, query, limit = 60 } = {}) {
    const filter = { published: true };
    if (CATEGORY_IDS.has(category)) filter.category = category;

    const normalizedQuery = cleanText(query, 100);
    if (normalizedQuery) {
      const terms = normalizedQuery.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      filter.$and = terms.map((term) => {
        const expression = new RegExp(escapeRegex(term), 'i');
        return {
          $or: [
            { searchText: expression },
            { title: expression },
            { description: expression },
            { genres: expression },
            { languages: expression }
          ]
        };
      });
    }

    // The list serializer uses safe file labels to resolve legacy language tags
    // such as "Multi (Hindi + Malayalam)". It never returns `files` to clients.
    return this.contents
      .find(filter, { projection: LIST_CONTENT_PROJECTION })
      .sort({ featured: -1, publishedAt: -1 })
      .limit(Math.max(1, Math.min(Number(limit) || 60, 100)))
      .toArray();
  }

  async findContentBySlug(slug) {
    // Detail pages need the saved file labels/quality/episode information to
    // create individual Telegram choices. The public serializer strips all
    // raw Telegram IDs and storage message IDs before returning this record.
    return this.contents.findOne(
      { slug, published: true },
      { projection: { 'poster.deleteUrl': 0 } }
    );
  }

  async findContentByShareCode(shareCode) {
    return this.contents.findOne({ shareCode, published: true });
  }

  async findContentByStorageMessageId(storageMessageId) {
    const asNumber = Number(storageMessageId);
    const values = Number.isSafeInteger(asNumber) ? [asNumber, String(storageMessageId)] : [String(storageMessageId)];
    return this.contents.findOne(
      { 'files.storageMessageId': { $in: values } },
      { projection: { slug: 1, title: 1, adminId: 1, shareCode: 1 } }
    );
  }

  async findContentByAdminId(adminId) {
    return this.contents.findOne({ adminId: String(adminId).toUpperCase() });
  }

  async deleteContentByAdminId(adminId) {
    return this.contents.findOneAndDelete(
      { adminId: String(adminId).toUpperCase() },
      { includeResultMetadata: false }
    );
  }

  async createContent(input) {
    const baseSlug = slugify(input.title);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const document = {
        ...normalizeContent(input),
        slug: `${baseSlug}${suffix}`,
        shareCode: makeShareCode(),
        adminId: makeReference('SB')
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
          workflow: 'manual',
          batch: null,
          auto: null,
          overrides: null,
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
    const filter = { chatId: String(chatId), ownerId: String(ownerId) };
    const update = await this.sessions.updateOne(
      filter,
      {
        $push: { files: file },
        $set: {
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS)
        }
      }
    );

    // updateOne gives an unambiguous matchedCount across MongoDB driver versions.
    // Fetching afterward also means callers always receive the actual saved draft,
    // rather than a findOneAndUpdate metadata wrapper.
    if (update.matchedCount !== 1) return null;
    return this.sessions.findOne(filter);
  }

  async findSessionByStorageMessageId(storageMessageId) {
    const asNumber = Number(storageMessageId);
    const values = Number.isSafeInteger(asNumber) ? [asNumber, String(storageMessageId)] : [String(storageMessageId)];
    return this.sessions.findOne(
      { 'files.storageMessageId': { $in: values }, expiresAt: { $gt: new Date() } },
      { projection: { chatId: 1, ownerId: 1, workflow: 1 } }
    );
  }

  async deleteSession(chatId, ownerId) {
    await this.sessions.deleteOne({ chatId: String(chatId), ownerId: String(ownerId) });
  }

  async createAdminSession({ chatId, ownerId, expiresAt }) {
    const now = new Date().toISOString();
    const result = await this.adminSessions.findOneAndUpdate(
      { chatId: String(chatId), ownerId: String(ownerId) },
      {
        $set: { createdAt: now, expiresAt: new Date(expiresAt) },
        $setOnInsert: { chatId: String(chatId), ownerId: String(ownerId) }
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false }
    );
    return result;
  }

  async findAdminSession(chatId, ownerId) {
    return this.adminSessions.findOne({
      chatId: String(chatId),
      ownerId: String(ownerId),
      expiresAt: { $gt: new Date() }
    });
  }

  async deleteAdminSession(chatId, ownerId) {
    await this.adminSessions.deleteOne({ chatId: String(chatId), ownerId: String(ownerId) });
  }

  async createRequest({ requestText, requester }) {
    const document = {
      id: makeReference('REQ'),
      requestText: cleanText(requestText, 500),
      requester: {
        id: String(requester?.id || ''),
        username: cleanText(requester?.username || '', 60),
        name: cleanText([requester?.first_name, requester?.last_name].filter(Boolean).join(' '), 100)
      },
      status: 'open',
      createdAt: new Date().toISOString()
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.requests.insertOne(document);
        return document;
      } catch (error) {
        if (error?.code !== 11000 || attempt === 7) throw error;
        document.id = makeReference('REQ');
      }
    }
    throw new Error('Could not create a request ID.');
  }

  async listRequests(limit = 12) {
    return this.requests
      .find({ status: 'open' })
      .sort({ createdAt: -1 })
      .limit(Math.max(1, Math.min(Number(limit) || 12, 30)))
      .toArray();
  }

  async addAnnouncementChannel({ channelId, title = '', username = '', addedBy = '' }) {
    const document = {
      channelId: String(channelId),
      title: cleanText(title, 120),
      username: cleanText(username, 80),
      addedBy: String(addedBy),
      addedAt: new Date().toISOString()
    };
    await this.announcementChannels.updateOne(
      { channelId: document.channelId },
      { $set: document },
      { upsert: true }
    );
    return document;
  }

  async listAnnouncementChannels() {
    return this.announcementChannels.find({}).sort({ title: 1, addedAt: 1 }).toArray();
  }

  async removeAnnouncementChannel(channelId) {
    return this.announcementChannels.findOneAndDelete(
      { channelId: String(channelId) },
      { includeResultMetadata: false }
    );
  }

  async getAutoPublishSettings() {
    return (await this.automationSettings.findOne({ _id: 'auto-publish' })) || {
      enabled: false,
      enabledAt: null,
      updatedAt: null,
      updatedBy: null
    };
  }

  async setAutoPublishSettings({ enabled, updatedBy = null }) {
    const now = new Date().toISOString();
    const settings = {
      enabled: Boolean(enabled),
      enabledAt: enabled ? now : null,
      updatedAt: now,
      updatedBy: updatedBy === null || updatedBy === undefined ? null : String(updatedBy)
    };
    await this.automationSettings.updateOne(
      { _id: 'auto-publish' },
      { $set: settings },
      { upsert: true }
    );
    return settings;
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
