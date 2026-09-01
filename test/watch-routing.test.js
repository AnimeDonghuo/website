import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChoicesForEpisode, hasReleaseLevelWatch, releaseLevelStreamEntries, streamEntriesForEpisode, watchPagePath } from '../src/client/watch-utils.js';

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
