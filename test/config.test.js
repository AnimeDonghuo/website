import test from 'node:test';
import assert from 'node:assert/strict';
import { getContentPageUrl, loadConfig } from '../src/server/config.js';

test('announcement URLs resolve to a public content detail page', () => {
  const config = loadConfig({
    PUBLIC_SITE_URL: 'https://sorabox-demo.koyeb.app/',
    TELEGRAM_MODE: 'disabled'
  });

  assert.equal(config.siteUrl, 'https://sorabox-demo.koyeb.app');
  assert.equal(
    getContentPageUrl(config, { category: 'donghua', slug: 'perfect-world' }),
    'https://sorabox-demo.koyeb.app/donghua/perfect-world'
  );
});

test('an invalid announcement site URL cannot create an external button', () => {
  const config = loadConfig({ PUBLIC_SITE_URL: 'javascript:alert(1)' });
  assert.equal(config.siteUrl, '');
  assert.equal(getContentPageUrl(config, { category: 'movie', slug: 'toxic' }), null);
});
