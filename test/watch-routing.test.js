import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeStreamEntries, fileChoicesForEpisode, hasReleaseLevelWatch, playerDisplayName, playerShortName, releaseLevelStreamEntries, splitEpisodeGroups, streamEntriesForEpisode, watchHeading, watchPagePath } from '../src/client/watch-utils.js';

function episode(number) {
  return { start: number, end: number, label: `Episode ${String(number).padStart(2, '0')}` };
}

test('an episode player appears only for its matching delivery episode', () => {
  const item = {
    category: 'web-series',
    slug: 'twenty-episode-release',
    stream: {
      entries: [{ id: 'episode-one', label: 'Episode 01', episode: episode(1), embedUrl: 'https://example.invalid/one' }]
    }
  };
  const files = Array.from({ length: 20 }, (_, index) => ({ id: `file-${index + 1}`, label: `Twenty Episode Release EP ${index + 1} English Sub`, episode: episode(index + 1) }));

  assert.equal(hasReleaseLevelWatch(item.stream), false, 'an episode link must not produce a release-level Watch control');
  assert.deepEqual(releaseLevelStreamEntries(item.stream.entries), []);
  assert.deepEqual(streamEntriesForEpisode(item.stream.entries, files[0].episode).map((entry) => entry.id), ['episode-one']);
  assert.deepEqual(streamEntriesForEpisode(item.stream.entries, files[1].episode), []);
  assert.deepEqual(fileChoicesForEpisode(files, episode(1)).map((file) => file.id), ['file-1']);
  assert.equal(watchPagePath(item, files[0].episode), '/web-series/twenty-episode-release/watch/episode/1');
  assert.equal(watchPagePath(item, files[1].episode), '/web-series/twenty-episode-release/watch/episode/2');
});

test('release-level players remain release-level and never silently satisfy an episode route', () => {
  const main = { id: 'main', label: 'Main player', episode: null };
  const episodeOne = { id: 'episode-one', label: 'Episode 01', episode: episode(1) };
  const stream = { entries: [main, episodeOne] };

  assert.equal(hasReleaseLevelWatch(stream), true);
  assert.deepEqual(releaseLevelStreamEntries(stream.entries).map((entry) => entry.id), ['main']);
  assert.deepEqual(streamEntriesForEpisode(stream.entries, episode(1)).map((entry) => entry.id), ['episode-one']);
  assert.deepEqual(streamEntriesForEpisode(stream.entries, episode(2)), []);
});

test('episode-range players can intentionally serve contained delivery episodes without leaking into a wider file range', () => {
  const streamEntries = [{ id: 'batch-one-to-three', episode: { start: 1, end: 3, label: 'Episodes 01–03' } }];
  assert.deepEqual(streamEntriesForEpisode(streamEntries, episode(2)).map((entry) => entry.id), ['batch-one-to-three']);
  assert.deepEqual(streamEntriesForEpisode(streamEntries, episode(4)), []);
  assert.deepEqual(streamEntriesForEpisode([{ id: 'episode-one', episode: episode(1) }], { start: 1, end: 20 }), []);
});

test('a combined pack is never mixed into the file list of a single episode', () => {
  const choices = [
    { id: 'single-1', episode: { start: 1, end: 1 } },
    { id: 'pack-1-5', episode: { start: 1, end: 5 } },
    { id: 'single-2', episode: { start: 2, end: 2 } },
    { id: 'movie', episode: null }
  ];

  assert.deepEqual(fileChoicesForEpisode(choices, { start: 1, end: 1 }).map((file) => file.id), ['single-1']);
  assert.deepEqual(fileChoicesForEpisode(choices, { start: 2, end: 2 }).map((file) => file.id), ['single-2']);
  assert.deepEqual(fileChoicesForEpisode(choices, { start: 1, end: 5 }).map((file) => file.id), ['pack-1-5'], 'the pack keeps its own page');
  // A gap in the numbering must still offer something instead of an empty page.
  assert.deepEqual(fileChoicesForEpisode(choices, { start: 4, end: 4 }).map((file) => file.id), ['pack-1-5']);
  assert.deepEqual(fileChoicesForEpisode(choices, { start: 4, end: 4 }, { includeOverlapping: false }).map((file) => file.id), []);
  assert.deepEqual(fileChoicesForEpisode(choices, null).map((file) => file.id), [], 'a release without episode numbering is not listed by episode');
});

