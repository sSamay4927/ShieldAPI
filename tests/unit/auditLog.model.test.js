const AuditLog = require('../../src/infrastructure/mongo/AuditLog.model');

describe('AuditLog Model & Schema Validation (Unit)', () => {
  const validDocData = {
    eventId: '11111111-2222-3333-4444-555555555555',
    occurredAt: new Date(),
    route: '/gateway/v1/catalog',
    method: 'GET',
    policyId: 'default',
    identityType: 'api-key',
    identityDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    decision: 'RATE_LIMITED',
    requestId: '99999999-8888-7777-6666-555555555555',
    limit: 5,
    windowMs: 60000,
    retryAfterMs: 12000,
    expireAt: new Date(Date.now() + 86400000)
  };

  test('validates successfully with complete valid document data', async () => {
    const doc = new AuditLog(validDocData);
    let validationError = null;
    try {
      await doc.validate();
    } catch (err) {
      validationError = err;
    }
    expect(validationError).toBeNull();
    expect(doc.route).toBe('/gateway/v1/catalog');
    expect(doc.method).toBe('GET');
    expect(doc.policyId).toBe('default');
  });

  test('fails validation when required fields are missing', async () => {
    const doc = new AuditLog({});
    let validationError = null;
    try {
      await doc.validate();
    } catch (err) {
      validationError = err;
    }
    expect(validationError).toBeDefined();
    expect(validationError.errors.eventId).toBeDefined();
    expect(validationError.errors.route).toBeDefined();
    expect(validationError.errors.method).toBeDefined();
    expect(validationError.errors.identityType).toBeDefined();
    expect(validationError.errors.identityDigest).toBeDefined();
    expect(validationError.errors.decision).toBeDefined();
    expect(validationError.errors.requestId).toBeDefined();
    expect(validationError.errors.limit).toBeDefined();
    expect(validationError.errors.windowMs).toBeDefined();
    expect(validationError.errors.retryAfterMs).toBeDefined();
  });

  test('enforces identityType enum values ("api-key" or "ip")', async () => {
    const doc = new AuditLog({
      ...validDocData,
      identityType: 'jwt_token' // Invalid
    });
    let validationError = null;
    try {
      await doc.validate();
    } catch (err) {
      validationError = err;
    }
    expect(validationError).toBeDefined();
    expect(validationError.errors.identityType.message).toContain('is not a valid identityType');
  });

  test('enforces decision enum values ("RATE_LIMITED" or "UPSTREAM_ERROR")', async () => {
    const doc = new AuditLog({
      ...validDocData,
      decision: 'ALLOWED' // Invalid: AuditLog stores violations/errors only
    });
    let validationError = null;
    try {
      await doc.validate();
    } catch (err) {
      validationError = err;
    }
    expect(validationError).toBeDefined();
    expect(validationError.errors.decision.message).toContain('is not a valid decision');
  });

  test('declares the required indexes on schema', () => {
    const indexes = AuditLog.schema.indexes();
    // Index 1: occurredAt descending
    const hasOccurredAtIndex = indexes.some(
      ([fields]) => fields.occurredAt === -1 && Object.keys(fields).length === 1
    );
    expect(hasOccurredAtIndex).toBe(true);

    // Index 2: identityDigest + occurredAt descending
    const hasCompoundIdentityIndex = indexes.some(
      ([fields]) => fields.identityDigest === 1 && fields.occurredAt === -1
    );
    expect(hasCompoundIdentityIndex).toBe(true);

    // Index 3: expireAt TTL index
    const hasExpireAtIndex = indexes.some(
      ([fields, options]) => fields.expireAt === 1 && options && options.expireAfterSeconds === 0
    );
    expect(hasExpireAtIndex).toBe(true);
  });
});
