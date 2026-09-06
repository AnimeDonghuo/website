import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import {
  PosterRateLimitError,
  clearPosterUploadCache,
  configurePosterKeys,
  configurePosterUploadOptions,
  hostPosterImage,
  isPosterRateLimit,
  parseImgBBKeys,
  posterKeyPoolStatus,
  preparePosterImage,
  resetPosterUploadPace,
  uploadImageToImgBB
} from '../src/server/services/poster-service.js';
import {
  attachPosterRetryQueue,
  createPosterRetryQueue,
  posterDeferralNote,
  shortDuration
} from '../src/server/services/telegram-bot.js';

const reply = (body, { ok = true, status = 200, headers = {} } = {}) => ({
  ok,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body
});

const accepted = (name) => reply({ success: true, data: { url: `https://i.ibb.co/x/${name}.png`, display_url: `https://i.ibb.co/y/${name}.png`, id: name } });

function fakeFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options?.body });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next(calls.length) : next;
  };
  return calls;
}

let waits = [];
beforeEach(() => {
  clearPosterUploadCache();
  resetPosterUploadPace();
  configurePosterKeys([]);
  waits = [];
  configurePosterUploadOptions({
    spacingMs: 0,
    attempts: 3,
    backoffMs: 1_000,
    wait: async (ms) => { waits.push(ms); },
    now: () => 1_000
  });
});

test('a rate limit from ImgBB is recognised as the one hosting error a release should survive', () => {
  assert.equal(isPosterRateLimit(new PosterRateLimitError('Rate limit reached.')), true);
  assert.equal(isPosterRateLimit(new Error('Rate limit reached.')), true, 'the exact wording ImgBB returns');
  assert.equal(isPosterRateLimit(Object.assign(new Error('host said no'), { status: 429 })), true, 'the status code alone is enough');
  assert.equal(isPosterRateLimit(null), false);
  assert.equal(isPosterRateLimit(new Error('Too Many Requests')), true);
  assert.equal(isPosterRateLimit(new Error('The poster is larger than the 8 MB upload limit.')), false, 'a real problem stays a real problem');
});

test('a limited upload is waited out inside the same call rather than failing the publish', async () => {
  const calls = fakeFetch([
    reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429, headers: { 'retry-after': '7' } }),
    accepted('poster-a')
  ]);
  const hosted = await uploadImageToImgBB({ buffer: Buffer.from('image bytes'), title: 'Naruto Shippuden', apiKey: 'key' });
  assert.equal(calls.length, 2, 'the host was asked again after waiting, not on the next publish');
  assert.deepEqual(waits, [7_000], 'and it waited the number of seconds ImgBB itself asked for');
  assert.equal(hosted.url, 'https://i.ibb.co/y/poster-a.png');

  const exhausted = fakeFetch([() => reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429 })]);
  await assert.rejects(
    () => uploadImageToImgBB({ buffer: Buffer.from('other bytes'), title: 'Bleach', apiKey: 'key' }),
    (error) => error instanceof PosterRateLimitError && /Rate limit reached/.test(error.message),
    'after its attempts it is reported as a rate limit, which is what lets the caller defer instead of fail'
  );
  assert.equal(exhausted.length >= 3, true);
});

test('identical artwork is hosted once, and the pace between uploads is honoured', async () => {
  const calls = fakeFetch([accepted('same'), accepted('second')]);
  const first = await uploadImageToImgBB({ buffer: Buffer.from('one poster'), title: 'Extinction', apiKey: 'key' });
  const again = await uploadImageToImgBB({ buffer: Buffer.from('one poster'), title: 'Extinction 001', apiKey: 'key' });
  assert.equal(calls.length, 1, 'the same bytes are not uploaded a second time for another card');
  assert.equal(again.cached, true);
  assert.deepEqual({ url: again.url }, { url: first.url });
  await uploadImageToImgBB({ buffer: Buffer.from('another poster'), title: 'Extinction 002', apiKey: 'key' });
  assert.equal(calls.length, 2, 'different artwork still gets its own upload');

  configurePosterUploadOptions({ spacingMs: 1_600, now: () => 10_000, wait: async (ms) => { waits.push(ms); } });
  resetPosterUploadPace();
  await uploadImageToImgBB({ buffer: Buffer.from('first frame'), title: 'A', apiKey: 'key' });
  // A single clock means no gap is needed after the first upload; the wait appears on the next one.
  assert.deepEqual(waits, [], 'the first upload never waits');
});

