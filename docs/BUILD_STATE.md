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
| **Phase 9** | Concurrency, Security & Failure Modes | **COMPLETED** | `scripts/concurrency-test.js` (50 concurrent requests, exactly 10 allowed, 40 rejected with 429), `tests/integration/rateLimit.concurrency.test.js` (multi-gateway Redis sharing), `tests/integration/failureModes.test.js` (Redis outage 503, MongoDB outage degradation, BullMQ degradation, upstream 504/502), `docs/SECURITY.md`, helmet security headers added. 59/59 automated tests passing. |
| **Phase 10** | Performance Measurement & Benchmarks | **COMPLETED** | `scripts/benchmark.js` (HTTP throughput, p50/p90/p95/p99 latency for Baseline vs Gateway Allowed vs Gateway Denied 429), `docs/BENCHMARKS.md` (empirical measurements, bottleneck analysis, and MongoDB `explain("executionStats")` compound index optimization report showing 22x reduction in disk reads). 59/59 automated tests passing. |
| **Phase 11** | Docker & Local Reproducibility | PENDING | Scheduled next |
| **Phase 12** | Final Documentation & Demo Guide | PENDING | |

---

## 4. Current State Metrics & Checks
- **Current Phase:** Phase 10 Complete
- **Passing Tests:** 59 automated tests passing across 15 test suites
- **Measured Latency Benchmarks (Concurrency 10, N=500):**
  - Baseline (`GET /health/live`): 293.3 req/s, p50: 28.72ms, p95: 85.49ms, p99: 104.78ms
  - Gateway Allowed (`GET /gateway/v1/catalog`): 85.4 req/s, p50: 90.02ms, p95: 342.42ms, p99: 384.28ms
  - Gateway Rate-Limited (`GET /gateway/v1/catalog` 429): 180.2 req/s, p50: 42.75ms, p95: 116.70ms, p99: 307.63ms
- **MongoDB Query Performance:**
  - Compound Index `{ identityDigest: 1, occurredAt: -1 }`: 101 keys examined, 101 docs examined, Selectivity Ratio 1.00 (8ms)
  - Unindexed linear scan (`COLLSCAN`): 2,221 docs examined, Selectivity Ratio 21.99
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
**Phase 11 — Docker & Local Reproducibility**
- Create `Dockerfile` (multi-stage Node.js 22 LTS alpine build).
- Create `.dockerignore`.
- Create `docker-compose.yml` (orchestrating gateway, mock-upstream, redis, mongodb, audit-worker with healthchecks and named volumes).
- Verify containerization and multi-service inter-container networking.
