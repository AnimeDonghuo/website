import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { toPublicContent } from '../src/server/index.js';
import { createTelegramMagnetFlow, uploadedMagnetEpisodes } from '../src/server/services/telegram-magnets.js';
import { createSubsPleaseService } from '../src/server/services/subsplease-service.js';

const config = { telegram: { botUsername: 'DeliveryBot' } };
async function setup(count = 3) {
  const repository = new MemoryCatalogRepository([]);
  const saved = await repository.createContent({ title: 'Uploaded Anime', category: 'anime', files: Array.from({ length: count }, (_, index) => ({ name: `Uploaded Anime S01E${index + 1} 480p.mkv`, quality: '480p', episode: { start: index + 1, end: index + 1, label: `Episode ${index + 1}` }, storageMessageId: index + 1, storageChannelId: '-1001' })) });
  const replies = [];
  const answers = [];
  const ctx = { chat: { id: 4 }, from: { id: 5 }, reply: async (text, extra) => replies.push({ text, extra }), answerCbQuery: async (text) => answers.push(text), editMessageReplyMarkup: async (markup) => replies.push({ markup }) };
  return { repository, saved, replies, answers, ctx, serialize: (content) => toPublicContent(content, config) };
}
function callback(fixture, row = 0) {
  fixture.ctx.callbackQuery = { data: fixture.replies[0].extra.reply_markup.inline_keyboard[row][0].callback_data };
}

test('picker groups qualities per uploaded episode and supports packs without inventing missing episodes', () => {
  const groups = uploadedMagnetEpisodes({ fileChoices: [
    { position: 1, season: 1, episode: { start: 1, end: 1 }, quality: '480p' },
    { position: 2, season: 1, episode: { start: 1, end: 1 }, quality: '720p' },
    { position: 3, season: 1, episode: { start: 3, end: 3 }, quality: '480p' },
    { position: 4, seasonPack: 2, quality: '1080p' },
    { position: 5, quality: '480p' }
  ] });
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].positions, [1, 2]);
  assert.deepEqual(groups[0].qualities, ['480p', '720p']);
  assert.match(groups[1].label, /Episode 3/);
  assert.match(groups[2].label, /Season pack/);
});

test('manual title retry searches only the selected episode, then saves a scoped override', async () => {
  const f = await setup();
  let options;
  const flow = createTelegramMagnetFlow({ ...f, subsPlease: { resolve: async (item, source, opts) => {
    options = opts;
    assert.equal(item.fileChoices.length, 1);
    assert.equal(item.fileChoices[0].episode.start, 2);
    return { state: 'ready', item: { ...item, fileChoices: item.fileChoices.map((file) => ({ ...file, magnet: { quality: '480p' } })) } };
  } } });
  await flow.open(f.ctx, `${f.saved.adminId} SubsPlease Anime`);
  callback(f, 1);
  await flow.action(f.ctx);
  assert.deepEqual(options, { force: true, searchTitle: 'SubsPlease Anime' });
  assert.equal((await f.repository.findSubsPleaseOverride(f.saved.adminId)).searchTitle, 'SubsPlease Anime');
  assert.equal((await f.repository.findContentByAdminId(f.saved.adminId)).title, 'Uploaded Anime');
  assert.match(f.replies.at(-1).text, /Found: 480p/);
});

test('not-found searches never save overrides; other users, expired and stale keyboards cannot run searches', async () => {
  const f = await setup();
  let time = 0;
  let calls = 0;
  const flow = createTelegramMagnetFlow({ ...f, now: () => time, subsPlease: { resolve: async (item) => { calls += 1; return { item, state: 'not-found' }; } } });
  await flow.open(f.ctx, `${f.saved.adminId} Unknown Anime`);
  callback(f);
  f.ctx.from.id = 6;
  await flow.action(f.ctx);
  assert.equal(calls, 0);
  f.ctx.from.id = 5;
  await flow.action(f.ctx);
  assert.equal(calls, 1);
  assert.equal(await f.repository.findSubsPleaseOverride(f.saved.adminId), null);
  assert.match(f.replies.at(-1).text, /\/searchm/);
  time = 16 * 60_000;
  await flow.action(f.ctx);
  assert.equal(calls, 1);
  time = 0;
  await f.repository.updateContentByAdminId(f.saved.adminId, { title: 'Different anime' });
  await flow.action(f.ctx);
  assert.equal(calls, 1);
  assert.match(f.answers.at(-1), /post changed/);
});

