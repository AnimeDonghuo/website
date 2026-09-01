import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDeliveryFileName, cleanMediaName, detectMediaQuality, detectUploadEpisode, detectUploadLanguages, detectUploadSubtitleLanguages, stripTelegramAttribution, summarizeEpisodes, summarizeUploadLanguages } from '../src/server/services/episode-service.js';

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

test('release cleaner removes Markdown URLs, providers, codecs, and bracketed labels while preserving sequel numbers', () => {
  assert.equal(
    cleanMediaName('Cocktail.2.2026.1080p.NF.WEB-DL.Hindi.DDP5.1.H.265~[C_B].mkv'),
    'Cocktail 2 Hindi'
  );
  assert.equal(cleanMediaName('A Film [t.is](http://t.is) https://example.com @release_source 720p AMZN'), 'A Film');
  assert.equal(cleanMediaName('Raakh.S01E03.1080p.AMZN.mkv'), 'Raakh S01E03');
  assert.equal(cleanMediaName('Raakh.Season.01.1080p.AMZN.mkv'), 'Raakh');
  assert.equal(cleanMediaName('The Gentlemen Season 1 (2024) [Hindi-English] 720p Netflix WEB-DL ESubs.mkv'), 'The Gentlemen');
  assert.equal(cleanDeliveryFileName('The Gentlemen Season 1 (2024) [Hindi-English] 720p HEVC Netflix WEB-DL ESubs.mkv'), 'The Gentlemen Season 1');
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

test('compact ESubs release tags become subtitle metadata without corrupting dual-audio labels', () => {
  const caption = 'The Gentlemen Season 1 (2024) [Hindi-English] 720p HEVC Netflix WEB-DL ESubs.mkv';
  assert.deepEqual(detectUploadLanguages({ caption, filename: '' }), ['Hindi', 'English']);
  assert.deepEqual(detectUploadSubtitleLanguages({ caption, filename: '' }), ['English']);
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