test('covering players win, and an overlapping batch player is only a fallback', () => {
  const entries = [
    { id: 'partial-pack', episode: { start: 1, end: 5, url: 'https://stream.example/pack' } },
    { id: 'exact-episode', episode: { start: 4, end: 4, url: 'https://stream.example/e4' } },
    { id: 'unrelated', episode: { start: 9, end: 9, url: 'https://stream.example/e9' } }
  ];

  // Episode 4 has its own player; the wider pack player also covers it.
  assert.deepEqual(episodeStreamEntries(entries, { start: 4, end: 4 }).map((entry) => entry.id), ['partial-pack', 'exact-episode']);
  assert.deepEqual(streamEntriesForEpisode(entries, { start: 4, end: 4 }).map((entry) => entry.id), ['partial-pack', 'exact-episode']);
  // 4-6 is not covered by any player, but the pack player still touches it.
  assert.deepEqual(streamEntriesForEpisode(entries, { start: 4, end: 6 }), [], 'strict containment offers nothing here');
  // The fallback keeps every player that touches the range, not only the pack.
  assert.deepEqual(episodeStreamEntries(entries, { start: 4, end: 6 }).map((entry) => entry.id), ['partial-pack', 'exact-episode']);
  // An episode that is only partially inside a pack never lists an unrelated player.
  assert.deepEqual(episodeStreamEntries(entries, { start: 7, end: 7 }), []);
});

test('detail pages split single episodes from batch packs', () => {
  const groups = splitEpisodeGroups([
    { start: 1, end: 1, label: 'Episode 01' },
    { start: 1, end: 3, label: 'Episodes 01\\u201303', fileCount: 1 },
    { start: 2, end: 2, label: 'Episode 02' }
  ]);
  assert.deepEqual(groups.episodes.map((group) => group.label), ['Episode 01', 'Episode 02']);
  assert.deepEqual(groups.packs.map((group) => group.label), ['Episodes 01\\u201303']);
  assert.deepEqual(splitEpisodeGroups(undefined), { episodes: [], packs: [] });
});

test('players are named after their provider, never as an anonymous number', () => {
  assert.equal(playerDisplayName({ server: 'Dailymotion server', label: 'Dailymotion · Episode 02' }), 'Dailymotion server');
  assert.equal(playerShortName({ server: 'Rumble server' }), 'Rumble');
  // entries stored before server naming existed still read from their label
  assert.equal(playerDisplayName({ label: 'SeekStreaming HQ' }), 'SeekStreaming HQ');
  // …and a leftover "Player 2" label falls back to the episode it belongs to
  assert.equal(playerDisplayName({ label: 'Player 2', episode: episode(7) }), 'Episode 07');
  assert.equal(playerDisplayName({}), 'Main player');
});

test('a Watch page names the episode and its season, and a movie only its languages', () => {
  const item = {
    category: 'web-series',
    title: 'Fullmetal Alchemist: Brotherhood S02',
    episodeGroups: [{ start: 1, end: 24, label: 'Season 2' }],
    languages: ['Hindi Dubbed', 'English'],
    subtitleLanguages: ['English']
  };
  const single = watchHeading(item, { episode: episode(5), fileLabel: 'Episode 05' });
  assert.deepEqual(
    { title: single.title, meta: single.meta, isEpisode: single.isEpisode },
    { title: 'Fullmetal Alchemist: Brotherhood S02', meta: ['Season 2', 'Episode 05'], isEpisode: true },
    'a label that is only the episode number does not replace the release name'
  );
  const named = watchHeading(item, { episode: episode(9), fileLabel: 'Brotherhood EP 09 Dual Audio' });
  assert.deepEqual({ title: named.title, meta: named.meta }, { title: 'Brotherhood EP 09 Dual Audio', meta: ['Season 2', 'Episode 09'] });
  const pack = watchHeading(item, { episode: { start: 3, end: 6, label: 'Episodes 03–06' } });
  assert.deepEqual(pack.meta, ['Season 2', 'Episodes 03–06']);

  // the season may only be spelled out in the title, and a sequel number is not a season
  assert.equal(watchHeading({ ...item, episodeGroups: [] }, { episode: episode(3) }).seasonLabel, 'Season 2');
  assert.equal(watchHeading({ ...item, title: 'Rocky 2', episodeGroups: [] }, { episode: episode(3) }).seasonLabel, null);
  // a grouped label without a season still shows no invented season
  assert.deepEqual(watchHeading({ ...item, title: 'Show', episodeGroups: [{ start: 1, end: 12, label: 'Episodes 01–12' }] }, { episode: episode(4) }).meta, ['Episode 04']);

  const movie = { category: 'movie', title: 'RRR', episodeGroups: [], languages: ['Hindi Dubbed', 'Tamil'], subtitleLanguages: ['English'] };
  const movieHeading = watchHeading(movie, { fileLabel: null });
  assert.deepEqual(
    { title: movieHeading.title, meta: movieHeading.meta, isEpisode: movieHeading.isEpisode },
    { title: 'RRR', meta: ['Hindi Dubbed · Tamil', 'Subtitles: English'], isEpisode: false },
    'a movie shows its languages and never a season or episode number'
  );
  assert.equal(watchHeading(movie, {}).title, 'RRR');
});
