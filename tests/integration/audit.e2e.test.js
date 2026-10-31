const request = require('supertest');
const crypto = require('crypto');
const express = require('express');
const { connect: connectRedis, disconnect: disconnectRedis } = require('../../src/infrastructure/redis/redisClient');
const { connect: connectMongo, disconnect: disconnectMongo } = require('../../src/infrastructure/mongo/mongoClient');
const AuditLog = require('../../src/infrastructure/mongo/AuditLog.model');
const { createAuditWorker } = require('../../src/workers/auditWorker');
const { closeQueue, getQueue } = require('../../src/infrastructure/queue/auditQueue');
const { createMockUpstreamApp } = require('../../src/upstream/mockUpstream');
const { createUpstreamProxy } = require('../../src/proxy/upstreamProxy');
const { identifyClient, computeIdentityDigest } = require('../../src/middleware/identifyClient');
const { createRateLimitMiddleware } = require('../../src/middleware/rateLimit');
const requestIdMiddleware = require('../../src/middleware/requestId');

describe('BullMQ Asynchronous Audit Pipeline (End-to-End)', () => {
  let mockUpstreamApp;
  let mockUpstreamServer;
  let upstreamBaseUrl;
  let worker;
  const createdAuditIds = [];

  beforeAll(async () => {
    // 1. Establish infrastructure connections
    await connectRedis();
    await connectMongo();

    // 2. Start mock upstream on dynamic port
    mockUpstreamApp = createMockUpstreamApp();
    await new Promise((resolve) => {
      mockUpstreamServer = mockUpstreamApp.listen(0, '127.0.0.1', () => {
        const port = mockUpstreamServer.address().port;
        upstreamBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 3. Start BullMQ background audit worker
    worker = createAuditWorker({ concurrency: 2 });
  });

  afterAll(async () => {
    // Clean up created audit records from MongoDB
    if (createdAuditIds.length > 0) {
      await AuditLog.deleteMany({ _id: { $in: createdAuditIds } }).catch(() => {});
    }

    if (worker) {
      await worker.close();
    }
    await closeQueue();

    if (mockUpstreamServer) {
      await new Promise((resolve) => mockUpstreamServer.close(resolve));
    }

    await disconnectRedis();
    await disconnectMongo();
  });

  function createTestGateway(maxRequests = 2) {
    const gatewayApp = express();
    gatewayApp.use(requestIdMiddleware);
    gatewayApp.use(express.json({ limit: '100kb' }));

    const keyPrefix = `shieldapi:test:audit:${crypto.randomUUID()}`;

    gatewayApp.use(
      '/gateway/v1',
      identifyClient,
      createRateLimitMiddleware({
        policy: {
          id: 'audit-test',
          windowMs: 60000,
          maxRequests,
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

    return gatewayApp;
  }

  /**
   * Helper to poll MongoDB for document created by asynchronous queue worker.
   */
  async function waitForAuditLog(requestId, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const doc = await AuditLog.findOne({ requestId }).lean();
      if (doc) {
        return doc;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  test('rate-limit violation (HTTP 429) is asynchronously persisted into MongoDB via BullMQ', async () => {
    const gateway = createTestGateway(1);
    const rawApiKey = `audit-key-${crypto.randomUUID()}`;
    const expectedDigest = computeIdentityDigest(rawApiKey);

    // Request 1 -> 200 (allowed)
    const res1 = await request(gateway)
      .get('/gateway/v1/catalog')
      .set('X-API-Key', rawApiKey);
    expect(res1.status).toBe(200);

    // Request 2 -> 429 (quota exceeded, triggers audit event)
    const res2 = await request(gateway)
      .get('/gateway/v1/catalog')
      .set('X-API-Key', rawApiKey);

    expect(res2.status).toBe(429);
    const requestId = res2.body.requestId;
    expect(requestId).toBeDefined();

    // Poll MongoDB for the asynchronously processed document
    const auditDoc = await waitForAuditLog(requestId);
    expect(auditDoc).not.toBeNull();
    createdAuditIds.push(auditDoc._id);

    // Verify all audit schema fields
    expect(auditDoc.decision).toBe('RATE_LIMITED');
    expect(auditDoc.requestId).toBe(requestId);
    expect(auditDoc.identityDigest).toBe(expectedDigest);
    expect(auditDoc.identityType).toBe('api-key');
    expect(auditDoc.limit).toBe(1);
    expect(auditDoc.windowMs).toBe(60000);
    expect(auditDoc.retryAfterMs).toBeGreaterThan(0);
    expect(auditDoc.route).toContain('/gateway/v1/catalog');
    expect(auditDoc.method).toBe('GET');
    expect(auditDoc.occurredAt).toBeInstanceOf(Date);
    expect(auditDoc.expireAt).toBeInstanceOf(Date);

    // CRITICAL: Raw API key must NEVER be in the audit document
    const docString = JSON.stringify(auditDoc);
    expect(docString).not.toContain(rawApiKey);
  });

  test('gateway continues returning 429 correctly even when worker is offline (decoupled)', async () => {
    // Pause worker to simulate background processing delay / worker downtime
    await worker.pause();

    const gateway = createTestGateway(1);
    const rawApiKey = `offline-worker-key-${crypto.randomUUID()}`;

    // Request 1 -> 200
    await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', rawApiKey);

    // Request 2 -> 429 (must return 429 immediately without failing)
    const res = await request(gateway).get('/gateway/v1/catalog').set('X-API-Key', rawApiKey);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limit_exceeded');

    // Resume worker for subsequent operations
    worker.resume();
  });
});
