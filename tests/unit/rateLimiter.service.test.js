const { checkLimit } = require('../../src/services/rateLimiter.service');
const { BadRequestError } = require('../../src/utils/errors');

describe('Rate Limiter Service - Argument Validation (Unit)', () => {
  test('rejects empty or non-string key', async () => {
    await expect(checkLimit('', 60000, 5, 'uuid-1')).rejects.toThrow(BadRequestError);
    await expect(checkLimit(null, 60000, 5, 'uuid-1')).rejects.toThrow(/invalid.*key/i);
  });

  test('rejects non-positive or non-integer windowMs', async () => {
    await expect(checkLimit('key:1', 0, 5, 'uuid-1')).rejects.toThrow(/invalid.*window/i);
    await expect(checkLimit('key:1', -100, 5, 'uuid-1')).rejects.toThrow(/invalid.*window/i);
    await expect(checkLimit('key:1', 'not-a-number', 5, 'uuid-1')).rejects.toThrow(/invalid.*window/i);
  });

  test('rejects non-positive or non-integer maxRequests', async () => {
    await expect(checkLimit('key:1', 60000, 0, 'uuid-1')).rejects.toThrow(/invalid.*limit/i);
    await expect(checkLimit('key:1', 60000, -2, 'uuid-1')).rejects.toThrow(/invalid.*limit/i);
  });

  test('rejects empty or missing member string', async () => {
    await expect(checkLimit('key:1', 60000, 5, '')).rejects.toThrow(/invalid.*member/i);
    await expect(checkLimit('key:1', 60000, 5, null)).rejects.toThrow(/invalid.*member/i);
  });
});

