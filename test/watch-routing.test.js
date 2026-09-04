import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeNameFromLabel, episodePagePath, episodeStreamEntries, fileChoicesForEpisode, findEpisodeGroup, hasReleaseLevelWatch, parseEpisodeRoute, playerDisplayName, playerShortName, releaseLevelStreamEntries, splitEpisodeGroups, streamEntriesForEpisode, watchHeading, watchPagePath } from '../src/client/watch-utils.js';

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
  assert.deepEqual(splitEpisodeGroups(undefined), { episodes: [], packs: [], seasons: [] });
  // Season blocks appear only when a card really spans several seasons, so an
  // ordinary single-season guide is untouched.
  const flat = splitEpisodeGroups([{ start: 1, end: 1, label: 'Episode 01', season: 1 }]);
  assert.deepEqual(flat.seasons, [], 'one season is not a block worth a heading');
  const merged = splitEpisodeGroups([
    { start: 1, end: 1, label: 'Episode 01', season: 1, seasonLabel: 'Season 1' },
    { start: 2, end: 4, label: 'Episodes 02\u201304', season: 1, seasonLabel: 'Season 1' },
    { start: 1, end: 1, label: 'Episode 01', season: 2, seasonLabel: 'Season 2' }
  ]);
  assert.deepEqual(merged.seasons.map((block) => block.seasonLabel), ['Season 1', 'Season 2']);
  assert.deepEqual(merged.seasons[0].episodes.map((g) => g.label), ['Episode 01']);
  assert.deepEqual(merged.seasons[0].packs.map((g) => g.label), ['Episodes 02\u201304'], 'a pack stays out of the single-episode row');
  assert.deepEqual(merged.seasons[1].episodes.map((g) => g.label), ['Episode 01'], 'Season 2 keeps its own Episode 01');

  const item = { category: 'donghua', slug: 'bleach', episodeGroups: [
    { start: 1, end: 1, label: 'Episode 01', season: 1 },
    { start: 1, end: 1, label: 'Episode 01', season: 2 }
  ] };
  assert.equal(episodePagePath(item, { start: 1, end: 1, season: 2 }), '/donghua/bleach/episode/1?s=2');
  assert.equal(episodePagePath(item, { start: 1, end: 1 }), '/donghua/bleach/episode/1', 'an unseasoned card keeps its old link');
  assert.equal(watchPagePath(item, { start: 1, end: 1, season: 2 }), '/donghua/bleach/watch/episode/1?s=2');
  assert.deepEqual(parseEpisodeRoute('1', '2'), { start: 1, end: 1, season: 2, label: 'Episode 01' });
  assert.deepEqual(parseEpisodeRoute('1', null), { start: 1, end: 1, season: null, label: 'Episode 01' });
  assert.deepEqual(parseEpisodeRoute('1', 'abc'), { start: 1, end: 1, season: null, label: 'Episode 01' });
  assert.equal(findEpisodeGroup(item.episodeGroups, { start: 1, end: 1, season: 2 }).season, 2);
  assert.equal(findEpisodeGroup(item.episodeGroups, { start: 1, end: 1 }).season, 1, 'no season on the route reads the first block');
  assert.equal(findEpisodeGroup([{ start: 5, end: 5, label: 'Episode 05' }], { start: 5, end: 5, season: 3 }).start, 5, 'an older unseasoned card still resolves');
  assert.equal(findEpisodeGroup(item.episodeGroups, { start: 9, end: 9, season: 2 }), null);

  // Files of the same number in another season never leak onto this episode page.
  const choices = [
    { id: 's1e1', episode: { start: 1, end: 1 }, season: 1 },
    { id: 's2e1', episode: { start: 1, end: 1 }, season: 2 }
  ];
  assert.deepEqual(fileChoicesForEpisode(choices, { start: 1, end: 1, season: 2 }).map((f) => f.id), ['s2e1']);
  assert.deepEqual(fileChoicesForEpisode(choices, { start: 1, end: 1 }).map((f) => f.id), ['s1e1', 's2e1']);
  assert.deepEqual(
    fileChoicesForEpisode([{ id: 'plain', episode: { start: 1, end: 1 } }], { start: 1, end: 1, season: 4 }).map((f) => f.id),
    ['plain'],
    'a card without season data is never emptied by a season route'
  );
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
    { title: 'Fullmetal Alchemist: Brotherhood S02 · Episode 05', meta: ['Season 2'], isEpisode: true },
    'the heading is the release name once, then the episode number'
  );
  // A caption written for Telegram is never pasted into the heading whole: its
  // repeated show name, emoji, and "Quality: ✅" are decoration, not a title.
  const messy = watchHeading(item, { episode: episode(176), fileLabel: 'Fullmetal Alchemist: Brotherhood S02 Ep 176 🔥 Quality: ✅' });
  assert.deepEqual({ title: messy.title, meta: messy.meta }, { title: 'Fullmetal Alchemist: Brotherhood S02 · Episode 176', meta: ['Season 2'] });
  // …and a dotted file name keeps its real information as a chip instead.
  const fileish = watchHeading(item, { episode: episode(176), fileLabel: 'Fullmetal.Alchemist.Brotherhood.176.1080p.WEB-DL.Hindi' });
  assert.deepEqual({ title: fileish.title, meta: fileish.meta }, { title: 'Fullmetal Alchemist: Brotherhood S02 · Episode 176', meta: ['Season 2', 'Quality: 1080P'] });
  // A caption that actually names the episode is used as the name.
  const named = watchHeading(item, { episode: episode(9), fileLabel: 'Reunion of Shadows' });
  assert.deepEqual({ title: named.title, meta: named.meta }, { title: 'Fullmetal Alchemist: Brotherhood S02 · Reunion of Shadows', meta: ['Season 2', 'Episode 09'] });
  // A leftover fragment of the show's own title is not a new name.
  const partial = watchHeading(item, { episode: episode(9), fileLabel: 'Brotherhood EP 09 Dual Audio' });
  assert.deepEqual({ title: partial.title, meta: partial.meta }, { title: 'Fullmetal Alchemist: Brotherhood S02 · Episode 09', meta: ['Season 2'] });
  const pack = watchHeading(item, { episode: { start: 3, end: 6, label: 'Episodes 03–06' } });
  assert.deepEqual({ title: pack.title, meta: pack.meta }, { title: 'Fullmetal Alchemist: Brotherhood S02 · Episodes 03–06', meta: ['Season 2'] });

  // the season may only be spelled out in the title, and a sequel number is not a season
  assert.equal(watchHeading({ ...item, episodeGroups: [] }, { episode: episode(3) }).seasonLabel, 'Season 2');
  assert.equal(watchHeading({ ...item, title: 'Rocky 2', episodeGroups: [] }, { episode: episode(3) }).seasonLabel, null);
  // a grouped label without a season still shows no invented season
  const numbered = watchHeading({ ...item, title: 'Show', episodeGroups: [{ start: 1, end: 12, label: 'Episodes 01–12' }] }, { episode: episode(4) });
  assert.deepEqual({ title: numbered.title, meta: numbered.meta }, { title: 'Show · Episode 04', meta: [] });
  assert.equal(episodeNameFromLabel('Show S01 Complete 1080p', 'Show').name, null, 'a season pack is not one episode');

  const movie = { category: 'movie', title: 'RRR', episodeGroups: [], languages: ['Hindi Dubbed', 'Tamil'], subtitleLanguages: ['English'] };
  const movieHeading = watchHeading(movie, { fileLabel: null });
  assert.deepEqual(
    { title: movieHeading.title, meta: movieHeading.meta, isEpisode: movieHeading.isEpisode },
    { title: 'RRR', meta: ['Hindi Dubbed · Tamil', 'Subtitles: English'], isEpisode: false },
    'a movie shows its languages and never a season or episode number'
  );
  assert.equal(watchHeading(movie, {}).title, 'RRR');
});
