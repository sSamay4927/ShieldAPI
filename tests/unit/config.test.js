const { loadConfig } = require('../../src/config/env');

describe('Configuration & Environment Validation (loadConfig)', () => {
  const baseValidEnv = {
    NODE_ENV: 'test',
    PORT: '3000',
    UPSTREAM_BASE_URL: 'http://localhost:4001',
    REDIS_URL: 'redis://localhost:6379',
    MONGODB_URI: 'mongodb://localhost:27017/shieldapi',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_MAX_REQUESTS: '5',
    RATE_LIMIT_FAIL_MODE: 'closed',
    RATE_LIMIT_IDENTITY_MODE: 'api-key-or-ip',
    IDENTITY_HASH_SECRET: 'test-environment-secret-length-exceeds-16',
    PROXY_TIMEOUT_MS: '5000',
    AUDIT_RETENTION_DAYS: '30'
  };

  test('loads valid configuration successfully', () => {
    const config = loadConfig(baseValidEnv);
    expect(config.PORT).toBe(3000);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60000);
    expect(config.RATE_LIMIT_MAX_REQUESTS).toBe(5);
    expect(config.RATE_LIMIT_FAIL_MODE).toBe('closed');
    expect(config.IDENTITY_HASH_SECRET).toBe('test-environment-secret-length-exceeds-16');
  });

  test('rejects non-integer or non-positive PORT', () => {
    expect(() => loadConfig({ ...baseValidEnv, PORT: '0' })).toThrow(/PORT.*positive integer/i);
    expect(() => loadConfig({ ...baseValidEnv, PORT: '-10' })).toThrow(/PORT.*positive integer/i);
    expect(() => loadConfig({ ...baseValidEnv, PORT: 'abc' })).toThrow(/PORT.*positive integer/i);
    expect(() => loadConfig({ ...baseValidEnv, PORT: '99999' })).toThrow(/PORT.*65535/i);
  });

  test('rejects non-positive RATE_LIMIT_MAX_REQUESTS', () => {
    expect(() => loadConfig({ ...baseValidEnv, RATE_LIMIT_MAX_REQUESTS: '0' })).toThrow(
      /RATE_LIMIT_MAX_REQUESTS.*positive integer/i
    );
    expect(() => loadConfig({ ...baseValidEnv, RATE_LIMIT_MAX_REQUESTS: '-5' })).toThrow(
      /RATE_LIMIT_MAX_REQUESTS.*positive integer/i
    );
  });

  test('rejects non-positive RATE_LIMIT_WINDOW_MS', () => {
    expect(() => loadConfig({ ...baseValidEnv, RATE_LIMIT_WINDOW_MS: '0' })).toThrow(
      /RATE_LIMIT_WINDOW_MS.*positive integer/i
    );
  });

  test('rejects invalid RATE_LIMIT_FAIL_MODE', () => {
    expect(() => loadConfig({ ...baseValidEnv, RATE_LIMIT_FAIL_MODE: 'invalid-mode' })).toThrow(
      /RATE_LIMIT_FAIL_MODE.*either "closed" or "open"/i
    );
  });

  test('rejects too short or missing IDENTITY_HASH_SECRET', () => {
    expect(() => loadConfig({ ...baseValidEnv, IDENTITY_HASH_SECRET: 'short' })).toThrow(
      /IDENTITY_HASH_SECRET.*at least 16 characters/i
    );
  });

  test('rejects invalid UPSTREAM_BASE_URL', () => {
    expect(() => loadConfig({ ...baseValidEnv, UPSTREAM_BASE_URL: 'ftp://not-http' })).toThrow(
      /UPSTREAM_BASE_URL.*valid HTTP\/HTTPS URL/i
    );
    expect(() => loadConfig({ ...baseValidEnv, UPSTREAM_BASE_URL: 'not-a-url' })).toThrow(
      /UPSTREAM_BASE_URL.*valid HTTP\/HTTPS URL/i
    );
  });
});
