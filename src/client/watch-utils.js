function episodeRange(value) {
  const start = Number(value?.start);
  const end = Number(value?.end ?? value?.start);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) return null;
  return { start, end };
}

/** A usable season number only: nothing, `0`, and text never become Season 0. */
function episodeSeason(value) {
  const season = Number(value?.season);
  return Number.isInteger(season) && season >= 1 && season <= 99 ? season : null;
}

export function formatEpisodeNumber(value) {
  return String(value).padStart(2, '0');
}

/**
 * An episode route plus the season it belongs to. A card that spans seasons has
 * more than one Episode 01, so `?s=2` travels beside the number and keeps the
 * page on the right block.
 */
export function parseEpisodeRoute(value, season = null) {
  const match = String(value || '').match(/^(\d{1,3})(?:-(\d{1,3}))?$/);
  if (!match) return null;
  const range = episodeRange({ start: match[1], end: match[2] || match[1] });
  if (!range) return null;
  return {
    ...range,
    season: episodeSeason({ season }),
    label: range.start === range.end
      ? `Episode ${formatEpisodeNumber(range.start)}`
      : `Episodes ${formatEpisodeNumber(range.start)}–${formatEpisodeNumber(range.end)}`
  };
}

export function episodePagePath(item, group) {
  const range = episodeRange(group);
  if (!range) return `/${item.category}/${item.slug}`;
  const pathRange = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
  const season = episodeSeason(group);
  return `/${item.category}/${item.slug}/episode/${pathRange}${season ? `?s=${season}` : ''}`;
}

/**
 * The episode-index block a route belongs to. When the route names a season the
 * same-numbered block of another season is never an acceptable match; an older
 * card without season data still falls back to the number alone.
 */
export function findEpisodeGroup(groups = [], episode = null) {
  const range = episodeRange(episode);
  if (!range) return null;
  const list = Array.isArray(groups) ? groups : [];
  const season = episodeSeason(episode);
  const matches = list.filter((group) => Number(group?.start) === range.start && Number(group?.end ?? group?.start) === range.end);
  if (!season) return matches[0] || null;
  const seasonMatches = matches.filter((group) => episodeSeason(group) === season);
  if (seasonMatches.length) return seasonMatches[0];
  // A card whose blocks carry no season at all (published before merging existed)
  // is still readable by number alone, so an old link never turns into a 404.
  return matches.find((group) => !episodeSeason(group)) || null;
}

/**
 * A Watch link can only be attached to a delivery episode when both have an
 * explicit episode range. A release-wide player is deliberately not treated
 * as a fallback for every episode.
 */
export function rangesOverlap(first, second) {
  const left = episodeRange(first);
  const right = episodeRange(second);
  return Boolean(left && right && left.start <= right.end && left.end >= right.start);
}

export function streamEntriesForEpisode(entries = [], episode) {
  const requested = episodeRange(episode);
  if (!requested) return [];
  // A player must cover the whole delivery range shown beside it. This avoids
  // offering an Episode 1 player on a single file that actually represents
  // Episodes 1–20 just because their ranges touch at the first episode.
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const streamEpisode = episodeRange(entry?.episode);
    return Boolean(streamEpisode && streamEpisode.start <= requested.start && streamEpisode.end >= requested.end);
  });
}

/** Players that touch this episode at all, including a partial batch link. */
export function overlappingStreamEntries(entries = [], episode) {
  const requested = episodeRange(episode);
  if (!requested) return [];
  return (Array.isArray(entries) ? entries : []).filter((entry) => rangesOverlap(entry?.episode, requested));
}

/**
 * An episode page offers every player the publisher attached to that episode.
 * A covering link is preferred; an overlapping one is still surfaced so a Watch
 * button never silently disappears from an episode a publisher linked.
 */
export function episodeStreamEntries(entries = [], episode) {
  const covering = streamEntriesForEpisode(entries, episode);
  if (covering.length) return covering;
  return overlappingStreamEntries(entries, episode);
}

/**
 * Files listed on an episode page. A combined upload (Episodes 1–5) is shown
 * only on its own pack page, so a single episode never appears to contain the
 * whole batch. When nothing matches exactly — an older card, or a shared link
 * opened directly — overlapping files are still offered instead of a dead page.
 */
export function fileChoicesForEpisode(choices = [], episode, { includeOverlapping = true } = {}) {
  const requested = episodeRange(episode);
  if (!requested) return [];
  let list = Array.isArray(choices) ? choices : [];
  // A merged card holds the same episode number in two seasons. When the route
  // names a season and the files really are season-tagged, only that block is
  // offered; otherwise the list is left alone so older releases keep every file.
  const season = episodeSeason(episode);
  if (season && list.some((choice) => episodeSeason(choice))) {
    list = list.filter((choice) => episodeSeason(choice) === season);
  }
  const exact = list.filter((choice) => {
    const range = episodeRange(choice?.episode);
    return Boolean(range && range.start === requested.start && range.end === requested.end);
  });
  if (exact.length || !includeOverlapping) return exact;
  return list.filter((choice) => rangesOverlap(choice?.episode, requested));
}