test('long episode lists have pagination and non-anime cards are refused', async () => {
  const f = await setup(23);
  const flow = createTelegramMagnetFlow({ ...f, subsPlease: {} });
  await flow.open(f.ctx, f.saved.adminId);
  assert.equal(f.replies[0].extra.reply_markup.inline_keyboard.length, 11);
  callback(f, 10);
  await flow.action(f.ctx);
  assert.match(f.replies.at(-1).markup.inline_keyboard[0][0].text, /Episode 11/);
  await f.repository.updateContentByAdminId(f.saved.adminId, { category: 'movie' });
  await flow.open(f.ctx, f.saved.adminId);
  assert.match(f.replies.at(-1).text, /only available for anime/);
});

test('saved manual title applies automatically to every uploaded episode and is ignored after rename', async () => {
  const f = await setup();
  await f.repository.saveSubsPleaseOverride(f.saved.adminId, { title: f.saved.title, category: 'anime', searchTitle: 'SubsPlease Anime' });
  const service = createSubsPleaseService({ repository: f.repository, logger: { warn() {} }, fetchImpl: async (url) => {
    const query = new URL(url).searchParams.get('s');
    if (query !== 'SubsPlease Anime') return new Response('[]');
    const payload = Object.fromEntries([1, 2, 3].map((episode) => [episode, { show: 'SubsPlease Anime', episode: String(episode), downloads: [{ res: '480', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }] }]));
    return new Response(JSON.stringify(payload));
  } });
  const result = await service.resolve(f.serialize(f.saved), f.saved);
  assert.ok(result.item.fileChoices.every((file) => file.magnet));
  assert.equal(result.item.title, f.saved.title);
  const updated = await f.repository.updateContentByAdminId(f.saved.adminId, { title: 'New Anime' });
  const renamed = await service.resolve(f.serialize(updated), updated);
  assert.ok(renamed.item.fileChoices.every((file) => !file.magnet));
  await service.stop();
});

test('file buttons keep a safe gap and tap target; successful explanatory prose is removed', async () => {
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.file-choice__actions \{ flex-wrap: wrap; max-width: 170px; gap: 12px; \}/);
  assert.match(css, /\.file-choice__actions \.file-choice__action \{ min-height: 44px; \}/);
  const app = await readFile(new URL('../src/client/App.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /audio\/subtitles may differ|Magnet links open your torrent app/);
});

test('only searchm opens the magnet picker; search keeps title and ID catalog lookup', async () => {
  const source = await readFile(new URL('../src/server/services/telegram-bot.js', import.meta.url), 'utf8');
  const search = source.slice(source.indexOf("  bot.command('search',"), source.indexOf("  bot.command('posts',"));
  assert.match(search, /repository\.listContent\(\{ query, limit: 24, includeAdminId: true \}\)/);
  assert.doesNotMatch(search, /magnetFlow|findContentByAdminId/);
  const searchm = source.slice(source.indexOf("  bot.command('searchm',"), source.indexOf("  bot.action(\/\^mg:"));
  assert.match(searchm, /magnetFlow\.open/);
  const f = await setup();
  const flow = createTelegramMagnetFlow({ ...f, subsPlease: {} });
  await flow.open(f.ctx, '');
  assert.match(f.replies[0].text, /Usage: \/searchm /);
  assert.doesNotMatch(f.replies[0].text, /\/search /);
});
