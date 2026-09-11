import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, test } from 'node:test';

import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { CATEGORIES, CATEGORY_IDS, categoryDetails, resolveCategoryId } from '../src/server/lib/strings.js';
import {
  announcementLaneDrained,
  decidePublishCategory,
  inferBatchTitle,
  queuePosterRematchForTitle,
  tidyReleaseTitle,
  handlePostIdLookupMessage,
  inferBatchCategory,
  postIdAnswerText,
  resetAnnouncementLane,
  updatePublishedPost
} from '../src/server/services/telegram-bot.js';
import { categoryFromHints } from '../src/server/services/metadata-service.js';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const STICKY_FILES = [
  { storageMessageId: 701, storageChannelId: '-100kdrama', name: 'Our.Sticky.Love.S01.[Epi.01-06].480p.HEVC.HDRip.mkv' },
  { storageMessageId: 702, storageChannelId: '-100kdrama', name: 'Our.Sticky.Love.S01.[Epi.07-12].480p.HEVC.HDRip.mkv' }
];

function makeContext(telegram = {}, replies = []) {
  return {
    chat: { id: -1002 },
    from: { id: 7, is_bot: false, username: 'publisher' },
    message: {},
    telegram: {
      editMessageMedia: async () => ({ message_id: 601 }),
      editMessageCaption: async () => ({ message_id: 601 }),
      editMessageText: async () => ({ message_id: 601 }),
      ...telegram
    },
    reply: async (text, extra) => {
      replies.push({ text, keyboard: extra?.reply_markup || extra || null });
      return { message_id: 900 + replies.length };
    }
  };
}

beforeEach(async () => {
  resetAnnouncementLane();
  await announcementLaneDrained();
});

// ── the TV & OTT shelf ────────────────────────────────────────────────────────────────────────

test('TV & OTT is a real category with the words publishers use for it', () => {
  const tv = CATEGORIES.find((entry) => entry.id === 'tv');
  assert.ok(tv, 'the catalog has a tv category');
  assert.equal(tv.label, 'TV & OTT', 'both names people use are on the shelf');
  assert.equal(tv.shortLabel, 'TV');
  assert.ok(CATEGORY_IDS.has('tv'));
  assert.equal(categoryDetails('tv').label, 'TV & OTT');

  // Spoken aliases all land on the one shelf; a word that is not a category stays unresolved
  // rather than silently becoming something else.
  for (const spoken of ['tv', 'TV', 'ott', 'OTT', 'tv show', 'tv-series', 'television', 'streaming', 'broadcast']) {
    assert.equal(resolveCategoryId(spoken), 'tv', `${spoken} means the TV & OTT shelf`);
  }
  assert.equal(resolveCategoryId('webseries'), 'web-series', 'the old shorthand still resolves');
  assert.equal(resolveCategoryId('web series'), 'web-series');
  assert.equal(resolveCategoryId('nonsense'), null);
  assert.equal(resolveCategoryId(''), null);
});

test('a caption that names TV or OTT is filed there, and one that does not is only a guess', () => {
  const files = [{ name: 'India.Got.Latent.2026.1080p.WEB-DL.mkv' }];
  assert.deepEqual(
    inferBatchCategory({ title: 'India Got Latent (OTT Premiere)', files, withSignal: true }),
    { category: 'tv', evidence: true },
    'an OTT premiere is evidence, not a guess'
  );
  assert.deepEqual(
    inferBatchCategory({ title: 'Some Release | TV Special', files: [{ name: 'x.mkv' }] , withSignal: true }),
    { category: 'tv', evidence: true }
  );
  const packed = inferBatchCategory({ title: 'Some Release', files: [{ name: 'Some.Release.S01E01.1080p.WEB-DL.TV.mkv' }], withSignal: true });
  assert.equal(packed.evidence, false, 'a release-group tag of TV is not evidence, or every webrip becomes TV');
});

