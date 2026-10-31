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
- **Gateway Proxying & SSRF Prevention:** Fixed-target reverse proxy (`http-proxy-middleware` `^3.0.10`) bound strictly to `UPSTREAM_BASE_URL` with 100kb body limits, proxy timeout enforcement, and sanitized 502/504 error mapping
- **Async Queue & Pipeline:** BullMQ (`^5.66.4`) queue `shieldapi-audit` decoupled from request hot path. Queue durability is bounded by Redis availability and configured retry settings.
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
| **Phase 7** | Mock Upstream & Fixed Gateway Proxy | **COMPLETED** | `src/upstream/mockUpstream.js` (`/catalog`, `/slow`, `/echo` with hit tracking), `src/proxy/upstreamProxy.js` (strict fixed target forwarding, body re-streaming, 502/504 error mapping), `src/routes/gateway.routes.js` mounted at `/gateway/v1`. Verified via end-to-end integration tests (47/47 passing). |
| **Phase 8** | BullMQ Async Audit Pipeline | **COMPLETED** | `src/infrastructure/queue/auditQueue.js` (named queue `shieldapi-audit`, non-blocking enqueueing, queue health status), `src/services/audit.service.js` (payload formatting, zero secret leakage), `src/workers/auditWorker.js` (background worker writing to MongoDB with retry backoff and idempotency), `package.json` `"worker"` script. Verified via unit and E2E tests (52/52 passing). |
| **Phase 9** | Concurrency & Failure Test Suite | PENDING | Scheduled next |
| **Phase 10** | Performance Measurement & Benchmarks | PENDING | |
| **Phase 11** | Docker & Local Reproducibility | PENDING | |
| **Phase 12** | Final Documentation & Demo Guide | PENDING | |

---

## 4. Current State Metrics & Checks
- **Current Phase:** Phase 8 Complete
- **Passing Tests:** 52 automated tests passing across 13 test suites:
  - `tests/unit/config.test.js` (7 tests)
  - `tests/unit/requestId.test.js` (3 tests)
  - `tests/unit/errorHandler.test.js` (3 tests)
  - `tests/unit/health.test.js` (2 tests: `/health/live` and `/health/ready` with Redis, Mongo, Queue status)
  - `tests/unit/auditLog.model.test.js` (5 tests: fields, enums, required indexes)
  - `tests/integration/mongo.smoke.test.js` (1 test: live insert, read, compound index query, cleanup)
  - `tests/unit/rateLimiter.service.test.js` (4 tests: input parameter validation)
  - `tests/integration/rateLimiter.integration.test.js` (4 tests: quota enforcement, sliding expiration, same-ms concurrency, non-insertion on denial)
  - `tests/unit/identifyClient.test.js` (5 tests: API-key precedence, IP fallback, privacy digest verification)
  - `tests/integration/rateLimit.http.test.js` (7 tests: HTTP 200 headers, 429 with Retry-After, separate quotas per key, IP fallback, zero credential leakage, 503 fail-closed, degraded fail-open)
  - `tests/integration/gateway.proxy.test.js` (6 tests: allowed proxying, zero upstream hits on 429 denial, 504 proxy timeout, 502 bad gateway, body forwarding on POST, SSRF injection protection)
  - `tests/unit/auditWorker.test.js` (3 tests: payload validation, retry on transient DB failure, idempotent duplicate event handling)
  - `tests/integration/audit.e2e.test.js` (2 tests: end-to-end 429 persistence in MongoDB via BullMQ, decoupling with offline worker)
- **Failing Tests:** 0
- **Running Services:** Standalone Express gateway server with non-blocking MongoDB, Redis, and BullMQ queue connections
- **Endpoints Active:**
  - `GET /health/live` (HTTP 200 JSON process liveness)
  - `GET /health/ready` (HTTP 200 JSON Redis, MongoDB, and BullMQ queue readiness)
  - `GET /gateway/v1/catalog` (Proxied to mock upstream `/catalog` with rate limiting)
  - `GET /gateway/v1/slow` (Proxied to mock upstream `/slow` with 504 timeout enforcement)
  - `POST /gateway/v1/echo` (Proxied to mock upstream `/echo` with body re-streaming)
  - Unmatched routes (HTTP 404 JSON with `requestId`)
- **Queue & Durability Policy:**
  - Queue durability is bounded by Redis availability and configured retry settings (3 attempts with exponential backoff).
  - MongoDB persistence is fully asynchronous and decoupled from the gateway request hot path.

---

## 5. Next Task
**Phase 9 — Concurrency, Security & Failure Test Suite**
- Implement `scripts/concurrency-test.js` firing 50 concurrent requests with limit 10 (asserting exactly 10 pass, 40 rejected with 429).
- Implement `tests/integration/rateLimit.concurrency.test.js` (single gateway instance and multi-instance simulation sharing Redis).
- Implement `tests/integration/failureModes.test.js` (Redis outage 503, MongoDB degradation, queue degradation, upstream timeout 504, upstream down 502).
- Create `docs/SECURITY.md` documenting security boundary, header injection prevention, credential hashing, and denial-of-service protections.
