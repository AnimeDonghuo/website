import crypto from 'node:crypto';
import { magnetContentRevision } from './subsplease-service.js';

const PAGE_SIZE = 10;
const TTL_MS = 15 * 60_000;

export function uploadedMagnetEpisodes(item) {
  const groups = new Map();
  for (const file of item.fileChoices || []) {
    const start = Number(file.episode?.start);
    const end = Number(file.episode?.end || start);
    const season = Number(file.season || file.episode?.season || file.seasonPack) || null;
    const numbered = Number.isInteger(start) && start >= 1 && end >= start;
    if (!numbered && !file.seasonPack) continue;
    const key = [season, numbered ? start : 'pack', numbered ? end : 'pack'].join(':');
    if (!groups.has(key)) groups.set(key, {
      label: `${season ? `S${String(season).padStart(2, '0')} · ` : ''}${numbered ? (start === end ? `Episode ${start}` : `Episodes ${start}–${end}`) : 'Season pack'}`,
      positions: [], qualities: new Set()
    });
    const group = groups.get(key);
    group.positions.push(file.position);
    if (file.quality) group.qualities.add(file.quality);
  }
  return [...groups.values()].map((group) => ({ ...group, qualities: [...group.qualities] }));
}

// Opaque callbacks are tied to the publisher/chat and the exact upload revision.
// A renamed post, changed file list, another publisher, or an expired keyboard
// cannot accidentally search an episode using the wrong index or override name.
export function createTelegramMagnetFlow({ repository, subsPlease, serialize, now = Date.now }) {
  const sessions = new Map();
  const owner = (ctx) => `${ctx.chat?.id}:${ctx.from?.id}`;
  const keyboard = (token, session, page) => {
    const lastPage = Math.max(0, Math.ceil(session.groups.length / PAGE_SIZE) - 1);
    page = Math.max(0, Math.min(page, lastPage));
    const rows = session.groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((group, index) => [{
      text: `${group.label} · ${group.qualities.join(', ') || 'unknown quality'}`.slice(0, 100),
      callback_data: `mg:ep:${token}:${page * PAGE_SIZE + index}`
    }]);
    const navigation = [];
    if (page) navigation.push({ text: '← Previous', callback_data: `mg:page:${token}:${page - 1}` });
    if (page < lastPage) navigation.push({ text: 'Next →', callback_data: `mg:page:${token}:${page + 1}` });
    if (navigation.length) rows.push(navigation);
    return { reply_markup: { inline_keyboard: rows } };
  };
  return {
    async open(ctx, argument) {
      const match = String(argument || '').trim().match(/^(SB-[A-F0-9]{10})(?:\s+(.{1,180}))?$/i);
      if (!match) { await ctx.reply('Usage: /search SB-0123ABCDEF\nOr /searchm SB-0123ABCDEF SubsPlease anime title'); return; }
      if (!subsPlease || !serialize) { await ctx.reply('Magnet search is temporarily unavailable.'); return; }
      const content = await repository.findContentByAdminId(match[1].toUpperCase());
      if (!content) { await ctx.reply('That Post ID was not found.'); return; }
      if (content.category !== 'anime') { await ctx.reply('Magnet search is only available for anime posts.'); return; }
      const groups = uploadedMagnetEpisodes(serialize(content));
      if (!groups.length) { await ctx.reply('This post has no indexed uploaded episodes or season packs. Correct its episode metadata first.'); return; }
      for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
      if (sessions.size >= 500) sessions.delete(sessions.keys().next().value);
      const token = crypto.randomBytes(6).toString('hex');
      const session = { owner: owner(ctx), adminId: content.adminId, revision: magnetContentRevision(content), searchTitle: match[2]?.trim() || null, groups, expires: now() + TTL_MS, busy: false };
      sessions.set(token, session);
      await ctx.reply(`${content.adminId} · ${content.title}\nChoose an episode you uploaded to retry its SubsPlease search.${session.searchTitle ? `\nSearch title: ${session.searchTitle}` : ''}\nAutomatic matching already checks all uploaded episodes.`, keyboard(token, session, 0));
    },
    async action(ctx) {
      const match = String(ctx.callbackQuery?.data || '').match(/^mg:(ep|page):([a-f0-9]{12}):(\d{1,5})$/);
      if (!match) return;
      const [, action, token, rawIndex] = match;
      const session = sessions.get(token);
      if (!session || session.expires <= now() || session.owner !== owner(ctx)) {
        await ctx.answerCbQuery('This picker expired or belongs to another publisher. Send /searchm again.'); return;
      }
      const content = await repository.findContentByAdminId(session.adminId);
      if (!content || content.category !== 'anime' || magnetContentRevision(content) !== session.revision) {
        sessions.delete(token);
        await ctx.answerCbQuery('This post changed. Send /searchm again for the current episodes.'); return;
      }
      if (action === 'page') {
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(keyboard(token, session, Number(rawIndex)).reply_markup); return;
      }
      const group = session.groups[Number(rawIndex)];
      if (!group) { await ctx.answerCbQuery('That episode is unavailable.'); return; }
      if (session.busy) { await ctx.answerCbQuery('A search is already running for this picker.'); return; }
      session.busy = true;
      await ctx.answerCbQuery('Searching SubsPlease…');
      try {
        const item = serialize(content);
        item.fileChoices = item.fileChoices.filter((file) => group.positions.includes(file.position));
        const result = await subsPlease.resolve(item, content, { force: true, searchTitle: session.searchTitle });
        const current = await repository.findContentByAdminId(session.adminId);
        if (!current || magnetContentRevision(current) !== session.revision) {
          await ctx.reply('This post changed while searching. No title override was saved. Send /searchm again.'); return;
        }
        const found = result.item.fileChoices.filter((file) => file.magnet);
        if (!found.length) {
          await ctx.reply(result.state === 'unavailable'
            ? 'SubsPlease lookup is temporarily unavailable. Retry shortly; existing downloads were not changed.'
            : `${group.label}: no exact episode/range and quality match found.\nTry /searchm ${session.adminId} SubsPlease anime title`);
          return;
        }
        if (session.searchTitle) await repository.saveSubsPleaseOverride(session.adminId, { title: content.title, category: content.category, searchTitle: session.searchTitle });
        const qualities = [...new Set(found.map((file) => file.magnet.quality))];
        const missing = result.item.fileChoices.filter((file) => !file.magnet).map((file) => file.quality || 'unknown quality');
        await ctx.reply(`${session.adminId} · ${group.label}\nFound: ${qualities.join(', ')}. Magnet buttons are available on the site after reload.${missing.length ? `\nNo match: ${[...new Set(missing)].join(', ')}.` : ''}${session.searchTitle ? '\nSaved this SubsPlease search title for the post’s other uploaded episodes too. The catalog title was not changed.' : ''}`);
      } catch {
        await ctx.reply('Magnet search could not finish. Please retry; your catalog files were not changed.');
      } finally { session.busy = false; }
    }
  };
}