test('the providers decide an evidence-free category, and never overrule a person', async () => {
  const files = [{ name: 'Peerless.Martial.Spirit.S02E18.1080p.mkv' }];
  const chineseSeries = async () => ([{
    provider: 'tmdb',
    score: 0.93,
    type: 'tv',
    originCountry: 'CN',
    genreIds: [16],
    title: 'Peerless Martial Spirit',
    popularity: 900
  }]);

  const decided = await decidePublishCategory({
    title: 'Peerless Martial Spirit',
    files,
    config: { tmdbApiKey: 'test-key' },
    search: chineseSeries
  });
  assert.equal(decided.category, 'donghua', 'a donghua stops being filed as a web series');
  assert.equal(decided.was, 'web-series', 'and the reply can say what it replaced');
  assert.equal(decided.source, 'tmdb');

  const chosen = await decidePublishCategory({
    title: 'Demon Slayer',
    files: [{ name: 'Demon.Slayer.S01E01.1080p.mkv' }],
    chosen: 'anime',
    config: { tmdbApiKey: 'test-key' },
    search: chineseSeries
  });
  assert.equal(chosen.category, 'anime', 'a category picked on the panel or by /batch tv | … outranks a provider');
  assert.equal(chosen.source, 'publisher');

  const offline = await decidePublishCategory({
    title: 'Peerless Martial Spirit',
    files,
    config: {},
    search: chineseSeries
  });
  assert.equal(offline.category, 'web-series', 'with no TMDB key the caption guess stands, because silence is not evidence');

  const argued = await decidePublishCategory({
    title: 'Peerless Martial Spirit (Donghua)',
    files,
    config: { tmdbApiKey: 'test-key' },
    search: async () => [{ provider: 'tmdb', score: 0.99, type: 'movie', title: 'Peerless Martial Spirit', originCountry: 'US' }]
  });
  assert.equal(argued.category, 'donghua', 'a word the publisher typed is never argued with');
});

test('the provider answer is read as a category, country by country', () => {
  const cases = [
    [{ provider: 'anilist', score: 0.9, countryOfOrigin: 'CN', type: 'tv' }, 'donghua'],
    [{ provider: 'anilist', score: 0.9, countryOfOrigin: 'JP', type: 'movie' }, 'anime'],
    [{ provider: 'tmdb', score: 0.9, type: 'tv', originCountry: 'KR' }, 'kdrama'],
    [{ provider: 'tmdb', score: 0.9, type: 'tv', originCountry: 'IN' }, 'tv'],
    [{ provider: 'tmdb', score: 0.9, type: 'movie', originCountry: 'IN' }, 'movie'],
    [{ provider: 'tmdb', score: 0.9, type: 'tv', originCountry: 'US', genreIds: [16] }, 'cartoon'],
    [{ provider: 'tmdb', score: 0.9, type: 'tv', originCountry: 'US' }, 'web-series'],
    [{ provider: 'tmdb', score: 0.3, type: 'tv', originCountry: 'CN' }, null],
    [null, null]
  ];
  for (const [hints, expected] of cases) {
    assert.equal(categoryFromHints({ hints }), expected, JSON.stringify(hints));
  }
});

