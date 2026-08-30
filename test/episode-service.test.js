import test from 'node:test';
import assert from 'node:assert/strict';
import { detectUploadEpisode, stripTelegramAttribution, summarizeEpisodes } from '../src/server/services/episode-service.js';

test('caption is cleaned of Telegram attribution before episode parsing', () => {
  const result = detectUploadEpisode({
    caption: 'Perfect World @ONGOING_Anime_File_bot — Ep 1 To 5',
    filename: 'random-upload-1080p.mkv'
  });

  assert.equal(stripTelegramAttribution('Perfect World @ONGOING_Anime_File_bot'), 'Perfect World');
  assert.deepEqual(
    { start: result.start, end: result.end, source: result.source, label: result.label },
    { start: 1, end: 5, source: 'caption', label: 'Episodes 01–05' }
  );
});

test('filename is used only when the caption has no episode number', () => {
  const result = detectUploadEpisode({
    caption: 'Perfect World @mychannel',
    filename: 'Perfect.World.S01E06-E10.1080p.mkv'
  });
  assert.equal(result.start, 6);
  assert.equal(result.end, 10);
  assert.equal(result.source, 'filename');
});

test('episode summary creates an ordered public-friendly index', () => {
  const summary = summarizeEpisodes([
    { episode: { start: 6, end: 10, label: 'Episodes 06–10' } },
    { episode: { start: 1, end: 5, label: 'Episodes 01–05' } },
    { episode: { start: 1, end: 5, label: 'Episodes 01–05' } }
  ]);

  assert.equal(summary.count, 10);
  assert.equal(summary.groups.length, 2);
  assert.equal(summary.groups[0].fileCount, 2);
  assert.equal(summary.releaseLabel, '10 episodes');
});
