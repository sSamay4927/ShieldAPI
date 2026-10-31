# ShieldAPI — Multi-Phase Development Plan

> **Intended audience:** A lower-tier AI coding assistant (e.g. Gemini Flash).  
> **Rule:** Complete one phase fully, verify its acceptance gate, commit to Git, then move on. Never jump ahead.

---

## Project Summary

**ShieldAPI** is a backend API Gateway that:
- Sits in front of a downstream/mock API
- Identifies each client (by API key HMAC digest, or IP fallback)
- Checks their request count using a **Redis sorted-set sliding-window log**
- Makes the allow/deny decision inside **one atomic Lua script** — no race conditions
- Forwards allowed requests to a fixed upstream; rejects over-quota requests with HTTP 429
- Persists violation events asynchronously to **MongoDB** via a **BullMQ** worker queue
- Ships as a fully reproducible **Docker Compose** local demo

**Tech Stack:** Node.js (CommonJS), Express, Redis, Lua, MongoDB, BullMQ, Docker

---

## Global Coding Rules (Read Before Every Phase)

These rules apply throughout every phase. The AI assistant **must follow all of them**:

1. **Inspect before editing.** Always read existing files before changing them. Never assume a file exists or doesn't exist.
2. **One phase at a time.** Only implement what the current phase asks. Do not add future features early.
3. **CommonJS everywhere.** Use `require()` and `module.exports` consistently. Never mix ESM (`import/export`) into the project.
4. **No invented APIs.** Check `package.json` and installed package versions before using any library function. Use the matching documented API.
5. **Validate environment variables.** On startup, read and validate all required env vars. Fail with a clear message if any are missing or invalid.
6. **Never commit secrets.** `.env` must be git-ignored. Only commit `.env.example` with placeholder values.
7. **Always add tests.** Every new behavior gets a test. Do not claim a test passes without running it.
8. **Do not silently remove working code.** Do not rename unrelated files or introduce extra frameworks not in scope.
9. **Explain decisions in plain language.** A beginner should understand why each module exists.
10. **At the end of each phase, report:** files created/changed, commands run, actual results, known limitations, and what the next phase is.
11. **Update `docs/BUILD_STATE.md`** only with facts that are verified in the repo — not with guesses.

---

---

## Global System Prompt (Paste Once at Start of Any Coding Session)

Paste this prompt to the AI assistant at the very beginning of every new chat session before starting any phase work:

```text
You are my implementation assistant for ShieldAPI, a backend engineering portfolio project. I am using a low-tier Gemini Flash model, so work in small, verifiable steps.

Project goal: build an Express API gateway that applies a Redis-backed distributed sliding-window-log rate limiter. The rate-limit decision must execute in one atomic Redis Lua script. Allowed requests are forwarded to a fixed, configured upstream service. MongoDB stores audit records. BullMQ may be added later for asynchronous audit persistence.

Engineering rules:
1. First inspect the current repository and read docs/BUILD_STATE.md if it exists. Do not assume files or dependencies that you have not inspected.
2. Implement only the phase I name. Do not build future phases early.
3. Prefer simple, readable JavaScript using CommonJS consistently.
4. Do not invent package APIs. Check the installed package version and use its matching API.
5. Validate environment variables and fail with useful messages. Never commit secrets.
6. Add tests for the behavior being implemented. Do not claim tests pass unless you ran them.
7. Do not silently remove working code, rename unrelated files, or introduce extra frameworks.
8. Explain important choices in beginner-friendly language.
9. At the end, report: files created/changed, commands run, actual results, known limitations, and the exact next phase.
10. Update docs/BUILD_STATE.md only with facts verified in the repository.

If a requirement is ambiguous, choose the smallest safe implementation and state the assumption. Stop when the current phase's acceptance criteria are satisfied.
```

## Repository Structure (Build Toward This — Do Not Create All Files Now)

```
shieldapi/
  src/
    app.js                          ← Express app factory (no port binding)
    server.js                       ← Starts the HTTP server
    config/
      env.js                        ← Reads + validates environment variables
      policies.js                   ← Rate-limit policy definitions
    middleware/
      requestId.js                  ← Assigns a unique ID to every request
      identifyClient.js             ← Extracts + hashes client identity
      rateLimit.js                  ← Calls Redis limiter, sets headers or returns 429/503
      errorHandler.js               ← Central JSON error handler
    routes/
      health.routes.js              ← /health/live and /health/ready
      gateway.routes.js             ← /gateway/v1/* routes
    services/
      rateLimiter.service.js        ← Calls Lua script, returns structured result
      audit.service.js              ← Enqueues audit events to BullMQ
    infrastructure/
      redis/
        redisClient.js              ← Redis connection + ping + shutdown
        slidingWindowLog.lua        ← Atomic Lua rate-limit script
      mongo/
        mongoClient.js              ← MongoDB connection + health
        AuditLog.model.js           ← Mongoose schema + indexes
      queue/
        auditQueue.js               ← BullMQ queue definition
    proxy/
      upstreamProxy.js              ← Fixed-target HTTP proxy with timeout + error handling
    workers/
      auditWorker.js                ← BullMQ worker: reads jobs → writes MongoDB
    upstream/
      mockUpstream.js               ← Fake downstream API on a separate port
    utils/
      asyncHandler.js               ← Wraps async route handlers to catch errors
  tests/
    unit/                           ← Fast tests with no external services
    integration/                    ← Tests against real Redis/Mongo
  scripts/
    concurrency-test.js             ← Fires N simultaneous requests, counts results
    benchmark.js                    ← Throughput + latency measurement
  docs/
    BUILD_STATE.md                  ← Always up-to-date project status
    DECISIONS.md                    ← Architectural decisions with reasons
    API.md                          ← Route contract, headers, error codes
    BENCHMARKS.md                   ← Real measured results only
    SECURITY.md                     ← Security checklist
    DEMO.md                         ← Step-by-step demo commands
  .env.example                      ← Placeholder env vars (safe to commit)
  .gitignore
  Dockerfile
  docker-compose.yml
  .dockerignore
  package.json
  README.md
```

> **Important:** Create files only when their phase begins. Do not scaffold the entire structure in Phase 0.

---

## Environment Variables Reference

These are development defaults. Never commit real secrets.

```env
NODE_ENV=development
PORT=3000
UPSTREAM_BASE_URL=http://localhost:4001
REDIS_URL=redis://localhost:6379
MONGODB_URI=mongodb://localhost:27017/shieldapi
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=5
RATE_LIMIT_FAIL_MODE=closed
RATE_LIMIT_IDENTITY_MODE=api-key-or-ip
IDENTITY_HASH_SECRET=replace-with-a-long-random-local-secret
PROXY_TIMEOUT_MS=5000
AUDIT_RETENTION_DAYS=30
```

---

## HTTP API Contract (Summary)