test('the TV & OTT shelf is wired through the client, both themes, and the player import', () => {
  const app = source('../src/client/App.jsx');
  assert.match(app, /const categoryOrder = \[[^\]]*'tv'/, 'the category order includes the new shelf');
  assert.match(app, /^\s{2}tv: \{ eyebrow:/m, 'the shelf has its own browse copy');
  assert.match(app, /id === 'tv' \? 'TV & OTT'/, 'and the rail spells it out instead of capitalising the id');

  const dark = source('../src/client/styles.css');
  for (const selector of [
    '.category-tile--tv::before',
    '.browse-hero--tv',
    '.category-pill--amber',
    '.shelf-tile__dot--amber',
    '.artwork--amber'
  ]) {
    assert.ok(dark.includes(selector), `${selector} paints the new shelf at night`);
  }
  assert.match(dark, /--amber: #ffc46b;/);
  const light = source('../src/client/styles-light.css');
  assert.match(light, /--amber: #e08a18;/, 'Day mode gets a darker amber, not the night one');
  assert.match(light, /--amber-ink: #7d4301;/, 'and ink that is readable on white');

  assert.match(source('../src/server/services/streaming-service.js'), /resolveCategoryId\(raw\)/, 'a player sheet that says OTT resolves to the same shelf');
  assert.match(source('../src/server/services/poster-service.js'), /^  tv: \[\[/m, 'fallback artwork for this shelf has its own palette');
  assert.match(source('../src/server/services/telegram-bot.js'), /^const PUBLISH_CATEGORIES = \[.*'tv'/m, 'the bot can publish it');
});

// ── a corrected title re-indexes the delivery page ────────────────────────────────────────────

test('a rename re-derives the episode blocks, so the delivery page stops listing episodes as one flat release', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'our sticky love s01 [epi 01-06] [epi 07-12]',
    category: 'kdrama',
    year: 2026,
    files: STICKY_FILES,
    // A photo announcement can only be edited when there is artwork to put back in it.
    posterUrl: 'https://i.ibb.co/sticky.png',
    announcementRefs: [{ channelId: '-1002', messageId: 601, kind: 'photo', caption: 'Old caption' }]
  });
  // The state a card published before this filename shape was understood: the index is written once,
  // and a metadata edit carries it over verbatim. So it is stored flat, on purpose, to be rebuilt.
  const stored = repository.contents.get(created.slug);
  repository.contents.set(created.slug, { ...stored, episodeGroups: [], episodeCount: 0, releaseLabel: '1 release' });
  const stale = await repository.findContentByAdminId(created.adminId);
  assert.deepEqual(stale.episodeGroups, [], 'the card really was stale before the edit');

  const captions = [];
  const replies = [];
  // A photo announcement is edited through its media and a text one through its caption, so both are
  // watched: the point is that the channel copy is rewritten from the rebuilt index.
  const ctx = makeContext({
    // Telegraf takes the caption in the extra object, and a photo post is edited through its media.
    editMessageCaption: async (channelId, messageId, _ignored, extra) => {
      captions.push(extra?.caption || '');
      return { message_id: messageId };
    },
    editMessageMedia: async (channelId, messageId, _ignored, extra) => {
      captions.push(extra?.caption || '');
      return { message_id: messageId };
    }
  }, replies);
  await updatePublishedPost({
    ctx,
    repository,
    config: null,
    argument: `${created.adminId} Our Sticky Love`,
    field: 'title',
    fieldLabel: 'Title',
    rematchPoster: false
  });

  const saved = await repository.findContentByAdminId(created.adminId);
  assert.equal(saved.title, 'Our Sticky Love');
  assert.equal(saved.episodeGroups.length, 2, 'both combined ranges are indexed again from the files');
  assert.equal(saved.episodeCount, 12);
  // The stored label a publisher (or an older build) wrote is never overwritten by a re-index —
  // only the episode attribution is rebuilt — so the shelf headline stays as it was.
  assert.equal(saved.releaseLabel, '1 release', 'a re-index rebuilds the episode index, not the words a person typed');
  const summary = JSON.stringify(saved.episodeGroups);
  assert.match(summary, /"start":1,"end":6/);
  assert.match(summary, /"start":7,"end":12/);
  for (let attempt = 0; attempt < 40 && !captions.length; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.ok(
    captions.some((caption) => caption.includes('Our Sticky Love')),
    `the announcement channel copy is rewritten from the corrected card: ${JSON.stringify(captions)}`
  );
  const remembered = (await repository.findContentByAdminId(created.adminId)).announcementRefs[0];
  assert.match(remembered.caption, /Our Sticky Love/, 'and the card remembers what its channel copy now says');
  assert.match(replies.at(0).text, /re-indexed from their files/, 'and the publisher is told that happened');
});

test('renaming onto a title the catalog already holds offers the merge, Yes or No, instead of a second announcement', async () => {
  const repository = new MemoryCatalogRepository([]);
  const existing = await repository.createContent({
    title: 'Our Sticky Love',
    category: 'kdrama',
    year: 2026,
    files: [STICKY_FILES[0]]
  });
  const newer = await repository.createContent({
    title: 'Newly typed title',
    category: 'kdrama',
    year: 2026,
    files: [STICKY_FILES[1]]
  });
  const replies = [];
  const ctx = makeContext({}, replies);

  await updatePublishedPost({
    ctx,
    repository,
    config: null,
    argument: `${newer.adminId} Our Sticky Love`,
    field: 'title',
    fieldLabel: 'Title',
    rematchPoster: false
  });

  const pending = await repository.findMergePlan(-1002, 7);
  assert.ok(pending?.plan, 'the merge plan is waiting for a tap');
  assert.equal(pending.plan.targetAdminId, existing.adminId, 'the files move into the card that already existed');
  assert.deepEqual(pending.plan.sources.map((entry) => entry.adminId), [newer.adminId]);
  const offer = replies.at(-1);
  assert.match(offer.text, /Merge them\?/);
  assert.match(offer.text, new RegExp(newer.adminId));
  const rows = offer.keyboard.inline_keyboard;
  assert.equal(rows[0].length, 2, 'Yes and No on one row, one tap each');
  assert.deepEqual(rows[0].map((button) => button.text), ['Confirm merge', 'Cancel']);

  // A rename that stays unique offers nothing.
  const lonely = await repository.createContent({ title: 'Solo Card', category: 'kdrama', files: [STICKY_FILES[0]] });
  const quietReplies = [];
  await updatePublishedPost({
    ctx: makeContext({}, quietReplies),
    repository,
    config: null,
    argument: `${lonely.adminId} A Title Nobody Else Has`,
    field: 'title',
    fieldLabel: 'Title',
    rematchPoster: false
  });
  assert.ok(!quietReplies.some((entry) => /Merge them\?/.test(entry.text)), 'no duplicate, no offer');
});

// ── Post IDs a publisher can actually get hold of ──────────────────────────────────────────────

test('a forwarded announcement, a catalog link, and a channel link all answer with the Post ID', async () => {
  const repository = new MemoryCatalogRepository([]);
  const created = await repository.createContent({
    title: 'Our Sticky Love',
    category: 'kdrama',
    year: 2026,
    files: STICKY_FILES,
    announcementRefs: [{ channelId: '-100333', messageId: 4242, kind: 'photo', caption: 'Our Sticky Love' }]
  });
  assert.equal(
    (await repository.findContentByAnnouncementMessage({ channelId: '-100333', messageId: 4242 })).adminId,
    created.adminId,
    'the announcement message walks back to the card'
  );
  assert.equal(await repository.findContentByAnnouncementMessage({ channelId: '-100333', messageId: 999 }), null);
  assert.equal(await repository.findContentByAnnouncementMessage({ messageId: 0 }), null);

  const forwards = [
    { forward_origin: { type: 'channel', chat: { id: -100333, username: 'sora_kdrama' }, message_id: 4242 } },
    { forward_from_chat: { id: -100333, username: 'sora_kdrama' }, forward_from_message_id: 4242 }
  ];
  for (const forwarded of forwards) {
    const replies = [];
    const handled = await handlePostIdLookupMessage(
      { message: forwarded, reply: async (text) => { replies.push(text); } },
      repository,
      null
    );
    assert.equal(handled, true, 'a forwarded post is always answered');
    assert.match(replies[0], new RegExp(`Post ID: ${created.adminId}`));
    assert.match(replies[0], /Our Sticky Love/);
    assert.match(replies[0], /\/title SB-[A-F0-9]{10} New title/);
  }

  const unmatched = [];
  assert.equal(await handlePostIdLookupMessage(
    { message: { forward_origin: { type: 'channel', chat: { id: -100999 }, message_id: 7 } }, reply: async (text) => { unmatched.push(text); } },
    repository,
    null
  ), true, 'an announcement that is not ours is still answered, never swallowed');
  assert.match(unmatched[0], /\/search <title>/);

  const linkReplies = [];
  const slug = created.slug;
  assert.equal(await handlePostIdLookupMessage(
    { message: { text: `https://donghuo.example/kdrama/${slug}` }, reply: async (text) => { linkReplies.push(text); } },
    repository,
    null
  ), true, 'the catalog page link is a Post ID question');
  assert.match(linkReplies[0], new RegExp(created.adminId));

  const channelReplies = [];
  assert.equal(await handlePostIdLookupMessage(
    { message: { text: 'https://t.me/c/100333/4242' }, reply: async (text) => { channelReplies.push(text); } },
    repository,
    null
  ), true, 'and so is the link to the post in the channel');
  assert.match(channelReplies[0], new RegExp(created.adminId));

  const ignored = [];
  assert.equal(await handlePostIdLookupMessage(
    { message: { text: 'Our Sticky Love' }, reply: async (text) => { ignored.push(text); } },
    repository,
    null
  ), false, 'a title typed into a draft is not a lookup');
  assert.deepEqual(ignored, [], 'and nothing is replied to it here');
  assert.equal(await handlePostIdLookupMessage(
    { message: { text: 'https://donghuo.example/pricing' }, reply: async () => {} },
    repository,
    null
  ), false, 'a page that is not a card is passed on');
});

test('the Post ID answer names the card, its shelf, and the commands it works with', () => {
  const text = postIdAnswerText({
    adminId: 'SB-ABC1234567',
    title: 'Our Sticky Love',
    category: 'kdrama',
    year: 2026,
    filesCount: 4
  }, null);
  assert.match(text, /^Post ID: SB-ABC1234567/);
  assert.match(text, /K-Drama · 2026 · 4 files/);
  assert.match(text, /\/poster SB-ABC1234567/);
  assert.match(text, /\/category SB-ABC1234567 tv/);
});

// ── the upload channel's own advertising never becomes part of a name ──────────────────────────

test('a caption that leads with the channel plug still yields the release name, in both flows', () => {
  const caption = '❤️ Join ~ [ @twg]King of Prison (2020) 720p HDRip x264 ESubs [Dual Audio] [Hindi ORG - English].mkv';
  const files = [{ displayName: caption, name: caption }];
  assert.equal(inferBatchTitle(files), 'King of Prison', 'batch title inference');
  const typed = tidyReleaseTitle(caption);
  assert.ok(typed.startsWith('King of Prison'), `a typed title starts at the name: ${typed}`);
  assert.ok(!/\bJoin\b/.test(typed), `no lead-in survives into the title: ${typed}`);
  // Nothing left but the plug is not a title, so the file follows the release above it instead of
  // becoming a card nobody asked for.
  assert.equal(inferBatchTitle([{ displayName: '❤️ Join ~ [@twg]', name: 'x.mkv' }]), '');
});

test('a poster picked from a search looks its details up under the name it was found as', async () => {
  let lookedUp = null;
  let saved = null;
  const outcome = await queuePosterRematchForTitle({
    repository: {
      async updateContentByAdminId(adminId, patch) {
        saved = patch;
        return { adminId, ...patch };
      }
    },
    content: { adminId: 'SB-PICK000001', title: 'Old typed name', category: 'movie', posterUrl: null, poster: null, description: '', year: null, genres: [] },
    lookupTitle: 'Fukra 2',
    find: async (title) => {
      lookedUp = title;
      return {
        matched: true,
        title: 'Fukra 2',
        posterOriginalUrl: 'https://image.test/fukra.jpg',
        description: 'The provider synopsis.',
        year: 2024,
        genres: ['Drama'],
        provider: 'tmdb'
      };
    },
    prepare: async () => ({ buffer: Buffer.from('png'), contentType: 'image/png', sourceUrl: 'https://image.test/fukra.jpg' }),
    host: async () => ({ url: 'https://i.ibb.co/fukra.png', providerId: 'imgbb-1', originalUrl: 'https://image.test/fukra.jpg', source: 'remote-mirror' })
  });
  const result = await outcome;
  assert.equal(result.updated, 1, 'the card was written');
  assert.equal(lookedUp, 'Fukra 2', 'the search name decided which release the details came from');
  assert.equal(saved.description, 'The provider synopsis.');
  assert.equal(saved.year, 2024);
  assert.equal(saved.poster.title, 'Old typed name', 'while the poster keeps the card’s own name, so a pick is never re-searched away later');
});
