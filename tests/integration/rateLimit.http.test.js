const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { connect, disconnect, getClient } = require('../../src/infrastructure/redis/redisClient');
const requestId = require('../../src/middleware/requestId');
const { identifyClient } = require('../../src/middleware/identifyClient');
const { createRateLimitMiddleware } = require('../../src/middleware/rateLimit');

describe('Express Rate-Limit Middleware HTTP Integration', () => {
  let redisClient;
  const testKeysToCleanup = new Set();

  beforeAll(async () => {
    redisClient = await connect();
  });

  afterAll(async () => {
    if (redisClient && testKeysToCleanup.size > 0) {
      await redisClient.del(...Array.from(testKeysToCleanup)).catch(() => {});
    }
    await disconnect();
  });

  function createTestApp(policyOptions) {
    const app = express();
    app.use(requestId);
    app.use(identifyClient);

    const keyPrefix = `shieldapi:test:http:${crypto.randomUUID()}`;
    testKeysToCleanup.add(`${keyPrefix}:*`); // pattern hint for tracking

    app.use(
      '/api/resource',
      createRateLimitMiddleware({
        policy: {
          id: 'test',
          windowMs: policyOptions.windowMs || 60000,
          maxRequests: policyOptions.maxRequests || 3,
          failMode: policyOptions.failMode || 'closed'
        },
        keyPrefix
      }),
      (req, res) => {
        res.status(200).json({ success: true, message: 'Resource reached', identityType: req.identityType });
      }
    );

    return app;
  }

  test('allows requests within quota and returns accurate X-RateLimit headers', async () => {
    const app = createTestApp({ maxRequests: 2, windowMs: 60000 });
    const apiKey = `key-${crypto.randomUUID()}`;

    // Request 1: remaining = 1
    const res1 = await request(app)
      .get('/api/resource')
      .set('X-API-Key', apiKey);

    expect(res1.status).toBe(200);
    expect(res1.headers['x-ratelimit-limit']).toBe('2');
    expect(res1.headers['x-ratelimit-remaining']).toBe('1');
    expect(res1.headers['x-ratelimit-reset']).toBeDefined();
    expect(res1.body.success).toBe(true);
    expect(res1.body.identityType).toBe('api-key');

    // Request 2: remaining = 0
    const res2 = await request(app)
      .get('/api/resource')
      .set('X-API-Key', apiKey);

    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-limit']).toBe('2');
    expect(res2.headers['x-ratelimit-remaining']).toBe('0');
  });

  test('returns HTTP 429 with Retry-After and JSON error when quota exceeded', async () => {
    const app = createTestApp({ maxRequests: 2, windowMs: 60000 });
    const apiKey = `key-${crypto.randomUUID()}`;

    // Exhaust quota (2 requests)
    await request(app).get('/api/resource').set('X-API-Key', apiKey);
    await request(app).get('/api/resource').set('X-API-Key', apiKey);

    // 3rd request -> over limit
    const res3 = await request(app)
      .get('/api/resource')
      .set('X-API-Key', apiKey);

    expect(res3.status).toBe(429);
    expect(res3.headers['retry-after']).toBeDefined();
    expect(Number(res3.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res3.headers['x-ratelimit-limit']).toBe('2');
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');

    expect(res3.body).toMatchObject({
      error: 'rate_limit_exceeded',
      message: expect.any(String),
      requestId: expect.any(String),
      remaining: 0
    });
    expect(res3.body.retryAfter).toBeGreaterThanOrEqual(1);
  });

  test('distinct API keys receive separate, independent rate limit quotas', async () => {
    const app = createTestApp({ maxRequests: 1, windowMs: 60000 });
    const apiKeyAlpha = `key-alpha-${crypto.randomUUID()}`;
    const apiKeyBeta = `key-beta-${crypto.randomUUID()}`;

    // Alpha uses 1st request -> 200
    const resAlpha1 = await request(app).get('/api/resource').set('X-API-Key', apiKeyAlpha);
    expect(resAlpha1.status).toBe(200);

    // Alpha 2nd request -> 429 (quota exhausted)
    const resAlpha2 = await request(app).get('/api/resource').set('X-API-Key', apiKeyAlpha);
    expect(resAlpha2.status).toBe(429);

    // Beta 1st request -> 200 (completely unaffected by Alpha)
    const resBeta1 = await request(app).get('/api/resource').set('X-API-Key', apiKeyBeta);
    expect(resBeta1.status).toBe(200);
    expect(resBeta1.headers['x-ratelimit-remaining']).toBe('0');
  });

  test('requests without X-API-Key fallback to IP identity', async () => {
    const app = createTestApp({ maxRequests: 2, windowMs: 60000 });

    const res1 = await request(app).get('/api/resource');
    expect(res1.status).toBe(200);
    expect(res1.body.identityType).toBe('ip');

    const res2 = await request(app).get('/api/resource');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('0');

    const res3 = await request(app).get('/api/resource');
    expect(res3.status).toBe(429);
  });

  test('raw API key is NEVER reflected in response body or headers', async () => {
    const app = createTestApp({ maxRequests: 1, windowMs: 60000 });
    const superSecretKey = 'super-secret-user-token-999888';

    // Consume limit
    await request(app).get('/api/resource').set('X-API-Key', superSecretKey);

    // Trigger 429
    const res = await request(app).get('/api/resource').set('X-API-Key', superSecretKey);
    expect(res.status).toBe(429);

    const bodyString = JSON.stringify(res.body);
    const headersString = JSON.stringify(res.headers);

    expect(bodyString).not.toContain(superSecretKey);
    expect(headersString).not.toContain(superSecretKey);
  });

  test('returns HTTP 503 (rate_limiter_unavailable) in fail-closed mode when rate limiter fails', async () => {
    const rateLimiterService = require('../../src/services/rateLimiter.service');
    const spy = jest.spyOn(rateLimiterService, 'checkLimit').mockRejectedValueOnce(
      new Error('Redis connection lost')
    );

    const app = createTestApp({ failMode: 'closed' });
    const res = await request(app).get('/api/resource');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'rate_limiter_unavailable',
      message: 'Rate limiting service is temporarily unavailable. Fail-closed policy active.',
      requestId: expect.any(String)
    });

    spy.mockRestore();
  });

  test('permits request with degraded header in fail-open mode when rate limiter fails', async () => {
    const rateLimiterService = require('../../src/services/rateLimiter.service');
    const spy = jest.spyOn(rateLimiterService, 'checkLimit').mockRejectedValueOnce(
      new Error('Redis down')
    );

    const app = createTestApp({ failMode: 'open' });
    const res = await request(app).get('/api/resource');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-degraded']).toBe('true');
    expect(res.body.success).toBe(true);

    spy.mockRestore();
  });
});
