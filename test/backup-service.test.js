import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { createAndSendBackup, createSignedBackupArchive, indiaMonthKey, readSignedBackupArchive } from '../src/server/services/backup-service.js';
import { runMonthlyBackup } from '../src/server/services/telegram-bot.js';

const secret = 'a stable backup secret for tests';

function backupConfig() {
  return {
    telegram: { storageChannelId: '-100900' },
    backup: {
      signingSecret: secret,
      monthlyEnabled: true,
      maxBytes: 1024 * 1024,
      maxUncompressedBytes: 4 * 1024 * 1024,
      timeoutMs: 1_000
    }
  };
}

test('signed portable backup round-trips application data and rejects tampering', async () => {
  const source = new MemoryCatalogRepository([]);
  const post = await source.createContent({
    title: 'Recoverable release', category: 'movie', languages: ['Hindi'], subtitleLanguages: ['English'],
    files: [{ storageMessageId: 12, name: 'release.mkv' }]
  });
  await source.createRequest({ requestText: 'Recover this request', requester: { id: 200, first_name: 'Viewer' } });
  await source.addAnnouncementChannel({ channelId: '-100901', title: 'Announcements' });
  await source.recordSiteVisit({ visitorId: 'anonymous-visitor', path: '/' });
  const snapshot = await source.exportBackupData();
  const archive = createSignedBackupArchive({
    data: snapshot,
    signingSecret: secret,
    createdAt: '2026-09-01T01:02:03.000Z'
  });
  const decoded = readSignedBackupArchive({
    archive,
    signingSecret: secret,
    options: { maxBytes: 1024 * 1024, maxUncompressedBytes: 4 * 1024 * 1024 }
  });
  assert.equal(decoded.createdAt, '2026-09-01T01:02:03.000Z');
  assert.equal(decoded.data.collections.content[0].adminId, post.adminId);

  const replacement = new MemoryCatalogRepository([]);
  const counts = await replacement.restoreBackupData(decoded.data);
  assert.equal(counts.content, 1);
  assert.equal((await replacement.findContentByAdminId(post.adminId)).title, 'Recoverable release');
  assert.equal((await replacement.listRequests({ limit: 10 })).length, 1);
  assert.equal((await replacement.listAnnouncementChannels()).length, 1);

  assert.throws(
    () => readSignedBackupArchive({ archive, signingSecret: 'wrong but long backup secret' }),
    /signature/i
  );
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(
    () => readSignedBackupArchive({ archive: tampered, signingSecret: secret }),
    /readable SoraBox backup|signature/i
  );
});

test('manual backup sends one compressed document only to the configured private storage channel', async () => {
  const repository = new MemoryCatalogRepository([]);
  await repository.createContent({ title: 'Backup file', category: 'movie', files: [] });
  const calls = [];
  const result = await createAndSendBackup({
    repository,
    telegram: {
      async sendDocument(channelId, input, options) {
        calls.push({ channelId, input, options });
        return { message_id: 7 };
      }
    },
    storageChannelId: '-100900',
    signingSecret: secret,
    options: { maxBytes: 1024 * 1024 },
    createdAt: '2026-09-01T03:00:00.000Z'
  });
  assert.equal(result.document.message_id, 7);
  assert.equal(calls[0].channelId, '-100900');
  assert.match(result.filename, /^sorabox-backup-.*\.json\.gz$/);
  assert.match(calls[0].options.caption, /signed application backup/i);
});

test('monthly backups use an India calendar month and a durable once-per-month claim', async () => {
  const repository = new MemoryCatalogRepository([]);
  const sent = [];
  const bot = {
    telegram: {
      async sendDocument(channelId, input) {
        sent.push({ channelId, input });
        return { message_id: sent.length };
      }
    }
  };
  const config = backupConfig();
  assert.equal(indiaMonthKey('2026-08-31T18:30:00.000Z'), '2026-09');

  const first = await runMonthlyBackup({ bot, repository, config, now: new Date('2026-08-31T18:30:00.000Z') });
  const again = await runMonthlyBackup({ bot, repository, config, now: new Date('2026-09-15T10:00:00.000Z') });
  const next = await runMonthlyBackup({ bot, repository, config, now: new Date('2026-09-30T18:30:00.000Z') });
  assert.equal(first.sent, true);
  assert.equal(again.sent, false);
  assert.equal(next.sent, true);
  assert.equal(sent.length, 2);
  assert.equal((await repository.getBackupSettings()).lastBackupMonth, '2026-10');
});