| Route | Purpose | Behavior |
|---|---|---|
| `GET /health/live` | Process liveness | Returns 200 + JSON. Does NOT check Redis or Mongo. |
| `GET /health/ready` | Readiness check | Checks Redis. Reports Mongo degradation separately. |
| `GET /gateway/v1/catalog` | Protected demo route | Rate-limited. Forwards to mock upstream if allowed. |
| `GET /gateway/v1/slow` | Timeout demo | Forwards to slow mock endpoint. Tests 504 handling. |
| `POST /gateway/v1/echo` | Body forwarding test | Forwards JSON body. Enforces strict body size limit. |

### Response Status Codes

| Scenario | Status | Notes |
|---|---|---|
| Request allowed | Upstream status | Forward upstream response + rate-limit headers |
| Quota exceeded | 429 | Include `Retry-After`, `requestId`, `remaining: 0` |
| Redis unavailable | 503 | Code: `rate_limiter_unavailable`. NOT a 429. |
| Upstream timeout | 504 | Include `requestId`. |
| Upstream unreachable | 502 | Safe error body. No stack traces. |

### Rate-Limit Headers

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 3
X-RateLimit-Reset: 1700000060   (Unix epoch seconds)
Retry-After: 45                 (seconds, only on 429)
```

---

## The Core Algorithm — Sliding Window Lua Script

The entire allow/deny decision happens inside **one Lua script** executed atomically by Redis. Never split this into multiple Redis calls from JavaScript.

### How It Works

1. Get current time from Redis `TIME` command (not app server clock)
2. Remove sorted-set entries older than `now - windowMs` (expired requests)
3. Count remaining entries with `ZCARD`
4. **If count < limit:** Add current request (unique UUID member, timestamp as score), set key expiry, return `allowed=1`
5. **If count >= limit:** Calculate `retryAfterMs` from oldest entry, return `allowed=0`

### Redis Key Format

```
shieldapi:rl:v1:<policyId>:<identityDigest>
```

- `policyId`: e.g. `default`
- `identityDigest`: HMAC-SHA256 of the API key (or raw IP fallback). **Never the raw API key.**

### Reference Lua Script Shape

```lua
local window_ms = tonumber(ARGV[1])
local limit     = tonumber(ARGV[2])
local member    = ARGV[3]

local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000
  + math.floor(tonumber(redis_time[2]) / 1000)
local cutoff_ms = now_ms - window_ms

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff_ms)
local current_count = redis.call('ZCARD', KEYS[1])

if current_count < limit then
  redis.call('ZADD', KEYS[1], now_ms, member)
  redis.call('PEXPIRE', KEYS[1], window_ms + 1000)
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local reset_after_ms = math.max(1, tonumber(oldest[2]) + window_ms - now_ms)
  return {1, limit - current_count - 1, reset_after_ms, now_ms}
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry_after_ms = 1
if oldest[2] then
  retry_after_ms = math.max(1, tonumber(oldest[2]) + window_ms - now_ms)
end
return {0, 0, retry_after_ms, now_ms}
```

> **Verify:** argument order, return value parsing, numeric types, and empty-set edge cases. Run integration tests before marking this phase done.

---

## MongoDB Audit Document Schema

```json
{
  "eventId":       "uuid-string",
  "occurredAt":    "ISO Date",
  "route":         "/gateway/v1/catalog",
  "method":        "GET",
  "policyId":      "default",
  "identityType":  "api-key",
  "identityDigest":"hmac-sha256-hex-string",
  "decision":      "RATE_LIMITED",
  "requestId":     "uuid-string",
  "limit":         5,
  "windowMs":      60000,
  "retryAfterMs":  12000,
  "expireAt":      "ISO Date"
}
```

**Never store raw API keys. Never store full IP addresses without a documented reason.**

### Required Indexes

| Index | Purpose |
|---|---|
| `occurredAt` descending | Time-range investigation |
| `identityDigest + occurredAt` descending | Per-client violation history |
| `route + occurredAt` descending | Hot-route analysis (add later) |
| `expireAt` TTL | Auto-delete old documents (add only if retention is configured) |

---

---

# Phase 0 — Workspace & Repository Setup

## Objective

Create a clean, tracked Git repository with the project control files in place. No application code yet.

## Copy-Paste Prompt for Lower-Tier Model (Phase 0)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 0:

```text
I am starting Phase 0 of ShieldAPI. Inspect the current folder first. Do not implement application features. Set up only the repository hygiene and project tracking described in Phase 0 of the blueprint: package initialization if needed, .gitignore, docs/BUILD_STATE.md, and docs/DECISIONS.md. Use CommonJS as the planned module system. Do not install a large dependency set yet. Show the files you create, the exact commands I should run, and how I can verify the setup. Do not claim a command ran unless you actually ran it.
```

## What to Build

- Initialize a Git repository in the project folder
- Create a `.gitignore` that ignores: `node_modules/`, `.env`, `logs/`, `coverage/`, local build output
- Run `npm init` to create a minimal `package.json` (no production dependencies yet)
- Create `docs/BUILD_STATE.md` with the following sections filled in:
  - **Project goal** (one paragraph)
  - **Module system chosen**: CommonJS
  - **Current phase**: Phase 0
  - **Completed phases**: none
  - **Failing tests**: none yet
  - **Next task**: Phase 1 — document the API contract
- Create `docs/DECISIONS.md` — start it empty except for a header. Only add entries when a real decision is made in later phases.
- Record the Node.js LTS version being used (run `node --version`)

## Files to Create

```
.gitignore
package.json
docs/BUILD_STATE.md
docs/DECISIONS.md
```

## Acceptance Gate (All must pass before moving on)

- [ ] `git status` shows a clean working tree after the initial commit
- [ ] `.env` and `node_modules/` are listed in `.gitignore`
- [ ] `docs/BUILD_STATE.md` exists and says implementation has not started
- [ ] No application source files exist yet

## Git Commit

```bash
git init
git add .
git commit -m "chore: phase 0 - initialize repository and project controls"
```

---

# Phase 1 — Requirements & API Contract Documentation

## Objective

Write the full API contract as a markdown document before touching any code. This is the single source of truth for the rest of the project.

## Copy-Paste Prompt for Lower-Tier Model (Phase 1)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 1:

```text
Implement Phase 1 documentation only. Inspect the repository and the supplied ShieldAPI blueprint. Create docs/API.md describing the exact minimum routes, request flow, rate-limit policy, identity rules, response headers, and error cases. Add only confirmed decisions to docs/DECISIONS.md. Keep the project scope to one Express gateway, one mock upstream, Redis Lua rate limiting, and later MongoDB audit persistence. Do not write application code or add dependencies in this phase. If a detail is not settled, label it as an assumption rather than presenting it as fact.
```

## What to Build

Create `docs/API.md` with the following sections:

1. **Request flow narrative** — step by step, what happens when a request arrives at the gateway (allowed path and rejected path)
2. **Failure flow narratives** — what happens when Redis is down, when the upstream times out, when the upstream is unreachable
3. **Route table** — all 5 routes with method, path, purpose, rate-limited (yes/no), and expected behavior
4. **Rate-limit policy** — define the default policy:
   - Window: `RATE_LIMIT_WINDOW_MS` (default 60000ms)
   - Max requests: `RATE_LIMIT_MAX_REQUESTS` (default 5)
   - Failure mode: `RATE_LIMIT_FAIL_MODE=closed` (503 if Redis is unavailable)
5. **Client identity rules**:
   - If `X-API-Key` header is present → HMAC-SHA256 digest is the identity
   - Otherwise → `req.ip` is the identity
   - Raw API keys must never appear in Redis keys, logs, or database
6. **Response headers table** — document `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
7. **Error response format** — show the JSON shape for 429, 503, 502, 504 responses
8. **Non-goals** — explicitly state what this project does NOT do

