import test from 'node:test';
import assert from 'node:assert/strict';
import { connectCatalogStore, createCatalogRepository, STORE_CONNECT_DELAYS_MS } from '../src/server/catalog.repository.js';

const quietLog = () => ({ lines: [], warn(message) { this.lines.push(String(message)); }, info(message) { this.lines.push(String(message)); } });

test('the app waits out a database that is still waking up instead of dying on the first no-answer', async () => {
  const waits = [];
  const log = quietLog();
  let attempts = 0;
  const repository = await connectCatalogStore({
    uri: 'mongodb://x',
    database: 'sorabox',
    log,
    delays: [0, 2, 3, 4],
    wait: async (ms) => { waits.push(ms); },
    open: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('MongoServerSelectionError: connection refused');
      return { kind: 'mongodb', persistent: true };
    }
  });

  assert.equal(repository.kind, 'mongodb');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2, 3], 'the failed attempts are spaced out rather than hammered');
  assert.match(log.lines.join('\n'), /attempt 2\/4/);
  assert.match(log.lines.join('\n'), /reachable again after 3 attempts/);
});

test('giving up says what to check, and never leaves a half-open client behind', async () => {
  const closed = [];
  const log = quietLog();
  await assert.rejects(
    () => connectCatalogStore({
      uri: 'mongodb://x',
      log,
      delays: [0, 1],
      wait: async () => {},
      open: async () => {
        throw Object.assign(new Error('bad auth'), { close: async () => { closed.push('client'); } });
      }
    }),
    (error) => {
      assert.match(error.message, /after 2 attempts/);
      assert.match(error.message, /cluster is running/);
      assert.match(error.message, /allowlist/);
      assert.match(error.message, /MONGODB_URI/);
      return true;
    }
  );

  const failures = log.lines.filter((line) => /not answering yet/.test(line));
  assert.equal(failures.length, 1, 'only the retries between attempts are reported');
  assert.deepEqual(closed, [], 'a failed attempt does not hand back a client for the retry loop to leak');
});

test('a local run without MONGODB_URI still takes the memory store and never retries', async () => {
  const repository = await createCatalogRepository({ mongodbUri: '', mongodbDb: 'sorabox' });
  assert.equal(repository.kind, 'memory');
  assert.equal(repository.persistent, false);
  await repository.close();
});

test('the production wait stays inside the window a platform will give a starting container', () => {
  const totalSleep = STORE_CONNECT_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  assert.ok(STORE_CONNECT_DELAYS_MS.length >= 4 && STORE_CONNECT_DELAYS_MS.length <= 6);
  assert.ok(totalSleep <= 45_000, `sleeping ${totalSleep}ms on top of each 8s selection timeout is too long`);
});
