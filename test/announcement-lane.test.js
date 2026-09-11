import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  announcementCaption,
  announcementLaneDrained,
  announcementReferenceIsCurrent,
  announcementSyncNote,
  announcementSyncStatus,
  announcementRefIsDeferred,
  announcementSignature,
  classifyAnnouncementEditFailure,
  sweepAnnouncedCards,
  deleteAnnouncementMessages,
  queuePosterRematchForTitle,
  queueAnnouncementSync,
  clearAnnouncementUnsyncable,
  listAnnouncementUnsyncable,
  queueAnnouncementDeletion,
  resetAnnouncementLane,
  syncPublishedAnnouncements
} from '../src/server/services/telegram-bot.js';
import { PosterRateLimitError } from '../src/server/services/poster-service.js';

const card = (overrides = {}) => ({
  adminId: 'SB-AAA111',
  title: 'Long March',
  category: 'anime',
  categoryLabel: 'Anime',
  slug: 'long-march',
  filesCount: 3,
  episodeCount: 3,
  // No artwork on the fixture card, so a text reference stays on the text path: the tests that
  // watch caption edits are not also paying for the photo promotion that a card with art gets.
  posterUrl: null,
  description: 'A crew crosses a desert.',
  languages: ['Hindi'],
  announcementRefs: [{ channelId: '-100chan', messageId: 11, kind: 'text', websiteUrl: 'https://site.test/anime/long-march' }],
  ...overrides
});

const editError = (description, retryAfter = null) => Object.assign(new Error(description), {
  description,
  ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {})
});

function recorder(behaviours = []) {
  const calls = [];
  const waits = [];
  let index = 0;
  const next = (method, args) => {
    const behaviour = behaviours[index] ?? null;
    index += 1;
    calls.push({ method, args });
    if (behaviour instanceof Error) return Promise.reject(behaviour);
    if (typeof behaviour === 'function') return behaviour(args);
    return Promise.resolve({});
  };
  return {
    calls,
    waits,
    telegram: {
      editMessageText: (...args) => next('editMessageText', args),
      editMessageMedia: (...args) => next('editMessageMedia', args),
      editMessageReplyMarkup: (...args) => next('editMessageReplyMarkup', args),
      deleteMessage: (...args) => next('deleteMessage', args),
      sendMessage: async (chatIdArg, text) => { calls.push({ method: 'sendMessage', args: [chatIdArg, text] }); return { message_id: 1 }; }
    },
    wait: async (ms) => { waits.push(ms); }
  };
}

beforeEach(() => {
  resetAnnouncementLane();
});

test('a reference counts as current only when caption, link, and artwork all agree', () => {
  const current = { caption: 'same', websiteUrl: 'https://site.test/a', kind: 'photo', posterUrl: 'https://img.test/p.jpg' };
  assert.equal(announcementReferenceIsCurrent(current, { caption: 'same', link: 'https://site.test/a', posterUrl: 'https://img.test/p.jpg' }), true);
  assert.equal(announcementReferenceIsCurrent({ ...current, caption: 'older' }, { caption: 'same', link: 'https://site.test/a', posterUrl: 'https://img.test/p.jpg' }), false);
  assert.equal(announcementReferenceIsCurrent(current, { caption: 'same', link: 'https://site.test/b', posterUrl: 'https://img.test/p.jpg' }), false, 'a moved detail-page link is a real change');
  assert.equal(announcementReferenceIsCurrent(current, { caption: 'same', link: 'https://site.test/a', posterUrl: 'https://img.test/other.jpg' }), false, 'new artwork has to reach the channel');
  assert.equal(announcementReferenceIsCurrent({ kind: 'text', caption: 'same' }, { caption: 'same', link: null, posterUrl: null }), true, 'a text copy of a card with no artwork has nothing to disagree about');
  const art = { caption: 'same', link: null, posterUrl: 'https://img.test/p.jpg' };
  assert.equal(announcementReferenceIsCurrent({ kind: 'text', caption: 'same' }, art), false, 'a text copy of a card that now has artwork is behind, because the photo can be attached');
  assert.equal(announcementReferenceIsCurrent({ kind: 'text', caption: 'same', posterUpgrade: { signature: announcementSignature(art) } }, art), true, 'unless Telegram already refused that very attachment, which is remembered instead of re-attempted');
  // A post announced before this memory existed has nothing to compare against, and that is
  // exactly the point: it is treated as stale, which is how /sync finds the announcements
  // whose copy still carries an @channel handle from before the cleaner.
  assert.equal(announcementReferenceIsCurrent({ kind: 'text', websiteUrl: 'https://site.test/a' }, { caption: 'same', link: 'https://site.test/a', posterUrl: null }), false);
});

