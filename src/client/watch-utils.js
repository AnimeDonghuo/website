function episodeRange(value) {
  const start = Number(value?.start);
  const end = Number(value?.end ?? value?.start);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 999) return null;
  return { start, end };
}

export function formatEpisodeNumber(value) {
  return String(value).padStart(2, '0');
}

export function parseEpisodeRoute(value) {
  const match = String(value || '').match(/^(\d{1,3})(?:-(\d{1,3}))?$/);
  if (!match) return null;
  const range = episodeRange({ start: match[1], end: match[2] || match[1] });
  if (!range) return null;
  return {
    ...range,
    label: range.start === range.end
      ? `Episode ${formatEpisodeNumber(range.start)}`
      : `Episodes ${formatEpisodeNumber(range.start)}–${formatEpisodeNumber(range.end)}`
  };
}

export function episodePagePath(item, group) {
  const range = episodeRange(group);
  if (!range) return `/${item.category}/${item.slug}`;
  const pathRange = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
  return `/${item.category}/${item.slug}/episode/${pathRange}`;
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
  const list = Array.isArray(choices) ? choices : [];
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
  return {
    episodes: list.filter((group) => Number.isInteger(group?.start) && group.start === Number(group?.end)),
    packs: list.filter((group) => Number.isInteger(group?.start) && Number(group?.end) > group.start)
  };
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

export function watchPagePath(item, episode = null) {
  const base = `/${item.category}/${item.slug}/watch`;
  const range = episodeRange(episode);
  if (!range) return base;
  const pathRange = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
  return `${base}/episode/${pathRange}`;
}
