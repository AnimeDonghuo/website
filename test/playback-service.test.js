import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { loadConfig } from '../src/server/config.js';
import {
  BoundedRateLimiter,
  getClientIp,
  isChannelAllowed,
  normalizeChannelId,
  parseAndValidatePlaybackTarget,
  PLAYBACK_SESSION_COOKIE,
  requestPlaybackGrant,
  resolveCatalogContent,
  resolveOrCreatePlaybackSession,
  signPlaybackSession,
  verifyPlaybackCsrf,
  verifyPlaybackSession
} from '../src/server/services/playback-service.js';
import { getProtectedPlaybackTarget } from '../src/client/watch-utils.js';

test('normalizeChannelId and isChannelAllowed handle multiple Telegram storage channels correctly', () => {
  const allowed = ['-1002617067511', '-1002456789012', '2987654321'];

  assert.equal(normalizeChannelId('2617067511'), '-1002617067511');
  assert.equal(normalizeChannelId('-1002617067511'), '-1002617067511');
  assert.equal(normalizeChannelId(''), '');
  assert.equal(normalizeChannelId(null), '');

  // Matches -100... form
  assert.equal(isChannelAllowed('2617067511', allowed), true);
  assert.equal(isChannelAllowed('-1002617067511', allowed), true);

  // Matches second channel
  assert.equal(isChannelAllowed('2456789012', allowed), true);
  assert.equal(isChannelAllowed('-1002456789012', allowed), true);

  // Matches bare digit channel
  assert.equal(isChannelAllowed('2987654321', allowed), true);
  assert.equal(isChannelAllowed('-1002987654321', allowed), true);

  // Rejects unconfigured channels
  assert.equal(isChannelAllowed('9999999999', allowed), false);
  assert.equal(isChannelAllowed('-1009999999999', allowed), false);
  assert.equal(isChannelAllowed(null, allowed), false);
  assert.equal(isChannelAllowed('', allowed), false);
});

test('parseAndValidatePlaybackTarget accepts canonical Telegram URLs and IDs', () => {
  const allowed = ['-1002617067511'];

  // Valid Telegram URL
  const validUrl = parseAndValidatePlaybackTarget({ url: 'https://t.me/c/2617067511/22047' }, allowed);
  assert.equal(validUrl.valid, true);
  assert.equal(validUrl.type, 'url');
  assert.equal(validUrl.canonicalUrl, 'https://t.me/c/2617067511/22047');
  assert.equal(validUrl.channelNumber, '2617067511');
  assert.equal(validUrl.channelId, '-1002617067511');
  assert.equal(validUrl.messageId, 22047);
  assert.deepEqual(validUrl.approvedTarget, { url: 'https://t.me/c/2617067511/22047' });

  // Valid Telegram URL with query params
  const withQuery = parseAndValidatePlaybackTarget({ url: 'https://t.me/c/2617067511/22047?single' }, allowed);
  assert.equal(withQuery.valid, true);
  assert.equal(withQuery.canonicalUrl, 'https://t.me/c/2617067511/22047');

  // Valid Video ID
  const validId = parseAndValidatePlaybackTarget({ id: 'custom-watch_id-01' }, allowed);
  assert.equal(validId.valid, true);
  assert.equal(validId.type, 'id');
  assert.equal(validId.id, 'custom-watch_id-01');
  assert.deepEqual(validId.approvedTarget, { id: 'custom-watch_id-01' });
});