Add a short entry to `docs/DECISIONS.md`:
- Decision: fail-closed (503) when Redis is unavailable
- Reason: silently allowing unlimited traffic during Redis outage defeats the purpose of the limiter

## Files to Create/Update

```
docs/API.md           ← Create new
docs/DECISIONS.md     ← Add first real decision entry
docs/BUILD_STATE.md   ← Update current phase to "Phase 1 complete"
```

## Acceptance Gate

- [ ] Every route is documented with method, path, rate-limited flag, and expected behavior
- [ ] The 429 response is clearly distinct from the 503 Redis error — different error codes, different meanings
- [ ] The document explicitly states this is application-level protection, not network-level DDoS mitigation
- [ ] No application source code has been written

## Git Commit

```bash
git add .
git commit -m "docs: phase 1 - freeze API contract and policy rules"
```

---

# Phase 2 — Express Application Skeleton

## Objective

Get a minimal HTTP server running with just a liveness health check. No Redis, no MongoDB, no rate limiting yet.

## Copy-Paste Prompt for Lower-Tier Model (Phase 2)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 2:

```text
Implement Phase 2 only: a minimal Express application skeleton. Inspect the package.json and current files first. Use CommonJS consistently. Separate app construction from server startup so tests can import the app without binding a port. Add GET /health/live, a JSON 404 handler, and a safe central error handler. Add only required scripts and the Express dependency. Do not connect Redis, MongoDB, BullMQ, or a proxy yet. Run the server and verify the health route if terminal access is available; otherwise give me the exact commands and expected response.
```

## What to Build

### `src/app.js`
- Create and export the Express `app` object
- **Do NOT call `app.listen()` here** — keep app construction separate from server startup so tests can import the app without binding a network port
- Mount the health routes
- Add a catch-all 404 handler that returns JSON: `{ error: "not_found", path: "..." }`
- Add a central error handler at the bottom that returns JSON errors without leaking stack traces

### `src/server.js`
- Import `app` from `app.js`
- Call `app.listen(PORT)` here only
- Log the port on startup

### `src/routes/health.routes.js`
- `GET /health/live` → returns `{ status: "ok", timestamp: "..." }` with HTTP 200
- Do NOT check Redis or MongoDB in this route — it is a pure process liveness check

### `package.json` scripts
```json
{
  "scripts": {
    "start": "node src/server.js",
    "dev": "node src/server.js"
  }
}
```

Install only: `express`

## Files to Create

```
src/app.js
src/server.js
src/routes/health.routes.js
package.json (updated with express dependency)
package-lock.json
```

## Acceptance Gate

- [ ] `npm start` starts the server without needing Redis or MongoDB
- [ ] `GET /health/live` returns HTTP 200 and a JSON body
- [ ] `GET /unknown-route` returns HTTP 404 and a JSON body (not an HTML Express error page)
- [ ] `app.js` can be `require()`'d in a test file without binding a port

## Git Commit

```bash
git add .
git commit -m "feat: phase 2 - express skeleton with liveness health check"
```

---

# Phase 3 — Configuration, Request IDs, Logging & Error Handling

## Objective

Make the application's configuration, request tracking, and error behavior robust and predictable before connecting any external services.

## Copy-Paste Prompt for Lower-Tier Model (Phase 3)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 3:

```text
Implement Phase 3 only. Inspect the current skeleton and package versions. Add centralized environment parsing/validation, .env.example, request-ID middleware, safe structured logging, and consistent JSON error handling. Do not add Redis or MongoDB code yet. Do not log raw credentials, authorization headers, or full API keys. Add focused tests for invalid numeric configuration, request IDs, 404s, and safe error responses. Keep the code small and explain each new module's responsibility.
```

## What to Build

### `src/config/env.js`
- Use `dotenv` to load `.env` file
- Read and validate every required environment variable
- Validate numeric values: `PORT`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, `PROXY_TIMEOUT_MS`
  - Reject zero, negative, `NaN`, or unreasonably large values
  - Exit the process with a descriptive error message if validation fails
- Export a frozen config object — do not let other modules call `process.env` directly

### `.env.example`
- Create this file with all variables listed as placeholders
- This file IS committed to Git. The real `.env` is NOT.

### `src/middleware/requestId.js`
- If the incoming request has an `X-Request-Id` header AND it matches a safe format (UUID pattern), use it
- Otherwise generate a new UUID
- Attach the request ID to `req.requestId`
- Add `X-Request-Id` to the response headers
- **Never trust arbitrary strings from headers without validation**

### Structured Logging
- Add a simple logger (use `pino` or a minimal custom logger)
- Log: `method`, `url`, `statusCode`, `requestId`, `durationMs` for every request
- **Never log:** `Authorization` header, `X-API-Key` header, raw API key values, passwords, or secrets

### `src/middleware/errorHandler.js`
- Central Express error handler (4-argument function: `err, req, res, next`)
- Maps known application errors to stable JSON responses
- Unknown errors return 500 with a generic message — **no stack trace in response body**
- In development mode, log the full error internally

### Tests to add

- Test that missing `PORT` env var causes startup to fail with a message
- Test that `RATE_LIMIT_MAX_REQUESTS=0` is rejected
- Test that `GET /anything-unknown` returns 404 JSON
- Test that a thrown error inside a route returns 500 JSON without a stack trace

## Files to Create/Update

```
src/config/env.js
src/middleware/requestId.js
src/middleware/errorHandler.js
.env.example
tests/unit/config.test.js
tests/unit/errorHandler.test.js
```

Install: `dotenv`, `pino` (or equivalent), `uuid`, `jest`, `supertest`

## Acceptance Gate

- [ ] Starting the app with a missing required env var exits with a clear, human-readable error
- [ ] Every HTTP response contains an `X-Request-Id` header
- [ ] Authorization and API key values never appear in logs
- [ ] A simulated internal error returns JSON `{ error: "internal_server_error" }` — no stack trace in body

## Git Commit

```bash
git add .
git commit -m "feat: phase 3 - config validation, request IDs, logging, error handling"
```

---

# Phase 4 — MongoDB Audit Model & Connection

## Objective

Add MongoDB persistence for audit records. This connection must NOT be in the rate-limit decision path — MongoDB is for durable storage only, not real-time allow/deny.

## Copy-Paste Prompt for Lower-Tier Model (Phase 4)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 4:

```text
Implement Phase 4 only: MongoDB audit persistence. Inspect the installed Node and package versions before choosing APIs. Add a Mongo connection module and an AuditLog model using the fields defined in Section 6.1 of the blueprint. Store only the HMAC identity digest, never a raw API key. Add indexes for occurredAt and identityDigest plus occurredAt. Do not add BullMQ yet and do not write audit records from the request path yet. Add a small smoke test/script that proves insert and read work. Explain how to start local MongoDB and how connection failure is reported.
```