test('a prepared poster survives a busy host so the retry needs no re-upload', async () => {
  const image = await preparePosterImage({ sourceUrl: null, title: 'Despicable Me', category: 'cartoon' });
  assert.equal(image.usedFallback, true, 'generated artwork is prepared before the host is asked');
  assert.equal(image.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  fakeFetch([() => reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429 })]);
  await assert.rejects(() => hostPosterImage({ image, title: 'Despicable Me', config: { imgbbApiKey: 'key' } }), (error) => isPosterRateLimit(error));
  assert.equal(image.sourceUrl, null);
});

function makeQueue(overrides = {}) {
  const updated = [];
  const announced = [];
  const notified = [];
  let clock = 0;
  const queue = createPosterRetryQueue({
    repository: {
      async updateContentByAdminId(adminId, patch) {
        updated.push({ adminId, patch });
        return { adminId, posterUrl: patch.posterUrl, announcementRefs: [] };
      }
    },
    config: { imgbbApiKey: 'key' },
    host: async () => {
      if (queue.__limit) {
        const error = new PosterRateLimitError('Rate limit reached.');
        throw error;
      }
      return { url: 'https://i.ibb.co/hosted.png', providerId: 'abc', originalUrl: 'https://i.ibb.co/source.png', source: 'remote-mirror' };
    },
    announce: async (content) => { announced.push(content.adminId); },
    notify: async (chatIdArg, text) => { notified.push({ chatIdArg, text }); },
    now: () => clock,
    intervalMs: 60_000,
    rounds: 3,
    ...overrides
  });
  return { queue, updated, announced, notified, tick: (ms = 60_000) => { clock += ms; return clock; } };
}

test('a deferred poster updates the card in place when the host catches up', async () => {
  const { queue, updated, announced, notified, tick } = makeQueue();
  queue.enqueue({ adminId: 'SB-1111AAAA1111', title: 'Insidious', image: { buffer: Buffer.from('x'), sourceUrl: 'https://i.ibb.co/source.png' }, notifyChatId: '-100pub' });
  queue.enqueue({ adminId: 'SB-2222BBBB2222', title: 'Stolen Girl', image: { buffer: Buffer.from('y'), sourceUrl: null }, notifyChatId: '-100pub' });
  assert.equal(queue.size, 2);
  assert.deepEqual(queue.list().map((entry) => entry.adminId), ['SB-1111AAAA1111', 'SB-2222BBBB2222']);

  const tooEarly = await queue.runDue();
  assert.equal(tooEarly.hosted, 0, 'nothing is retried before its time, so the host is not hammered again');
  assert.equal(tooEarly.deferred, 2);

  const result = await queue.runDue(tick());
  assert.equal(result.hosted, 2);
  assert.equal(queue.size, 0, 'a hosted poster leaves the queue, so this cannot spin forever');
  assert.deepEqual(updated.map((entry) => entry.patch.posterUrl), ['https://i.ibb.co/hosted.png', 'https://i.ibb.co/hosted.png']);
  assert.equal(updated[0].patch.backdropUrl, 'https://i.ibb.co/hosted.png', 'the card and its backdrop are swapped together');
  assert.equal(updated[0].patch.poster.provider, 'imgbb');
  assert.equal(updated[0].patch.poster.originalUrl, 'https://i.ibb.co/source.png', 'the source URL is kept for the record');
  assert.deepEqual(announced, ['SB-1111AAAA1111', 'SB-2222BBBB2222'], 'the channel post that showed the old artwork is refreshed through the lane');
  assert.match(notified[0].text, /2 posters ImgBB had refused are hosted now/);
  assert.match(notified[0].text, /Poster for SB-1111AAAA1111 · Insidious is hosted/);
  assert.match(notified[0].text, /Poster for SB-2222BBBB2222 · Stolen Girl is hosted/);
  assert.equal(notified.length, 1, 'a tick tells the publisher once, with both cards named, instead of sending one message per poster');
});

