class AppError extends Error {
  constructor(message, statusCode = 500, code = 'internal_server_error') {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Invalid request parameters', code = 'bad_request') {
    super(message, 400, code);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'The requested endpoint does not exist.', code = 'not_found') {
    super(message, 404, code);
  }
}

class TooManyRequestsError extends AppError {
  constructor(message = 'Rate limit exceeded. Try again later.', retryAfter = 60, remaining = 0) {
    super(message, 429, 'rate_limit_exceeded');
    this.retryAfter = retryAfter;
    this.remaining = remaining;
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable.', code = 'service_unavailable') {
    super(message, 503, code);
  }
}

class BadGatewayError extends AppError {
  constructor(message = 'Failed to connect to upstream service.', code = 'bad_gateway') {
    super(message, 502, code);
  }
}

class GatewayTimeoutError extends AppError {
  constructor(message = 'Upstream service response timed out.', code = 'gateway_timeout') {
    super(message, 504, code);
  }
}

module.exports = {
  AppError,
  BadRequestError,
  NotFoundError,
  TooManyRequestsError,
  ServiceUnavailableError,
  BadGatewayError,
  GatewayTimeoutError
};
