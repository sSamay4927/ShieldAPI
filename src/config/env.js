const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env file if present
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parsePositiveInt(name, val, defaultValue) {
  const raw = val !== undefined && val !== '' ? val : defaultValue;
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(
      `Invalid environment configuration: "${name}" must be a positive integer. Received: "${raw}"`
    );
  }
  return num;
}

function parseUrl(name, val, defaultValue) {
  const raw = val !== undefined && val !== '' ? val : defaultValue;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`protocol must be http: or https:`);
    }
    return raw.replace(/\/$/, ''); // Remove trailing slash
  } catch (err) {
    throw new Error(
      `Invalid environment configuration: "${name}" must be a valid HTTP/HTTPS URL. Received: "${raw}". (${err.message})`
    );
  }
}

function loadConfig(env = process.env) {
  const NODE_ENV = env.NODE_ENV || 'development';
  const PORT = parsePositiveInt('PORT', env.PORT, 3000);
  if (PORT > 65535) {
    throw new Error(`Invalid environment configuration: "PORT" must be <= 65535. Received: "${PORT}"`);
  }

  const UPSTREAM_BASE_URL = parseUrl('UPSTREAM_BASE_URL', env.UPSTREAM_BASE_URL, 'http://localhost:4001');

  const REDIS_URL = env.REDIS_URL || 'redis://localhost:6379';
  if (!REDIS_URL.startsWith('redis://') && !REDIS_URL.startsWith('rediss://')) {
    throw new Error(
      `Invalid environment configuration: "REDIS_URL" must begin with redis:// or rediss://. Received: "${REDIS_URL}"`
    );
  }

  const MONGODB_URI = env.MONGODB_URI || 'mongodb://localhost:27017/shieldapi';
  if (!MONGODB_URI.startsWith('mongodb://') && !MONGODB_URI.startsWith('mongodb+srv://')) {
    throw new Error(
      `Invalid environment configuration: "MONGODB_URI" must begin with mongodb:// or mongodb+srv://. Received: "${MONGODB_URI}"`
    );
  }

  const RATE_LIMIT_WINDOW_MS = parsePositiveInt('RATE_LIMIT_WINDOW_MS', env.RATE_LIMIT_WINDOW_MS, 60000);
  const RATE_LIMIT_MAX_REQUESTS = parsePositiveInt('RATE_LIMIT_MAX_REQUESTS', env.RATE_LIMIT_MAX_REQUESTS, 5);

  const RATE_LIMIT_FAIL_MODE = (env.RATE_LIMIT_FAIL_MODE || 'closed').toLowerCase();
  if (!['closed', 'open'].includes(RATE_LIMIT_FAIL_MODE)) {
    throw new Error(
      `Invalid environment configuration: "RATE_LIMIT_FAIL_MODE" must be either "closed" or "open". Received: "${env.RATE_LIMIT_FAIL_MODE}"`
    );
  }

  const RATE_LIMIT_IDENTITY_MODE = env.RATE_LIMIT_IDENTITY_MODE || 'api-key-or-ip';
  if (!['api-key-or-ip', 'api-key', 'ip'].includes(RATE_LIMIT_IDENTITY_MODE)) {
    throw new Error(
      `Invalid environment configuration: "RATE_LIMIT_IDENTITY_MODE" must be one of ["api-key-or-ip", "api-key", "ip"]. Received: "${RATE_LIMIT_IDENTITY_MODE}"`
    );
  }

  const IDENTITY_HASH_SECRET = env.IDENTITY_HASH_SECRET || 'development-local-hmac-secret-change-in-production';
  if (!IDENTITY_HASH_SECRET || typeof IDENTITY_HASH_SECRET !== 'string' || IDENTITY_HASH_SECRET.length < 16) {
    throw new Error(
      `Invalid environment configuration: "IDENTITY_HASH_SECRET" must be a string of at least 16 characters.`
    );
  }
  if (NODE_ENV === 'production' && IDENTITY_HASH_SECRET.includes('development-local-hmac-secret')) {
    throw new Error(
      `Security violation: Default "IDENTITY_HASH_SECRET" cannot be used in production environment.`
    );
  }

  const PROXY_TIMEOUT_MS = parsePositiveInt('PROXY_TIMEOUT_MS', env.PROXY_TIMEOUT_MS, 5000);
  const AUDIT_RETENTION_DAYS = parsePositiveInt('AUDIT_RETENTION_DAYS', env.AUDIT_RETENTION_DAYS, 30);

  return Object.freeze({
    NODE_ENV,
    PORT,
    UPSTREAM_BASE_URL,
    REDIS_URL,
    MONGODB_URI,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_FAIL_MODE,
    RATE_LIMIT_IDENTITY_MODE,
    IDENTITY_HASH_SECRET,
    PROXY_TIMEOUT_MS,
    AUDIT_RETENTION_DAYS,
    isProduction: NODE_ENV === 'production',
    isTest: NODE_ENV === 'test'
  });
}

// Instantiate default configuration from current process.env
const config = loadConfig(process.env);

module.exports = {
  config,
  loadConfig
};
