const request = require('supertest');
const app = require('../../src/app');

describe('Request ID Middleware', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  test('generates a valid UUID v4 when no X-Request-Id is sent', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  test('preserves a valid incoming X-Request-Id', async () => {
    const customId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const res = await request(app)
      .get('/health/live')
      .set('X-Request-Id', customId);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(customId);
  });

  test('replaces an invalid or malicious incoming X-Request-Id with a new UUID', async () => {
    const maliciousId = '<script>alert(1)</script>';
    const res = await request(app)
      .get('/health/live')
      .set('X-Request-Id', maliciousId);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).not.toBe(maliciousId);
    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });
});
