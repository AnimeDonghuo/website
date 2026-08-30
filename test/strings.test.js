import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, parseCommandArgument, slugify } from '../src/server/lib/strings.js';

test('slugify makes stable URL-safe release slugs', () => {
  assert.equal(slugify('  Fūtsūtsuka: An Akujo!  '), 'futsutsuka-an-akujo');
  assert.equal(slugify('***'), 'untitled-release');
});

test('command arguments remove the Telegram command and normalize spacing', () => {
  assert.equal(parseCommandArgument('/movie   A    quiet   place'), 'A quiet place');
  assert.equal(cleanText('hello\u0000  world', 30), 'hello world');
});
