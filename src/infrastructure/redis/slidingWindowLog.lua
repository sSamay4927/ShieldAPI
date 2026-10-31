-- ==============================================================================
-- ShieldAPI Atomic Sliding-Window Log Rate Limiter
-- ==============================================================================
-- KEYS[1]: Redis sorted set key (e.g. shieldapi:rl:v1:default:<digest>)
-- ARGV[1]: window_ms (sliding window duration in milliseconds, e.g. 60000)
-- ARGV[2]: limit (maximum allowed requests in window, e.g. 5)
-- ARGV[3]: member (unique request identifier, e.g. UUID)
--
-- Return format: { allowed, remaining, reset_or_retry_after_ms, now_ms }
--   allowed: 1 if request is permitted, 0 if quota exceeded
--   remaining: count of remaining requests permitted in active window
--   reset_or_retry_after_ms: milliseconds until oldest accepted request clears window
--   now_ms: Redis server timestamp in milliseconds
-- ==============================================================================

local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]

-- 1. Fetch current Redis server time (avoids application clock drift across instances)
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)

-- 2. Evict expired entries older than (now - window_ms)
local cutoff_ms = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff_ms)

-- 3. Count remaining accepted entries in current active window
local current_count = redis.call('ZCARD', KEYS[1])

-- 4. Evaluate quota: Allowed
if current_count < limit then
  -- Atomically record this accepted request
  redis.call('ZADD', KEYS[1], now_ms, member)
  -- Set key expiry slightly longer than window to reclaim memory automatically
  redis.call('PEXPIRE', KEYS[1], window_ms + 1000)

  -- Oldest request timestamp defines when a quota slot opens up
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local reset_after_ms = math.max(1, tonumber(oldest[2]) + window_ms - now_ms)

  return { 1, limit - current_count - 1, reset_after_ms, now_ms }
end

-- 5. Evaluate quota: Quota Exceeded (Do NOT insert member)
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry_after_ms = 1
if oldest and oldest[2] then
  retry_after_ms = math.max(1, tonumber(oldest[2]) + window_ms - now_ms)
end

return { 0, 0, retry_after_ms, now_ms }

