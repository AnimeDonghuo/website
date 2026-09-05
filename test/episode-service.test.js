import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDeliveryFileName, cleanMediaName, seasonPackOf, compareQualityAscending, detectMediaQuality, detectUploadEpisode, detectUploadLanguages, detectUploadSubtitleLanguages, extractSeasonNumber, fileReplacementKey, groupFilesBySeason, normalizeQualityLabel, publicFileDisplayName, qualityHeight, stripTelegramAttribution, summarizeEpisodes, summarizeUploadLanguages } from '../src/server/services/episode-service.js';

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

test('known qualities read as an ascending ladder instead of upload order', () => {
  assert.equal(normalizeQualityLabel('1080p'), '1080P');
  assert.equal(normalizeQualityLabel('4K'), '4K');
  assert.equal(qualityHeight('4K'), 2160);
  assert.equal(qualityHeight('720P'), 720);
  const shuffled = ['1080P', null, '480p', '4K', '280P', '720P'];
  assert.deepEqual(
    [...shuffled].sort((first, second) => compareQualityAscending(first, second)),
    ['280P', '480p', '720P', '1080P', '4K', null]
  );
});

test('season markers are recognised without confusing years or quality labels', () => {
  assert.equal(extractSeasonNumber('Demon Slayer S01E05 1080p'), 1);
  assert.equal(extractSeasonNumber('Show.Season.4.720p.mkv'), 4);
  assert.equal(extractSeasonNumber('Solo Leveling S2 EP 3'), 2);
  assert.equal(extractSeasonNumber('Breaking Bad 3x07'), 3);
  assert.equal(extractSeasonNumber('Cocktail 2 (2026) 1080p NF WEB-DL'), null);
  assert.equal(extractSeasonNumber('Naruto.Shippuden.1920x1080.mp4'), null);
});

test('a mixed-season batch becomes one file group per season', () => {
  const files = [
    { name: 'Show.S01E01.mkv', episode: { start: 1, end: 1 }, season: 1 },
    { name: 'Show.S01E02.mkv', episode: { start: 2, end: 2 }, season: 1 },
    { name: 'Show.S06E01.mkv', episode: { start: 1, end: 1 }, season: 6 },
    // A caption that only says "EP 40" still belongs to the season that holds it.
    { name: 'Show EP 40.mkv', episode: { start: 40, end: 40 } }
  ];
  const groups = groupFilesBySeason(files);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.season), [1, 6]);
  assert.deepEqual(groups[1].files.map((file) => file.name), ['Show.S06E01.mkv', 'Show EP 40.mkv']);

  // A single-season batch is deliberately not split.
  assert.deepEqual(groupFilesBySeason(files.slice(0, 2)), []);
});

test('a re-upload replaces its own slot, and only its own slot', () => {
  const episodeFile = (messageId, quality, languages = []) => ({
    storageMessageId: messageId,
    quality,
    audioLanguages: languages,
    languages: languages,
    episode: { start: 1, end: 5, label: 'Episodes 01–05' }
  });
  assert.deepEqual(
    fileReplacementKey(episodeFile(1, '480P')),
    fileReplacementKey(episodeFile(2, '1080P', [])),
    'the same episode range replaces an older quality'
  );
  assert.notDeepEqual(
    fileReplacementKey(episodeFile(1, '480P', ['Hindi'])),
    fileReplacementKey(episodeFile(2, '480P', ['Tamil'])),
    'a different audio language is a different delivery slot'
  );

  const movie1080 = { name: 'Cocktail.2.1080p.mkv', quality: '1080P' };
  const movie480 = { name: 'Cocktail.2.480p.mkv', quality: '480P' };
  assert.notEqual(fileReplacementKey(movie1080).key, fileReplacementKey(movie480).key, 'adding a quality must not delete another');
  assert.equal(fileReplacementKey({ name: 'Cocktail.2.1080p.mkv', quality: '1080P' }).key, fileReplacementKey(movie1080).key);
  assert.equal(fileReplacementKey({ name: 'Cocktail.2.1080p.mkv' }), null, 'an unknown quality never replaces anything');
});

test('public file labels keep the uploader wording that identifies the file', () => {
  assert.equal(
    publicFileDisplayName('Demon.Slayer.S01E05.1080p.WEB-DL.Hindi.mkv @promo_channel'),
    'Demon Slayer S01E05 1080p WEB-DL Hindi'
  );
  assert.equal(publicFileDisplayName('https://t.me/promo Perfect World EP 01 4K'), 'Perfect World EP 01 4K');
});

test('a file naming a season and no episode is that season complete', () => {
  const pack = (name, extra = {}) => seasonPackOf({ name, ...extra });

  assert.deepEqual(pack('The.Simpsons.S01.1080p.DSNP.WEBRip.x264.mkv'), { season: 1, label: 'Season 1', wholeSeason: true });
  assert.equal(pack('Breaking.Point.S02.1080p.WEB-DL.Hindi')?.season, 2);
  assert.equal(pack('Show S03 Complete 1080p.mkv')?.season, 3);
  assert.equal(pack('Show.Season.5.Box.Set.720p.mkv')?.season, 5);
  assert.equal(pack('Show S02 720p x264 [Batch].mkv')?.season, 2);

  // a caption is read the same way as a file name, because that is where the
  // uploader writes the season
  assert.equal(seasonPackOf({ name: 'file.mkv', displayName: 'The Simpsons S01 1080p DSNP WEBRip [English]' })?.season, 1);

  // nothing is invented: an episode anywhere in the wording, an extra, a film, or a
  // season the card merely attributes to an unnamed file all stay out of this class
  assert.equal(pack('The.Simpsons.S01E05.1080p.mkv'), null);
  assert.equal(pack('The.Simpsons.S01E05.1080p.mkv', { episode: { start: 5, end: 5, label: 'Episode 05' } }), null);
  assert.equal(pack('The.Simpsons.Trailer.2.1080p.mkv'), null);
  assert.equal(pack('Some.Movie.1999.1080p.mkv'), null);
  assert.equal(pack('Show.1080p.mkv', { season: 2 }), null, 'an inherited season alone cannot claim to be a whole season');
  assert.equal(pack('Show S02 Episode 7 1080p.mkv'), null);
  assert.equal(seasonPackOf(null), null);
  assert.equal(seasonPackOf({}), null);
});
