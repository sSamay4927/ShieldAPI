const crypto = require('crypto');
const { getClient, connect, disconnect } = require('../../src/infrastructure/redis/redisClient');
const { checkLimit } = require('../../src/services/rateLimiter.service');

describe('Atomic Redis Lua Sliding-Window Rate Limiter (Integration)', () => {
  let redisClient;
  const testKeysToCleanup = new Set();

  beforeAll(async () => {
    redisClient = await connect();
  });

  afterAll(async () => {
    // Clean up all test keys created during integration testing
    if (redisClient && testKeysToCleanup.size > 0) {
      await redisClient.del(...Array.from(testKeysToCleanup)).catch(() => {});
    }
    await disconnect();
  });

  function getUniqueTestKey() {
    const key = `shieldapi:test:${crypto.randomUUID()}`;
    testKeysToCleanup.add(key);
    return key;
  }

  test('allows requests up to the limit and denies subsequent requests with correct retry-after', async () => {
    const key = getUniqueTestKey();
    const windowMs = 60000;
    const limit = 2;

    // 1st request -> allowed
    const res1 = await checkLimit(key, windowMs, limit, crypto.randomUUID());
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(1);
    expect(res1.nowMs).toBeGreaterThan(0);
    expect(res1.resetEpochSec).toBeGreaterThan(0);

    // 2nd request -> allowed, quota now fully consumed
    const res2 = await checkLimit(key, windowMs, limit, crypto.randomUUID());
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(0);

    // 3rd request -> DENIED (over limit)
    const res3 = await checkLimit(key, windowMs, limit, crypto.randomUUID());
    expect(res3.allowed).toBe(false);
    expect(res3.remaining).toBe(0);
    expect(res3.retryAfterMs).toBeGreaterThan(0);
    expect(res3.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  test('sliding window opens up after window expires', async () => {
    const key = getUniqueTestKey();
    const shortWindowMs = 400; // 400ms window
    const limit = 1;

    // Request 1 -> allowed
    const res1 = await checkLimit(key, shortWindowMs, limit, crypto.randomUUID());
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(0);

    // Request 2 -> immediate second request denied
    const res2 = await checkLimit(key, shortWindowMs, limit, crypto.randomUUID());
    expect(res2.allowed).toBe(false);

    // Wait 500ms for window to slide past the first request
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Request 3 -> now allowed again!
    const res3 = await checkLimit(key, shortWindowMs, limit, crypto.randomUUID());
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);
  });

  test('two requests in the exact same millisecond with distinct UUIDs are both counted', async () => {
    const key = getUniqueTestKey();
    const windowMs = 60000;
    const limit = 5;

    const [r1, r2] = await Promise.all([
      checkLimit(key, windowMs, limit, crypto.randomUUID()),
      checkLimit(key, windowMs, limit, crypto.randomUUID())
    ]);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);

    // Verify Redis sorted set has exactly 2 members
    const zcard = await redisClient.zcard(key);
    expect(zcard).toBe(2);
  });

  test('denied requests are NOT inserted into the sorted set', async () => {
    const key = getUniqueTestKey();
    const windowMs = 60000;
    const limit = 1;

    await checkLimit(key, windowMs, limit, 'member-1'); // allowed
    await checkLimit(key, windowMs, limit, 'member-2'); // denied
    await checkLimit(key, windowMs, limit, 'member-3'); // denied

    // Set size must remain exactly 1
    const zcard = await redisClient.zcard(key);
    expect(zcard).toBe(1);
  });
});