test('a flood wait is obeyed inside the edit, and the reference learns what was sent', async () => {
  const fixture = recorder([
    editError('Too Many Requests: retry after 4', 4),
    editError('Too Many Requests: retry after 2', 2)
  ]);
  const saved = [];
  const repository = { updateContentByAdminId: async (adminId, patch) => { saved.push({ adminId, patch }); return null; } };
  const sync = await syncPublishedAnnouncements({
    telegram: fixture.telegram,
    repository,
    content: card(),
    options: { spacingMs: 700, wait: fixture.wait }
  });

  assert.equal(sync.updated, 1, 'the edit went through on the third try');
  assert.equal(sync.failed, 0, 'a refused edit that later succeeds is not reported as a failure');
  assert.equal(sync.retryAfterMs, 4_000);
  assert.deepEqual(fixture.waits, [4_000, 2_000, 700], 'the lane waits as long as Telegram asked, then paces');
  assert.equal(fixture.calls.filter((entry) => entry.method === 'editMessageText').length, 3);
  assert.equal(saved[0].adminId, 'SB-AAA111');
  assert.equal(saved[0].patch.announcementRefs[0].messageId, 11, 'the reference is written back, not replaced');
});

test('an announcement that already reads correctly costs no call at all', async () => {
  // A photo announcement, because that is the shape that carries artwork: the memory has to
  // cover both the text and the image, or a poster change would be skipped as "unchanged".
  const content = card({
    posterUrl: 'https://img.test/poster.jpg',
    announcementRefs: [{ channelId: '-100chan', messageId: 11, kind: 'photo', websiteUrl: 'https://site.test/anime/long-march' }]
  });
  const caption = announcementCaption(content);
  const player = (counter) => ({
    editMessageText: async () => { counter.value += 1; return {}; },
    editMessageMedia: async () => { counter.value += 1; return {}; },
    editMessageReplyMarkup: async () => ({})
  });
  const saved = [];
  const prepared = await syncPublishedAnnouncements({
    telegram: player({ value: 0 }),
    repository: { updateContentByAdminId: async (adminId, patch) => { saved.push(patch); return null; } },
    content,
    options: { spacingMs: 0, wait: async () => {} }
  });
  assert.equal(prepared.updated, 1);
  assert.equal(saved[0].announcementRefs[0].caption, caption, 'the reference remembers the exact text, not a normalized copy of it');
  assert.equal(saved[0].announcementRefs[0].posterUrl, 'https://img.test/poster.jpg', 'and the artwork it was sent with');

  // The next pass has to answer "already showing this" without calling Telegram at all,
  // which is what keeps a 400-card /sync from turning into 400 edits and a flood wait.
  const touched = { value: 0 };
  const again = await syncPublishedAnnouncements({
    telegram: player(touched),
    repository: { updateContentByAdminId: async () => null },
    content: { ...content, announcementRefs: [{ ...saved[0].announcementRefs[0] }] },
    options: { spacingMs: 0, wait: async () => {} }
  });
  assert.equal(touched.value, 0, 'a caption and poster the reference already remembers are never sent again');
  assert.equal(again.unchanged, 1);
  assert.equal(again.updated, 0);
  assert.equal(again.channels, 1);

  // new artwork on the same caption is still a change worth sending
  const resent = { value: 0 };
  await syncPublishedAnnouncements({
    telegram: player(resent),
    repository: { updateContentByAdminId: async () => null },
    content: { ...content, posterUrl: 'https://img.test/new.jpg', announcementRefs: [{ ...saved[0].announcementRefs[0] }] },
    options: { spacingMs: 0, wait: async () => {} }
  });
  assert.equal(resent.value, 1, 'the channel keeps the card’s artwork in step');
});

