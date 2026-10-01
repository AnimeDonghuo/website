import test from 'node:test';
import assert from 'node:assert/strict';
import { detectUploadLanguages, detectUploadSubtitleLanguages, needsMediaTrackInspection, normalizeLanguageLabel, summarizeSubtitleLanguages } from '../src/server/services/episode-service.js';
import { inspectDeferredMediaTracks, isInspectableMediaFile, parseMediaInfoTracks } from '../src/server/services/media-info-service.js';

test('subtitle labels and MediaInfo ISO tags normalize to explicit public languages', () => {
  assert.deepEqual(
    detectUploadSubtitleLanguages({
      caption: 'Dual Audio Hindi + English Subtitles',
      filename: 'release.mkv'
    }),
    ['English']
  );
  assert.deepEqual(
    detectUploadLanguages({
      caption: 'Hindi Audio + English Subtitles',
      filename: 'release.mkv'
    }),
    ['Hindi']
  );
  assert.equal(normalizeLanguageLabel('hi-IN'), 'Hindi');
  assert.equal(normalizeLanguageLabel('cmn'), 'Chinese');
  assert.deepEqual(detectUploadSubtitleLanguages({ caption: 'A Movie CC', filename: 'release.mkv' }), []);
  assert.deepEqual(
    parseMediaInfoTracks({
      media: {
        track: [
          { '@type': 'General' },
          { '@type': 'Audio', Language: 'hin' },
          { '@type': 'Audio', Language_String: 'en-US' },
          { '@type': 'Text', 'Language/String': 'eng' },
          { '@type': 'Text', Language: 'jpn' }
        ]
      }
    }),
    { audioLanguages: ['Hindi', 'English'], subtitleLanguages: ['English', 'Japanese'], tracksFound: true }
  );
  assert.deepEqual(summarizeSubtitleLanguages([{ subtitleLanguages: ['eng', 'Hindi'] }]), ['English', 'Hindi']);
});

test('deferred MediaInfo scan processes ambiguous media serially only after collection and preserves fallback labels', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const files = [
    {
      name: 'release.dual.mkv',
      displayName: 'Release Dual Audio',
      telegramFileId: 'first',
      size: 12,
      kind: 'document',
      languages: [],
      audioLanguages: [],
      subtitleLanguages: [],
      mediaInfo: { status: 'pending' }
    },
    {
      name: 'release.unlabelled.mp4',
      displayName: 'Release',
      telegramFileId: 'second',
      size: 12,
      kind: 'video',
      languages: [],
      audioLanguages: [],
      subtitleLanguages: [],
      mediaInfo: { status: 'pending' }
    }
  ];
  assert.ok(files.every(isInspectableMediaFile));
  assert.ok(files.every(needsMediaTrackInspection));

  const result = await inspectDeferredMediaTracks({
    files,
    mediaInfo: { maxDownloadBytes: 100, maxFiles: 5, timeoutMs: 1_000 },
    downloadFile: async (file) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(`download:${file.telegramFileId}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return Buffer.from('tiny media');
    },
    runMediaInfo: async () => {
      calls.push('mediainfo');
      return JSON.stringify({
        media: {
          track: [
            { '@type': 'Audio', Language: 'hin' },
            { '@type': 'Audio', Language: 'eng' },
            { '@type': 'Text', Language: 'eng' }
          ]
        }
      });
    },
    now: () => '2026-09-01T00:00:00.000Z'
  });

  assert.equal(result.scanned, 2);
  assert.equal(maximumActive, 1);
  assert.deepEqual(calls, ['download:first', 'mediainfo', 'download:second', 'mediainfo']);
  assert.deepEqual(result.files[0].audioLanguages, ['Hindi', 'English']);
  assert.deepEqual(result.files[0].subtitleLanguages, ['English']);
  assert.equal(result.files[0].mediaInfo.status, 'verified');
  assert.equal(result.files[1].languages[0], 'Hindi');
});

test('MediaInfo respects known download caps and leaves an accurate skipped state', async () => {
  let downloaded = 0;
  const result = await inspectDeferredMediaTracks({
    files: [{
      name: 'large.dual.mkv', displayName: 'Large Dual Audio', telegramFileId: 'large', size: 1_025,
      kind: 'document', languages: [], mediaInfo: { status: 'pending' }
    }],
    mediaInfo: { maxDownloadBytes: 1_024 },
    downloadFile: async () => { downloaded += 1; return Buffer.alloc(1); },
    runMediaInfo: async () => JSON.stringify({ media: { track: [] } })
  });
  assert.equal(downloaded, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.files[0].mediaInfo.status, 'skipped-size');

  const unknownSize = await inspectDeferredMediaTracks({
    files: [{
      name: 'remote-size.dual.mkv', displayName: 'Remote Dual Audio', telegramFileId: 'remote', size: 0,
      kind: 'document', languages: [], mediaInfo: { status: 'pending' }
    }],
    telegram: { async getFile() { return { file_size: 1_025 }; } },
    mediaInfo: { maxDownloadBytes: 1_024 },
    downloadFile: async () => { downloaded += 1; return Buffer.alloc(1); },
    runMediaInfo: async () => JSON.stringify({ media: { track: [] } })
  });
  assert.equal(unknownSize.skipped, 1);
  assert.equal(unknownSize.files[0].mediaInfo.status, 'skipped-size');
  assert.equal(downloaded, 0);
});
