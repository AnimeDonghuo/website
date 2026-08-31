import test from 'node:test';
import assert from 'node:assert/strict';
import { fileFromMessage, storageErrorHint, storeMediaInChannel } from '../src/server/services/telegram-bot.js';

test('storage uses a reusable Telegram file ID when copyMessage is refused', async () => {
  const calls = [];
  const telegram = {
    async copyMessage() {
      throw { description: "Bad Request: message can't be copied" };
    },
    async sendDocument(destination, fileId, extra) {
      calls.push({ destination, fileId, extra });
      return { message_id: 456 };
    }
  };
  const stored = await storeMediaInChannel(telegram, '-100123', 999, {
    message_id: 12,
    caption: 'Perfect World Ep 01',
    document: { file_id: 'document-file-id', file_name: 'perfect-world.mkv' }
  });

  assert.deepEqual(stored, { storageMessageId: 456, method: 'file-id-fallback' });
  assert.deepEqual(calls[0], {
    destination: '-100123',
    fileId: 'document-file-id',
    extra: { disable_notification: true, caption: 'Perfect World Ep 01' }
  });
});

test('stored file record keeps the returned storage message ID', () => {
  const file = fileFromMessage(
    {
      message_id: 12,
      caption: 'Lingwu Continent @sourcechannel Episode 204 English Sub',
      video: {
        file_id: 'telegram-file-id',
        file_name: 'Lingwu.Continent.Episode.204.English.Sub.mkv',
        mime_type: 'video/x-matroska',
        file_size: 72_100_000
      }
    },
    987,
    'copy'
  );

  assert.equal(file.storageMessageId, 987);
  assert.equal(file.episode.start, 204);
  assert.equal(file.episode.source, 'caption');
});

test('storage troubleshooting distinguishes protected content and wrong channel IDs', () => {
  assert.match(storageErrorHint({ description: "Bad Request: message can't be copied" }), /protected/i);
  assert.match(storageErrorHint({ description: 'Bad Request: chat not found' }), /numeric -100/i);
});