test('a deleted announcement post is forgotten, a refused one is kept for the next round', async () => {
  const gone = recorder([editError('Bad Request: message to edit not found')]);
  const savedPatches = [];
  const dropped = await syncPublishedAnnouncements({
    telegram: gone.telegram,
    repository: { updateContentByAdminId: async (adminId, patch) => { savedPatches.push(patch); return null; } },
    content: card(),
    options: { spacingMs: 0, wait: gone.wait }
  });
  assert.equal(dropped.dropped, 1);
  assert.deepEqual(savedPatches[0].announcementRefs, [], 'the reference list shrinks so nothing is retried forever');

  const refused = recorder([editError('Forbidden: bot is not a member of the channel')]);
  const keptPatches = [];
  const failed = await syncPublishedAnnouncements({
    telegram: refused.telegram,
    repository: { updateContentByAdminId: async (adminId, patch) => { keptPatches.push(patch); return null; } },
    content: card(),
    options: { spacingMs: 0, wait: refused.wait }
  });
  assert.equal(failed.failed, 0);
  assert.equal(failed.blocked, 1, 'a bot that is not in the channel is refused for a reason that will not change, so the lane stops after one attempt');
  assert.equal(keptPatches.length, 1, 'the ref is kept — the card still wants that channel copy');
  assert.equal(keptPatches[0].announcementRefs[0].syncError.blocked, true, 'and it remembers why, so /sync can say it');
  assert.match(keptPatches[0].announcementRefs[0].syncError.reason, /bot is not a member/);
  assert.match(announcementSyncNote(failed), /refused because this bot is not an administrator of that channel, or was removed from it/);

  // A flood-limit refusal is the opposite case: one attempt per round, retried later, and still counted as failed.
  const limited = recorder([editError('Too Many Requests: retry after 8 seconds')]);
  const throttled = await syncPublishedAnnouncements({
    telegram: limited.telegram,
    repository: { updateContentByAdminId: async () => null },
    content: card(),
    options: { spacingMs: 0, wait: limited.wait, attempts: 1 }
  });
  assert.equal(throttled.failed, 1, 'a wait is not a permanent refusal');
  assert.match(announcementSyncNote(throttled), /waiting on Telegram\u2019s limit and queued for a later round/);
  assert.match(throttled.reason, /Too Many Requests/, 'and the report quotes what Telegram actually said');
});

test('a copy another account posted is remembered as unfixable instead of refused forever', async () => {
  const other = recorder([editError('Bad Request: MESSAGE_AUTHOR_INVALID: bots can\u2019t edit messages sent by other bots')]);
  const patches = [];
  const first = await syncPublishedAnnouncements({
    telegram: other.telegram,
    repository: { updateContentByAdminId: async (adminId, patch) => { patches.push(patch); return null; } },
    content: card(),
    options: { spacingMs: 0, wait: other.wait }
  });
  assert.equal(first.unsyncable, 1, 'the reference is dropped, because keeping it means refusing it again on every future edit');
  assert.equal(first.dropped, 0, 'and it is not called a deleted post: the copy is still in the channel, it is just not this bot\u2019s to edit');
  assert.equal(first.skipped, 0);
  assert.match(announcementSyncNote(first), /copy this bot did not post/);
  assert.equal(listAnnouncementUnsyncable()[0].key, '-100chan:11', 'the message is remembered by channel and id, not by card');

  // The next edit of the same card never reaches Telegram at all, and /sync can still name it.
  const second = recorder([editError('nope')]);
  const again = await syncPublishedAnnouncements({
    telegram: second.telegram,
    repository: { updateContentByAdminId: async () => null },
    content: card(),
    options: { spacingMs: 0, wait: second.wait }
  });
  assert.equal(second.calls.length, 0, 'one refused call per message is enough for anyone');
  assert.equal(again.skipped, 1);
  assert.match(again.reason, /posted by another account/);
  assert.equal(clearAnnouncementUnsyncable(), 1, '/sync retry forgets it, so the next edit tries again');
});

