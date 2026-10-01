import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  installLongReplyPagination,
  isTelegramHandlerTimeout,
  splitTelegramText,
  storageScrubPreviewText
} from '../src/server/services/telegram-bot.js';

const LIMIT = 4_096;

test('a reply Telegram cannot hold is split, never cut short', () => {
  assert.deepEqual(splitTelegramText('Short answer.'), ['Short answer.'], 'an ordinary reply is left exactly as it was, numbering included not at all');
  assert.deepEqual(splitTelegramText(''), ['']);

  const lines = Array.from({ length: 261 }, (_, index) => `▪ ${13_500 + index} · The Daily Life of the Immortal King S02 E${index + 1} Combined 1080p HEVC BluRay [Hindi + English + Japanese]`);
  const report = lines.join('\n');
  const parts = splitTelegramText(report, 3_800);
  assert.ok(parts.length > 4, 'a 261-file report is several messages');
  assert.ok(parts.every((part) => part.length <= 3_800), 'and every message fits inside Telegram’s limit');
  assert.ok(parts.every((part) => part.length < LIMIT));
  assert.match(parts[0], /^\(1\/\d+\) /, 'the parts say which one of how many they are');
  assert.deepEqual(
    parts.map((part) => part.replace(/^\(\d+\/\d+\) /, '')).join('\n').split('\n'),
    lines,
    'not one line of the list is lost — the ids a publisher has to act on are at the end'
  );

  const oneHugeLine = 'x'.repeat(9_000);
  const forced = splitTelegramText(oneHugeLine, 1_000);
  assert.ok(forced.length >= 9, 'a single line longer than the limit is split mid-line rather than refused');
  assert.ok(forced.every((part) => part.length <= 1_000));
  assert.equal(forced.map((part) => part.replace(/^\(\d+\/\d+\) /, '')).join('').length, oneHugeLine.length);
});

test('a long reply is paginated by the bot itself, so no command has to remember', async () => {
  let middleware = null;
  installLongReplyPagination({ use: (fn) => { middleware = fn; } });
  const sent = [];
  const ctx = {
    async reply(text, extra) { sent.push({ kind: 'reply', text, extra }); return { message_id: 900 + sent.length }; },
    async replyWithHTML(text, extra) { sent.push({ kind: 'html', text, extra }); return { message_id: 950 + sent.length }; },
    async editMessageText(text, extra) { sent.push({ kind: 'edit', text, extra }); return { message_id: 999 }; }
  };
  await middleware(ctx, async () => {});

  const keyboard = { reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.test' }]] }, disable_notification: true };
  const returned = await ctx.reply('Head\n'.concat(Array.from({ length: 400 }, (_, index) => `▪ line ${index}`).join('\n')), keyboard);
  assert.ok(sent.length > 1, 'the long text became more than one message instead of an API error');
  assert.deepEqual(returned, { message_id: 901 }, 'the caller still gets the message it edited later');
  assert.deepEqual(sent[0].extra, keyboard, 'the first message keeps the keyboard and every other option');
  assert.ok(sent.slice(1).every((entry) => entry.extra && !('reply_markup' in entry.extra)), 'the buttons are not repeated under every part');
  assert.ok(sent[0].extra.disable_notification === true, 'the rest of the options do survive');

  sent.length = 0;
  await ctx.reply('short');
  assert.equal(sent.length, 1, 'a short reply is one call, unchanged');
  assert.equal(sent[0].text, 'short');

  sent.length = 0;
  await ctx.replyWithHTML('<b>big</b>\n' + 'z'.repeat(8_000));
  assert.ok(sent.length > 1 && sent[0].kind === 'html', 'the HTML and Markdown variants are wrapped too');

  sent.length = 0;
  await ctx.editMessageText('k'.repeat(8_000));
  assert.equal(sent[0].kind, 'edit');
  assert.match(sent[0].text, /Continued in the message below\.$/);
  assert.ok(sent[0].text.length <= 3_800, 'an edit has one message to work with, so it is clamped…');
  assert.ok(sent.some((entry) => entry.kind === 'reply' && entry.text.length > 100), '…and the remainder is sent as a follow-up rather than dropped');
});

test('a handler that ran out of its time budget is not a failed job', () => {
  assert.equal(isTelegramHandlerTimeout(Object.assign(new Error('Promise timed out after 90000 milliseconds'), { name: 'TimeoutError' })), true);
  assert.equal(isTelegramHandlerTimeout({ message: 'Promise timed out after 90000 milliseconds' }), true);
  assert.equal(isTelegramHandlerTimeout(new Error('Bad Request: message is too long')), false);
  assert.equal(isTelegramHandlerTimeout(new Error('Network request failed')), false);
  assert.equal(isTelegramHandlerTimeout(null), false);
});

test('the sweep names the whole page it is about to read, not three lines of it', () => {
  const targets = Array.from({ length: 80 }, (_, index) => ({
    adminId: `SB-${String(index).padStart(10, '0')}`,
    title: `The Daily Life of the Immortal King season ${index + 1}`,
    channel: '-100db',
    messageId: 13_540 - index
  }));
  const preview = storageScrubPreviewText({ targets, cards: 80, stats: { files: 261, cards: 80, legacyChannel: 12, more: true, capped: true } });
  assert.match(preview, /message 13540/);
  assert.match(preview, /message 13516/, 'the twenty-fifth card is still on the page instead of being cut at three lines');
  assert.ok(!preview.includes('message 13515'), 'and it stops where it says it stops');
  assert.match(preview, /\+55 more not listed here/);
  assert.match(preview, /This preview shows one page of 80 messages/);
});
