const { identifyClient, computeIdentityDigest } = require('../../src/middleware/identifyClient');
const { config } = require('../../src/config/env');

describe('Client Identification Middleware (Unit)', () => {
  test('computes stable 64-char hex digest for API key and sets identityType="api-key"', () => {
    const rawKey = 'test-secret-key-12345';
    const req = {
      get: (header) => (header.toLowerCase() === 'x-api-key' ? rawKey : undefined),
      headers: { 'x-api-key': rawKey },
      ip: '192.168.1.1'
    };
    const res = {};
    const next = jest.fn();

    identifyClient(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.identityType).toBe('api-key');
    expect(req.identityDigest).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(req.identityDigest)).toBe(true);
    expect(req.identityDigest).not.toContain(rawKey);
    expect(req.identityDigest).toBe(computeIdentityDigest(rawKey));
  });

  test('falls back to req.ip when X-API-Key is missing', () => {
    const req = {
      get: () => undefined,
      headers: {},
      ip: '203.0.113.195'
    };
    const res = {};
    const next = jest.fn();

    identifyClient(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.identityType).toBe('ip');
    expect(req.identityDigest).toBe(computeIdentityDigest('203.0.113.195'));
  });

  test('falls back to req.ip when X-API-Key is empty or whitespace string', () => {
    const req = {
      get: (header) => (header.toLowerCase() === 'x-api-key' ? '   ' : undefined),
      headers: { 'x-api-key': '   ' },
      ip: '10.0.0.1'
    };
    const res = {};
    const next = jest.fn();

    identifyClient(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.identityType).toBe('ip');
    expect(req.identityDigest).toBe(computeIdentityDigest('10.0.0.1'));
  });

  test('distinct API keys produce distinct identity digests (no collision)', () => {
    const digestA = computeIdentityDigest('key-alpha');
    const digestB = computeIdentityDigest('key-beta');

    expect(digestA).not.toBe(digestB);
    expect(digestA).toHaveLength(64);
    expect(digestB).toHaveLength(64);
  });

  test('distinct IPs produce distinct identity digests', () => {
    const digestA = computeIdentityDigest('192.168.1.10');
    const digestB = computeIdentityDigest('192.168.1.11');

    expect(digestA).not.toBe(digestB);
  });
});

