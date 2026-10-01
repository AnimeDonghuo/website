import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackPosterPng } from '../src/server/services/poster-service.js';

test('generated fallback poster is a valid non-empty PNG buffer', () => {
  const poster = createFallbackPosterPng('A very original title', 'anime');
  assert.deepEqual([...poster.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(poster.length > 5000);
  assert.equal(poster.subarray(-8, -4).toString('ascii'), 'IEND');
});

test('fallback art varies by title', () => {
  const first = createFallbackPosterPng('First title', 'movie');
  const second = createFallbackPosterPng('Second title', 'movie');
  assert.notDeepEqual(first, second);
});
