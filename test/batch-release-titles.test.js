import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  groupFilesByReleaseTitle,
  inferBatchTitle,
  isPlausibleReleaseTitle,
  planDraftPublicationGroups,
  tidyReleaseTitle
} from '../src/server/services/telegram-bot.js';

// How a mixed range actually arrives: the same film captioned several ways by one uploader, each
// caption holding that uploader's tags. Before the tidy, every spelling became its own catalog post,
// its own announcement, and its own ImgBB upload — which is how one release tripped a rate limit.
const MINIONS_MESS = [
  'Minions DUAL -KyoGo mkv 🔊 #',
  'Minions DUAL -KyoGo mkv 🔊 # ',
  'Minions DUAL -KyoGo mkv 🔊 #.mkv',
  'Minions [1080p] [x265] - KyoGo.mkv',
  'minions 2015 hindi dubbed full movie -KyoGo 🔊',
  'Minions',
  'Minions (2015)',
  'Minions - KyoGo'
];

const filesFrom = (names) => names.map((name, index) => ({ name, displayName: name, messageId: 400 + index }));

test('a release title is what is left after the packaging is gone', () => {
  for (const caption of MINIONS_MESS) {
    // Case is the uploader’s own; the tidy is about what is not a title.
    assert.equal(tidyReleaseTitle(caption).toLowerCase(), 'minions', `the tags around the name never belong on a card: ${caption}`);
  }
  assert.equal(tidyReleaseTitle('Despicable Me DUAL -KyoGo.mkv'), 'Despicable Me');
  assert.equal(tidyReleaseTitle('Incipit of Snippet [Vray] .mp4'), 'Incipit of Snippet');
  assert.equal(tidyReleaseTitle('minions 2015 hindi dubbed full movie -KyoGo 🔊'), 'minions');
  // A number, a subtitle, or a hyphen that is part of the name is the name. Only a lone separator
  // between words goes, and a group tag only when it is what a release group writes there.
  assert.equal(tidyReleaseTitle('Despicable Me 2'), 'Despicable Me 2');
  assert.equal(tidyReleaseTitle('Scooby-Doo! Return To Zombie Island'), 'Scooby-Doo! Return To Zombie Island');
  assert.equal(tidyReleaseTitle('K.G.F – Chapter 2'), 'K.G.F Chapter 2');
  assert.equal(tidyReleaseTitle('D E B S AKA DEBS'), 'D E B S AKA DEBS');
  assert.equal(tidyReleaseTitle('Vampires Of The Velvet Lounge'), 'Vampires Of The Velvet Lounge');
  assert.equal(tidyReleaseTitle(''), '');

test('a title that opens with a year keeps its year, because it is the name', () => {
  assert.equal(inferBatchTitle([{ name: '2001: A Space Odyssey' }]), '2001: A Space Odyssey');
  assert.equal(inferBatchTitle([{ name: '2001: A Space Odyssey (1968).mkv' }]), '2001: A Space Odyssey');
  // A year somewhere else in the name is metadata, which is what cleanMediaName has always assumed.
  assert.equal(inferBatchTitle([{ name: 'Minions (2015) - KyoGo.mkv' }]), 'Minions');
});
});

test('a caption that names nothing follows the file above it instead of becoming a post', () => {
  assert.equal(isPlausibleReleaseTitle('Minions'), true);
  assert.equal(isPlausibleReleaseTitle('Reacher Season 4'), true);
  assert.equal(isPlausibleReleaseTitle('D E B S AKA DEBS'), true);
  for (const junk of ['🔊 #', 'mkv', '2015', 'Document', 'video', 'file 3', 'EP']) {
    assert.equal(isPlausibleReleaseTitle(junk), false, `"${junk}" cannot name a catalog card`);
  }
  // What matters is that inferBatchTitle finds nothing usable in them, which is the signal the
  // grouping uses to let a file join the release it was sent with.
  for (const junk of ['🔊 #', 'mkv', 'Document', 'video 2', '#', '1080p']) {
    assert.equal(inferBatchTitle([{ name: junk }]), '', `"${junk}" is not a release title`);
  }
});

test('one release pasted eight ways is one group, and a real second release stays separate', () => {
  const groups = groupFilesByReleaseTitle(filesFrom([...MINIONS_MESS, 'Despicable Me DUAL -KyoGo.mkv', 'Despicable Me']));
  assert.equal(groups.length, 2, 'eight spellings of one film do not make eight cards');
  const minions = groups.find((group) => group.title === 'Minions');
  assert.equal(minions.files.length, MINIONS_MESS.length);
  assert.equal(groups.find((group) => group.title === 'Despicable Me').files.length, 2);
  assert.equal(minions.title, 'Minions', 'the card is named after the release, not after the messiest caption');
});

test('a batch of one release publishes one post, and a mixed range still splits', () => {
  const session = (files) => ({
    workflow: 'batch',
    title: 'Minions',
    category: 'movie',
    files,
    batch: { titleProvided: false, categoryOverride: null }
  });
  assert.deepEqual(planDraftPublicationGroups(session(filesFrom(MINIONS_MESS))), [], 'no split, so no extra announcement and no extra poster upload');

  const mixed = planDraftPublicationGroups(session(filesFrom([...MINIONS_MESS, 'Despicable Me 2', 'Gold 2022'])));
  assert.equal(mixed.length, 3, 'a range that really does hold several releases still becomes one post each');
  assert.deepEqual(mixed.map((group) => group.title), ['Minions', 'Despicable Me 2', 'Gold']);
});

test('an episode list stays one series card even when every file adds its own tags', () => {
  const captions = [
    'Fullmetal Alchemist - S01E01 - KyoGo.mkv',
    'Fullmetal Alchemist S01E02 [1080p].mkv 🔊',
    'Fullmetal Alchemist - S01E03 DUAL.mkv'
  ];
  for (const name of captions) {
    assert.equal(inferBatchTitle([{ name }]), 'Fullmetal Alchemist', `"${name}" is one series, not three releases`);
  }
  const files = filesFrom(captions);
  assert.deepEqual(groupFilesByReleaseTitle(files), [], 'one release means one post, so there is nothing to split');

  const withFilm = groupFilesByReleaseTitle([...files, ...filesFrom(['Fullmetal Alchemist The Movie - KyoGo.mkv'])]);
  assert.equal(withFilm.length, 2, 'a film of the same series is its own card, because its title differs');
  assert.equal(withFilm[0].files.length, 3);

  const session = {
    workflow: 'batch',
    title: 'Fullmetal Alchemist',
    category: 'anime',
    files,
    batch: { titleProvided: false, categoryOverride: null }
  };
  assert.deepEqual(planDraftPublicationGroups(session), [], 'and /batch publishes the range as one post instead of three');
});
