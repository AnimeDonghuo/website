import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMediaQuality, detectUploadEpisode, detectUploadLanguages, stripTelegramAttribution, summarizeEpisodes, summarizeUploadLanguages } from '../src/server/services/episode-service.js';

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

test('quality is detected from a cleaned caption before the filename fallback', () => {
  assert.equal(
    detectMediaQuality({ caption: 'Perfect World @release_source 4k WEB-DL', filename: 'Perfect.World.1080p.mkv' }),
    '4K'
  );
  assert.equal(detectMediaQuality({ caption: 'Perfect World', filename: 'Perfect.World.720p.mkv' }), '720P');
});

test('file descriptions resolve explicit multi-audio labels instead of a generic Multi label', () => {
  assert.deepEqual(
    detectUploadLanguages({
      caption: 'Evil Dead Burn Multi (Hindi + Malayalam) @release_source 1080p',
      filename: 'Evil.Dead.Burn.English.720p.mkv'
    }),
    ['Hindi', 'Malayalam']
  );
  assert.deepEqual(
    detectUploadLanguages({ caption: 'Multi Audio', filename: 'Evil_Dead_Burn_Hindi_Malayalam_1080p.mkv' }),
    ['Hindi', 'Malayalam']
  );
  assert.deepEqual(
    summarizeUploadLanguages([
      { languages: ['Hindi', 'Malayalam'] },
      { languages: ['Malayalam', 'Tamil'] }
    ]),
    ['Hindi', 'Malayalam', 'Tamil']
  );
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
