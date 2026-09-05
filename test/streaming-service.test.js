import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddablePlayerUrl, mergeStreamingEntries, oneClickDownloadHost, parseStreamingManifest, publicStreamingData, removeStreamingEntries, safeStreamingUrl, streamServerName } from '../src/server/services/streaming-service.js';

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

test('compact provider episode markers address one player per episode and keep their server names', () => {
  const manifest = parseStreamingManifest(JSON.stringify([
    { Post: 'SB-0123ABCDEF', Episode: 'S01E01', 'Embed Link': 'https://www.dailymotion.com/video/xAAA' },
    { Post: 'SB-0123ABCDEF', Episode: 'S01E02', 'Embed Link': 'https://rumble.com/v7exnu4-second.html' },
    { Post: 'SB-0123ABCDEF', Episode: 'S01E03', 'Embed Link': 'https://soraboxs.embedseek.com/#third' }
  ]), { format: 'json' });

  assert.equal(manifest.rejected.length, 0);
  // the season digits of "S01E02" must not be read as episode 1, which is how a
  // season-long export used to collapse onto a single player
  assert.deepEqual(manifest.entries.map((entry) => entry.entry.episode?.start), [1, 2, 3]);
  // pasted page links are stored as the URL the site can actually frame
  assert.deepEqual(manifest.entries.map((entry) => entry.entry.embedUrl), [
    'https://www.dailymotion.com/embed/video/xAAA',
    'https://rumble.com/embed/v7exnu4/',
    'https://soraboxs.embedseek.com/#third'
  ]);

  const merged = mergeStreamingEntries(null, manifest.entries);
  assert.equal(merged.entries.length, 3);
  assert.deepEqual(publicStreamingData(merged).entries.map((entry) => entry.server), [
    'Dailymotion server',
    'Rumble server',
    'Seek server'
  ]);
});

test('a pasted Rumble or Dailymotion list keeps every link, and players can be dropped by number or episode range', () => {
  const stream = mergeStreamingEntries(null, [
    { entry: { label: 'Dailymotion · Episode 01', episode: { start: 1, end: 1, label: 'Episode 01' }, embedUrl: 'https://www.dailymotion.com/embed/video/xAAA' } },
    { entry: { label: 'Rumble · Episode 02', episode: { start: 2, end: 2, label: 'Episode 02' }, embedUrl: 'https://rumble.com/embed/v7exnu4/' } },
    { entry: { label: 'Seek · Episode 03', episode: { start: 3, end: 3, label: 'Episode 03' }, embedUrl: 'https://soraboxs.embedseek.com/#third' } }
  ]);
  assert.equal(stream.entries.length, 3);

  const ranged = removeStreamingEntries(stream, { episode: { start: 2, end: 3 } });
  assert.equal(ranged.removed, 2);
  assert.deepEqual(ranged.remaining, 1);
  assert.deepEqual(ranged.stream.entries.map((entry) => entry.embedUrl), ['https://www.dailymotion.com/embed/video/xAAA']);

  const numbered = removeStreamingEntries(stream, { indexes: [1] });
  assert.equal(numbered.removed, 1);
  assert.deepEqual(numbered.stream.entries.map((entry) => entry.episode.start), [2, 3]);

  const cleared = removeStreamingEntries(stream, { all: true });
  assert.equal(cleared.removed, 3);
  assert.equal(cleared.stream, null);
  assert.equal(removeStreamingEntries(stream, { indexes: [9] }).removed, 0);
});

test('Vimeo, OK.ru, and Rumble page links become the frame that actually plays', () => {
  const embed = (value) => embeddablePlayerUrl(value);

  assert.deepEqual(embed('https://vimeo.com/76979871'), {
    embedUrl: 'https://player.vimeo.com/video/76979871',
    watchUrl: 'https://vimeo.com/76979871'
  });
  assert.equal(embed('https://vimeo.com/channels/staffpicks/76979871').embedUrl, 'https://player.vimeo.com/video/76979871');
  assert.equal(embed('https://vimeo.com/album/4321/video/76979871').embedUrl, 'https://player.vimeo.com/video/76979871');
  // a pasted player URL is kept whole, because the h= token is what lets an
  // embed-only or privacy-protected video play at all
  assert.equal(embed('https://player.vimeo.com/video/76979871?h=AbC123').embedUrl, 'https://player.vimeo.com/video/76979871?h=AbC123');
  assert.equal(embed('https://vimeo.com/manage/videos/76979871').embedUrl, null, 'an admin page is not a video link');

  assert.deepEqual(embed('https://ok.ru/video/5145652956508'), {
    embedUrl: 'https://ok.ru/videoembed/5145652956508',
    watchUrl: 'https://ok.ru/video/5145652956508'
  });
  assert.equal(embed('https://ok.ru/videoembed/5145652956508').embedUrl, 'https://ok.ru/videoembed/5145652956508');
  // a live broadcast has no embed path, so it stays an external link instead of a
  // frame that would sit there black forever
  const live = embed('https://ok.ru/live/1530522920786');
  assert.equal(live.embedUrl, null);
  assert.equal(live.watchUrl, 'https://ok.ru/live/1530522920786');

  // Rumble's own Share code carries a publisher token that no page link contains,
  // so it is stored verbatim instead of being rebuilt into the short form
  const share = 'https://rumble.com/embedJS/u3385.v7exnu4/?url=https%3A%2F%2Frumble.com%2Fv7exnu4-x.html';
  assert.equal(embed(share).embedUrl, share);
  assert.equal(embed(share).watchUrl, 'https://rumble.com/v7exnu4.html');
  assert.equal(embed('https://rumble.com/embed/v7exnu4.01/').embedUrl, 'https://rumble.com/embed/v7exnu4.01/');
  assert.equal(embed('https://rumble.com/v7exnu4-some-title.html').embedUrl, 'https://rumble.com/embed/v7exnu4/');

  // a file host that publishes its own embed path needs no rewriting at all
  assert.equal(embed('https://dood.pm/f/abc123xyz').embedUrl, 'https://dood.pm/f/abc123xyz');
  assert.equal(streamServerName('https://ok.ru/videoembed/1'), 'OK.ru server');
  assert.equal(streamServerName('https://player.vimeo.com/video/1'), 'Vimeo server');
  assert.equal(streamServerName('https://streamwish.to/f/1'), 'StreamWish server');
  assert.equal(streamServerName('https://streamtape.com/e/1'), 'StreamTape server');
});

test('approved hosts enter the allow-list and the frame policy, one-click hosts do not', () => {
  assert.equal(safeStreamingUrl('https://dood.pm/f/abc123'), 'https://dood.pm/f/abc123');
  assert.equal(safeStreamingUrl('https://player.vimeo.com/video/76979871'), 'https://player.vimeo.com/video/76979871');
  assert.equal(safeStreamingUrl('https://ok.ru/videoembed/5145652956508'), 'https://ok.ru/videoembed/5145652956508');
  assert.equal(safeStreamingUrl('https://some-random-player.example/f/1'), null);

  assert.equal(oneClickDownloadHost('https://mega.nz/file/abcd#frag'), 'mega.nz');
  assert.equal(oneClickDownloadHost('https://www.gofile.io/d/abc'), 'gofile.io');
  assert.equal(oneClickDownloadHost('https://abyss.to/file/abc'), 'abyss.to');
  assert.equal(oneClickDownloadHost('<iframe src="https://dood.pm/f/abc" allowfullscreen></iframe>'), null);
  assert.equal(oneClickDownloadHost('not a url'), null);
});