## What to Build

### `src/infrastructure/mongo/mongoClient.js`
- Connect to MongoDB using the `MONGODB_URI` env var
- Export `connect()`, `disconnect()`, and `isConnected()` functions
- If MongoDB is unavailable at startup, log a warning and continue — the gateway should still start
- Expose a `mongoHealthy` flag that the readiness endpoint can read

### `src/infrastructure/mongo/AuditLog.model.js`
- Create a Mongoose schema with these fields:
  - `eventId` (String, required, unique)
  - `occurredAt` (Date, required)
  - `route` (String, required)
  - `method` (String, required)
  - `policyId` (String, required)
  - `identityType` (String, enum: `["api-key", "ip"]`)
  - `identityDigest` (String, required) — HMAC digest only, never raw key
  - `decision` (String, enum: `["RATE_LIMITED", "UPSTREAM_ERROR"]`)
  - `requestId` (String, required)
  - `limit` (Number)
  - `windowMs` (Number)
  - `retryAfterMs` (Number)
  - `expireAt` (Date)
- Add these indexes:
  - `{ occurredAt: -1 }` — for time-range queries
  - `{ identityDigest: 1, occurredAt: -1 }` — for per-client violation history

### Update `GET /health/ready`
- Check if Redis is reachable (ping) → required for readiness
- Report MongoDB status separately (degraded vs. unavailable)
- Return 200 if Redis is healthy, even if MongoDB is not

### Smoke test / script
- Write a small test or script that:
  1. Connects to local MongoDB
  2. Inserts one audit document
  3. Reads it back and verifies field values
  4. Cleans up the test document

## Files to Create/Update

```
src/infrastructure/mongo/mongoClient.js
src/infrastructure/mongo/AuditLog.model.js
src/routes/health.routes.js    ← update /health/ready
tests/integration/mongo.smoke.test.js
docs/BUILD_STATE.md            ← update
```

Install: `mongoose`

## Acceptance Gate

- [ ] A real AuditLog document can be inserted into and read from a local MongoDB instance
- [ ] The two required indexes exist (`occurredAt`, `identityDigest + occurredAt`)
- [ ] No raw API key is stored in any document
- [ ] The rate-limit decision code path does NOT touch MongoDB
- [ ] The gateway starts and `/health/live` returns 200 even if MongoDB is down

## Git Commit

```bash
git add .
git commit -m "feat: phase 4 - mongodb audit model and connection"
```

---

# Phase 5 — Redis Connection & Atomic Lua Rate Limiter

## Objective

Implement the most critical feature of the project — the atomic Redis Lua rate limiter — as a completely isolated service with integration tests. Do NOT wire it to Express middleware yet.

## Copy-Paste Prompt for Lower-Tier Model (Phase 5)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 5:

```text
Implement Phase 5 only: Redis connection and the isolated sliding-window-log rate limiter. Use one Redis client library consistently. Write a Lua script that obtains time from Redis TIME, removes entries at or before now-window, counts the sorted set, atomically inserts a unique request member only when under the limit, sets key expiry, and returns allowed/remaining/retryAfterMs/nowMs. Keep all decision operations inside the same script. Validate arguments and document the key format. Add real Redis integration tests for a limit of 2, rejection, and window expiry. Do not create Express middleware or proxy routes yet. Do not claim concurrency is proven until the separate concurrency test is run.
```

## What to Build

### `src/infrastructure/redis/redisClient.js`
- Use `ioredis` to connect to Redis using `REDIS_URL`
- Export `connect()`, `ping()`, `getClient()`, and `disconnect()` functions
- Handle Redis connection errors gracefully — log and expose health status

### `src/infrastructure/redis/slidingWindowLog.lua`
- Write the complete Lua script as described in the algorithm section above
- The script receives:
  - `KEYS[1]` — the Redis key for this client+policy
  - `ARGV[1]` — window duration in milliseconds
  - `ARGV[2]` — max requests allowed
  - `ARGV[3]` — unique member string (UUID for this request)
- The script returns an array: `[allowed, remaining, retryAfterMs, nowMs]`
  - `allowed`: `1` if the request is allowed, `0` if denied
  - `remaining`: how many requests are left in the window
  - `retryAfterMs`: milliseconds until the oldest window entry expires
  - `nowMs`: current Redis server time in milliseconds

### `src/services/rateLimiter.service.js`
- Load the Lua script at startup and register it with Redis
- Export a `checkLimit(key, windowMs, maxRequests, uniqueMember)` function
- Parse the Lua script's return array into a clean JavaScript object:
  ```js
  {
    allowed: true,
    remaining: 3,
    retryAfterMs: 45000,
    resetAtMs: 1700000060000,   // Unix ms when oldest entry expires
    nowMs: 1700000015000
  }
  ```
- Validate `windowMs` and `maxRequests` before calling Redis — throw if invalid

### Integration Tests (against a real Redis instance)

Write these tests. Do NOT mock Redis:

1. **Basic allow:** Send 1 request with limit=2 → allowed, remaining=1
2. **Second request allowed:** Send 2nd request → allowed, remaining=0
3. **Third request denied:** Send 3rd request → denied, retryAfterMs > 0
4. **Window expiry:** After the window expires (or using a tiny window), a new request is allowed again
5. **Unique members:** Two requests in the same millisecond do not collapse into one (use unique UUIDs)
6. **Redis error:** If Redis is unreachable, `checkLimit` throws a recognizable error

## Files to Create

```
src/infrastructure/redis/redisClient.js
src/infrastructure/redis/slidingWindowLog.lua
src/services/rateLimiter.service.js
tests/integration/rateLimiter.integration.test.js
docs/BUILD_STATE.md   ← update
```

Install: `ioredis`

## Acceptance Gate

- [ ] With `limit=2`: request 1 → allowed, request 2 → allowed, request 3 → **denied**
- [ ] A denied request returns `retryAfterMs > 0`
- [ ] After the window duration passes, a new request is allowed
- [ ] The entire check-insert decision is inside one Lua script — JavaScript does NOT do a separate read-then-write
- [ ] Redis server time (`TIME`) is used for the decision — not `Date.now()` on the app server
- [ ] `X-RateLimit-Reset` is a Unix epoch in seconds; `Retry-After` is a duration in seconds

## Git Commit

```bash
git add .
git commit -m "feat: phase 5 - redis client and atomic lua sliding-window limiter"
```

---

# Phase 6 — Client Identity & Express Rate-Limit Middleware

## Objective

Connect the tested Redis limiter to real HTTP requests. Extract client identity, apply the limiter, and return the correct status codes and headers.

## Copy-Paste Prompt for Lower-Tier Model (Phase 6)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 6:

```text
Implement Phase 6 only: client identity and Express rate-limit middleware. Reuse the tested Redis service from Phase 5. Use HMAC-SHA256 with IDENTITY_HASH_SECRET to derive a stable identity digest; never store the raw API key in Redis or logs. Prefer API key identity when present and fall back to req.ip. Do not set trust proxy to true blindly; explain the safe configuration needed for deployment. Add the documented X-RateLimit headers, 429 response with Retry-After, and fail-closed 503 behavior when Redis is unavailable. Add HTTP-level tests. Do not build the upstream proxy yet.
```