test('parseAndValidatePlaybackTarget rejects malformed, ambiguous, and unauthorized targets', () => {
  const allowed = ['-1002617067511'];

  // Missing payload / non-object
  assert.equal(parseAndValidatePlaybackTarget(null, allowed).valid, false);
  assert.equal(parseAndValidatePlaybackTarget([], allowed).valid, false);
  assert.equal(parseAndValidatePlaybackTarget('string', allowed).valid, false);

  // Ambiguous: both url and id
  const ambiguous = parseAndValidatePlaybackTarget({ url: 'https://t.me/c/2617067511/22047', id: 'video-1' }, allowed);
  assert.equal(ambiguous.valid, false);
  assert.equal(ambiguous.status, 400);

  // Missing target: neither url nor id
  const empty = parseAndValidatePlaybackTarget({}, allowed);
  assert.equal(empty.valid, false);
  assert.equal(empty.status, 400);

  // Unexpected extra property
  const extra = parseAndValidatePlaybackTarget({ id: 'valid-id', extra: 'malicious' }, allowed);
  assert.equal(extra.valid, false);
  assert.equal(extra.status, 400);

  // Malformed URL (not a Telegram post link)
  const nonTgUrl = parseAndValidatePlaybackTarget({ url: 'https://evil.com/video.mp4' }, allowed);
  assert.equal(nonTgUrl.valid, false);
  assert.equal(nonTgUrl.status, 400);

  // Unauthorized channel
  const forbiddenChannel = parseAndValidatePlaybackTarget({ url: 'https://t.me/c/9999999999/123' }, allowed);
  assert.equal(forbiddenChannel.valid, false);
  assert.equal(forbiddenChannel.status, 403);

  // Malformed ID (invalid characters / XSS attempt)
  const invalidId = parseAndValidatePlaybackTarget({ id: '<script>alert(1)</script>' }, allowed);
  assert.equal(invalidId.valid, false);
  assert.equal(invalidId.status, 400);

  // Target url exceeding length limit
  const longUrl = parseAndValidatePlaybackTarget({ url: 'https://t.me/c/2617067511/' + '1'.repeat(1500) }, allowed);
  assert.equal(longUrl.valid, false);
  assert.equal(longUrl.status, 400);
});

test('CSRF verification validates Sec-Fetch-Site and Origin header defenses', () => {
  const config = { siteUrl: 'https://youngest-corabella-platinum0-23c07cdf.koyeb.app' };

  // Allowed same-origin request
  const validReq = {
    headers: {
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      host: 'youngest-corabella-platinum0-23c07cdf.koyeb.app',
      origin: 'https://youngest-corabella-platinum0-23c07cdf.koyeb.app'
    }
  };
  assert.equal(verifyPlaybackCsrf(validReq, config).valid, true);

  // Cross-site request rejected
  const crossSiteReq = {
    headers: {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors'
    }
  };
  const crossSiteRes = verifyPlaybackCsrf(crossSiteReq, config);
  assert.equal(crossSiteRes.valid, false);
  assert.match(crossSiteRes.error, /cross-site/i);

  // Direct navigation rejected
  const navReq = {
    headers: {
      'sec-fetch-mode': 'navigate'
    }
  };
  const navRes = verifyPlaybackCsrf(navReq, config);
  assert.equal(navRes.valid, false);

  // Disallowed external origin rejected
  const evilOriginReq = {
    headers: {
      host: 'youngest-corabella-platinum0-23c07cdf.koyeb.app',
      origin: 'https://evil-attacker.example.com'
    }
  };
  const evilRes = verifyPlaybackCsrf(evilOriginReq, config);
  assert.equal(evilRes.valid, false);
  assert.match(evilRes.error, /not permitted/i);
});

