const crypto = require('crypto');
const { connect, disconnect, isConnected } = require('../../src/infrastructure/mongo/mongoClient');
const AuditLog = require('../../src/infrastructure/mongo/AuditLog.model');

describe('MongoDB Audit Persistence Smoke Test (Integration)', () => {
  const TEST_DB_URI = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/shieldapi_test';
  let mongoAvailable = false;

  beforeAll(async () => {
    try {
      await connect(TEST_DB_URI);
      mongoAvailable = isConnected();
    } catch {
      mongoAvailable = false;
    }
  }, 10000);

  afterAll(async () => {
    if (mongoAvailable) {
      await AuditLog.deleteMany({ policyId: 'smoke-test-policy' }).catch(() => {});
      await disconnect();
    }
  }, 10000);

  test('successfully connects, inserts, queries, and cleans up an audit record in MongoDB', async () => {
    if (!mongoAvailable) {
      console.warn('Skipping MongoDB integration test: local MongoDB not reachable at', TEST_DB_URI);
      return;
    }

    const testEventId = crypto.randomUUID();
    const testDigest = crypto.createHash('sha256').update('test-api-key-demo').digest('hex');

    // 1. Insert audit record
    const auditDoc = await AuditLog.create({
      eventId: testEventId,
      occurredAt: new Date(),
      route: '/gateway/v1/catalog',
      method: 'GET',
      policyId: 'smoke-test-policy',
      identityType: 'api-key',
      identityDigest: testDigest,
      decision: 'RATE_LIMITED',
      requestId: crypto.randomUUID(),
      limit: 5,
      windowMs: 60000,
      retryAfterMs: 45000
    });

    expect(auditDoc).toBeDefined();
    expect(auditDoc.eventId).toBe(testEventId);

    // 2. Query document back from MongoDB
    const found = await AuditLog.findOne({ eventId: testEventId });
    expect(found).not.toBeNull();
    expect(found.identityDigest).toBe(testDigest);
    expect(found.decision).toBe('RATE_LIMITED');
    expect(found.limit).toBe(5);
    expect(found.method).toBe('GET');

    // 3. Query using compound index fields
    const clientHistory = await AuditLog.find({
      identityDigest: testDigest,
      policyId: 'smoke-test-policy'
    }).sort({ occurredAt: -1 });

    expect(clientHistory.length).toBeGreaterThanOrEqual(1);
    expect(clientHistory[0].eventId).toBe(testEventId);

    // 4. Delete smoke test document
    await AuditLog.deleteOne({ eventId: testEventId });
    const deletedCheck = await AuditLog.findOne({ eventId: testEventId });
    expect(deletedCheck).toBeNull();
  });
});