test('the lane serializes every job, retries a stuck one, and reports what is left', async () => {
  let active = 0;
  let peak = 0;
  let refusedEdits = 0;
  const telegram = {
    async editMessageText(chatIdArg, messageIdArg, inline, text) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      // one post refuses for longer than the in-run attempts allow, so the lane's own
      // second round — the part that fixes a flood that outlives the command — is exercised
      if (String(messageIdArg) === '21' && refusedEdits < 4) {
        refusedEdits += 1;
        throw editError('Too Many Requests: retry after 1', 1);
      }
      return { message_id: messageIdArg };
    },
    async editMessageMedia() { return { message_id: 1 }; },
    async sendMessage(chatIdArg, text) {
      this.sent = this.sent || [];
      this.sent.push({ chatId: chatIdArg, text });
      return { message_id: 99 };
    }
  };
  const repository = { updateContentByAdminId: async () => null };
  const jobs = [11, 12, 13, 21].map((messageId, index) => queueAnnouncementSync({
    telegram,
    repository,
    content: card({
      adminId: `SB-${index}`,
      announcementRefs: [{ channelId: '-100chan', messageId, kind: 'text', websiteUrl: 'https://site.test/anime/long-march' }]
    }),
    adminId: `SB-${index}`,
    notifyChatId: '-100admin'
  }, { spacingMs: 0, wait: async () => {}, rounds: 2 }));

  await announcementLaneDrained();
  await Promise.all(jobs.filter(Boolean));

  assert.equal(peak, 1, 'one edit at a time is the whole point of the lane');
  const status = announcementSyncStatus();
  assert.equal(status.pending, 0);
  assert.ok(status.totals.retried >= 1, 'the refused edit was counted as a retry, not a silent loss');
  assert.equal(status.stale.length, 0, 'the second round got it through, so nothing is left behind');
  assert.ok(telegram.sent?.length, 'a job that had to be retried tells the publisher what happened');
  assert.match(telegram.sent.at(-1).text, /SB-3/);
});

test('a job that never gets through stays listed and says so, instead of vanishing', async () => {
  const telegram = {
    async editMessageText() { throw editError('Too Many Requests: retry after 6', 6); },
    async sendMessage(chatIdArg, text) { this.sent = [...(this.sent || []), { chatId: chatIdArg, text }]; return {}; }
  };
  const job = queueAnnouncementSync({
    telegram,
    repository: { updateContentByAdminId: async () => null },
    content: card(),
    adminId: 'SB-STUCK9',
    notifyChatId: '-100admin'
  }, { spacingMs: 40, wait: async () => {}, rounds: 2 });

  await job;
  const status = announcementSyncStatus();
  assert.deepEqual(status.stale.map((entry) => entry.key), ['SB-STUCK9'], 'still listed after the last round');
  assert.equal(status.stale[0].failed, 1);
  assert.match(telegram.sent.at(-1).text, /SB-STUCK9/);
  assert.match(telegram.sent.at(-1).text, /\/sync/);
  assert.match(telegram.sent.at(-1).text, /catalog card is already correct/);
});

test('deletions obey the same rules: wait, keep, and treat a missing post as gone', async () => {
  const references = [{ channelId: '-100chan', messageId: 5 }, { channelId: '-100chan', messageId: 6 }];
  const waits = [];
  let attempts = 0;
  const result = await deleteAnnouncementMessages({
    telegram: {
      async deleteMessage(chatIdArg, messageIdArg) {
        attempts += 1;
        if (messageIdArg === 5 && attempts === 1) throw editError('Too Many Requests: retry after 3', 3);
        if (messageIdArg === 6) throw editError('Bad Request: message to delete not found');
        return true;
      }
    },
    references,
    options: { spacingMs: 0, wait: async (ms) => { waits.push(ms); } }
  });
  assert.equal(result.deleted, 1, 'the refused deletion went through on the retry');
  assert.equal(result.gone, 1, 'a post already deleted by hand is not retried');
  assert.equal(result.failed, 0);
  assert.deepEqual(waits, [3_000]);
  assert.equal(announcementSyncStatus().totals.deleted, 1);
});

test('a queued deletion keeps the merge result honest without waiting on the channel', async () => {
  const content = card({ adminId: 'SB-SOURCE1', announcementRefs: [{ channelId: '-100chan', messageId: 7, kind: 'text' }] });
  const patches = [];
  const job = queueAnnouncementDeletion({
    telegram: { async deleteMessage() { return true; } },
    repository: { updateContentByAdminId: async (adminId, patch) => { patches.push({ adminId, patch }); return null; } },
    content,
    references: content.announcementRefs
  }, { detached: true, spacingMs: 0, wait: async () => {} });
  assert.equal(job, null, 'a detached job returns nothing so the caller can answer at once');
  await announcementLaneDrained();
  assert.deepEqual(patches[0].patch.announcementRefs, [], 'the absorbed card forgets a message that no longer exists');
});