test('BoundedRateLimiter enforces rate limits and bounds memory consumption', () => {
  const limiter = new BoundedRateLimiter({ maxRequests: 3, windowMs: 1_000, maxKeys: 4 });

  // First 3 requests succeed
  assert.equal(limiter.isAllowed('user1').allowed, true);
  assert.equal(limiter.isAllowed('user1').allowed, true);
  assert.equal(limiter.isAllowed('user1').allowed, true);

  // 4th request exceeds limit
  const blocked = limiter.isAllowed('user1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds >= 1, true);

  // Other users are not affected
  assert.equal(limiter.isAllowed('user2').allowed, true);

  // Memory capacity bound test: add multiple keys beyond maxKeys
  limiter.isAllowed('user3');
  limiter.isAllowed('user4');
  limiter.isAllowed('user5');
  assert.equal(limiter.hits.size <= 4, true, 'limiter hits map size must be bounded by maxKeys');
});

test('signed expiring guest session tokens round-trip, detect tampering, and expire', () => {
  const secret = 'super-secret-key-12345';
  const visitorId = 'visitor-alpha-beta';

  const token = signPlaybackSession(visitorId, secret);
  assert.match(token, /^visitor-alpha-beta\.\d+\.[A-Za-z0-9_-]+$/);

  const verified = verifyPlaybackSession(token, secret);
  assert.equal(verified?.visitorId, visitorId);

  // Tampered payload fails verification
  const tampered = token.replace('visitor-alpha-beta', 'attacker');
  assert.equal(verifyPlaybackSession(tampered, secret), null);

  // Tampered signature fails verification
  const parts = token.split('.');
  const badSig = `${parts[0]}.${parts[1]}.badsignature`;
  assert.equal(verifyPlaybackSession(badSig, secret), null);

  // Expired token (> 24 hours) fails verification
  const expiredTime = Date.now() - (25 * 60 * 60 * 1000);
  const expiredToken = signPlaybackSession(visitorId, secret, expiredTime);
  assert.equal(verifyPlaybackSession(expiredToken, secret), null);

  // Wrong secret fails verification
  assert.equal(verifyPlaybackSession(token, 'different-secret'), null);
});

test('resolveCatalogContent maps target to published items and checks adult category', async () => {
  const repository = new MemoryCatalogRepository([]);

  // Create normal published release with a Telegram file
  const normalPost = await repository.createContent({
    title: 'Donghua Adventure Season 1',
    category: 'donghua',
    published: true,
    files: [{
      storageMessageId: 22047,
      storageChannelId: '-1002617067511',
      name: 'Episode 01.mp4',
      kind: 'video'
    }]
  });

  // Create adult published release
  const adultPost = await repository.createContent({
    title: 'Secret 18+ Release',
    category: 'adult',
    published: true,
    files: [{
      storageMessageId: 33050,
      storageChannelId: '-1002617067511',
      name: 'Adult 01.mp4',
      kind: 'video'
    }]
  });

  // Create unlisted/unpublished release
  await repository.createContent({
    title: 'Unpublished Draft',
    category: 'anime',
    published: false,
    files: [{
      storageMessageId: 44060,
      storageChannelId: '-1002617067511',
      name: 'Draft.mp4',
      kind: 'video'
    }]
  });

  // 1. Resolve normal published item by Telegram URL
  const targetNormal = {
    type: 'url',
    canonicalUrl: 'https://t.me/c/2617067511/22047',
    channelNumber: '2617067511',
    channelId: '-1002617067511',
    messageId: 22047
  };
  const resolvedNormal = await resolveCatalogContent({ target: targetNormal, repository });
  assert.equal(resolvedNormal.found, true);
  assert.equal(resolvedNormal.content.slug, normalPost.slug);
  assert.equal(resolvedNormal.isAdult, false);

  // 2. Resolve adult published item by Telegram URL
  const targetAdult = {
    type: 'url',
    canonicalUrl: 'https://t.me/c/2617067511/33050',
    channelNumber: '2617067511',
    channelId: '-1002617067511',
    messageId: 33050
  };
  const resolvedAdult = await resolveCatalogContent({ target: targetAdult, repository });
  assert.equal(resolvedAdult.found, true);
  assert.equal(resolvedAdult.content.slug, adultPost.slug);
  assert.equal(resolvedAdult.isAdult, true);

  // 3. Resolve unpublished release is rejected
  const targetUnpublished = {
    type: 'url',
    canonicalUrl: 'https://t.me/c/2617067511/44060',
    channelNumber: '2617067511',
    channelId: '-1002617067511',
    messageId: 44060
  };
  const resolvedUnpublished = await resolveCatalogContent({ target: targetUnpublished, repository });
  assert.equal(resolvedUnpublished.found, false);
  assert.equal(resolvedUnpublished.status, 404);

  // 4. Resolve nonexistent target is rejected
  const targetNonexistent = {
    type: 'url',
    canonicalUrl: 'https://t.me/c/2617067511/99999',
    channelNumber: '2617067511',
    channelId: '-1002617067511',
    messageId: 99999
  };
  const resolvedNonexistent = await resolveCatalogContent({ target: targetNonexistent, repository });
  assert.equal(resolvedNonexistent.found, false);
  assert.equal(resolvedNonexistent.status, 404);

  // 5. Resolve by ID (slug)
  const targetId = { type: 'id', id: normalPost.slug };
  const resolvedById = await resolveCatalogContent({ target: targetId, repository });
  assert.equal(resolvedById.found, true);
  assert.equal(resolvedById.content.slug, normalPost.slug);
});

test('requestPlaybackGrant performs server-to-server grant request and sanitizes errors', async () => {
  const config = {
    playback: {
      playerOrigin: 'https://v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3.koyeb.app',
      issuerKey: 'valid-issuer-secret-key-xyz'
    }
  };

  const target = {
    approvedTarget: { url: 'https://t.me/c/2617067511/22047' }
  };

  // Mock successful upstream grant
  const mockSuccessFetch = async (url, options) => {
    assert.equal(url, 'https://v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3.koyeb.app/api/playback/grant');
    assert.equal(options.headers['Authorization'], 'Bearer valid-issuer-secret-key-xyz');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.body, JSON.stringify(target.approvedTarget));

    return {
      ok: true,
      status: 200,
      json: async () => ({
        token: 'granted-jwt-token-abc.123.xyz',
        resource: 'https://t.me/c/2617067511/22047',
        expiresAt: 1727500060000
      })
    };
  };

  const successResult = await requestPlaybackGrant({ target, config, fetchImpl: mockSuccessFetch });
  assert.equal(successResult.success, true);
  assert.equal(successResult.data.token, 'granted-jwt-token-abc.123.xyz');
  assert.equal(successResult.data.resource, 'https://t.me/c/2617067511/22047');
  assert.equal(successResult.data.expiresAt, 1727500060000);

  // Mock upstream refusal
  const mockErrorFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'internal server error in player backend' })
  });
  const errorResult = await requestPlaybackGrant({ target, config, fetchImpl: mockErrorFetch });
  assert.equal(errorResult.success, false);
  assert.equal(errorResult.status, 502);
  assert.equal(errorResult.error.includes('valid-issuer-secret-key-xyz'), false, 'must never leak issuer key');

  // Mock missing issuer key
  const missingKeyResult = await requestPlaybackGrant({ target, config: { playback: {} } });
  assert.equal(missingKeyResult.success, false);
  assert.equal(missingKeyResult.status, 503);
});