## What to Build

### `src/middleware/identifyClient.js`
- Read the `X-API-Key` header
- If present: compute `HMAC-SHA256(IDENTITY_HASH_SECRET, apiKey)` as a hex digest. Attach to `req.identityDigest` and set `req.identityType = "api-key"`
- If absent: use `req.ip` as identity, set `req.identityType = "ip"`
- **CRITICAL:** Never put the raw API key string into `req.identityDigest`, Redis keys, or logs
- About `trust proxy`: Do NOT set `app.set('trust proxy', true)` blindly. Only configure trusted proxy if behind a known reverse proxy. Document this in `docs/DECISIONS.md`.

### `src/middleware/rateLimit.js`
- This middleware runs after `identifyClient`
- Build the Redis key: `shieldapi:rl:v1:default:<identityDigest>`
- Call `rateLimiter.service.checkLimit(key, windowMs, maxRequests, uuidV4())`
- **If allowed:**
  - Set headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds)
  - Call `next()` to continue to the proxy or route handler
- **If denied (quota exceeded):**
  - Return HTTP 429 JSON:
    ```json
    {
      "error": "rate_limit_exceeded",
      "requestId": "...",
      "retryAfter": 45,
      "remaining": 0
    }
    ```
  - Set `Retry-After: 45` header
  - Do NOT call `next()` — stop here
- **If Redis throws an error (unavailable):**
  - In `fail-closed` mode → return HTTP 503:
    ```json
    { "error": "rate_limiter_unavailable", "requestId": "..." }
    ```
  - Do NOT return 429 for a Redis outage — these are different problems

### Tests

- Two requests with different API keys → each gets its own independent counter
- Request without `X-API-Key` header → falls back to IP-based identity
- 6th request in a 5-request-per-window policy → 429 with `Retry-After` header
- Redis unavailable → 503 (not 429)
- Raw API key value does NOT appear in the Redis key or any log line

## Files to Create/Update

```
src/middleware/identifyClient.js
src/middleware/rateLimit.js
src/services/rateLimiter.service.js   ← minor updates if needed
tests/integration/rateLimit.http.test.js
docs/API.md                           ← add header and error JSON examples
docs/DECISIONS.md                     ← document trust proxy decision
docs/BUILD_STATE.md                   ← update
```

## Acceptance Gate

- [ ] Two different API keys get separate Redis counters — verified with test
- [ ] No API key → `req.ip` is used as identity
- [ ] Raw API key does NOT appear in Redis key names or logs anywhere
- [ ] Exceeding quota returns 429, does not continue to next middleware
- [ ] Redis outage returns 503 — NOT 429

## Git Commit

```bash
git add .
git commit -m "feat: phase 6 - client identity middleware and rate-limit http integration"
```

---

# Phase 7 — Mock Upstream Service & Fixed-Target Gateway Proxy

## Objective

Complete the gateway behavior: rate-limit first, then forward allowed requests to a mock downstream service. Blocked requests must never reach the upstream.

## Copy-Paste Prompt for Lower-Tier Model (Phase 7)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 7:

```text
Implement Phase 7 only: mock upstream and fixed-target gateway proxy. First inspect the installed proxy library and its version; do not guess its API. Create a separate mock upstream service with catalog, slow, and JSON echo endpoints. Add /gateway routes that run request-ID and rate-limit middleware before forwarding. The destination must come only from UPSTREAM_BASE_URL; never let callers submit an arbitrary target URL or host. Add timeout, body-size, 502, and 504 handling. Test that a rate-limited request never reaches the upstream. Keep authentication out of scope.
```

## What to Build

