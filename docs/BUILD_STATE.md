# ShieldAPI — Build State

This document is the single source of truth for the project's current implementation state. It is updated at the conclusion of every completed phase.

---

## 1. Project Goal & Overview
Build a demonstrable, production-quality distributed API gateway and rate limiter using Express, Redis (atomic Lua script), and MongoDB. The system enforces shared sliding-window-log quotas across multiple gateway instances, rejects over-quota requests with HTTP 429, forwards accepted requests to a fixed mock upstream, and records security violation events asynchronously via BullMQ into MongoDB.

---

## 2. Technical Stack & Architecture Decisions
- **Runtime & Environment:** Node.js v22 LTS (`v22.12.0`)
- **Module System:** CommonJS (`require` / `module.exports`) consistently throughout
- **Web Framework:** Express.js (`^5.3.0`)
- **Configuration & Environment:** `dotenv` (`^18.0.9`) with strict positive numeric validation and frozen config object
- **Request Tracing:** RFC 4122 UUID v4 generation and header validation (`X-Request-Id`)
- **Testing:** Jest (`^30.5.2`) + Supertest (`^7.3.1`)
- **Audit Store:** MongoDB (v7+) with Mongoose ODM (`^8.19.1`)
  - Schema: `AuditLog` with HMAC digest, `occurredAt`, `route`, `decision`, `requestId`, `limit`, `windowMs`, `retryAfterMs`
  - Indexes: `{ occurredAt: -1 }`, `{ identityDigest: 1, occurredAt: -1 }`, `{ expireAt: 1 }` (TTL)
- **Rate-Limiter Storage & Engine:** Redis (v7+) with atomic Lua script execution (`ioredis`)
- **Identity & Privacy:** HMAC-SHA256 (`IDENTITY_HASH_SECRET`) for deterministic client identity without exposing raw API keys or IPs
- **Rate-Limit Enforcement:** Express middleware returning RFC-compliant headers (`X-RateLimit-*`, `Retry-After`), HTTP 429 on quota exhaustion, and HTTP 503 fail-closed mode on Redis outages
- **Async Queue:** BullMQ (Phase 8)
- **Containerization:** Docker & Docker Compose (Phase 11)

---

## 3. Phase Status

| Phase | Description | Status | Verification & Evidence |
|---|---|---|---|
| **Phase 0** | Workspace & Project Controls | **COMPLETED** | Git repo initialized, `.gitignore`, minimal `package.json`, `docs/BUILD_STATE.md`, `docs/DECISIONS.md`. |
| **Phase 1** | Requirements & API Contract | **COMPLETED** | `docs/API.md` created with routes, lifecycles, headers, errors; `docs/DECISIONS.md` populated with ADR-001 through ADR-006. |
| **Phase 2** | Express Application Skeleton | **COMPLETED** | `src/app.js` (unbound app), `src/server.js` (port listener), `src/routes/health.routes.js` (`GET /health/live` -> 200 JSON), 404 JSON catch-all, central JSON error handler. Verified via live smoke test. |
| **Phase 3** | Config, Request IDs, Logging & Errors | **COMPLETED** | `.env.example`, `src/config/env.js`, `src/config/policies.js`, `src/middleware/requestId.js`, `src/utils/logger.js`, `src/utils/errors.js`, `src/middleware/errorHandler.js`. 13/13 automated unit tests passing. |
| **Phase 4** | MongoDB Audit Model & Connection | **COMPLETED** | `src/infrastructure/mongo/mongoClient.js` (resilient connection with `runtimeAdapters`), `src/infrastructure/mongo/AuditLog.model.js` (fields, validations, indexes). `GET /health/ready` reports Mongo state. Verified via unit and integration tests (21/21 passing). |
| **Phase 5** | Redis Connection & Atomic Lua Limiter | **COMPLETED** | `src/infrastructure/redis/redisClient.js` (resilient connection manager with ping and retryStrategy), `src/infrastructure/redis/slidingWindowLog.lua` (atomic TIME, cutoff eviction, ZCARD, ZADD, PEXPIRE, retryAfterMs), `src/services/rateLimiter.service.js` (strict input validation, command registration, return parsing). Verified via unit and live integration tests (29/29 passing). |
| **Phase 6** | Client Identity & Express Middleware | **COMPLETED** | `src/middleware/identifyClient.js` (HMAC-SHA256 identity extraction with API-key precedence and IP fallback), `src/middleware/rateLimit.js` (RFC rate limit headers, 429 quota rejection, fail-closed 503). Verified via unit and HTTP integration tests (41/41 passing). |
| **Phase 7** | Mock Upstream & Fixed Gateway Proxy | PENDING | Scheduled next |
| **Phase 8** | BullMQ Async Audit Pipeline | PENDING | |
| **Phase 9** | Concurrency & Failure Test Suite | PENDING | |
| **Phase 10** | Performance Measurement & Benchmarks | PENDING | |
| **Phase 11** | Docker & Local Reproducibility | PENDING | |
| **Phase 12** | Final Documentation & Demo Guide | PENDING | |

---

## 4. Current State Metrics & Checks
- **Current Phase:** Phase 6 Complete
- **Passing Tests:** 41 automated tests passing across 10 test suites:
  - `tests/unit/config.test.js` (7 tests)
  - `tests/unit/requestId.test.js` (3 tests)
  - `tests/unit/errorHandler.test.js` (3 tests)
  - `tests/unit/health.test.js` (2 tests: `/health/live` and `/health/ready`)
  - `tests/unit/auditLog.model.test.js` (5 tests: fields, enums, required indexes)
  - `tests/integration/mongo.smoke.test.js` (1 test: live insert, read, compound index query, cleanup)
  - `tests/unit/rateLimiter.service.test.js` (4 tests: input parameter validation)
  - `tests/integration/rateLimiter.integration.test.js` (4 tests: quota enforcement, sliding expiration, same-ms concurrency, non-insertion on denial)
  - `tests/unit/identifyClient.test.js` (5 tests: API-key precedence, IP fallback, privacy digest verification)
  - `tests/integration/rateLimit.http.test.js` (7 tests: HTTP 200 headers, 429 with Retry-After, separate quotas per key, IP fallback, zero credential leakage, 503 fail-closed, degraded fail-open)
- **Failing Tests:** 0
- **Running Services:** Standalone Express server with non-blocking MongoDB and Redis connections
- **Endpoints Active:**
  - `GET /health/live` (HTTP 200 JSON with process uptime, ISO timestamp, and `X-Request-Id`)
  - `GET /health/ready` (HTTP 200 JSON with Redis and MongoDB connection readiness)
  - Unmatched routes (HTTP 404 JSON with `requestId`)
- **Known Limitations:**
  - Mock upstream service and reverse proxy forwarding scheduled for Phase 7.
  - Audit documents not yet enqueued from request path (synchronous bypass prevents performance impact; BullMQ scheduled in Phase 8).

---

## 5. Next Task
**Phase 7 — Mock Upstream Service & Fixed-Target Gateway Proxy**
- Implement `src/upstream/mockUpstream.js` providing `/catalog`, `/slow`, and `/echo` endpoints.
- Implement `src/proxy/upstreamProxy.js` forwarding `/gateway/v1/*` traffic strictly to `UPSTREAM_BASE_URL` with timeouts and 502/504 error handling.
- Verify end-to-end gateway proxying and ensure rate-limited requests are blocked before ever reaching upstream.