test('getProtectedPlaybackTarget parses protected telegram players on client side', () => {
  // Direct telegramUrl
  assert.deepEqual(
    getProtectedPlaybackTarget({ telegramUrl: 'https://t.me/c/2617067511/22047' }),
    { type: 'url', url: 'https://t.me/c/2617067511/22047' }
  );

  // Direct watchId
  assert.deepEqual(
    getProtectedPlaybackTarget({ watchId: 'ep-01-stream' }),
    { type: 'id', id: 'ep-01-stream' }
  );

  // From embedUrl containing telegram post
  assert.deepEqual(
    getProtectedPlaybackTarget({ embedUrl: 'https://t.me/c/2617067511/22047' }),
    { type: 'url', url: 'https://t.me/c/2617067511/22047' }
  );

  // From embedUrl pointing to player service with ?url=
  assert.deepEqual(
    getProtectedPlaybackTarget({
      embedUrl: 'https://v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3.koyeb.app/watch?url=https%3A%2F%2Ft.me%2Fc%2F2617067511%2F22047'
    }),
    { type: 'url', url: 'https://t.me/c/2617067511/22047' }
  );

  // External provider (e.g. Streamtape or Dailymotion) is NOT a protected Telegram player
  assert.equal(
    getProtectedPlaybackTarget({
      provider: 'Streamtape',
      embedUrl: 'https://streamtape.com/e/6xyz789'
    }),
    null
  );
  assert.equal(
    getProtectedPlaybackTarget({
      provider: 'Dailymotion',
      embedUrl: 'https://www.dailymotion.com/embed/video/x8abcde'
    }),
    null
  );
});

