const { processAuditJob } = require('../../src/workers/auditWorker');
const AuditLog = require('../../src/infrastructure/mongo/AuditLog.model');

describe('Audit Worker Processor (Unit)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('validates required payload fields and rejects invalid job data', async () => {
    const invalidJob = {
      id: 'job-1',
      data: { route: '/test' } // Missing required fields
    };

    await expect(processAuditJob(invalidJob)).rejects.toThrow(/missing required field/i);
  });

  test('retries when transient MongoDB database error occurs (throws to trigger BullMQ backoff)', async () => {
    jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('MongoNetworkError: connection timed out'));

    const validJob = {
      id: 'job-transient',
      attemptsMade: 1,
      data: {
        eventId: 'evt-123',
        route: '/gateway/v1/catalog',
        method: 'GET',
        identityType: 'api-key',
        identityDigest: 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        decision: 'RATE_LIMITED',
        requestId: 'req-123',
        limit: 5,
        windowMs: 60000,
        retryAfterMs: 15000
      }
    };

    await expect(processAuditJob(validJob)).rejects.toThrow('MongoNetworkError: connection timed out');
  });

  test('handles duplicate eventId (E11000) idempotently without throwing', async () => {
    const duplicateError = new Error('E11000 duplicate key error');
    duplicateError.code = 11000;
    jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(duplicateError);

    const validJob = {
      id: 'job-dup',
      attemptsMade: 1,
      data: {
        eventId: 'evt-duplicate',
        route: '/gateway/v1/catalog',
        method: 'GET',
        identityType: 'api-key',
        identityDigest: 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        decision: 'RATE_LIMITED',
        requestId: 'req-dup',
        limit: 5,
        windowMs: 60000,
        retryAfterMs: 15000
      }
    };

    const result = await processAuditJob(validJob);
    expect(result).toEqual({ success: true, duplicate: true });
  });
});