test('a refused edit says which kind of refusal it was', () => {
  assert.deepEqual(classifyAnnouncementEditFailure('Bad Request: MESSAGE_AUTHOR_INVALID: bots can\u2019t edit messages sent by other bots'), {
    kind: 'unsyncable', reason: 'the copy was posted by another account, so no bot can rewrite it'
  });
  assert.equal(classifyAnnouncementEditFailure('Forbidden: bot is not a member of the channel').kind, 'rights');
  assert.equal(classifyAnnouncementEditFailure('Too Many Requests: retry after 6 seconds').kind, 'retry', 'a flood wait is not a permanent answer');
  assert.equal(classifyAnnouncementEditFailure('Bad Request: message is not modified').kind, 'retry');
});

test('a corrected title re-matches the artwork and updates the card, its backdrop, and the channel copy', async () => {
  const patches = [];
  const announced = [];
  const repository = {
    async updateContentByAdminId(adminId, patch) {
      patches.push({ adminId, patch });
      return { adminId, ...patch, announcementRefs: [{ channelId: '-100chan', messageId: 11, kind: 'photo' }] };
    }
  };
  const job = queuePosterRematchForTitle({
    repository,
    config: { imgbbApiKey: 'k' },
    content: { adminId: 'SB-AAA111', title: 'Vampires Of The Velvet Lounge', category: 'anime', posterUrl: null, poster: { source: 'generated-fallback', title: 'untitled 001' } },
    telegram: { editMessageMedia: async () => { announced.push('media'); return {}; } },
    find: async () => ({ matched: true, posterOriginalUrl: 'https://image.test/poster.jpg' }),
    prepare: async () => ({ buffer: Buffer.from('png'), contentType: 'image/png', sourceUrl: 'https://image.test/poster.jpg' }),
    host: async () => ({ url: 'https://i.ibb.co/new.png', providerId: 'new', originalUrl: 'https://image.test/poster.jpg', source: 'remote-mirror' })
  });
  assert.ok(job, 'a card with no matched artwork is exactly what this is for');
  const outcome = await job;
  assert.equal(outcome.updated, 1);
  assert.equal(patches[0].patch.posterUrl, 'https://i.ibb.co/new.png');
  assert.equal(patches[0].patch.backdropUrl, 'https://i.ibb.co/new.png', 'the card and its page art move together');
  assert.equal(patches[0].patch.poster.title, 'Vampires Of The Velvet Lounge', 'the artwork remembers the title it was matched under');
  await announcementLaneDrained();
  assert.deepEqual(announced, ['media'], 'the channel post is edited with the same fix, through the lane');
});

test('a poster chosen by hand is never re-matched away, and a busy ImgBB defers instead of failing', async () => {
  let saved = null;
  const untouched = queuePosterRematchForTitle({
    repository: { updateContentByAdminId: async () => ({}) },
    content: { adminId: 'SB-BBB222', title: 'Gold', category: 'movie', posterUrl: 'https://i.ibb.co/chosen.png', poster: { source: 'remote-mirror', title: 'Gold' }, description: 'Written by the publisher.', year: 2023, genres: ['Action'] },
    find: async () => ({ matched: true, posterOriginalUrl: 'https://image.test/other.jpg' })
  });
  assert.equal(untouched, null, 'the title still matches the title the artwork was found under and the card already carries its details, so nothing is re-searched');

  // The same card with no synopsis does get looked up — but only for its text. Artwork that was
  // chosen by hand is never searched away, however tempting the provider's poster looks next to it.
  const detailsOnly = await queuePosterRematchForTitle({
    repository: {
      async updateContentByAdminId(adminId, patch) {
        saved = patch;
        return { adminId, ...patch };
      }
    },
    content: {
      adminId: 'SB-BBB223',
      title: 'Gold',
      category: 'movie',
      posterUrl: 'https://i.ibb.co/chosen.png',
      poster: { source: 'remote-mirror', title: 'Gold' },
      description: '',
      year: null,
      genres: []
    },
    find: async () => ({ matched: true, posterOriginalUrl: 'https://image.test/other.jpg', description: 'A synopsis from the provider.', year: 2024, genres: ['Drama', 'History'], status: 'Ongoing' })
  });
  assert.equal(detailsOnly.updated, 1, 'the card\u2019s missing details are filled from the same lookup that found the artwork');
  assert.equal(saved.description, 'A synopsis from the provider.');
  assert.equal(saved.year, 2024);
  assert.deepEqual(saved.genres, ['Drama', 'History']);
  assert.equal(saved.status, 'Ongoing', 'and a card with no status at all takes the provider\u2019s, rather than showing the default');
  assert.equal(saved.posterUrl, undefined, 'the hand-picked artwork is left exactly where it was');

  const deferred = await queuePosterRematchForTitle({
    repository: { updateContentByAdminId: async () => { throw new Error('must not be called'); } },
    content: { adminId: 'SB-CCC333', title: 'Oculus', category: 'movie', posterUrl: null, poster: { source: 'generated-fallback' } },
    find: async () => ({ matched: true, posterOriginalUrl: 'https://image.test/poster.jpg' }),
    prepare: async () => ({ buffer: Buffer.from('png'), contentType: 'image/png', sourceUrl: 'https://image.test/poster.jpg' }),
    host: async () => { throw new PosterRateLimitError('Rate limit reached.'); }
  });
  assert.equal(deferred.skipped, 1);
  assert.match(deferred.reason, /rate limiting/, 'the publisher is told the artwork is on the poster queue rather than that it failed');
});

