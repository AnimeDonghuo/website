import test from 'node:test';
import assert from 'node:assert/strict';
import { getContentPageUrl, getDeliveryRedirectPath, getTelegramFileDeliveryUrl, loadConfig } from '../src/server/config.js';

test('MediaInfo and signed backup safety settings have bounded production defaults', () => {
  const config = loadConfig({
    ADMIN_LOGIN_CODE: 'long-enough-admin-code',
    MEDIAINFO_MAX_DOWNLOAD_BYTES: '12345',
    MEDIAINFO_TIMEOUT_MS: '5000',
    MEDIAINFO_MAX_FILES: '44',
    BACKUP_MAX_BYTES: '23456',
    BACKUP_MONTHLY_ENABLED: 'false'
  });
  assert.equal(config.mediaInfo.maxDownloadBytes, 12345);
  assert.equal(config.mediaInfo.timeoutMs, 5000);
  assert.equal(config.mediaInfo.maxFiles, 44);
  assert.equal(config.backup.signingSecret, 'long-enough-admin-code');
  assert.equal(config.backup.maxBytes, 23456);
  assert.equal(config.backup.monthlyEnabled, false);
});

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

test('quoted hostnames and Koyeb-style site URL aliases normalize into an announcement URL', () => {
  const config = loadConfig({
    PUBLIC_SITE_URL: 'not a URL',
    WEBSITE_URL: '  "catalog-example.koyeb.app/"  ',
    TELEGRAM_BOT_USERNAME: '@DeliveryBot'
  });

  assert.equal(config.siteUrl, 'https://catalog-example.koyeb.app');
  assert.equal(
    getTelegramFileDeliveryUrl(config, 'aB-cD_ef', 12),
    'https://t.me/DeliveryBot?start=file-aB-cD_ef-12'
  );
  assert.equal(getDeliveryRedirectPath('aB-cD_ef', 12), '/deliver/aB-cD_ef/file/12');
  assert.equal(getTelegramFileDeliveryUrl(config, 'aB-cD_ef', 0), null);
});
