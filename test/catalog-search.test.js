import { strict as assert } from 'node:assert';
import test from 'node:test';

import { MemoryCatalogRepository, reindexContentRecord } from '../src/server/catalog.repository.js';

const file = (name, episode) => ({
  name,
  fileName: name,
  quality: '1080p',
  size: '280 MB',
  ...(episode ? { episode } : {})
});

function repository(contents) {
  return new MemoryCatalogRepository(contents);
}

test('an episode number is searchable, with or without the word "ep"', async () => {
  const repo = repository([
    {
      slug: 'bleach',
      title: 'Bleach',
      category: 'anime',
      description: 'A substitute soul reaper defends Karakura Town.',
      files: [file('Bleach - 176 [Hindi].mkv', { start: 176, end: 176 }), file('Bleach - 178 [Hindi].mkv', { start: 178, end: 178 })]
    },
    {
      slug: 'naruto',
      title: 'Naruto',
      category: 'anime',
      description: 'A boy with a sealed fox spirit wants to be Hokage.',
      files: [file('Naruto - 009 [Hindi].mkv', { start: 9, end: 9 })]
    }
  ]);
  await repo.init();

  for (const query of ['ep 176', 'EP176', '176', 'episode 178']) {
    const found = await repo.listContent({ query });
    assert.deepEqual(found.map((item) => item.slug), ['bleach'], `"${query}" has to reach the card that owns that episode`);
  }

  assert.deepEqual((await repo.listContent({ query: 'ep 177' })).map((item) => item.slug), [], 'a gap in the index stays a gap');
  assert.deepEqual((await repo.listContent({ query: 'naruto 176' })).map((item) => item.slug), [], 'an episode cannot be borrowed from another release');
  // the words visitors type are indexed too, so a bare "episode" never matches everything
  assert.equal((await repo.listContent({ query: 'bleach episode' })).length, 1);
});

test('a combined pack makes every episode it covers findable, and seasons are labelled', async () => {
  const repo = repository([
    {
      slug: 'long-march',
      title: 'Long March',
      category: 'anime',
      files: [
        file('Long.March.S01.E001-E004.1080p.mkv', { start: 1, end: 4, season: 1 }),
        file('Long.March.S02.E005-E008.1080p.mkv', { start: 5, end: 8, season: 2 })
      ]
    }
  ]);
  await repo.init();

  const middle = await repo.listContent({ query: 'ep 02' });
  assert.equal(middle.length, 1, 'a zero-padded query still reaches the middle of a combined range');
  assert.equal((await repo.listContent({ query: 'long march 7' })).length, 1);
  // two seasons on one card is what makes the site label its blocks by season, and the
  // search index follows the same rule rather than inventing a season for a single block
  assert.equal((await repo.listContent({ query: 'season 2' })).length, 1);
  assert.equal((await repo.listContent({ query: 'long march s02 e05' })).length, 1, 'the season and episode shorthand is indexed with the block');
  assert.equal((await repo.listContent({ query: 'long march 9' })).length, 0);
});

test('a title search keeps working and a movie is not given fake episode terms', async () => {
  const repo = repository([
    { slug: 'rrr', title: 'RRR', category: 'movie', description: 'A rebel and a soldier, raised apart, meet on a mission.', files: [file('RRR.2022.Hindi.1080p.mkv')] },
    { slug: 'ship', title: 'Sea Ship', category: 'anime', files: [file('Sea.Ship.-.987[Hindi].mkv', { start: 987, end: 987 })] }
  ]);
  await repo.init();

  assert.deepEqual((await repo.listContent({ query: 'rrr' })).map((item) => item.slug), ['rrr']);
  assert.deepEqual((await repo.listContent({ query: 'rebel soldier' })).map((item) => item.slug), ['rrr'], 'the synopsis is still searchable');
  assert.deepEqual((await repo.listContent({ query: 'sea ship 987' })).map((item) => item.slug), ['ship']);
  const movie = repo.contents.get('rrr');
  assert.ok(!/ ep episode /.test(` ${movie.searchText} `), 'a single feature gets no episode vocabulary');
  assert.equal((await repo.listContent({ query: 'ep 2022' })).length, 0, 'a year in a movie title is not an episode');
  assert.match(repo.contents.get('ship').searchText, /987/, 'a number near the index limit is stored like any other');
});

test('/repair carries the episode index into a card saved before it existed', async () => {
  const legacy = {
    slug: 'old-show',
    title: 'Old Show',
    category: 'anime',
    // exactly what an old record looks like: files whose wording names episodes, and an
    // index built by whatever rules were current when it was published
    files: [file('Old.Show.004.720p.mkv'), file('Old.Show.005.720p.mkv')],
    episodeGroups: [{ start: 4, end: 5, label: 'EP 04–05', fileCount: 2 }],
    episodeCount: 2,
    searchText: 'old show anime'
  };
  const repaired = { ...legacy, files: legacy.files.map((entry, index) => ({ ...entry, episode: { start: index + 4, end: index + 4 } })) };
  const result = reindexContentRecord(repaired);
  assert.equal(result.changed, true, 'a search index that grew new terms counts as a change');
  assert.equal(typeof result.patch.searchText, 'string', 'searchText is one of the re-indexed fields, so /repair go persists it');
  assert.match(result.patch.searchText, /ep\b.*\b4\b.*\b5\b/);
  // and a card that is already current is left alone, so /repair's preview stays honest
  assert.equal(reindexContentRecord(result.content).changed, false, 're-indexing a repaired card a second time changes nothing');
});