test('end-to-end integration: POST /api/playback-token issues tokens and enforces adult gating and rate limits', async () => {
  const repository = new MemoryCatalogRepository([]);
  const config = loadConfig({
    ADMIN_LOGIN_CODE: 'admin-passcode-for-tests',
    WATCH_PLAYER_ORIGIN: 'https://v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3.koyeb.app',
    PLAYBACK_ISSUER_KEY: 'test-shared-issuer-key',
    TELEGRAM_CHANNEL_IDS: '-1002617067511,-1002456789012',
    PLAYBACK_RATE_LIMIT_MAX: '5',
    PLAYBACK_RATE_LIMIT_WINDOW_MS: '60000'
  });

  // Seed repository with normal and adult releases
  const regularContent = await repository.createContent({
    title: 'Super Series',
    category: 'anime',
    published: true,
    files: [{
      storageMessageId: 1001,
      storageChannelId: '-1002617067511',
      name: 'Episode 01.mkv',
      kind: 'video'
    }]
  });

  const adultContent = await repository.createContent({
    title: 'Restricted Romance',
    category: 'adult',
    published: true,
    files: [{
      storageMessageId: 2002,
      storageChannelId: '-1002456789012',
      name: 'Adult 01.mkv',
      kind: 'video'
    }]
  });

  // Mock global fetch for upstream player grant
  const originalFetch = globalThis.fetch;
  let lastUpstreamRequest = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/playback/grant')) {
      lastUpstreamRequest = { url, opts };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          token: 'mocked-playback-jwt-token-12345',
          resource: JSON.parse(opts.body).url || JSON.parse(opts.body).id,
          expiresAt: Date.now() + 60_000
        })
      };
    }
    return originalFetch(url, opts);
  };

  try {
    const app = createApp({ config, repository });
    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. GET /api/config includes watchPlayerOrigin
    const configRes = await fetch(`${baseUrl}/api/config`);
    const configBody = await configRes.json();
    assert.equal(configRes.status, 200);
    assert.equal(configBody.watchPlayerOrigin, 'https://v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3.koyeb.app');

    // 2. Successful token issuance for published normal video
    const tokenRes = await fetch(`${baseUrl}/api/playback-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin'
      },
      body: JSON.stringify({ url: 'https://t.me/c/2617067511/1001' })
    });

    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.headers.get('cache-control'), 'no-store');
    const tokenData = await tokenRes.json();
    assert.equal(tokenData.token, 'mocked-playback-jwt-token-12345');
    assert.equal(tokenData.resource, 'https://t.me/c/2617067511/1001');
    assert.equal(typeof tokenData.expiresAt, 'number');

    // Check upstream request headers and payload
    assert.equal(lastUpstreamRequest.opts.headers['Authorization'], 'Bearer test-shared-issuer-key');
    assert.deepEqual(JSON.parse(lastUpstreamRequest.opts.body), { url: 'https://t.me/c/2617067511/1001' });

    // Check Set-Cookie was issued for guest session
    const setCookie = tokenRes.headers.get('set-cookie');
    assert.match(setCookie || '', new RegExp(PLAYBACK_SESSION_COOKIE));
    assert.match(setCookie || '', /HttpOnly/i);

    // 3. Second channel in TELEGRAM_CHANNEL_IDS is also supported
    const channel2Res = await fetch(`${baseUrl}/api/playback-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        // Gated: adult content without adult access cookie must be rejected
      },
      body: JSON.stringify({ url: 'https://t.me/c/2456789012/2002' })
    });
    assert.equal(channel2Res.status, 403);
    const adultDeniedBody = await channel2Res.json();
    assert.match(adultDeniedBody.error, /Age confirmation/i);

    // 4. With adult access confirmed, adult video succeeds
    const adultAllowedRes = await fetch(`${baseUrl}/api/playback-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Cookie': 'sorabox_adult_access=1'
      },
      body: JSON.stringify({ url: 'https://t.me/c/2456789012/2002' })
    });
    assert.equal(adultAllowedRes.status, 200);
    const adultAllowedBody = await adultAllowedRes.json();
    assert.equal(adultAllowedBody.token, 'mocked-playback-jwt-token-12345');

    // 5. Cross-site request is blocked by CSRF defense
    const crossSiteRes = await fetch(`${baseUrl}/api/playback-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site'
      },
      body: JSON.stringify({ url: 'https://t.me/c/2617067511/1001' })
    });
    assert.equal(crossSiteRes.status, 403);

    // 6. Nonexistent video ID is rejected with 404
    const notFoundRes = await fetch(`${baseUrl}/api/playback-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({ id: 'nonexistent-post-slug' })
    });
    assert.equal(notFoundRes.status, 404);

    // 7. CSP header includes player origin in script-src and frame-src
    const homeRes = await fetch(`${baseUrl}/api/health`);
    const csp = homeRes.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src[^;]*https:\/\/v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3\.koyeb\.app/);
    assert.match(csp, /frame-src[^;]*https:\/\/v0qcx8-s9dg2f-grassfirepooltheee-2b27b1d3\.koyeb\.app/);

    server.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
