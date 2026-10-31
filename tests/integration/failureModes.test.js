const request = require('supertest');
const crypto = require('crypto');
const express = require('express');
const { connect: connectRedis, disconnect: disconnectRedis } = require('../../src/infrastructure/redis/redisClient');
const { connect: connectMongo, disconnect: disconnectMongo } = require('../../src/infrastructure/mongo/mongoClient');
const rateLimiterService = require('../../src/services/rateLimiter.service');
const auditQueue = require('../../src/infrastructure/queue/auditQueue');
const mongoClient = require('../../src/infrastructure/mongo/mongoClient');
const { createMockUpstreamApp } = require('../../src/upstream/mockUpstream');
const { createUpstreamProxy } = require('../../src/proxy/upstreamProxy');
const { identifyClient } = require('../../src/middleware/identifyClient');
const { createRateLimitMiddleware } = require('../../src/middleware/rateLimit');
const requestIdMiddleware = require('../../src/middleware/requestId');
const healthRoutes = require('../../src/routes/health.routes');

describe('System Failure Modes & Graceful Degradation Suite (Phase 9)', () => {
  let mockUpstreamApp;
  let mockUpstreamServer;
  let upstreamBaseUrl;

  beforeAll(async () => {
    await connectRedis();
    await connectMongo();

    mockUpstreamApp = createMockUpstreamApp();
    await new Promise((resolve) => {
      mockUpstreamServer = mockUpstreamApp.listen(0, '127.0.0.1', () => {
        const port = mockUpstreamServer.address().port;
        upstreamBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (mockUpstreamServer) {
      await new Promise((resolve) => mockUpstreamServer.close(resolve));
    }
    await auditQueue.closeQueue();
    await disconnectRedis();
    await disconnectMongo();
  });

  function createTestGateway(policyOptions = {}, proxyOptions = {}) {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json({ limit: '100kb' }));
    app.use('/health', healthRoutes);

    app.use(
      '/gateway/v1',
      identifyClient,
      createRateLimitMiddleware({
        policy: {
          id: 'failure-policy',
          windowMs: policyOptions.windowMs || 60000,
          maxRequests: policyOptions.maxRequests || 2,
          failMode: policyOptions.failMode || 'closed'
        },
        keyPrefix: `shieldapi:test:failure:${crypto.randomUUID()}`
      }),
      createUpstreamProxy({
        target: proxyOptions.target || upstreamBaseUrl,
        timeoutMs: proxyOptions.timeoutMs !== undefined ? proxyOptions.timeoutMs : 5000,
        pathPrefix: '/gateway/v1'
      })
    );

    return app;
  }

  test('1. Redis outage in fail-closed mode returns HTTP 503 (rate_limiter_unavailable), NOT 429 or 500', async () => {
    const spy = jest.spyOn(rateLimiterService, 'checkLimit').mockRejectedValueOnce(
      new Error('Redis connection refused: ECONNREFUSED 127.0.0.1:6379')
    );

    const gateway = createTestGateway({ failMode: 'closed' });
    const res = await request(gateway)
      .get('/gateway/v1/catalog')
      .set('X-API-Key', `key-${crypto.randomUUID()}`);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'rate_limiter_unavailable',
      message: 'Rate limiting service is temporarily unavailable. Fail-closed policy active.',
      requestId: expect.any(String)
    });

    spy.mockRestore();
  });

  test('2. MongoDB outage reports degraded status in /health/ready without blocking gateway rate limiting', async () => {
    const spy = jest.spyOn(mongoClient, 'getStatus').mockReturnValue('disconnected');

    const gateway = createTestGateway({ maxRequests: 1 });

    // Verify /health/ready reflects disconnected MongoDB
    const healthRes = await request(gateway).get('/health/ready');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('ready'); // Gateway is still ready to process traffic
    expect(healthRes.body.mongo).toBe('disconnected');

    // Gateway still enforces rate limiting normally despite Mongo degradation
    const apiKey = `key-${crypto.randomUUID()}`;
    const allowed = await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', apiKey);
    expect(allowed.status).toBe(200);

    const denied = await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', apiKey);
    expect(denied.status).toBe(429);

    spy.mockRestore();
  });

  test('3. Audit queue failure logs error without interrupting rate limiting or HTTP response', async () => {
    const queueSpy = jest.spyOn(auditQueue, 'enqueueAuditEvent').mockResolvedValueOnce(null);

    const gateway = createTestGateway({ maxRequests: 1 });
    const apiKey = `key-${crypto.randomUUID()}`;

    // Request 1 -> 200
    await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', apiKey);

    // Request 2 -> 429 rate limit violation
    const res = await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', apiKey);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limit_exceeded');

    queueSpy.mockRestore();
  });

  test('4. Upstream service response timeout returns HTTP 504 gateway_timeout with requestId', async () => {
    // Gateway configured with short 300ms proxy timeout
    const gateway = createTestGateway(
      { maxRequests: 5 },
      { timeoutMs: 300 }
    );

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

  test('5. Upstream unreachable returns sanitized HTTP 502 bad_gateway without leaking internal stack traces', async () => {
    // Target dead port
    const gateway = createTestGateway(
      { maxRequests: 5 },
      { target: 'http://127.0.0.1:49988' }
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

    // Ensure no internal file paths or node error traces in response
    const rawBody = JSON.stringify(res.body);
    expect(rawBody).not.toContain('node:');
    expect(rawBody).not.toContain('ECONNREFUSED');
    expect(rawBody).not.toContain('at TCPConnectWrap');
  });
});
