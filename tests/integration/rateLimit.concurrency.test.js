const request = require('supertest');
const crypto = require('crypto');
const express = require('express');
const { connect, disconnect, getClient } = require('../../src/infrastructure/redis/redisClient');
const { createMockUpstreamApp } = require('../../src/upstream/mockUpstream');
const { createUpstreamProxy } = require('../../src/proxy/upstreamProxy');
const { identifyClient, computeIdentityDigest } = require('../../src/middleware/identifyClient');
const { createRateLimitMiddleware } = require('../../src/middleware/rateLimit');
const requestIdMiddleware = require('../../src/middleware/requestId');

describe('Distributed Concurrency & Race-Condition Suite (Phase 9)', () => {
  let redisClient;
  let mockUpstreamApp;
  let mockUpstreamServer;
  let upstreamBaseUrl;
  const testKeysToCleanup = new Set();

  beforeAll(async () => {
    redisClient = await connect();

    // Start mock upstream on dynamic port
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
    if (redisClient && testKeysToCleanup.size > 0) {
      await redisClient.del(...Array.from(testKeysToCleanup)).catch(() => {});
    }
    if (mockUpstreamServer) {
      await new Promise((resolve) => mockUpstreamServer.close(resolve));
    }
    await disconnect();
  });

  function buildGatewayInstance(limit = 10, windowMs = 60000, keyPrefix = 'shieldapi:rl:v1:concurrency') {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json({ limit: '100kb' }));

    app.use(
      '/gateway/v1',
      identifyClient,
      createRateLimitMiddleware({
        policy: {
          id: 'concurrency-policy',
          windowMs,
          maxRequests: limit,
          failMode: 'closed'
        },
        keyPrefix
      }),
      createUpstreamProxy({
        target: upstreamBaseUrl,
        timeoutMs: 5000,
        pathPrefix: '/gateway/v1'
      })
    );

    return app;
  }

  test('Single Gateway Instance: 50 concurrent requests with limit=10 -> exactly 10 pass, 40 rejected', async () => {
    const keyPrefix = `shieldapi:test:concurrency:${crypto.randomUUID()}`;
    const limit = 10;
    const gateway = buildGatewayInstance(limit, 60000, keyPrefix);

    const testApiKey = `concurrency-single-${crypto.randomUUID()}`;
    const identityDigest = computeIdentityDigest(testApiKey);
    const redisKey = `${keyPrefix}:${identityDigest}`;
    testKeysToCleanup.add(redisKey);

    // Pre-clean Redis state
    await redisClient.del(redisKey);

    // Dispatch 50 simultaneous requests
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        request(gateway)
          .get('/gateway/v1/catalog')
          .set('X-API-Key', testApiKey)
      );
    }

    const responses = await Promise.all(promises);

    const status200 = responses.filter((r) => r.status === 200);
    const status429 = responses.filter((r) => r.status === 429);

    expect(status200).toHaveLength(10);
    expect(status429).toHaveLength(40);

    // Check Redis set size directly
    const zcard = await redisClient.zcard(redisKey);
    expect(zcard).toBe(10);
  });

  test('Two Distributed Gateway Instances Sharing Redis: 50 concurrent requests (25 each) -> exactly 10 pass, 40 rejected', async () => {
    const keyPrefix = `shieldapi:test:concurrency-cluster:${crypto.randomUUID()}`;
    const limit = 10;

    // Spin up two independent Express gateway applications sharing the same Redis
    const gatewayA = buildGatewayInstance(limit, 60000, keyPrefix);
    const gatewayB = buildGatewayInstance(limit, 60000, keyPrefix);

    const testApiKey = `concurrency-cluster-${crypto.randomUUID()}`;
    const identityDigest = computeIdentityDigest(testApiKey);
    const redisKey = `${keyPrefix}:${identityDigest}`;
    testKeysToCleanup.add(redisKey);

    // Pre-clean Redis state
    await redisClient.del(redisKey);

    // Dispatch 25 requests to Gateway A and 25 requests to Gateway B simultaneously
    const promises = [];
    for (let i = 0; i < 25; i++) {
      promises.push(
        request(gatewayA)
          .get('/gateway/v1/catalog')
          .set('X-API-Key', testApiKey)
      );
      promises.push(
        request(gatewayB)
          .get('/gateway/v1/catalog')
          .set('X-API-Key', testApiKey)
      );
    }

    const responses = await Promise.all(promises);

    const status200 = responses.filter((r) => r.status === 200);
    const status429 = responses.filter((r) => r.status === 429);

    expect(status200).toHaveLength(10);
    expect(status429).toHaveLength(40);

    // Check Redis set size directly
    const zcard = await redisClient.zcard(redisKey);
    expect(zcard).toBe(10);
  });
});

