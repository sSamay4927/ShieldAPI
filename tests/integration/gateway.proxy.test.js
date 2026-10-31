const request = require('supertest');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { connect, disconnect } = require('../../src/infrastructure/redis/redisClient');
const { createMockUpstreamApp } = require('../../src/upstream/mockUpstream');
const { createUpstreamProxy } = require('../../src/proxy/upstreamProxy');
const { identifyClient } = require('../../src/middleware/identifyClient');
const { createRateLimitMiddleware } = require('../../src/middleware/rateLimit');
const requestIdMiddleware = require('../../src/middleware/requestId');

describe('Gateway Reverse Proxy & Upstream Integration (Phase 7)', () => {
  let redisClient;
  let mockUpstreamApp;
  let mockUpstreamServer;
  let upstreamPort;
  let upstreamBaseUrl;

  beforeAll(async () => {
    redisClient = await connect();

    // Start mock upstream on a dynamic free port
    mockUpstreamApp = createMockUpstreamApp();
    await new Promise((resolve) => {
      mockUpstreamServer = mockUpstreamApp.listen(0, '127.0.0.1', () => {
        upstreamPort = mockUpstreamServer.address().port;
        upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (mockUpstreamServer) {
      await new Promise((resolve) => mockUpstreamServer.close(resolve));
    }
    await disconnect();
  });

  beforeEach(() => {
    mockUpstreamApp.resetHitCounts();
  });

  function createTestGateway(policyOptions = {}, proxyOptions = {}) {
    const gatewayApp = express();
    gatewayApp.use(requestIdMiddleware);
    gatewayApp.use(express.json({ limit: '100kb' }));

    const keyPrefix = `shieldapi:test:proxy:${crypto.randomUUID()}`;

    gatewayApp.use(
      '/gateway/v1',
      identifyClient,
      createRateLimitMiddleware({
        policy: {
          id: 'proxy-test',
          windowMs: policyOptions.windowMs || 60000,
          maxRequests: policyOptions.maxRequests || 2,
          failMode: policyOptions.failMode || 'closed'
        },
        keyPrefix
      }),
      createUpstreamProxy({
        target: proxyOptions.target || upstreamBaseUrl,
        timeoutMs: proxyOptions.timeoutMs !== undefined ? proxyOptions.timeoutMs : 5000,
        pathPrefix: '/gateway/v1'
      })
    );

    return gatewayApp;
  }

  test('1. Allowed request reaches mock upstream and returns response with rate-limit headers', async () => {
    const gateway = createTestGateway({ maxRequests: 5 });
    const apiKey = `key-${crypto.randomUUID()}`;

    const res = await request(gateway)
      .get('/gateway/v1/catalog')
      .set('X-API-Key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(['item-a', 'item-b']);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-request-id']).toBeDefined();

    // Verify upstream received exactly 1 hit
    expect(mockUpstreamApp.getHitCount('/catalog')).toBe(1);
  });

  test('2. Rate-limited request (over quota) does NOT reach upstream service', async () => {
    const gateway = createTestGateway({ maxRequests: 2 });
    const apiKey = `key-${crypto.randomUUID()}`;

    // Request 1 -> allowed
    const res1 = await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', apiKey);
    expect(res1.status).toBe(200);

    // Request 2 -> allowed (quota now full)
    const res2 = await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', apiKey);
    expect(res2.status).toBe(200);

    const hitCountAfterAllowed = mockUpstreamApp.getHitCount('/catalog');
    expect(hitCountAfterAllowed).toBe(2);

    // Request 3 -> DENIED with 429
    const res3 = await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', apiKey);
    expect(res3.status).toBe(429);
    expect(res3.body.error).toBe('rate_limit_exceeded');

    // Upstream hit count MUST NOT have incremented!
    expect(mockUpstreamApp.getHitCount('/catalog')).toBe(2);
  });

  test('3. Calling /gateway/v1/slow beyond proxy timeout returns HTTP 504 gateway_timeout', async () => {
    // Gateway configured with a tight 300ms proxy timeout
    const gateway = createTestGateway(
      { maxRequests: 5 },
      { timeoutMs: 300 }
    );

    // Request /slow with 1000ms delay to force timeout
    const res = await request(gateway)
      .get('/gateway/v1/slow?delayMs=1000')
      .set('X-API-Key', `key-${crypto.randomUUID()}`);

    expect(res.status).toBe(504);
    expect(res.body).toEqual({
      error: 'gateway_timeout',
      message: 'Upstream service timed out before responding',
      requestId: expect.any(String)
    });
  });

  test('4. Upstream connection failure (service offline) returns HTTP 502 bad_gateway', async () => {
    // Target a non-existent port where no server is listening
    const gateway = createTestGateway(
      { maxRequests: 5 },
      { target: 'http://127.0.0.1:49123' }
    );

    const res = await request(gateway)
      .get('/gateway/v1/catalog')
      .set('X-API-Key', `key-${crypto.randomUUID()}`);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: 'bad_gateway',
      message: 'Unable to connect to upstream service',
      requestId: expect.any(String)
    });
  });

  test('5. POST /gateway/v1/echo successfully forwards request body to upstream', async () => {
    const gateway = createTestGateway({ maxRequests: 5 });
    const payload = { action: 'test_payload', count: 42, active: true };

    const res = await request(gateway)
      .post('/gateway/v1/echo')
      .set('X-API-Key', `key-${crypto.randomUUID()}`)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.echoed).toEqual(payload);
    expect(res.body.receivedHeaders['x-request-id']).toBeDefined();
    expect(mockUpstreamApp.getHitCount('/echo')).toBe(1);
  });

  test('6. SSRF attack attempts to redirect proxy target via headers or query params are ignored', async () => {
    const gateway = createTestGateway({ maxRequests: 5 });

    // Try to divert traffic using host spoofing headers or destination query params
    const res = await request(gateway)
      .get('/gateway/v1/catalog?target=http://evil.com&host=evil.com')
      .set('X-Forwarded-Host', 'evil.com')
      .set('X-Forwarded-Server', 'evil.com')
      .set('X-API-Key', `key-${crypto.randomUUID()}`);

    expect(res.status).toBe(200);
    // Request must strictly hit the configured mock upstream catalog, not external
    expect(res.body.service).toBe('mock-upstream');
    expect(mockUpstreamApp.getHitCount('/catalog')).toBe(1);
  });
});