test('a refused copy is left alone on the next sweep until the card changes', async () => {
  const refused = recorder([editError('Forbidden: bot is not a member of the channel')]);
  const patches = [];
  const repository = {
    async updateContentByAdminId(adminId, patch) {
      patches.push(patch);
      return { ...card(), ...patch };
    }
  };
  const first = await syncPublishedAnnouncements({
    telegram: refused.telegram,
    repository,
    content: card(),
    options: { spacingMs: 0, wait: refused.wait }
  });
  assert.equal(first.blocked, 1);
  const remembered = patches[0].announcementRefs[0];
  assert.ok(remembered.syncError.signature, 'the refusal remembers exactly what it was asked to say');

  // The next sweep of the same card therefore costs no Telegram call at all. That is the difference
  // between /sync go being one pass over the archive and a publisher repeating it until the bot is
  // rate limited.
  const second = recorder([editError('this must never be reached')]);
  const again = await syncPublishedAnnouncements({
    telegram: second.telegram,
    repository: { updateContentByAdminId: async () => null },
    content: { ...card(), announcementRefs: [remembered] },
    options: { spacingMs: 0, wait: second.wait }
  });
  assert.deepEqual(second.calls, [], 'a refusal that cannot change is not re-attempted');
  assert.equal(again.skipped, 1);
  assert.equal(again.blocked, 0, 'and it is not counted as a fresh failure, so no warning is repeated');
  assert.equal(again.failed, 0);

  // The moment the card says something different, the same message is worth trying again.
  const third = recorder([{}]);
  const changed = await syncPublishedAnnouncements({
    telegram: third.telegram,
    repository: { updateContentByAdminId: async () => null },
    content: { ...card(), title: 'A Different Release', announcementRefs: [remembered] },
    options: { spacingMs: 0, wait: third.wait }
  });
  assert.equal(third.calls.length, 1, 'a new caption is a new request, so it is made once');
  assert.equal(changed.updated, 1);
  const websiteUrl = card().announcementRefs[0].websiteUrl;
  assert.equal(card().posterUrl, null, 'the fixture card carries no artwork');
  assert.ok(announcementRefIsDeferred(remembered, { caption: announcementCaption(card()), link: websiteUrl, posterUrl: card().posterUrl }), 'the same card, the same copy - deferred');
  assert.equal(announcementRefIsDeferred(remembered, { caption: 'other', link: null, posterUrl: null }), false);
});

test('the sweep says what it checked and never asks Telegram about a card that already matches', async () => {
  const reference = (over) => ({ channelId: '-100chan', messageId: 11, kind: 'text', ...over });
  const upToDate = { ...card(), announcementRefs: [reference({ caption: announcementCaption(card()), posterUrl: null })] };
  const behind = { ...card(), adminId: 'SB-BBB222', title: 'Old Name', announcementRefs: [reference({ messageId: 12, caption: 'something else entirely' })] };

  const sweep = await sweepAnnouncedCards({ repository: {}, list: [upToDate, behind] });
  assert.equal(sweep.checked, 2, 'the report has to say how much was looked at, not only what changed');
  assert.equal(sweep.matching, 1);
  assert.equal(sweep.stale.length, 1);
  assert.equal(sweep.stale[0].content.adminId, 'SB-BBB222');
  assert.equal(sweep.refs, 1);
  assert.ok(Number.isFinite(sweep.elapsedMs));

  const deferredReference = reference({
    messageId: 12,
    caption: 'something else entirely',
    syncError: { blocked: true, reason: 'no rights', signature: announcementSignature({ caption: announcementCaption(behind), link: null, posterUrl: card().posterUrl }) }
  });
  const leftAlone = await sweepAnnouncedCards({ repository: {}, list: [{ ...behind, announcementRefs: [deferredReference] }] });
  assert.equal(leftAlone.stale.length, 0, 'a card this bot cannot refresh is not offered as work to do');
  assert.equal(leftAlone.leftAlone, 1);
  assert.equal(leftAlone.deferred, 1);
  assert.equal(leftAlone.matching, 0, 'it is not "already correct" either: the copy is behind, and only the reason is settled');
});