test('a limit that keeps holding off is retried with a growing gap, then said out loud', async () => {
  const { queue, notified, tick } = makeQueue();
  queue.__limit = true;
  queue.enqueue({ adminId: 'SB-3333CCCC3333', title: 'Ghost in the Shell', image: { buffer: Buffer.from('z'), sourceUrl: null }, notifyChatId: '-100pub' });

  const first = await queue.runDue(tick(60_000));
  assert.equal(first.hosted, 0);
  assert.equal(queue.size, 1, 'the poster is still wanted, so it stays queued rather than being dropped');
  const [pending] = queue.list();
  assert.equal(pending.attempts, 1);
  assert.equal(pending.nextAt, 180_000, 'the next attempt waits twice as long, then three times as long');

  await queue.runDue(tick(120_000));
  assert.equal(queue.list()[0].attempts, 2);
  assert.equal(queue.list()[0].nextAt, 360_000);
  await queue.runDue(tick(180_000));
  assert.equal(queue.size, 0, 'after its rounds it stops, and the publisher is told instead of being left guessing');
  assert.match(notified.at(-1).text, /kept refusing 1 poster after 3 attempts/);
  assert.match(notified.at(-1).text, /Ghost in the Shell/);
  assert.match(notified.at(-1).text, /The card is published and correct/);
  assert.match(notified.at(-1).text, /no new post is needed/);
});

test('a poster problem that is not a rate limit is reported at once, and the bot attaches one queue', async () => {
  const { queue, notified } = makeQueue({ host: async () => { throw new Error('The poster host rejected the file format.'); } });
  queue.enqueue({ adminId: 'SB-4444DDDD4444', title: 'Wrong Turn', image: { buffer: Buffer.from('w') }, notifyChatId: '-100pub' });
  await queue.runDue(60_000);
  assert.equal(queue.size, 0, 'retrying a rejected file would only waste the hour');
  assert.match(notified[0].text, /1 poster could not be hosted at all/);
  assert.match(notified[0].text, /SB-4444DDDD4444 · Wrong Turn \u2014 The poster host rejected the file format/);

  const attached = attachPosterRetryQueue(queue);
  assert.equal(attached, queue, 'the publishing paths hand their deferred posters to this instance');
  assert.equal(queue.status().waiting, 0);
  assert.equal(queue.status().attached, true);
  attachPosterRetryQueue(null);
});

/* -- the key pool ------------------------------------------------------------
 * A burst of a hundred poster uploads is one quota's worst day, so the uploads are spread across
 * every configured ImgBB key instead of being fired at whichever key is first in the secret.
 */
test('the pool is read the way an operator writes it, up to twenty keys deep', () => {
  const list = parseImgBBKeys(`key-a, key-b
key-c ; key-a   key-b,key-4,key-5,key-6,key-7,key-8,key-9,key-10,key-11,key-12,key-13,key-14,key-15,key-16,key-17,key-18,key-19,key-20,key-21,key-22`);
  assert.deepEqual(list.slice(0, 3), ['key-a', 'key-b', 'key-c'], 'duplicates are dropped and the written order is kept');
  assert.equal(list.length, 20, 'twenty keys is the ceiling on the pool, never a cap on how many posters are hosted');
  assert.deepEqual(parseImgBBKeys('  ,, \n , '), []);
  assert.equal(configurePosterKeys(list), 20);
  assert.equal(posterKeyPoolStatus().configured, 20);
});

test('one key carries the burst until it refuses, and only then does the pool move', async () => {
  configurePosterKeys(['key-a', 'key-b', 'key-c']);
  const used = [];
  globalThis.fetch = async (url, options) => {
    used.push(options.body.get('key'));
    return accepted(`poster-${used.length}`);
  };
  for (const name of ['first', 'second', 'third', 'fourth', 'fifth']) {
    // No apiKey is passed: with a pool configured, that is the point of the pool.
    await uploadImageToImgBB({ buffer: Buffer.from(name), title: 'Minions' });
  }
  assert.deepEqual(used, Array(5).fill('key-a'), 'a healthy key is not abandoned mid-batch: switching every upload is the slow version of this');
  assert.equal(posterKeyPoolStatus().cooling, 0, 'a pool that is merely busy is not a pool in trouble');
  assert.equal(posterKeyPoolStatus().sticky, 'key-a');

  let refused = 0;
  globalThis.fetch = async (url, options) => {
    const key = options.body.get('key');
    used.push(key);
    if (key === 'key-a' && refused++ === 0) {
      return reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429, headers: { 'retry-after': '30' } });
    }
    return accepted('later');
  };
  used.length = 0;
  for (const name of ['sixth', 'seventh']) await uploadImageToImgBB({ buffer: Buffer.from(name), title: 'Minions' });
  assert.deepEqual(used, ['key-a', 'key-b', 'key-b'], 'the switch happens once, on the refusal, and the new key is then kept');
  assert.equal(posterKeyPoolStatus().sticky, 'key-b');
});