/** Split one episode index into single episodes and combined pack uploads. */
export function splitEpisodeGroups(groups = []) {
  const list = Array.isArray(groups) ? groups : [];
  const isSingle = (group) => Number.isInteger(group?.start) && group.start === Number(group?.end);
  const episodes = list.filter(isSingle);
  const packs = list.filter((group) => Number.isInteger(group?.start) && Number(group?.end) > group.start);
  // Season blocks are only handed to the page when a card spans more than one
  // season, so every other release renders its guide exactly as it did before.
  const seasons = [];
  for (const group of list) {
    const season = episodeSeason(group);
    if (!season) continue;
    let block = seasons.find((entry) => entry.season === season);
    if (!block) {
      block = { season, seasonLabel: group.seasonLabel || `Season ${season}`, episodes: [], packs: [] };
      seasons.push(block);
    }
    (isSingle(group) ? block.episodes : block.packs).push(group);
  }
  return { episodes, packs, seasons: seasons.length > 1 ? seasons : [] };
}

export function isReleaseLevelStream(entry) {
  return !episodeRange(entry?.episode);
}

export function releaseLevelStreamEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).filter(isReleaseLevelStream);
}

export function hasReleaseLevelWatch(stream) {
  return releaseLevelStreamEntries(stream?.entries).length > 0;
}

/**
 * Providers are what a viewer recognises. "Player 1" tells nobody which link is
 * which, so a player is named after the service that hosts it, falling back to
 * the publisher's own label and finally to the episode it belongs to.
 */
export function playerDisplayName(entry) {
  const server = String(entry?.server || '').trim();
  if (server) return server;
  const label = String(entry?.label || '').trim();
  if (label && !/^player\s*\d+$/i.test(label)) return label;
  return String(entry?.episode?.label || 'Main player').trim();
}

/** The same name without the trailing word, for a compact button label. */
export function playerShortName(entry) {
  return playerDisplayName(entry).replace(/\s+server$/i, '');
}

function seasonFromLabel(label) {
  const text = String(label || '');
  const spelled = text.match(/\bseason\s*0*(\d{1,2})\b/i);
  if (spelled) return Number(spelled[1]);
  const compact = text.match(/\bs\s*0*(\d{1,2})(?!\d)(?![a-df-z])/i);
  return compact ? Number(compact[1]) : null;
}

/**
 * The season a viewer should be told about, if any. The season of the episode
 * group wins, then a season spelled out in the release title. A movie with
 * neither shows no season at all rather than an invented "Season 1".
 */
export function episodeSeasonNumber(item, episode) {
  const range = episodeRange(episode);
  if (!range) return null;
  // The route itself knows its season after /merge, which is the only answer
  // that cannot be confused with the same number in another block.
  const requestedSeason = episodeSeason(episode);
  if (requestedSeason) return requestedSeason;
  for (const group of Array.isArray(item?.episodeGroups) ? item.episodeGroups : []) {
    const start = Number(group?.start);
    const end = Number(group?.end) || start;
    if (!Number.isInteger(start) || range.start < start || range.start > end) continue;
    const season = episodeSeason(group) || seasonFromLabel(group?.label);
    if (season) return season;
  }
  return seasonFromLabel(item?.title);
}

/**
 * What a Watch page announces: the episode's own name first, then season plus
 * episode number only when the release really is seasonal. A movie instead
 * lists the languages, which is the choice a viewer actually makes there.
 */
export function watchHeading(item, { episode = null, fileLabel = null, playerLabel = null } = {}) {
  const range = episodeRange(episode);
  const season = episodeSeasonNumber(item, episode);
  const supplied = String(episode?.label || '').trim();
  const episodeLabel = range
    ? (supplied && !/^player\s*\d+$/i.test(supplied)
      ? supplied
      : (range.start === range.end
        ? `Episode ${formatEpisodeNumber(range.start)}`
        : `Episodes ${formatEpisodeNumber(range.start)}–${formatEpisodeNumber(range.end)}`))
    : null;
  const languages = (Array.isArray(item?.languages) ? item.languages : []).filter(Boolean);
  const subtitles = (Array.isArray(item?.subtitleLanguages) ? item.subtitleLanguages : []).filter(Boolean);
  const cleanedLabel = String(fileLabel || '').trim();
  // A label that is nothing but the episode number repeats the line under the
  // heading, so the release name keeps the heading in that case.
  const bareNumber = /^(?:ep|eps?|episode)\.?\s*\d{1,3}(?:\s*(?:-|–|to)\s*\d{1,3})?$/i;
  const title = cleanedLabel && !bareNumber.test(cleanedLabel)
    ? cleanedLabel
    : (playerLabel || item?.title || 'Watch');
  const meta = range
    ? [season ? `Season ${season}` : null, episodeLabel].filter(Boolean)
    : [languages.length ? languages.join(' · ') : null, subtitles.length ? `Subtitles: ${subtitles.join(' · ')}` : null].filter(Boolean);
  return {
    title,
    seasonLabel: season ? `Season ${season}` : null,
    episodeLabel,
    meta,
    isEpisode: Boolean(range),
    languages,
    subtitles
  };
}

export function watchPagePath(item, episode = null) {
  const base = `/${item.category}/${item.slug}/watch`;
  const range = episodeRange(episode);
  if (!range) return base;
  const pathRange = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
  const season = episodeSeason(episode);
  return `${base}/episode/${pathRange}${season ? `?s=${season}` : ''}`;
}
