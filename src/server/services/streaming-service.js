import { cleanText } from '../lib/strings.js';

// This feature deliberately imports only a small publisher-supplied manifest.
// It never downloads, buffers, transcodes, or relays video through Koyeb.
// SeekStreaming exports iframe URLs from embedseek.com. The other defaults are
// hosts that publish a real embeddable player path, so a pasted page link can be
// turned into it automatically. Anything else a publisher trusts is added through
// STREAMING_ALLOWED_HOSTS without changing source code.
export const DEFAULT_STREAMING_HOSTS = [
  'seekstreaming.com',
  'embedseek.com',
  'dailymotion.com',
  'dai.ly',
  'rumble.com',
  'vimeo.com',
  'ok.ru',
  // File hosts whose own embed code is the player page; framing that path is what
  // they publish, so their links work without any rewriting beyond the allow-list.
  'dood.pm',
  'doo.sh',
  'streamwish.to',
  'mixdrop.to',
  'streamtape.com'
];

// One-click download hosts are a different product: the page a visitor lands on is
// a wait-a-timer form, not a player, and they send headers that refuse framing.
// Accepting one as a Watch player would ship a blank frame, so it is named instead.
export const ONE_CLICK_DOWNLOAD_HOSTS = [
  'mega.nz',
  'gofile.io',
  'gofile.me',
  'abyss.to',
  'krakenfiles.com',
  'pixeldrain.com',
  'd.tube',
  'dtube.nl'
];
export const MAX_STREAM_MANIFEST_ROWS = 1_000;
export const MAX_STREAM_ENTRIES_PER_POST = 500;

const POST_ID_PATTERN = /^SB-[A-F0-9]{10}$/;

