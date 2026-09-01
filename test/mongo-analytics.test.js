import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoCatalogRepository } from '../src/server/catalog.repository.js';

class CounterCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
    this.updates = [];
    this.inserts = [];
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const updatePaths = new Set();
    for (const operator of ['$set', '$setOnInsert', '$inc']) {
      for (const path of Object.keys(update[operator] || {})) {
        if (updatePaths.has(path)) throw new Error(`Mongo update conflict for ${path}`);
        updatePaths.add(path);
      }
    }
    this.updates.push(structuredClone(update));
    let document = this.docs.find((candidate) => Object.entries(filter).every(([key, value]) => candidate[key] === value));
    const inserting = !document;
    if (!document && !options.upsert) return null;
    if (!document) {
      document = { ...filter };
      this.docs.push(document);
    }
    if (inserting) Object.assign(document, update.$setOnInsert || {});
    Object.assign(document, update.$set || {});
    for (const [field, increment] of Object.entries(update.$inc || {})) {
      document[field] = Number(document[field] || 0) + Number(increment);
    }
    return structuredClone(document);
  }

  async insertOne(document) {
    this.inserts.push(structuredClone(document));
    this.docs.push(structuredClone(document));
    return { acknowledged: true };
  }
}

class FakeMongoDatabase {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new CounterCollection(name));
    return this.collections.get(name);
  }
}

test('Mongo analytics upserts increment counters without conflicting update paths', async () => {
  const db = new FakeMongoDatabase();
  const repository = new MongoCatalogRepository({}, db);

  const firstBot = await repository.recordBotUser({ id: 1001, username: 'first', first_name: 'First' }, { seenAt: '2026-09-02T10:00:00.000Z' });
  const secondBot = await repository.recordBotUser({ id: 1001, username: 'renamed', first_name: 'Renamed' }, { seenAt: '2026-09-02T11:00:00.000Z' });
  assert.equal(firstBot.interactionCount, 1);
  assert.equal(secondBot.interactionCount, 2);
  assert.equal(db.collection('bot_users').docs.length, 1, 'one Telegram user remains one unique bot user');

  const firstVisit = await repository.recordSiteVisit({ visitorId: 'visitor-one', path: '/', visitedAt: '2026-09-02T10:00:00.000Z' });
  const secondVisit = await repository.recordSiteVisit({ visitorId: 'visitor-one', path: '/web-series/example', visitedAt: '2026-09-02T10:30:00.000Z' });
  await repository.recordSiteVisit({ visitorId: 'visitor-two', path: '/', visitedAt: '2026-09-02T11:00:00.000Z' });
  assert.equal(firstVisit.visitCount, 1);
  assert.equal(secondVisit.visitCount, 2);
  assert.equal(db.collection('site_visitors').docs.length, 2, 'returning visits do not inflate unique visitor count');
  assert.equal(db.collection('site_visits').inserts.length, 3, 'every anonymous page visit is retained separately');

  for (const update of db.collection('bot_users').updates) {
    assert.equal(update.$setOnInsert.interactionCount, undefined);
    assert.deepEqual(update.$inc, { interactionCount: 1 });
  }
  for (const update of db.collection('site_visitors').updates) {
    assert.equal(update.$setOnInsert.visitCount, undefined);
    assert.deepEqual(update.$inc, { visitCount: 1 });
  }
});
