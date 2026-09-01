import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStreamingEntries, parseStreamingManifest, publicStreamingData, safeStreamingUrl } from '../src/server/services/streaming-service.js';

test('manual JSON streaming manifests accept authorized SeekStreaming players and episode data', () => {
  const result = parseStreamingManifest(JSON.stringify({
    entries: [
      {
        postId: 'SB-0123ABCDEF',
        episode: '01',
        label: 'Episode 01 · Hindi',
        embedUrl: 'https://player.seekstreaming.com/embed/first',
        watchUrl: 'https://seekstreaming.com/watch/first'
      },
      {
        post_id: 'SB-0123ABCDEF',
        episode: '2-3',
        url: 'https://seekstreaming.com/embed/second'
      }
    ]
  }), { format: 'json' });

  assert.equal(result.totalRows, 2);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0].entry.episode, { start: 1, end: 1, label: 'Episode 01' });
  assert.equal(result.entries[0].entry.embedUrl, 'https://player.seekstreaming.com/embed/first');
  assert.equal(result.entries[1].entry.embedUrl, 'https://seekstreaming.com/embed/second');
});

test('SeekStreaming dashboard exports accept their Embed Link or iframe Embed Code without a Post ID', () => {
  const linkExport = parseStreamingManifest(JSON.stringify([{
    VideoID: '58yvk',
    Title: 'The Gentlemen Season 1',
    'Embed Link': 'https://soraboxs.embedseek.com/#58yvk',
    'Embed Code': '<iframe src="https://soraboxs.embedseek.com/#58yvk" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>'
  }]), { format: 'json' });

  assert.equal(linkExport.rejected.length, 0);
  assert.equal(linkExport.entries[0].sourceTitle, 'The Gentlemen Season 1');
  assert.equal(linkExport.entries[0].entry.embedUrl, 'https://soraboxs.embedseek.com/#58yvk');
  assert.equal(linkExport.entries[0].entry.watchUrl, null);
  assert.equal(safeStreamingUrl('&lt;iframe src=&quot;https://soraboxs.embedseek.com/#58yvk&quot;&gt;&lt;/iframe&gt;'), 'https://soraboxs.embedseek.com/#58yvk');

  const multiVideoExport = parseStreamingManifest(JSON.stringify([
    { VideoID: 'seek-01', Title: 'The Gentlemen Season 1 Episode 01', 'Embed Link': 'https://soraboxs.embedseek.com/#seek-01' },
    { VideoID: 'seek-02', Title: 'The Gentlemen Season 1 Episode 02', 'Embed Link': 'https://soraboxs.embedseek.com/#seek-02' }
  ]), { format: 'json' });
  const targetOnlyExport = parseStreamingManifest(JSON.stringify([
    { VideoID: 'seek-no-title', 'Embed Link': 'https://soraboxs.embedseek.com/#seek-no-title' }
  ]), { format: 'json', allowMissingTarget: true });
  assert.equal(targetOnlyExport.entries.length, 1);
  const stream = mergeStreamingEntries(null, multiVideoExport.entries.map((entry) => entry.entry));
  assert.equal(stream.entries.length, 2);
  assert.deepEqual(stream.entries.map((entry) => entry.episode?.start), [1, 2]);
});

test('manual CSV streaming manifests parse quoted labels and reject untrusted embeds', () => {
  const result = parseStreamingManifest([
    'adminId,episode,label,embedUrl',
    'SB-0123ABCDEF,4,"Episode 04, English",https://seekstreaming.com/embed/four',
    'SB-0123ABCDEF,5,Blocked,javascript:alert(1)',
    'not-a-post,6,Invalid,https://seekstreaming.com/embed/six'
  ].join('\n'), { format: 'csv' });

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].entry.label, 'Episode 04, English');
  assert.deepEqual(result.rejected.map((item) => item.row), [2, 3]);
  assert.equal(safeStreamingUrl('https://evil.example/embed/x'), null);
  assert.equal(safeStreamingUrl('http://seekstreaming.com/embed/x'), null);
});

test('stream manifest re-import replaces only its matching episode and public data remains safe', () => {
  const first = mergeStreamingEntries(null, [
    { entry: { label: 'Episode 01', episode: { start: 1, end: 1, label: 'Episode 01' }, provider: 'SeekStreaming', embedUrl: 'https://seekstreaming.com/embed/one', watchUrl: null } },
    { entry: { label: 'Episode 02', episode: { start: 2, end: 2, label: 'Episode 02' }, provider: 'SeekStreaming', embedUrl: 'https://seekstreaming.com/embed/two', watchUrl: null } }
  ], { updatedAt: '2026-09-02T10:00:00.000Z' });
  const replaced = mergeStreamingEntries(first, [
    { entry: { label: 'Episode 02 · corrected', episode: { start: 2, end: 2, label: 'Episode 02' }, provider: 'SeekStreaming', embedUrl: 'https://seekstreaming.com/embed/two-new', watchUrl: 'https://seekstreaming.com/watch/two-new' } }
  ], { updatedAt: '2026-09-02T11:00:00.000Z' });

  assert.equal(replaced.entries.length, 2);
  assert.equal(replaced.entries[0].embedUrl, 'https://seekstreaming.com/embed/one');
  assert.equal(replaced.entries[1].embedUrl, 'https://seekstreaming.com/embed/two-new');
  const alternatives = mergeStreamingEntries(replaced, [
    { entry: { label: 'Episode 01 · Rumble', episode: { start: 1, end: 1, label: 'Episode 01' }, provider: 'Rumble', embedUrl: 'https://rumble.com/embed/v123', watchUrl: null } },
    { entry: { label: 'Episode 01 · Dailymotion', episode: { start: 1, end: 1, label: 'Episode 01' }, provider: 'Dailymotion', embedUrl: 'https://www.dailymotion.com/embed/video/x123', watchUrl: null } }
  ]);
  const publicData = publicStreamingData({
    entries: [...alternatives.entries, { label: 'Bad', embedUrl: 'https://evil.example/embed/x' }],
    updatedAt: alternatives.updatedAt,
    privateProviderToken: 'must-not-leak'
  });
  assert.equal(publicData.available, true);
  assert.equal(publicData.entries.length, 4);
  assert.equal(publicData.privateProviderToken, undefined);
  assert.deepEqual(publicData.entries.map((entry) => entry.episode?.start), [1, 1, 1, 2]);
});
