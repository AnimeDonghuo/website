import crypto from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { detectUploadSeason } from './episode-service.js';

export const SUBSPLEASE_RSS_URL = 'https://subsplease.org/rss/';
const POLL_MS = 10 * 60_000;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_RELEASES = 50_000;

// Only explicit season suffixes are interchangeable. Sequel numbers and Part/Cour
// names remain in the title, rather than guessing that a sequel is season two.
export function animeTitleIdentity(value) {
  let title = String(value || '').normalize('NFKC').trim();
  // Upload prefixes are not part of the anime name (S01EP11 in particular).
  const prefix = title.match(/^S(\d{1,2})[ ._-]*E(?:P(?:ISODE)?)?[ ._-]*\d{1,4}(?:[-–]\d{1,4})?[ ._:-]+/i);
  if (prefix) title = title.slice(prefix[0].length);
  const seasonMatch = title.match(/(?:\s|^)(?:season\s*(\d{1,2})|s(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+season)\s*$/i);
  const season = seasonMatch ? Number(seasonMatch[1] || seasonMatch[2] || seasonMatch[3]) : (prefix ? Number(prefix[1]) : null);
  if (seasonMatch) title = title.slice(0, seasonMatch.index);
  const titleKey = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return { titleKey, season };
}

function animeSearchTitle(value) {
  return String(value || '').normalize('NFKC').trim()
    .replace(/^S\d{1,2}[ ._-]*E(?:P(?:ISODE)?)?[ ._-]*\d{1,4}(?:[-–]\d{1,4})?[ ._:-]+/i, '')
    .replace(/(?:\s|^)(?:season\s*\d{1,2}|s\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+season)\s*$/i, '')
    .replace(/[’‘]/g, "'").trim();
}

export function safeMagnet(value) {
  const text = String(value || '').trim();
  if (text.length > 8_192 || /[\x00-\x20<>"']/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'magnet:' || !url.searchParams.getAll('xt').some((xt) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(xt))) return null;
    return text;
  } catch { return null; }
}

export function parseSubsPleaseRelease(title, magnet) {
  const magnetUrl = safeMagnet(magnet);
  // The feed publishes single episodes and batch ranges. Do not interpret a
  // bare series name or an unrecognised quality as a downloadable episode.
  const match = String(title || '').match(/^\[SubsPlease\]\s+(.+?)\s+(?:-\s*|\()(\d{1,4})(?:v\d+)?(?:\s*[-–~]\s*(\d{1,4})(?:v\d+)?)?\)?\s+\((480|540|720|1080)p\)(?:\s*\[[^\]]+\])*(?:\.mkv)?$/i);
  if (!match || !magnetUrl) return null;
  const identity = animeTitleIdentity(match[1]);
  const start = Number(match[2]);
  const end = Number(match[3] || match[2]);
  if (!identity.titleKey || start < 1 || end < start) return null;
  const season = identity.season || 1;
  const quality = `${match[4]}p`;
  const key = [identity.titleKey, season, start, end, quality].join('|');
  return { key, title: String(title), titleKey: identity.titleKey, season, start, end, quality, magnetUrl };
}

export function parseSubsPleaseFeed(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_FEED_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid SubsPlease RSS feed');
  const document = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(xml);
  if (!document?.rss?.channel) throw new Error('SubsPlease did not return an RSS channel');
  const raw = document.rss.channel.item || [];
  const items = Array.isArray(raw) ? raw : [raw];
  const releases = new Map();
  for (const item of items.slice(0, 5_000)) {
    const release = parseSubsPleaseRelease(item.title, item.link);
    // RSS is newest first; keep the newest revision for a given episode/quality.
    if (release && !releases.has(release.key)) releases.set(release.key, release);
  }
  return [...releases.values()];
}

export function matchSubsPleaseMagnet(content, file, releases = [], aliases = []) {
  if (content?.category !== 'anime') return null;
  const identity = animeTitleIdentity(content.title);
  const labelSeason = animeTitleIdentity(content.releaseLabel).season;
  const explicitSeason = Number(file.season || file.seasonPack) || identity.season || labelSeason;
  if ((identity.season && explicitSeason !== identity.season) || (labelSeason && explicitSeason !== labelSeason)) return null;
  const season = explicitSeason || 1;
  const quality = String(file.quality || '').toLowerCase();
  if (!/^(480|540|720|1080)p$/.test(quality)) return null;
  const start = Number(file.episode?.start);
  const end = Number(file.episode?.end || start);
  const knownRange = Number.isInteger(start) && start > 0 && Number.isInteger(end) && end >= start;
  const wholeSeason = !knownRange && Number(file.seasonPack) > 0;
  if (!knownRange && !wholeSeason) return null;
  const titleKeys = new Set([identity.titleKey, ...aliases.map(animeTitleIdentity).filter((alias) => (alias.season || 1) === season).map((alias) => alias.titleKey)]);
  const candidates = releases.filter((entry) => titleKeys.has(entry.titleKey) && entry.season === season && entry.quality === quality
    && (knownRange ? entry.start === start && entry.end === end : entry.start === 1 && entry.end > 1));
  // A whole-season file with no known end must not choose between competing
  // batch ranges. Single-episode files never point at a larger batch.
  if (candidates.length !== 1) return null;
  const match = candidates[0];
  const url = safeMagnet(match.magnetUrl);
  return url ? { url, provider: 'SubsPlease', quality, start: match.start, end: match.end } : null;
}

export function addSubsPleaseMagnets(content, releases = [], source = null, aliases = []) {
  return { ...content, fileChoices: (content.fileChoices || []).map((file) => {
    const raw = source?.files?.[file.position - 1];
    // Public episode groups intentionally hide season numbers for single-season
    // cards. Matching must still use S02 from that file, not silently assume S01.
    const detected = raw ? detectUploadSeason({ filename: raw.name, caption: raw.sourceLabel || raw.displayName }) : null;
    const season = Number(detected?.season) || Number(raw?.season) || file.season;
    return { ...file, magnet: matchSubsPleaseMagnet(content, { ...file, season }, releases, aliases) };
  }) };
}

async function readFeed(response, provider = 'SubsPlease RSS') {
  if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_FEED_BYTES) throw new Error(`${provider} response is too large`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_FEED_BYTES) throw new Error(`${provider} response is too large`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The same public search API used by SubsPlease's website includes old episodes
// and batch packs; unlike RSS it is not limited to recent announcements.
export function parseSubsPleaseSearch(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid SubsPlease search response');
  const entries = new Map();
  const rows = Object.values(payload);
  if (rows.length && !rows.some((row) => row && typeof row.show === 'string' && Array.isArray(row.downloads))) throw new Error('Invalid SubsPlease search response');
  for (const row of rows.slice(0, 5_000)) {
    if (!row || typeof row.show !== 'string' || !Array.isArray(row.downloads)) continue;
    for (const download of row.downloads.slice(0, 12)) {
      const magnet = safeMagnet(download?.magnet);
      if (!magnet) continue;
      const quality = String(download.res || '').replace(/p$/i, '');
      const expected = parseSubsPleaseRelease(`[SubsPlease] ${row.show} - ${row.episode} (${quality}p)`, magnet);
      // Where present, the actual torrent display name must agree with the API
      // row. Never take a resolution label while ignoring what its magnet says.
      const dn = new URL(magnet).searchParams.get('dn');
      const actual = dn ? parseSubsPleaseRelease(dn, magnet) : expected;
      if (!expected || !actual || expected.key !== actual.key) continue;
      if (!entries.has(actual.key)) entries.set(actual.key, actual);
    }
  }
  return [...entries.values()];
}

export function selectAnimeAliases(payload, title) {
  const identity = animeTitleIdentity(title);
  const media = payload?.data?.Page?.media;
  if (!Array.isArray(media)) throw new Error('Anime title lookup is unavailable');
  const candidates = media.filter((entry) => {
    if (!entry?.id || !entry.title) return false;
    const official = [entry.title.english, entry.title.romaji, entry.title.native].filter(Boolean);
    const names = [...official, ...(Array.isArray(entry.synonyms) ? entry.synonyms : [])];
    // A search result isn't proof of identity. Require an exact official/alternate
    // title and reject conflicting season suffixes, rather than choosing result 1.
    return !official.some((name) => { const season = animeTitleIdentity(name).season; return season && season !== (identity.season || 1); })
      && names.some((name) => { const key = animeTitleIdentity(name); return key.titleKey === identity.titleKey && (key.season || 1) === (identity.season || 1); });
  });
  const unique = [...new Map(candidates.map((entry) => [entry.id, entry])).values()];
  if (unique.length !== 1) return [];
  const found = unique[0];
  return [...new Set([found.title.romaji, found.title.english, found.title.native, ...(found.synonyms || [])])]
    .filter((name) => typeof name === 'string' && name.length > 1 && name.length <= 180).slice(0, 8);
}

export function magnetContentRevision(content) {
  return crypto.createHash('sha256').update(JSON.stringify([
    content?.category, content?.title, content?.releaseLabel,
    (content?.files || []).map((file) => [file.name, file.sourceLabel, file.displayName, file.quality, file.episode, file.season])
  ])).digest('hex').slice(0, 24);
}

export function createSubsPleaseService({ repository, fetchImpl = fetch, logger = console, intervalMs = POLL_MS } = {}) {
  let releases = new Map();
  let pending = null;
  let timer = null;
  let stopped = false;
  const lookups = new Map();
  const archivePending = new Map();
  const lookupKey = (title) => { const id = animeTitleIdentity(title); return `${id.titleKey}|${id.season || 1}`; };
  const remember = (key, value) => {
    lookups.delete(key);
    lookups.set(key, value);
    if (lookups.size > 500) lookups.delete(lookups.keys().next().value);
  };
  const json = async (url, options, signal) => {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal, headers: { Accept: 'application/json', ...options?.headers } });
    return JSON.parse(await readFeed(response, new URL(url).hostname));
  };
  const merge = (rows) => {
    for (const row of rows) {
      // Revalidate persisted data too; never trust a stored URL as browser-safe.
      const release = parseSubsPleaseRelease(row.title, row.magnetUrl);
      if (release) { releases.delete(release.key); releases.set(release.key, release); }
    }
    if (releases.size > MAX_RELEASES) releases = new Map([...releases].slice(-MAX_RELEASES));
  };
  const refresh = () => {
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(SUBSPLEASE_RSS_URL, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'SoraBoxRSS/1.0' } });
      const rows = parseSubsPleaseFeed(await readFeed(response));
      merge(rows);
      if (rows.length && repository?.saveSubsPleaseReleases) await repository.saveSubsPleaseReleases(rows);
      return rows.length;
    })().finally(() => { pending = null; });
    return pending;
  };
  const lookupArchive = async (title, force = false) => {
    const key = lookupKey(title);
    if (archivePending.has(key)) return archivePending.get(key);
    const cached = lookups.get(key);
    if (!force && cached && cached.until > Date.now()) return cached;
    // Bounded concurrency, single-flight per title, short negative/error caching.
    // Different qualities of one episode do not make separate search requests.
    if (archivePending.size >= 3) return { aliases: cached?.aliases || [], state: 'unavailable' };
    const work = (async () => {
      let aliases = cached?.aliases || [];
      let state = 'ready';
      try {
        if (!aliases.length && repository?.findSubsPleaseAliases) {
          const saved = await repository.findSubsPleaseAliases(key);
          if (saved?.key === key && Array.isArray(saved.aliases)) aliases = saved.aliases.filter((name) => typeof name === 'string' && name.length <= 180).slice(0, 8);
        }
        const signal = AbortSignal.timeout(10_000);
        const search = async (query) => {
          const url = new URL('https://subsplease.org/api/');
          url.search = new URLSearchParams({ f: 'search', tz: 'UTC', s: query }).toString();
          const rows = parseSubsPleaseSearch(await json(url.href, {}, signal));
          merge(rows);
          if (rows.length && repository?.saveSubsPleaseReleases) await repository.saveSubsPleaseReleases(rows);
          return rows;
        };
        // Normalized words remove S01EP11/package punctuation but not sequel
        // numbers. Search is broad; attachment below still requires exact identity.
        const identity = animeTitleIdentity(title);
        const first = await search(aliases[0] || animeSearchTitle(title));
        const direct = first.some((row) => row.titleKey === identity.titleKey && row.season === (identity.season || 1));
        if (!direct && !aliases.length) {
          const payload = await json('https://graphql.anilist.co', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'query ($search: String!) { Page(perPage: 10) { media(search: $search, type: ANIME) { id title { english romaji native } synonyms } } }', variables: { search: animeSearchTitle(title) + (identity.season && identity.season > 1 ? ` Season ${identity.season}` : '') } })
          }, signal);
          aliases = selectAnimeAliases(payload, title);
          if (aliases.length) {
            if (repository?.saveSubsPleaseAliases) await repository.saveSubsPleaseAliases(key, aliases);
            await search(aliases[0]);
          }
        }
      } catch (error) {
        state = 'unavailable';
        logger.warn('[subsplease] Archive lookup failed:', error.message);
      }
      const result = { aliases, state, until: Date.now() + (state === 'unavailable' ? 30_000 : POLL_MS) };
      remember(key, result);
      return result;
    })().finally(() => archivePending.delete(key));
    archivePending.set(key, work);
    return work;
  };
  return {
    entries: () => [...releases.values()],
    refresh,
    aliases: (title) => lookups.get(lookupKey(title))?.aliases || [],
    async resolve(content, source, { force = false, searchTitle = null } = {}) {
      if (content?.category !== 'anime') return { item: addSubsPleaseMagnets(content, []), state: 'not-applicable' };
      let wanted = searchTitle;
      if (!wanted && source?.adminId && repository?.findSubsPleaseOverride) {
        const override = await repository.findSubsPleaseOverride(source.adminId);
        if (override?.title === content.title && override?.category === content.category) wanted = override.searchTitle;
      }
      const lookupContent = wanted ? { ...content, title: wanted } : content;
      const found = await lookupArchive(lookupContent.title, force);
      const matched = addSubsPleaseMagnets(lookupContent, [...releases.values()], source, found.aliases);
      const item = { ...matched, title: content.title };
      const hasMatch = item.fileChoices.some((file) => file.magnet);
      return { item, state: hasMatch ? 'ready' : found.state === 'unavailable' ? 'unavailable' : 'not-found' };
    },
    async start() {
      stopped = false;
      try { if (repository?.loadSubsPleaseReleases) merge(await repository.loadSubsPleaseReleases(MAX_RELEASES)); }
      catch (error) { logger.warn('[subsplease] Could not load cached releases:', error.message); }
      if (stopped) return;
      const tick = () => refresh().catch((error) => logger.warn('[subsplease] Keeping previously verified links:', error.message));
      await tick();
      if (!stopped && !timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); }
    },
    async stop() { stopped = true; clearInterval(timer); timer = null; await pending?.catch(() => {}); await Promise.allSettled([...archivePending.values()]); }
  };
}