### `src/upstream/mockUpstream.js`
- A separate Express server on port `4001` (or `UPSTREAM_BASE_URL` port)
- Routes to expose:
  - `GET /catalog` → returns `{ items: ["item-a", "item-b"] }` immediately
  - `GET /slow` → waits 8 seconds before responding (to trigger the gateway's 504)
  - `POST /echo` → reads the request body and echoes it back as JSON
- This server starts independently and is used only for testing/demo

### `src/proxy/upstreamProxy.js`
- Use `http-proxy-middleware` or `http-proxy` — **check the installed version and its exact API before writing code**
- Configure the proxy target from `UPSTREAM_BASE_URL` only — never accept a target from user input
- Set proxy timeout to `PROXY_TIMEOUT_MS` (from env)
- Handle errors:
  - Connection refused / unreachable → return 502 JSON: `{ "error": "bad_gateway", "requestId": "..." }`
  - Timeout → return 504 JSON: `{ "error": "gateway_timeout", "requestId": "..." }`
- Set a strict body size limit on incoming request bodies (e.g., 100kb)
- Never leak internal hostnames, stack traces, or upstream error details to the client

### `src/routes/gateway.routes.js`
- Mount on `/gateway/v1`
- Apply middleware in this order: `requestId` → `identifyClient` → `rateLimit` → `upstreamProxy`
- `GET /gateway/v1/catalog` → proxies to mock upstream `/catalog`
- `GET /gateway/v1/slow` → proxies to mock upstream `/slow`
- `POST /gateway/v1/echo` → proxies to mock upstream `/echo`

### Integration Tests

1. An allowed request (`GET /gateway/v1/catalog`) reaches the mock upstream and returns its response
2. A rate-limited request (6th request in 5-request window) does NOT reach the mock upstream — verify by counting upstream hits
3. Calling `GET /gateway/v1/slow` beyond the timeout threshold returns 504 JSON with `requestId`
4. Stopping the mock upstream and calling the gateway returns 502 JSON (not 500, not a stack trace)
5. A crafted request that tries to override the upstream host in query params/body is ignored

## Files to Create/Update

```
src/upstream/mockUpstream.js
src/proxy/upstreamProxy.js
src/routes/gateway.routes.js
src/app.js                            ← mount gateway routes
tests/integration/gateway.proxy.test.js
docs/BUILD_STATE.md                   ← update
```

Install: `http-proxy-middleware` (or `http-proxy`)

## Acceptance Gate

- [ ] An allowed request successfully receives the mock upstream's response body
- [ ] A rate-limited request gets 429 and the mock upstream receives zero requests — verified by counter
- [ ] No user input can change the upstream proxy target
- [ ] Gateway timeout returns 504 with `requestId`; upstream connection failure returns 502
- [ ] `requestId` appears in both gateway logs and error responses

## Git Commit

```bash
git add .
git commit -m "feat: phase 7 - mock upstream and fixed-target gateway proxy"
```

---

# Phase 8 — Asynchronous Audit Pipeline with BullMQ

## Objective

Move audit writes completely off the request path. The gateway makes its rate-limit decision, enqueues an audit event (fire and forget), and continues. A separate worker process reads from the queue and writes to MongoDB.

## Copy-Paste Prompt for Lower-Tier Model (Phase 8)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 8:

```text
Implement Phase 8 only: asynchronous audit processing with BullMQ. Do not rewrite the rate limiter or proxy. Add a named BullMQ queue on Redis, enqueue rate-limit violation events, and add a worker that validates the job payload and persists it using the existing MongoDB AuditLog model. Configure a small bounded retry policy with exponential backoff. Keep audit work out of the critical allow/deny decision. If enqueueing fails, log a structured error and expose degraded health; never allow a request merely because the audit pipeline failed. Add an end-to-end test from a rate-limit violation to a MongoDB audit document.
```

## What to Build

### `src/infrastructure/queue/auditQueue.js`
- Create a BullMQ `Queue` using the existing Redis connection
- Use a distinct queue name such as `shieldapi:audit`
- Export `enqueueAuditEvent(payload)` — this is the only function called from the request path
- If enqueueing fails: log a structured error and update a health flag. **Never bypass the rate limiter because auditing failed.**

### `src/services/audit.service.js`
- Called after the rate-limit middleware makes a decision
- Only enqueue events for:
  - Rate-limit violations (decision = `RATE_LIMITED`)
  - Upstream errors (502, 504)
- Do NOT enqueue every successful request (this would be too noisy)
- Build the audit payload from `req` fields — never include raw API keys

### `src/workers/auditWorker.js`
- A separate BullMQ `Worker` process (run independently, not inside the gateway server)
- Validates the incoming job payload before writing
- Writes to MongoDB using the `AuditLog` model
- Configure:
  - Retry attempts: 3
  - Exponential backoff between retries
  - Bounded failed-job retention (do not keep unlimited failed jobs)
- Handles MongoDB write failures by retrying (via BullMQ retry policy)
- On shutdown: drain the queue, close the worker, close Redis and MongoDB connections gracefully

### Update `GET /health/ready`
- Report queue/worker health as a separate field (degraded if unavailable)

### End-to-End Test

1. Start gateway, mock upstream, Redis, MongoDB, and the audit worker
2. Send enough requests to trigger a 429
3. Wait briefly for the worker to process the job
4. Query MongoDB and verify the audit document exists with correct fields

## Files to Create/Update

```
src/infrastructure/queue/auditQueue.js
src/services/audit.service.js
src/workers/auditWorker.js
src/middleware/rateLimit.js           ← call audit.service after deny decision
src/routes/health.routes.js          ← report queue health
tests/integration/audit.e2e.test.js
package.json                         ← add "worker" script
docs/BUILD_STATE.md                  ← update
```

Install: `bullmq`

## Acceptance Gate

- [ ] A rate-limit violation is stored in MongoDB — verified by reading it back in the test
- [ ] A transient MongoDB failure causes the job to be retried (verify with retry count in document or logs)
- [ ] The gateway still returns 429 correctly even when the audit worker is stopped
- [ ] The worker and queue shut down cleanly (no hanging processes)
- [ ] The project documentation states: "Queue durability is bounded by Redis availability and configured retry settings"

## Git Commit

```bash
git add .
git commit -m "feat: phase 8 - bullmq async audit pipeline and worker"
```

---

# Phase 9 — Concurrency, Security & Failure Test Suite

## Objective

Prove the project's core engineering claims with real tests under concurrent load and dependency failures.

## Copy-Paste Prompt for Lower-Tier Model (Phase 9)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 9:

```text
Implement Phase 9 only: concurrency and failure-mode tests plus a focused security review. Do not change production code unless a test exposes a real defect; explain any required fix first. Build a test that fires 50 concurrent requests for the same fresh identity with a limit of 10. Exactly 10 should pass and 40 should receive 429. Then run the same test against two gateway instances sharing the same Redis. Add failure tests for Redis, MongoDB, queue, upstream timeout, and upstream outage. Make tests deterministic with unique identities and cleanup. Do not claim the system is race-condition-free beyond the tested single-Redis deployment model.
```

## What to Build

### `scripts/concurrency-test.js`
- Send **50 simultaneous requests** for the same fresh identity, with `limit=10`
- Use `Promise.all()` or a similar concurrent dispatch mechanism
- Count how many received 200 (allowed) and how many received 429 (denied)
- Print the exact counts
- **Expected result:** Exactly 10 allowed, exactly 40 denied

### `tests/integration/rateLimit.concurrency.test.js`
- Automated version of the above using Jest + Supertest
- Uses a **unique test identity** for each test run (generate a random API key per test)
- Cleans Redis state for the test key before running
- Tests:
  1. Single gateway instance: 50 simultaneous requests, limit 10 → exactly 10 pass
  2. Two gateway instances sharing the same Redis: 25 requests to each → combined total of exactly 10 pass

### `tests/integration/failureModes.test.js`
- Redis unavailable → protected route returns 503 (not 429, not 500)
- MongoDB unavailable → gateway still makes rate-limit decisions correctly; `/health/ready` shows degraded Mongo
- Audit queue unavailable → gateway still accepts and rejects requests correctly
- Upstream timeout → `/gateway/v1/slow` returns 504 with `requestId`
- Upstream unreachable → `/gateway/v1/catalog` returns 502 with safe error body

### `docs/SECURITY.md`
Review and document these controls:

| Control | Status | Notes |
|---|---|---|
| `trust proxy` configuration | Documented | Only trust known reverse proxies |
| Body size limits | Implemented | Hard limit in proxy middleware |
| Fixed upstream target | Implemented | No user-controlled redirect |
| Credential logging | Checked | API keys never in logs |
| CORS | Evaluated | Note if configured or intentionally omitted |
| Helmet headers | Added | Use `helmet()` middleware |
| Stack traces in responses | Blocked | Central error handler strips them |
| Redis key format | Reviewed | Only HMAC digests in keys |

## Files to Create/Update

```
scripts/concurrency-test.js
tests/integration/rateLimit.concurrency.test.js
tests/integration/failureModes.test.js
docs/SECURITY.md
src/app.js                  ← add helmet() if not present
docs/BUILD_STATE.md         ← update
```

Install: `helmet` (if not already installed)

## Acceptance Gate

- [ ] Single gateway: 50 concurrent requests with limit=10 → **exactly 10** allowed (no over- or under-admission)
- [ ] Two gateway instances sharing Redis: combined allowed count is **exactly 10**
- [ ] Tests use unique per-run identities and clean their Redis state before running
- [ ] All failure modes return the documented status codes
- [ ] No test makes calls to a public external API

## Git Commit

```bash
git add .
git commit -m "test: phase 9 - concurrency proof, failure modes, security review"
```

---

# Phase 10 — Performance Measurement & MongoDB Query Inspection

## Objective

Collect real, repeatable measurements. Do NOT fabricate numbers or copy examples from documentation as if they were your results.

## Copy-Paste Prompt for Lower-Tier Model (Phase 10)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 10:

```text
Implement Phase 10 only: measurement scripts and benchmark documentation. Keep existing functionality unchanged unless a measured issue justifies a targeted optimization. Build a repeatable local test for baseline versus gateway throughput and p50/p95/p99 latency. Record environment, concurrency, request count, Redis configuration, and all settings. Add a documented MongoDB explain("executionStats") procedure for an audit query and explain nReturned, totalKeysExamined, and totalDocsExamined. Do not fabricate output or promise a particular latency reduction. Use placeholders where I must run the test.
```

## What to Build

### `scripts/benchmark.js` or autocannon command
- Measure two scenarios:
  1. **Baseline route** (e.g. `/health/live`) — no rate limiting
  2. **Gateway route** (`/gateway/v1/catalog`) — with full rate limiting pipeline
- For each scenario record:
  - Machine specs (CPU, RAM, OS)
  - Node.js version
  - Redis and MongoDB versions
  - Number of gateway instances
  - Concurrency level (e.g. 10 parallel connections)
  - Request count (e.g. 500 total requests)
  - Policy settings
  - Results: requests/sec, p50 latency, p95 latency, p99 latency

### `docs/BENCHMARKS.md`
- Record raw numbers from your actual runs
- Include the exact command used to run the benchmark
- Record variability across multiple runs
- Identify where the bottleneck is (upstream, Redis, local machine, network)

### MongoDB Query Analysis
- Run a realistic audit query (e.g., "find all violations for identity X in the last 24 hours")
- Use `explain("executionStats")` to capture:
  - `nReturned`
  - `totalKeysExamined`
  - `totalDocsExamined`
  - `executionTimeMillis`
- Document whether the index is being used and how to verify it

## Files to Create/Update

```
scripts/benchmark.js
docs/BENCHMARKS.md        ← real data only, placeholders if not yet run
docs/BUILD_STATE.md       ← update
```

## Acceptance Gate

- [ ] The benchmark can be reproduced by running one documented command from a clean environment
- [ ] Latency and throughput numbers are recorded alongside the test environment details
- [ ] MongoDB `explain()` output is captured and interpreted (nReturned vs. docsExamined ratio)
- [ ] **No resume metric exists that is not backed by a row in BENCHMARKS.md**

## Git Commit

```bash
git add .
git commit -m "perf: phase 10 - benchmark scripts and mongodb query analysis"
```

---

# Phase 11 — Docker & Local Reproducibility

## Objective

Package the entire stack so any developer can run a full demo with one command on a clean machine.

## Copy-Paste Prompt for Lower-Tier Model (Phase 11)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 11:

```text
Implement Phase 11 only: Docker and Docker Compose for the local ShieldAPI demo. Inspect the current application scripts and ports first. Add a Dockerfile, .dockerignore, and compose services for Redis, MongoDB, gateway, mock upstream, and audit worker if Phase 8 exists. Use service DNS names inside containers, not localhost. Add appropriate health checks and explain startup ordering. Do not bake secrets into the image. Provide exact commands to build, start, inspect logs, stop, and remove containers while preserving or deleting volumes intentionally.
```

## What to Build

### `Dockerfile`
- Multi-stage or single-stage build for the Node.js application
- Use an official Node LTS slim image
- Copy only production files (not `tests/`, `scripts/`, `.env`, `node_modules` from host)
- Run `npm ci --only=production` inside the image
- Use a non-root user where possible
- Expose the correct port

### `.dockerignore`
```
node_modules
.env
logs
coverage
.git
tests
scripts
```

### `docker-compose.yml`
Define services:

| Service | Image | Notes |
|---|---|---|
| `redis` | `redis:7-alpine` | Named volume for data (optional for Redis) |
| `mongo` | `mongo:7` | Named volume for data persistence |
| `gateway` | Built from `Dockerfile` | Depends on `redis`, `mongo`. Uses service DNS names. |
| `mock-upstream` | Built from `Dockerfile` | Starts `src/upstream/mockUpstream.js` |
| `audit-worker` | Built from `Dockerfile` | Starts `src/workers/auditWorker.js` (if Phase 8 complete) |

**Important:** Inside Docker containers, services reach each other by service name (e.g., `redis://redis:6379`, not `redis://localhost:6379`). Update `.env.example` with container-safe values.

### Health checks in compose
- Redis: `redis-cli ping`
- MongoDB: `mongosh --eval "db.runCommand({ ping: 1 })"`
- Gateway: `curl -f http://localhost:3000/health/ready`

### README — Docker section

Document these commands exactly:

```bash
# Build and start everything
docker compose up --build

# Check gateway liveness
curl -i http://localhost:3000/health/live

# Check gateway readiness  
curl -i http://localhost:3000/health/ready

# Stop all containers
docker compose down

# Stop and delete volumes (wipes MongoDB data)
docker compose down -v

# View gateway logs
docker compose logs -f gateway
```

## Files to Create/Update

```
Dockerfile
.dockerignore
docker-compose.yml
README.md          ← add Docker section
docs/BUILD_STATE.md ← update
```

## Acceptance Gate

- [ ] `docker compose up --build` starts the full stack from scratch with no manual steps
- [ ] `GET http://localhost:3000/health/ready` returns healthy after services are up
- [ ] A client on the host machine can send requests through the gateway
- [ ] Restarting containers does NOT lose MongoDB data if the named volume is kept
- [ ] No secret or `.env` value is baked into the Docker image

## Git Commit

```bash
git add .
git commit -m "feat: phase 11 - dockerfile and docker compose local demo"
```

---

# Phase 12 — Final Documentation, Demo & Resume Evidence

## Objective

Package the completed project for a recruiter or reviewer who will clone the repo, run the demo, and evaluate the engineering.

## Copy-Paste Prompt for Lower-Tier Model (Phase 12)

> **How to use:** Paste this exact text into the AI assistant prompt window when working on Phase 12:

```text
Implement Phase 12 only: finalize documentation and the demonstration. Inspect the complete repository and actual test/benchmark results. Write a README that explains architecture, setup, environment variables, routes, tests, benchmark method, and limitations. Add a 3-5 minute demo script with exact commands for an allowed request, a 429 response, two separate identities, and the concurrency test. Do not invent a deployment URL, hosting quota, benchmark, or resume metric. For any value not measured, leave a clearly marked placeholder. Review the project as a recruiter and list the three strongest verifiable engineering points and the remaining limitations.
```

## What to Build

### `README.md` — Complete and final version

Sections:
1. **What it is** — one paragraph problem statement
2. **Architecture** — diagram (ASCII or Mermaid) + written explanation
3. **Request lifecycle** — allowed path and denied path, step by step
4. **Tech stack** — list with version numbers
5. **Prerequisites** — Docker, Node.js, etc.
6. **Setup** — clone, copy `.env.example` to `.env`, fill in secrets, then `docker compose up --build`
7. **Environment variables** — table with each variable, default value, and what it does
8. **API endpoints** — reference table
9. **Running tests** — exact commands
10. **Running the benchmark** — exact commands
11. **Known limitations** — honest list (e.g., single Redis = not multi-region, memory grows with active windows, etc.)

### `docs/DEMO.md`

A 3–5 minute walkthrough with exact commands and expected output:

```bash
# Step 1: Start the stack
docker compose up --build

# Step 2: Verify liveness
curl -i http://localhost:3000/health/live
# Expected: HTTP 200, {"status":"ok",...}

# Step 3: Demonstrate rate limiting (5 requests per 60s window)
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "X-API-Key: demo-client-a" \
    http://localhost:3000/gateway/v1/catalog
done
# Expected: 200 200 200 200 200 429

# Step 4: Demonstrate identity separation
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: demo-client-a" http://localhost:3000/gateway/v1/catalog
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: demo-client-b" http://localhost:3000/gateway/v1/catalog
# Expected: 429 (a is exhausted), 200 (b has its own counter)

# Step 5: Run the concurrency proof
node scripts/concurrency-test.js
# Expected output: "Allowed: 10, Denied: 40"
```

### Resume Bullets (template — fill in measured values only)

```
ShieldAPI — Distributed Rate Limiter & API Gateway
Tech: Node.js, Express.js, Redis, MongoDB, Lua, Docker

- Built a Redis-backed sliding-window rate limiter using atomic Lua scripts to
  enforce a shared per-client quota across [N] gateway instances.

- Validated concurrent request handling with [X] simultaneous requests, allowing
  exactly [L] under a limit of [L] across [N] instances sharing one Redis.

- Implemented a fixed-target API gateway with request IDs, rate-limit headers,
  upstream timeouts, and fail-closed 503 handling for Redis outages.

- Persisted rate-limit violation events asynchronously through BullMQ into MongoDB;
  achieved [query improvement] on audit queries using measured executionStats.
```

> Replace every `[bracketed value]` with your actual measured result. Remove any bullet for a feature you did not fully implement.

## Acceptance Gate

- [ ] A new developer can set up and run the full stack from README instructions alone
- [ ] The demo proves: allowed requests, 429 response, identity separation, and concurrency correctness
- [ ] Known limitations are listed and honest
- [ ] Every resume metric is traceable to a real row in `docs/BENCHMARKS.md` or a test output
- [ ] No API key, connection string, or secret appears in any public file

## Git Commit

```bash
git add .
git commit -m "docs: phase 12 - final readme, demo guide, and resume evidence"
```

---

## Full Test Matrix — Must All Pass Before Project Is Complete

| Test | Setup | Expected Result |
|---|---|---|
| Basic allow | Fresh identity, limit 5, send 1 request | 200 + headers; remaining decreases |
| Limit reached | Same identity, send 6 requests in 60s | First 5 pass; 6th gets 429 + Retry-After |
| Window expiry | Wait for oldest entry to expire, send again | New request is allowed |
| Separate keys | Two different API keys, same route | Each gets its own independent counter |
| IP fallback | No API key, same source IP | Requests share the IP-based counter |
| Atomic concurrency | 50 simultaneous requests, limit 10 | Exactly 10 allowed |
| Two gateway instances | 25 requests to each, shared Redis | Combined allowed = exactly 10 |
| No upstream on 429 | Count upstream hits while quota exceeded | Zero upstream hits during 429 responses |
| Redis unavailable | Stop Redis, call protected route | 503 (not 429, not 500) |
| Mongo unavailable | Stop MongoDB, Redis healthy | Rate-limit works; audit health degraded |
| Audit queue retry | MongoDB down while worker processes job | Job retries per configured policy |
| Upstream timeout | Call `/gateway/v1/slow` past timeout | 504 with requestId |
| Upstream outage | Stop mock upstream, call gateway | 502 with safe error body |
| Secret hygiene | Search logs, Redis keys, audit docs | No raw API keys or secrets found |

---

## Dependency Install Timeline

| Package | Phase | Purpose |
|---|---|---|
| `express` | Phase 2 | HTTP server framework |
| `dotenv` | Phase 3 | Load `.env` file |
| `pino` | Phase 3 | Structured logging |
| `uuid` | Phase 3 | Generate unique request/member IDs |
| `jest` + `supertest` | Phase 3 | Testing framework |
| `mongoose` | Phase 4 | MongoDB ODM |
| `ioredis` | Phase 5 | Redis client with Lua execution |
| `http-proxy-middleware` | Phase 7 | Fixed-target HTTP proxy |
| `bullmq` | Phase 8 | Async job queue |
| `helmet` | Phase 9 | Security headers |

---

---

## AI Assistant Recovery & Debugging Prompts

If the lower-tier model gets stuck, fails a test, or loses context across sessions, use these standardized prompts.

### 1. Debugging Prompt (Use when a test fails or code errors)

```text
Do not rewrite the project. Diagnose only this failure.
Command I ran:
[PASTE EXACT COMMAND]
Full output/error:
[PASTE FULL OUTPUT]
Relevant file(s):
[PASTE FILE OR PATH]

Please: (1) identify the most likely root cause and evidence, (2) name the smallest set of files that must change, (3) provide a focused patch, (4) add or update a regression test, and (5) tell me the exact command to rerun. Do not claim it is fixed until the test has passed.
```

### 2. Context Refresh Prompt (Use when starting in a fresh chat window)

```text
We are continuing ShieldAPI in a fresh coding session. Read the attached/current docs/BUILD_STATE.md, docs/DECISIONS.md, and docs/API.md before doing anything. The full project blueprint is available separately. Do not restart or redesign completed phases. First summarize only: current completed phase, current failing tests, current repository structure, and the next single task. Then wait for my phase-specific instruction. Do not edit files during this context-recovery step.
```

## Common Failure Modes & Recovery Actions

| Problem | What to Do |
|---|---|
| AI rewrites unrelated files | Revert with `git checkout -- <file>` or restore last commit. Then give a focused patch prompt. |
| AI invents a library API | Tell it to inspect `package.json` and the installed version's README. Ask for code that matches that exact version. |
| AI claims concurrency is fixed but has no test | Reject the claim. Ask for the 50-request test and require exact pass/fail counts in the output. |
| AI produces too much code in one response | Split the phase: "implement service only", then "implement middleware only", then "implement tests only". |
| AI loses context in a new chat | Paste the global prompt, current `docs/BUILD_STATE.md`, and only the current phase prompt. |
| A test fails | Paste the **full command**, **full error output**, and **relevant file**. Ask for the smallest root-cause fix only. |
| AI claims a benchmark without running it | Reject the number entirely. Leave the resume value as a placeholder until you run it yourself. |

---

## Final Completion Checklist

- [ ] Core gateway is working locally (rate limit → proxy → mock upstream)
- [ ] Redis Lua script owns the complete atomic rate-limit decision (no split read-write in JS)
- [ ] Client identity is hashed; raw credentials never appear in logs, Redis, or MongoDB
- [ ] HTTP 429, Retry-After, rate-limit headers, 503, 502, and 504 are all tested
- [ ] Allowed requests are forwarded to the upstream; denied requests are never forwarded
- [ ] MongoDB stores audit events with no raw API keys
- [ ] BullMQ worker is implemented and tested (or explicitly documented as not included)
- [ ] Concurrency test passes for one gateway instance and for two instances sharing Redis
- [ ] Benchmarks include environment details and test settings; no unsupported numbers claimed
- [ ] `docker compose up --build` starts the full local demo reproducibly
- [ ] README explains setup, architecture, test commands, demo, and limitations clearly
- [ ] Every resume bullet describes only a feature that is implemented and verified

