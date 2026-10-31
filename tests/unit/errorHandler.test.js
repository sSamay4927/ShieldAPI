const request = require('supertest');
const express = require('express');
const requestIdMiddleware = require('../../src/middleware/requestId');
const errorHandler = require('../../src/middleware/errorHandler');
const { AppError, BadRequestError } = require('../../src/utils/errors');

describe('Central Error Handling Middleware', () => {
  let testApp;

  beforeEach(() => {
    testApp = express();
    testApp.use(requestIdMiddleware);
    testApp.use(express.json());

    testApp.get('/operational-error', (req, res, next) => {
      next(new BadRequestError('Validation failed: invalid input field', 'invalid_input'));
    });

    testApp.get('/internal-crash', (req, res, next) => {
      next(new Error('Sensitive DB connection string: user:pass@secret.internal'));
    });

    testApp.get('/custom-status', (req, res, next) => {
      next(new AppError('Forbidden action', 403, 'forbidden'));
    });

    testApp.use(errorHandler);
  });

  test('formats operational client errors with correct status and error code', async () => {
    const res = await request(testApp).get('/operational-error');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_input',
      message: 'Validation failed: invalid input field',
      requestId: expect.any(String)
    });
    expect(res.body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  test('masks unexpected 500 errors and does NOT leak internal messages or stack traces', async () => {
    const res = await request(testApp).get('/internal-crash');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_server_error');
    expect(res.body.message).toBe('An unexpected internal server error occurred.');
    expect(res.body.message).not.toContain('Sensitive DB');
    expect(res.body.stack).toBeUndefined();
    expect(res.body.requestId).toBeDefined();
  });

  test('handles custom AppError with specified status code', async () => {
    const res = await request(testApp).get('/custom-status');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('Forbidden action');
  });
});
