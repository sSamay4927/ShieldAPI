const fs = require('fs');
const path = require('path');
const { getClient, connect } = require('../infrastructure/redis/redisClient');
const { ServiceUnavailableError, BadRequestError } = require('../utils/errors');
const { logger } = require('../utils/logger');

// Load the atomic Lua script once at module load
const LUA_SCRIPT_PATH = path.join(__dirname, '../infrastructure/redis/slidingWindowLog.lua');
const LUA_SCRIPT = fs.readFileSync(LUA_SCRIPT_PATH, 'utf-8');

/**
 * Register the custom Lua script command on the Redis client if not present.
 */
function ensureCommandRegistered(client) {
  if (client && typeof client.slidingWindowRateLimit !== 'function' && typeof client.defineCommand === 'function') {
    client.defineCommand('slidingWindowRateLimit', {
      numberOfKeys: 1,
      lua: LUA_SCRIPT
    });
  }
}

/**
 * Execute the atomic rate-limit check inside Redis.
 *
 * @param {string} key - Redis key (e.g. shieldapi:rl:v1:default:<digest>)
 * @param {number} windowMs - Window duration in milliseconds
 * @param {number} maxRequests - Max requests permitted in the window
 * @param {string} member - Unique request identifier (UUID)
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfterMs: number, retryAfterSec: number, resetEpochSec: number, nowMs: number}>}
 */
async function checkLimit(key, windowMs, maxRequests, member) {
  // 1. Strict input validation
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new BadRequestError('Invalid rate limiter key: must be a non-empty string', 'invalid_key');
  }

  const numWindow = Number(windowMs);
  if (!Number.isInteger(numWindow) || numWindow <= 0) {
    throw new BadRequestError('Invalid rate limiter windowMs: must be a positive integer', 'invalid_window');
  }

  const numLimit = Number(maxRequests);
  if (!Number.isInteger(numLimit) || numLimit <= 0) {
    throw new BadRequestError('Invalid rate limiter maxRequests: must be a positive integer', 'invalid_limit');
  }

  if (!member || typeof member !== 'string' || member.trim() === '') {
    throw new BadRequestError('Invalid rate limiter member: must be a non-empty string', 'invalid_member');
  }

  // 2. Obtain client and ensure command registered
  const client = getClient();
  ensureCommandRegistered(client);

  try {
    if (client.status !== 'ready' && client.status !== 'connect') {
      await connect();
      ensureCommandRegistered(client);
    }

    // 3. Execute atomic Lua script
    const result = await client.slidingWindowRateLimit(key, numWindow, numLimit, member);

    // 4. Parse return array: [allowed, remaining, reset_or_retry_after_ms, now_ms]
    const allowed = result[0] === 1;
    const remaining = Number(result[1]);
    const retryAfterMs = Number(result[2]);
    const nowMs = Number(result[3]);

    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const resetEpochSec = Math.ceil((nowMs + retryAfterMs) / 1000);

    return {
      allowed,
      remaining,
      retryAfterMs,
      retryAfterSec,
      resetEpochSec,
      nowMs
    };
  } catch (err) {
    if (err instanceof BadRequestError) {
      throw err;
    }

    logger.error('Redis atomic rate limiter execution failure', {
      key,
      error: err.message
    });

    throw new ServiceUnavailableError(
      'Rate limiting service is temporarily unavailable. Fail-closed policy active.',
      'rate_limiter_unavailable'
    );
  }
}

module.exports = {
  checkLimit,
  LUA_SCRIPT
};
