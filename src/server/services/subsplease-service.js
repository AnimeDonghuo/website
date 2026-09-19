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
  const seasonMatch = title.match(/(?:\s|^)(?:season\s*(\d{1,2})|s(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+season)\s*$/i);
  const season = seasonMatch ? Number(seasonMatch[1] || seasonMatch[2] || seasonMatch[3]) : null;
  if (seasonMatch) title = title.slice(0, seasonMatch.index);
  const titleKey = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return { titleKey, season };
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
  const match = String(title || '').match(/^\[SubsPlease\]\s+(.+?)\s+(?:-\s*|\()(\d{1,4})(?:v\d+)?(?:\s*[-–~]\s*(\d{1,4})(?:v\d+)?)?\)?\s+\((480|720|1080)p\)(?:\s*\[[^\]]+\])*(?:\.mkv)?$/i);
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

export function matchSubsPleaseMagnet(content, file, releases = []) {
  if (content?.category !== 'anime') return null;
  const identity = animeTitleIdentity(content.title);
  const labelSeason = animeTitleIdentity(content.releaseLabel).season;
  const explicitSeason = Number(file.season || file.seasonPack) || identity.season || labelSeason;
  if ((identity.season && explicitSeason !== identity.season) || (labelSeason && explicitSeason !== labelSeason)) return null;
  const season = explicitSeason || 1;
  const quality = String(file.quality || '').toLowerCase();
  if (!/^(480|720|1080)p$/.test(quality)) return null;
  const start = Number(file.episode?.start);
  const end = Number(file.episode?.end || start);
  const knownRange = Number.isInteger(start) && start > 0 && Number.isInteger(end) && end >= start;
  const wholeSeason = !knownRange && Number(file.seasonPack) > 0;
  if (!knownRange && !wholeSeason) return null;
  const candidates = releases.filter((entry) => entry.titleKey === identity.titleKey && entry.season === season && entry.quality === quality
    && (knownRange ? entry.start === start && entry.end === end : entry.start === 1 && entry.end > 1));
  // A whole-season file with no known end must not choose between competing
  // batch ranges. Single-episode files never point at a larger batch.
  if (candidates.length !== 1) return null;
  const match = candidates[0];
  const url = safeMagnet(match.magnetUrl);
  return url ? { url, provider: 'SubsPlease', quality, start: match.start, end: match.end } : null;
}

export function addSubsPleaseMagnets(content, releases = [], source = null) {
  return { ...content, fileChoices: (content.fileChoices || []).map((file) => {
    const raw = source?.files?.[file.position - 1];
    // Public episode groups intentionally hide season numbers for single-season
    // cards. Matching must still use S02 from that file, not silently assume S01.
    const detected = raw ? detectUploadSeason({ filename: raw.name, caption: raw.sourceLabel || raw.displayName }) : null;
    const season = Number(detected?.season) || Number(raw?.season) || file.season;
    return { ...file, magnet: matchSubsPleaseMagnet(content, { ...file, season }, releases) };
  }) };
}

async function readFeed(response) {
  if (!response.ok) throw new Error(`SubsPlease RSS returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_FEED_BYTES) throw new Error('SubsPlease RSS is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_FEED_BYTES) throw new Error('SubsPlease RSS is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createSubsPleaseService({ repository, fetchImpl = fetch, logger = console, intervalMs = POLL_MS } = {}) {
  let releases = new Map();
  let pending = null;
  let timer = null;
  let stopped = false;
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
  return {
    entries: () => [...releases.values()],
    refresh,
    async start() {
      stopped = false;
      try { if (repository?.loadSubsPleaseReleases) merge(await repository.loadSubsPleaseReleases(MAX_RELEASES)); }
      catch (error) { logger.warn('[subsplease] Could not load cached releases:', error.message); }
      if (stopped) return;
      const tick = () => refresh().catch((error) => logger.warn('[subsplease] Keeping previously verified links:', error.message));
      await tick();
      if (!stopped && !timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); }
    },
    async stop() { stopped = true; clearInterval(timer); timer = null; await pending?.catch(() => {}); }
  };
}
