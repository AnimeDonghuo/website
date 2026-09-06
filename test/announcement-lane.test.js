import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  announcementCaption,
  announcementLaneDrained,
  announcementReferenceIsCurrent,
  announcementSyncNote,
  announcementSyncStatus,
  deleteAnnouncementMessages,
  queueAnnouncementSync,
  queueAnnouncementDeletion,
  resetAnnouncementLane,
  syncPublishedAnnouncements
} from '../src/server/services/telegram-bot.js';

const card = (overrides = {}) => ({
  adminId: 'SB-AAA111',
  title: 'Long March',
  category: 'anime',
  categoryLabel: 'Anime',
  slug: 'long-march',
  filesCount: 3,
  episodeCount: 3,
  posterUrl: 'https://img.test/poster.jpg',
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
  assert.equal(announcementReferenceIsCurrent({ kind: 'text', caption: 'same' }, { caption: 'same', link: null, posterUrl: 'https://img.test/p.jpg' }), true, 'a text announcement has no artwork to disagree about');
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
  assert.equal(failed.failed, 1, 'a refusal that is not Telegram’s limit is still one attempt, not a loop');
  assert.deepEqual(keptPatches, [], 'a refused edit does not rewrite the reference list');
  assert.match(announcementSyncNote(failed), /waiting on Telegram’s limit and queued for a later round/);
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