test('a key that refuses is rested while the rest of the pool keeps hosting', async () => {
  configurePosterKeys(['key-a', 'key-b', 'key-c']);
  const used = [];
  globalThis.fetch = async (url, options) => {
    const key = options.body.get('key');
    used.push(key);
    if (key === 'key-a') {
      return reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429, headers: { 'retry-after': '30' } });
    }
    return accepted('hosted');
  };

  const hosted = await uploadImageToImgBB({ buffer: Buffer.from('the minions poster'), title: 'Minions' });
  assert.equal(hosted.url, 'https://i.ibb.co/y/hosted.png', 'the card is published with hosted artwork because another key took it');
  assert.equal(used.length >= 2, true);
  assert.equal(used[0], 'key-a');
  assert.equal(used.at(-1), 'key-b', 'the retry went to a different key rather than back at the one that just refused');
  assert.equal(posterKeyPoolStatus().cooling, 1, 'and the refusing key is now rested, not retried by every card in the range');

  used.length = 0;
  await uploadImageToImgBB({ buffer: Buffer.from('the gold poster'), title: 'Gold' });
  assert.equal(used.includes('key-a'), false, 'the next card never offers the cooling key its upload');
});

test('when every key is busy the poster is deferred, not waited out for an hour', async () => {
  configurePosterKeys(['key-a', 'key-b']);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return reply({ error: { message: 'Rate limit reached.' } }, { ok: false, status: 429, headers: { 'retry-after': '3600' } });
  };
  await assert.rejects(
    () => uploadImageToImgBB({ buffer: Buffer.from('whole pool busy'), title: 'Despicable Me' }),
    (error) => isPosterRateLimit(error) && error.retryAfterMs >= 3_600_000,
    'the caller publishes the card and hands the mirror to the retry queue'
  );
  assert.equal(calls, 2, 'both keys were tried once each, and then the publish was let go instead of parked');
  assert.equal(posterKeyPoolStatus().cooling, 2);
});

test('an hour when every key is full is reported as a wait with a number, not as a failure', async () => {
  assert.equal(shortDuration(42_000), '42 s');
  assert.equal(shortDuration(4 * 60_000), '4 min');
  assert.equal(shortDuration(75 * 60_000), '1 h 15 min');
  const note = posterDeferralNote({ deferred: true, allKeysCooling: true, poolSize: 10, retryAfterMs: 40_000 });
  assert.match(note, /all 10 configured ImgBB keys are rate limited right now/);
  assert.match(note, /The next one is free in about 40 s/);
  assert.match(note, /Nothing needs resending/);
  assert.match(posterDeferralNote({ deferred: true }), /uses the poster from its source for now/);
  assert.equal(posterDeferralNote({ deferred: false }), null, 'a card whose poster went through is not told about it again');

  // And the queue obeys the host instead of its own default, because a 45-second wait should not
  // become a five-minute one.
  const clock = { at: 0 };
  const queue = createPosterRetryQueue({
    repository: { updateContentByAdminId: async () => null },
    host: async () => {
      const error = new PosterRateLimitError('Every configured ImgBB key is rate limited.');
      error.retryAfterMs = 45_000;
      throw error;
    },
    now: () => clock.at,
    intervalMs: 300_000,
    rounds: 4
  });
  queue.enqueue({ adminId: 'SB-1111AAAA1111', title: 'Gold', image: { buffer: Buffer.from('poster bytes') } });
  await queue.runDue(300_000);
  assert.equal(queue.size, 1, 'the card stays queued while the pool is busy');
  assert.equal(queue.list()[0].nextAt, 345_000, 'the next attempt is when ImgBB said it would be ready');
});
