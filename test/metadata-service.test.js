import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMetadataTitle, findMetadata, metadataTitleMatchScore } from '../src/server/services/metadata-service.js';

test('metadata title scoring preserves sequel markers and rejects unrelated poster results', () => {
  assert.equal(canonicalMetadataTitle('Cocktail.2.2026.1080p.NF.WEB-DL.Hindi.mkv'), 'cocktail 2');
  assert.equal(metadataTitleMatchScore('Cocktail 2', 'Cocktail 2'), 1);
  assert.ok(metadataTitleMatchScore('Cocktail 2', 'Cocktail') < 0.56);
  assert.equal(metadataTitleMatchScore('Perfect World', 'An Unrelated Movie'), 0);
});

test('TMDB metadata uses the best verified title match instead of the first poster result', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/search\/movie/);
    return new Response(JSON.stringify({
      results: [
        { id: 10, title: 'Cocktail', poster_path: '/wrong.jpg', popularity: 9999, vote_count: 9999 },
        { id: 20, title: 'Cocktail 2', poster_path: '/right.jpg', popularity: 2, vote_count: 1 }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const metadata = await findMetadata('Cocktail 2', 'movie', { tmdbApiKey: 'test-key' });
  assert.equal(metadata.matched, true);
  assert.equal(metadata.provider, 'tmdb');
  assert.equal(metadata.title, 'Cocktail 2');
  assert.equal(metadata.tmdbId, '20');
  assert.equal(metadata.metadataKey, 'tmdb-movie-20');
  assert.equal(metadata.posterOriginalUrl, 'https://image.tmdb.org/t/p/w780/right.jpg');
});

test('unverified TMDB search results fall back instead of attaching an unrelated title or poster', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [{ id: 99, title: 'A Completely Different Release', poster_path: '/wrong.jpg' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const metadata = await findMetadata('Rare Precise Title', 'movie', { tmdbApiKey: 'test-key' });
  assert.equal(metadata.matched, false);
  assert.equal(metadata.provider, 'fallback');
  assert.equal(metadata.posterOriginalUrl, null);
});