test('a text-only channel copy gets its artwork attached, and a refusal is remembered not chased', async () => {
  const fixture = recorder([
    editError('Bad Request: wrong file identifier/HTTP URL specified'),
    {}
  ]);
  const saved = [];
  const withArt = card({ posterUrl: 'https://img.test/new.jpg' });
  const first = await syncPublishedAnnouncements({
    telegram: fixture.telegram,
    repository: { updateContentByAdminId: async (adminId, patch) => { saved.push(patch); return null; } },
    content: withArt,
    options: { spacingMs: 0, wait: fixture.wait }
  });
  assert.equal(first.upgradeFailed, 1, 'the photo was refused');
  assert.equal(first.updated, 1, 'and the caption was still corrected');
  assert.equal(fixture.calls[0].method, 'editMessageMedia', 'a text copy of a card with artwork is asked for a photo first');
  assert.match(saved[0].announcementRefs[0].posterUpgrade.reason, /wrong file identifier/);
  assert.equal(saved[0].announcementRefs[0].kind, 'text', 'it stays a text post, because that is what Telegram has');

  const quiet = recorder([{}]);
  const second = await syncPublishedAnnouncements({
    telegram: quiet.telegram,
    repository: { updateContentByAdminId: async () => null },
    content: { ...withArt, announcementRefs: saved[0].announcementRefs },
    options: { spacingMs: 0, wait: quiet.wait }
  });
  assert.deepEqual(quiet.calls, [], 'the same refusal is not bought twice');
  assert.equal(second.unchanged, 1);

  const tried = recorder([{}, {}]);
  const third = await syncPublishedAnnouncements({
    telegram: tried.telegram,
    repository: { updateContentByAdminId: async () => null },
    content: { ...withArt, title: 'Renamed Again', announcementRefs: saved[0].announcementRefs },
    options: { spacingMs: 0, wait: tried.wait }
  });
  assert.equal(third.promoted, 1, 'a new caption is a new request, and the photo is worth trying again');
  assert.equal(tried.calls[0].method, 'editMessageMedia');

  const promoted = recorder([{}, {}]);
  const fourth = await syncPublishedAnnouncements({
    telegram: promoted.telegram,
    repository: { updateContentByAdminId: async () => null },
    content: { ...withArt, announcementRefs: [{ channelId: '-100chan', messageId: 11, kind: 'text', websiteUrl: 'https://site.test/anime/long-march' }] },
    options: { spacingMs: 0, wait: promoted.wait }
  });
  assert.equal(fourth.promoted, 1);
  assert.equal(fourth.updated, 1);
  assert.match(announcementSyncNote(fourth), /text-only copy was given their artwork for the first time/);
});

test('a refresh reads the card as it is now, not as it was when the job was queued', async () => {
  const fresh = card({ title: 'Long March Final', posterUrl: 'https://img.test/better.jpg' });
  const fixture = recorder([{}, {}]);
  const stale = { ...card(), title: 'Long March Old Name', announcementRefs: [{ channelId: '-100chan', messageId: 11, kind: 'text', websiteUrl: 'https://site.test/anime/long-march' }] };
  const sync = await syncPublishedAnnouncements({
    telegram: fixture.telegram,
    repository: {
      findContentByAdminId: async () => fresh,
      updateContentByAdminId: async () => null
    },
    content: stale,
    options: { spacingMs: 0, wait: fixture.wait }
  });
  assert.equal(sync.updated, 1);
  const caption = fixture.calls[0].args[3].caption;
  assert.match(caption, /Long March Final/, 'the queued snapshot was a minute old; the channel must not be written from it');
  assert.doesNotMatch(caption, /Long March Old Name/);
});