function compactColumnName(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function valuesByColumn(row) {
  const values = new Map();
  for (const [key, value] of Object.entries(asObject(row) || {})) {
    const normalized = compactColumnName(key);
    if (normalized && !values.has(normalized)) values.set(normalized, value);
  }
  return values;
}

function firstValue(columns, names) {
  for (const name of names) {
    const value = columns.get(compactColumnName(name));
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function safeHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Normalize optional STREAMING_ALLOWED_HOSTS values while retaining SeekStreaming. */
export function normalizeStreamingHosts(value = []) {
  const supplied = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set([...DEFAULT_STREAMING_HOSTS, ...supplied]
    .map(safeHost)
    .filter(Boolean))];
}

/** The one-click host inside a pasted link, when the link points at one. */
export function oneClickDownloadHost(value) {
  const raw = String(value || '');
  let host = '';
  try {
    host = new URL(extractStreamingUrl(raw) || raw).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
  return ONE_CLICK_DOWNLOAD_HOSTS.find((candidate) => host === candidate || host.endsWith(`.${candidate}`)) || null;
}

function allowedHost(hostname, hosts) {
  const host = String(hostname || '').toLowerCase();
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

/**
 * Pull one usable URL out of whatever the publisher pasted: a naked link, a
 * Markdown link such as `[https://rumble.com/v1.html](https://rumble.com/v1.html)`,
 * a copied `<iframe>` snippet, or a link sitting inside a sentence. Telegram
 * frequently wraps copied links this way, and a rejected paste is what made
 * "the Rumble link cannot be added" look like a broken feature.
 */
export function extractStreamingUrl(value) {
  const raw = String(value || '').trim()
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
  if (!raw || raw.length > 8_000) return '';
  // A Markdown link keeps its target, which is the only half we can embed.
  const markdown = raw.match(/\[[^\]]*\]\(\s*(?:<|")?\s*(https?:\/\/[^)\s>"]+)/i);
  const candidate = markdown?.[1] || raw;
  // SeekStreaming's dashboard can export either a naked player URL or a full
  // iframe snippet. Accept both forms, but persist only the URL—not arbitrary
  // markup—so it can never inject HTML into a public catalog page.
  const iframeMatch = candidate.match(/<iframe\b[^>]*\bsrc\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
  const iframeSource = iframeMatch?.[2] || iframeMatch?.[3];
  if (iframeSource) return String(iframeSource).trim();
  // Otherwise take the first HTTP(S) token, ignoring quotes and stray prose.
  const bare = candidate.match(/https?:\/\/[^\s"'<>\])]+/i);
  return String(bare?.[0] || candidate).trim().replace(/[.,;:]+$/, '');
}

/**
 * A provider's watch page refuses to be framed, so an embed needs the player
 * path instead. Dailymotion answers `www.dailymotion.com/video/…` with
 * "refused to connect", and Rumble serves its page with framing headers that
 * block playback; both publish a dedicated embed route for the same video.
 * The original page stays as the external link, so a publisher can always open
 * the video on the provider even if a specific embed is unavailable.
 */
/**
 * Dailymotion lays its control bar out inside the frame it is handed, and on a phone that
 * row has more buttons than the width allows: it drops volume, subtitles, and full screen
 * rather than shrinking them. What it keeps are Dailymotion's own buttons — share, report,
 * up-next, its logo, the uploader's title on the start screen — and every one of them is a
 * query parameter away, so the embed is asked for plain playback chrome instead. Documented
 * at developer.dailymotion.com/player#player-parameters; a value the publisher already typed
 * wins, and the site's own highlight colour is offered so the scrubber matches the page.
 *
 * This is applied to the payload a visitor receives, never to what a publisher pasted: the
 * stored entry stays their exact link (so `/players` still reads back what was typed), and a
 * player attached months ago gets the same frame as one attached today, without a re-save.
 */
const DAILYMOTION_PLAYBACK_PARAMS = {
  'sharing-enable': '0',
  'reporter-enable': '0',
  'queue-enable': '0',
  'queue-autoplay-next': '0',
  'ui-logo': '0',
  'ui-start-screen-info': '0',
  'ui-highlight': 'c5f86a'
};

export function dailymotionPlayerUrl(value) {
  if (!value || typeof value !== 'string') return value || null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  const framed = host === 'dailymotion.com' || host.endsWith('.dailymotion.com') || host === 'dai.ly';
  if (!framed || !/\/embed\/video\/[A-Za-z0-9]+/i.test(url.pathname)) return value;
  for (const [name, setting] of Object.entries(DAILYMOTION_PLAYBACK_PARAMS)) {
    if (!url.searchParams.has(name)) url.searchParams.set(name, setting);
  }
  return url.toString();
}

export function embeddablePlayerUrl(value) {
  const raw = extractStreamingUrl(value);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();

  if (host === 'dai.ly') {
    const id = url.pathname.match(/^\/([A-Za-z0-9]+)/)?.[1];
    if (!id) return { embedUrl: null, watchUrl: url.toString() };
    return {
      embedUrl: `https://www.dailymotion.com/embed/video/${id}`,
      watchUrl: `https://www.dailymotion.com/video/${id}`
    };
  }

  if (host === 'dailymotion.com' || host.endsWith('.dailymotion.com')) {
    const embedMatch = url.pathname.match(/\/embed\/video\/([A-Za-z0-9]+)/i);
    if (embedMatch) return { embedUrl: url.toString(), watchUrl: `https://www.dailymotion.com/video/${embedMatch[1]}` };
    const videoMatch = url.pathname.match(/\/video\/([A-Za-z0-9]+)/i) || url.pathname.match(/^\/([A-Za-z0-9]{6,})\/?$/i);
    if (!videoMatch) return { embedUrl: null, watchUrl: url.toString() };
    const suffix = url.search || '';
    return {
      embedUrl: `https://www.dailymotion.com/embed/video/${videoMatch[1]}${suffix}`,
      watchUrl: `https://www.dailymotion.com/video/${videoMatch[1]}`
    };
  }

  if (host === 'rumble.com' || host.endsWith('.rumble.com')) {
    // Rumble's Share dialog hands out https://rumble.com/embedJS/u3385.v7exnu4/?url=…
    // and the u-code (the publisher number) exists only inside that URL: it cannot be
    // rebuilt from a page link. A pasted embedJS code is therefore stored exactly as
    // given, because it is the form that plays when the short /embed/<id>/ path is
    // refused for a channel whose embed settings differ.
    const embedJsMatch = url.pathname.match(/\/embedJS\/((?:u\d+\.)?v[A-Za-z0-9]+(?:\.\d+)?)\/?$/i);
    if (embedJsMatch) {
      const videoId = embedJsMatch[1].includes('.') ? embedJsMatch[1].split('.').pop() : embedJsMatch[1];
      return { embedUrl: url.toString(), watchUrl: `https://rumble.com/${videoId}.html` };
    }
    const embedMatch = url.pathname.match(/\/embed\/(?:VS)?([A-Za-z0-9.]+)/i);
    if (embedMatch) return { embedUrl: url.toString(), watchUrl: `https://rumble.com/${embedMatch[1]}.html` };
    // Page URLs look like /v7exnu4-title-slug.html; the video id is the v-token.
    const pageMatch = url.pathname.match(/\/(v[A-Za-z0-9]{4,})(?:-[^/]*)?\.?[a-z]*/i);
    if (!pageMatch) return { embedUrl: null, watchUrl: url.toString() };
    return {
      embedUrl: `https://rumble.com/embed/${pageMatch[1]}/`,
      watchUrl: url.toString()
    };
  }

  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    // player.vimeo.com/video/ID is the frameable half, so a page link becomes it and a
    // pasted player URL is kept whole — including the `?h=` token a privacy-protected or
    // embed-only video needs, which is the difference between a player and a frame that
    // reports the video as unavailable.
    const idMatch = url.pathname.match(/^\/(\d{6,})(?:\/|$)/)
      || url.pathname.match(/\/(?:channels|groups)\/[^/]+\/(?:videos?\/)?(\d{6,})/i)
      || url.pathname.match(/\/album\/[^/]+\/video\/(\d{6,})/i)
      || url.pathname.match(/\/video\/(\d{6,})(?:\/|$)/i);
    const id = idMatch?.[1];
    if (!id) return { embedUrl: null, watchUrl: url.toString() };
    const token = url.search.match(/[?&](h=[A-Za-z0-9-]+)/i)?.[1];
    const fromPlayerPage = host === 'player.vimeo.com';
    return {
      embedUrl: fromPlayerPage ? url.toString() : `https://player.vimeo.com/video/${id}${token ? `?${token}` : ''}`,
      watchUrl: fromPlayerPage ? `https://vimeo.com/${id}` : url.toString()
    };
  }

  if (host === 'ok.ru' || host.endsWith('.ok.ru')) {
    // Odnoklassniki serves the same video framed at /videoembed/<id> while the /video/
    // page refuses it. A live broadcast has no embed path at all, so it stays an
    // external link instead of a frame that would never play.
    const embedMatch = url.pathname.match(/\/videoembed\/(\d{4,})/i);
    if (embedMatch) return { embedUrl: url.toString(), watchUrl: `https://ok.ru/video/${embedMatch[1]}` };
    if (/\/live\//i.test(url.pathname)) return { embedUrl: null, watchUrl: url.toString() };
    const pageMatch = url.pathname.match(/\/video\/(\d{4,})/i) || url.search.match(/[?&]v=(\d{4,})/i);
    if (!pageMatch) return { embedUrl: null, watchUrl: url.toString() };
    return {
      embedUrl: `https://ok.ru/videoembed/${pageMatch[1]}`,
      watchUrl: url.toString()
    };
  }

  // Every other approved host is already an embed path the provider published
  // (dood's and StreamWish's own /f/<id>, a copied <iframe src>, a SeekStreaming
  // export), so the URL is stored as given and framed as-is.
  return { embedUrl: url.toString(), watchUrl: url.toString() };
}

/**
 * Publishers recognise the service people quote, not a raw hostname. Numbered
 * "Player 1 / Player 2" labels told nobody which link was which, so every
 * entry carries a stable server name derived from its own URL.
 */
export function streamServerName(value) {
  let host = '';
  try {
    host = new URL(String(value || '')).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    host = String(value || '').toLowerCase();
  }
  if (host.includes('dailymotion') || host === 'dai.ly') return 'Dailymotion server';
  if (host.includes('rumble')) return 'Rumble server';
  if (host.includes('embedseek') || host.includes('seekstreaming')) return 'Seek server';
  if (host === 'ok.ru' || host.endsWith('.ok.ru')) return 'OK.ru server';
  if (host.includes('dood')) return 'Dood server';
  if (host.includes('streamwish')) return 'StreamWish server';
  if (host.includes('streamtape')) return 'StreamTape server';
  if (host.includes('mixdrop')) return 'Mixdrop server';
  if (host.includes('vimeo')) return 'Vimeo server';
  const base = host.split('.')[0];
  if (!base || base === 'provider') return 'Direct player';
  return `${base.charAt(0).toUpperCase()}${base.slice(1)} server`;
}

export function safeStreamingUrl(value, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  return safeStreamingLink(value, { allowedHosts })?.embedUrl || null;
}

/**
 * Validate a publisher link and return both halves: the frameable `embedUrl`
 * and the provider `watchUrl`. Returns null when the host is not approved, so
 * the allow-list check happens before any provider-specific rewriting.
 */
export function safeStreamingLink(value, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  const raw = extractStreamingUrl(value);
  if (!raw || raw.length > 2_000) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hosts = normalizeStreamingHosts(allowedHosts);
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHost(url.hostname, hosts)) return null;
  const link = embeddablePlayerUrl(url.toString());
  if (!link?.embedUrl && !link?.watchUrl) return null;
  return {
    embedUrl: link.embedUrl ? truncate(link.embedUrl) : null,
    watchUrl: link.watchUrl ? truncate(link.watchUrl) : null
  };
}

function truncate(value) {
  const text = String(value || '');
  return text.length <= 2_000 ? text : null;
}

export function streamingFrameSources(streaming = {}) {
  return normalizeStreamingHosts(streaming.allowedHosts).flatMap((host) => [`https://${host}`, `https://*.${host}`]);
}

function positiveEpisode(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 999 ? parsed : null;
}

function episodeLabel(start, end) {
  const first = String(start).padStart(2, '0');
  const last = String(end).padStart(2, '0');
  return start === end ? `Episode ${first}` : `Episodes ${first}–${last}`;
}

function parseEpisode(columns) {
  const explicitStart = positiveEpisode(firstValue(columns, ['episodeStart', 'start']));
  const explicitEnd = positiveEpisode(firstValue(columns, ['episodeEnd', 'end']));
  const raw = cleanText(firstValue(columns, ['episode', 'ep', 'episodeNumber', 'episodeRange']), 80);
  let start = explicitStart;
  let end = explicitEnd;
  if (!start && raw) {
    // A dedicated Episode column may hold a bare number or range ("4", "2-7"),
    // or the compact marker a provider export uses ("S01E03", "1x03"). Each form
    // is anchored, so the season of "S01E03" can never be read as episode 1 -
    // that collapse is what merged a season-long export onto a single player. A
    // loose match is only allowed when an explicit episode marker is present.
    const seasonEpisode = raw.match(/^s\s*0*(\d{1,2})\s*[ex]\s*0*(\d{1,3})(?:\s*(?:-|–|to)\s*(?:e\s*x?\s*)?0*(\d{1,3}))?$/i)
      || raw.match(/^0*(\d{1,2})\s*x\s*0*(\d{1,3})(?:\s*(?:-|–|to)\s*\d*x\s*0*(\d{1,3}))?$/i);
    if (seasonEpisode) {
      start = positiveEpisode(seasonEpisode[2]);
      end = positiveEpisode(seasonEpisode[3]) || start;
    } else {
      const plain = raw.match(/^(?:episode|ep\.?|e)?\s*0*(\d{1,3})(?:\s*(?:-|–|to)\s*0*(\d{1,3}))?$/i)
        || raw.match(/\b(?:episode|ep\.?)\s*0*(\d{1,3})(?:\s*(?:-|–|to)\s*0*(\d{1,3}))?/i)
        || raw.match(/\bs\s*0*\d{1,2}\s*[ex]\s*0*(\d{1,3})(?:\s*(?:-|–|to)\s*(?:e\s*x?\s*)?0*(\d{1,3}))?/i);
      if (plain) {
        start = positiveEpisode(plain[1]);
        end = positiveEpisode(plain[2]) || start;
      }
    }
  }
  if (!start) {
    // SeekStreaming exports a Title but no dedicated Episode field. Infer only
    // explicit markers (Episode 01, EP 01, S01E01), never a sequel/year number
    // from an ordinary movie title such as “Cocktail 2”.
    const title = cleanText(firstValue(columns, ['episodeTitle', 'videoTitle', 'video_title', 'title', 'name']), 180);
    const match = title.match(/\b(?:episode|ep)\s*0*(\d{1,3})(?:\s*(?:-|–|to)\s*0*(\d{1,3}))?\b|\bs\d{1,2}e0*(\d{1,3})(?:\s*(?:-|–|to|[- ]?e)\s*0*(\d{1,3}))?\b/i);
    if (match) {
      start = positiveEpisode(match[1] || match[3]);
      end = positiveEpisode(match[2] || match[4]) || start;
    }
  }
  if (!start) return null;
  if (!end) end = start;
  if (end < start) return null;
  const label = cleanText(firstValue(columns, ['episodeLabel', 'episodeTitle']), 60) || episodeLabel(start, end);
  return { start, end, label };
}

/**
 * `provider` grouping is what a corrected CSV/JSON export needs: re-importing
 * the same provider row for the same episode overwrites that player, so a fixed
 * link replaces the broken one instead of accumulating duplicates.
 * `exact` grouping is what a manual /cmd link needs: two different videos added
 * to the same episode are two players, and both must survive.
 */
export const STREAM_IDENTITY_MODES = ['provider', 'exact'];

function streamEntryIdentity(entry, granularity = 'provider') {
  let host = 'provider';
  try {
    host = new URL(entry?.embedUrl || entry?.watchUrl || '').hostname.toLowerCase() || host;
  } catch {
    // A stored entry is normalized before this point; retain a stable fallback.
  }
  const labelKey = cleanText(entry?.videoId || entry?.label, 100)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'main';
  const videoKey = cleanText(entry?.videoId, 100).toLowerCase() || labelKey;
  // A provider-mode row without an explicit video id is identified by its slot
  // only, exactly as before, so a corrected export still overwrites its player.
  const slotKey = entry?.videoId ? videoKey : (granularity === 'exact' ? (urlIdentity(entry) || labelKey) : 'main');
  if (entry?.episode?.start) return `episode:${entry.episode.start}-${entry.episode.end || entry.episode.start}:${host}:${slotKey}`;
  return `default:${host}:${slotKey}`;
}

function urlIdentity(entry) {
  // The path (plus a short query) is the only stable per-video marker a
  // publisher-supplied URL always has: /embed/video/x8ab, /embed/v7exnu4/,
  // or SeekStreaming's /#episode-1 fragment.
  const raw = entry?.embedUrl || entry?.watchUrl || '';
  try {
    const url = new URL(raw);
    const fragment = url.hash ? `#${url.hash.slice(1)}` : '';
    return `${url.pathname}${url.search}${fragment}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  } catch {
    return '';
  }
}

function compareStreamEntries(first, second) {
  const firstEpisode = first?.episode?.start || Number.MAX_SAFE_INTEGER;
  const secondEpisode = second?.episode?.start || Number.MAX_SAFE_INTEGER;
  if (firstEpisode !== secondEpisode) return firstEpisode - secondEpisode;
  // Same episode: order by provider name so the list reads alphabetically and
  // never reshuffles between reads. /players numbering and button indices must
  // stay identical across reads, because deletion is addressed by that number.
  const serverOrder = String(first?.server || first?.provider || '').localeCompare(String(second?.server || second?.provider || ''));
  if (serverOrder) return serverOrder;
  return streamEntryIdentity(first, 'exact').localeCompare(streamEntryIdentity(second, 'exact')) ||
    String(first?.label || '').localeCompare(String(second?.label || ''));
}

function manifestCategory(value) {
  const raw = cleanText(value, 40).toLowerCase().replace(/[\s_]+/g, '-');
  if (raw === 'series' || raw === 'webseries') return 'web-series';
  if (raw === 'k-drama' || raw === 'korean-drama') return 'kdrama';
  return ['anime', 'cartoon', 'donghua', 'kdrama', 'movie', 'web-series'].includes(raw) ? raw : null;
}

function normalizedStreamFields(row, { allowedHosts = DEFAULT_STREAMING_HOSTS, requirePostId = false, allowMissingTarget = false } = {}) {
  const object = asObject(row);
  if (!object) return { error: 'must be an object with column names' };
  const columns = valuesByColumn(object);
  const suppliedPostId = cleanText(firstValue(columns, ['postId', 'post_id', 'adminId', 'admin_id', 'post']), 40).toUpperCase();
  const postId = POST_ID_PATTERN.test(suppliedPostId) ? suppliedPostId : null;
  const sourceTitle = cleanText(firstValue(columns, ['releaseTitle', 'release_title', 'contentTitle', 'content_title', 'soraboxTitle', 'sorabox_title', 'postTitle', 'post_title', 'catalogTitle', 'catalog_title', 'title']), 180);
  if (suppliedPostId && !postId) {
    return { error: 'contains an invalid SoraBox Post ID; use a value such as SB-0123ABCDEF' };
  }
  if (requirePostId && !postId) {
    return { error: 'requires a valid SoraBox Post ID such as SB-0123ABCDEF' };
  }
  if (!postId && !sourceTitle && !allowMissingTarget) {
    return { error: 'requires a postId/adminId, or a Title that exactly matches one existing catalog release' };
  }
  // SeekStreaming's export uses “Embed Link” and “Embed Code”. A naked URL,
  // an iframe snippet, or a CSV/JSON value under either name is accepted.
  const genericUrl = firstValue(columns, ['url', 'videoUrl', 'video_url']);
  const embedUrl = safeStreamingUrl(
    firstValue(columns, ['embedUrl', 'embed_url', 'embedLink', 'embed_link', 'embedCode', 'embed_code', 'embed', 'playerUrl', 'player_url', 'player', 'iframeUrl', 'iframe_url']) || genericUrl,
    { allowedHosts }
  );
  const watchUrl = safeStreamingUrl(
    firstValue(columns, ['watchUrl', 'watch_url', 'watch', 'link', 'externalUrl', 'external_url']) || genericUrl,
    { allowedHosts }
  );
  if (!embedUrl && !watchUrl) {
    return { error: 'requires an HTTPS player/embed or watch URL from an allowed streaming host' };
  }
  const episode = parseEpisode(columns);
  const server = streamServerName(embedUrl || watchUrl);
  const suppliedLabel = cleanText(firstValue(columns, ['label', 'videoTitle', 'video_title', 'name', 'title']), 100);
  const label = suppliedLabel && !/^player\s*\d+$/i.test(suppliedLabel)
    ? suppliedLabel
    : `${server.replace(/\s+server$/i, '')}${episode?.label ? ` · ${episode.label}` : ''}`;
  return {
    postId,
    sourceTitle: sourceTitle || null,
    category: manifestCategory(firstValue(columns, ['category', 'collection'])),
    entry: {
      label,
      episode,
      videoId: cleanText(firstValue(columns, ['videoId', 'video_id', 'id']), 100) || null,
      provider: cleanText(firstValue(columns, ['provider', 'host']), 60) || server,
      server,
      embedUrl,
      watchUrl
    }
  };
}

function csvRows(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted value.');
  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => cleanText(value, 80));
  if (!headers.some((value) => compactColumnName(value))) {
    throw new Error('The CSV header is empty.');
  }
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function jsonRows(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The JSON could not be read. Send an array of stream-link entries.');
  }
  if (Array.isArray(parsed)) return parsed;
  if (asObject(parsed)) {
    for (const key of ['entries', 'items', 'rows', 'videos', 'data']) {
      if (Array.isArray(parsed[key])) return parsed[key];
      if (asObject(parsed[key])) return [parsed[key]];
    }
    return [parsed];
  }
  throw new Error('The JSON must be an entry object or an array of entries.');
}

export function inferStreamManifestFormat(document = {}) {
  const filename = String(document?.file_name || document?.fileName || '').toLowerCase();
  const mimeType = String(document?.mime_type || document?.mimeType || '').toLowerCase();
  if (filename.endsWith('.csv') || /(?:text\/csv|application\/csv)/.test(mimeType)) return 'csv';
  if (filename.endsWith('.json') || /(?:application\/json|text\/json)/.test(mimeType)) return 'json';
  return null;
}

/** Parse a compact JSON/CSV publisher manifest into validated stream links. */
export function parseStreamingManifest(input, { format, allowedHosts = DEFAULT_STREAMING_HOSTS, requirePostId = false, allowMissingTarget = false } = {}) {
  const selectedFormat = format === 'csv' || format === 'json' ? format : null;
  if (!selectedFormat) throw new Error('Send a .json or .csv streaming manifest.');
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const rows = selectedFormat === 'csv' ? csvRows(text) : jsonRows(text);
  const entries = [];
  const rejected = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (index >= MAX_STREAM_MANIFEST_ROWS) {
      rejected.push({ row: index + 1, error: `exceeds the ${MAX_STREAM_MANIFEST_ROWS}-row safety limit` });
      continue;
    }
    const parsed = normalizedStreamFields(rows[index], { allowedHosts, requirePostId, allowMissingTarget });
    if (parsed.error) rejected.push({ row: index + 1, error: parsed.error });
    else entries.push({ row: index + 1, ...parsed });
  }
  return { format: selectedFormat, totalRows: rows.length, entries, rejected };
}

function normalizedStoredEntry(entry, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  const object = asObject(entry);
  if (!object) return null;
  const columns = valuesByColumn(object);
  const genericUrl = firstValue(columns, ['url', 'videoUrl', 'video_url']);
  const link = (value) => (value ? safeStreamingLink(value, { allowedHosts }) : null);
  const embedLink = link(
    firstValue(columns, ['embedUrl', 'embed_url', 'embed', 'playerUrl', 'player_url', 'player', 'iframeUrl', 'iframe_url']) || genericUrl
  );
  const watchLink = link(
    firstValue(columns, ['watchUrl', 'watch_url', 'watch', 'link', 'externalUrl', 'external_url']) || genericUrl
  );
  const embedUrl = embedLink?.embedUrl || null;
  // The external link is the provider's own page, where its whole control set — subtitles,
  // audio track, full screen — is laid out for a browser tab instead of a small frame. The
  // embed path only stands in when an entry never named a page, and a source with no
  // embeddable player at all (an OK.ru live broadcast) keeps its link rather than silently
  // disappearing from the Watch page.
  const watchUrl = watchLink?.watchUrl || watchLink?.embedUrl || embedLink?.watchUrl || null;
  if (!embedUrl && !watchUrl) return null;
  let episode = null;
  if (asObject(object.episode)) {
    const start = positiveEpisode(object.episode.start);
    const end = positiveEpisode(object.episode.end) || start;
    if (start && end >= start) {
      episode = {
        start,
        end,
        label: cleanText(object.episode.label, 60) || episodeLabel(start, end)
      };
    }
  } else {
    episode = parseEpisode(columns);
  }
  const server = streamServerName(embedUrl || watchUrl);
  return {
    label: cleanText(object.label, 100) || episode?.label || 'Main player',
    episode,
    videoId: cleanText(object.videoId, 100) || null,
    provider: cleanText(object.provider, 60) || server,
    // Derived from the URL on every read, so links saved before server naming
    // existed display correctly without touching stored data.
    server,
    embedUrl,
    watchUrl
  };
}

/**
 * Replace an existing player's same episode/default entry and retain the rest.
 * That makes re-importing a corrected CSV/JSON idempotent without deleting
 * other episode links attached to the release.
 */
export function mergeStreamingEntries(existingStream, incomingEntries, { allowedHosts = DEFAULT_STREAMING_HOSTS, granularity = 'provider', updatedAt = new Date().toISOString() } = {}) {
  const mode = STREAM_IDENTITY_MODES.includes(granularity) ? granularity : 'provider';
  const merged = new Map();
  const keys = new Map();
  const put = (entry) => {
    const key = streamEntryIdentity(entry, mode);
    merged.set(key, entry);
    keys.set(key, streamEntryIdentity(entry, 'exact'));
  };
  for (const existing of Array.isArray(existingStream?.entries) ? existingStream.entries : []) {
    const safe = normalizedStoredEntry(existing, { allowedHosts });
    if (safe) put(safe);
  }
  for (const candidate of Array.isArray(incomingEntries) ? incomingEntries : []) {
    const safe = normalizedStoredEntry(candidate?.entry || candidate, { allowedHosts });
    if (safe) put(safe);
  }
  const entries = [...merged.values()].sort(compareStreamEntries).slice(0, MAX_STREAM_ENTRIES_PER_POST);
  if (!entries.length) return null;
  return {
    provider: cleanText(existingStream?.provider, 60) || entries[0].provider || 'SeekStreaming',
    entries,
    updatedAt: new Date(updatedAt).toString() === 'Invalid Date' ? new Date().toISOString() : new Date(updatedAt).toISOString()
  };
}

/** Return only safe, public player fields; database/post IDs never travel here. */
export function publicStreamingData(stream, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  const entries = (Array.isArray(stream?.entries) ? stream.entries : [])
    .map((entry) => normalizedStoredEntry(entry, { allowedHosts }))
    .filter(Boolean)
    .sort(compareStreamEntries)
    .slice(0, MAX_STREAM_ENTRIES_PER_POST)
    .map((entry) => ({
      id: streamEntryIdentity(entry, 'exact'),
      label: entry.label,
      episode: entry.episode,
      provider: entry.provider,
      server: entry.server,
      // Identity above is computed from the stored URL; the frame policy the visitor
      // receives is tidied here, so players attached before this change behave the same.
      embedUrl: dailymotionPlayerUrl(entry.embedUrl || null),
      watchUrl: entry.watchUrl || null
    }));
  return {
    available: entries.length > 0,
    provider: cleanText(stream?.provider, 60) || entries[0]?.provider || null,
    entries,
    updatedAt: stream?.updatedAt && !Number.isNaN(new Date(stream.updatedAt).getTime()) ? new Date(stream.updatedAt).toISOString() : null
  };
}

/**
 * Remove publisher-chosen players: one listed entry, every player of an episode
 * range, or the whole release. Deletion is explicit because a corrected export
 * intentionally leaves other sources for the same episode in place.
 */
export function removeStreamingEntries(stream, { indexes = null, ids = null, episode = null, all = false } = {}, { allowedHosts = DEFAULT_STREAMING_HOSTS } = {}) {
  const entries = (Array.isArray(stream?.entries) ? stream.entries : [])
    .map((entry) => ({ entry: normalizedStoredEntry(entry, { allowedHosts }), raw: entry }))
    .filter((item) => item.entry);
  if (!entries.length) return { stream: null, removed: 0, remaining: 0, unmatched: 0 };

  const wantedIndexes = new Set((Array.isArray(indexes) ? indexes : []).map((value) => Number(value)).filter(Number.isInteger));
  const wantedIds = new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || '')).filter(Boolean));
  const range = episode && Number.isInteger(Number(episode.start))
    ? { start: Number(episode.start), end: Number(episode.end) || Number(episode.start) }
    : null;

  const kept = [];
  let removed = 0;
  entries.forEach((item, index) => {
    const entryRange = item.entry.episode
      ? { start: item.entry.episode.start, end: item.entry.episode.end || item.entry.episode.start }
      : null;
    const matchesRange = Boolean(range && entryRange && entryRange.start <= range.end && entryRange.end >= range.start);
    const hit = all
      || (wantedIndexes.size ? wantedIndexes.has(index + 1) : false)
      || (wantedIds.size ? wantedIds.has(streamEntryIdentity(item.entry, 'exact')) : false)
      || (range && !wantedIndexes.size && !wantedIds.size ? matchesRange : false);
    if (hit) removed += 1;
    else kept.push(item.raw);
  });
  if (!removed) return { stream, removed: 0, remaining: entries.length, unmatched: entries.length };

  const remaining = mergeStreamingEntries(null, kept, { allowedHosts, granularity: 'exact' });
  return {
    stream: remaining,
    removed,
    remaining: remaining?.entries?.length || 0,
    unmatched: 0
  };
}
