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

export function fileChoicesForEpisode(choices = [], episode) {
  return (Array.isArray(choices) ? choices : []).filter((choice) => rangesOverlap(choice?.episode, episode));
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
