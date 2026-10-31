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
- **Rate-Limiter Storage & Engine:** Redis (v7+) with atomic Lua script execution (`ioredis`) (Phase 5)
- **Audit Store:** MongoDB (v7+) with Mongoose ODM (Phase 4)
- **Async Queue:** BullMQ (Phase 8)
- **Containerization:** Docker & Docker Compose (Phase 11)

---

## 3. Phase Status

| Phase | Description | Status | Verification & Evidence |
|---|---|---|---|
| **Phase 0** | Workspace & Project Controls | **COMPLETED** | Git repo initialized, `.gitignore`, minimal `package.json`, `docs/BUILD_STATE.md`, `docs/DECISIONS.md`. |
| **Phase 1** | Requirements & API Contract | **COMPLETED** | `docs/API.md` created with routes, lifecycles, headers, errors; `docs/DECISIONS.md` populated with ADR-001 through ADR-006. |
| **Phase 2** | Express Application Skeleton | **COMPLETED** | `src/app.js` (unbound app), `src/server.js` (port listener), `src/routes/health.routes.js` (`GET /health/live` -> 200 JSON), 404 JSON catch-all, central JSON error handler. Verified via live smoke test. |
| **Phase 3** | Config, Request IDs, Logging & Errors | **COMPLETED** | `.env.example`, `src/config/env.js`, `src/config/policies.js`, `src/middleware/requestId.js`, `src/utils/logger.js` (safe header redaction), `src/utils/errors.js`, `src/middleware/errorHandler.js`. 13/13 automated unit tests passing. |
| **Phase 4** | MongoDB Audit Model & Connection | PENDING | Scheduled next |
| **Phase 5** | Redis Connection & Atomic Lua Limiter | PENDING | |
| **Phase 6** | Client Identity & Express Middleware | PENDING | |
| **Phase 7** | Mock Upstream & Fixed Gateway Proxy | PENDING | |
| **Phase 8** | BullMQ Async Audit Pipeline | PENDING | |
| **Phase 9** | Concurrency & Failure Test Suite | PENDING | |
| **Phase 10** | Performance Measurement & Benchmarks | PENDING | |
| **Phase 11** | Docker & Local Reproducibility | PENDING | |
| **Phase 12** | Final Documentation & Demo Guide | PENDING | |

---

## 4. Current State Metrics & Checks
- **Current Phase:** Phase 3 Complete
- **Passing Tests:** 13 unit tests passed across 3 test suites (`tests/unit/config.test.js`, `tests/unit/requestId.test.js`, `tests/unit/errorHandler.test.js`)
- **Failing Tests:** 0
- **Running Services:** Standalone Express server verified with request ID stamping, structured logging, and safe error masking
- **Endpoints Active:**
  - `GET /health/live` (HTTP 200 JSON with process uptime, ISO timestamp, and `X-Request-Id` header)
  - Unmatched routes (HTTP 404 JSON with `requestId`)
- **Known Limitations:**
  - MongoDB and Redis not yet connected (scheduled in Phases 4 & 5).
  - Rate limiting logic isolated until Redis Lua implementation in Phase 5.

---

## 5. Next Task
**Phase 4 — MongoDB Audit Model & Connection**
- Install `mongoose`.
- Implement `src/infrastructure/mongo/mongoClient.js` with connect, disconnect, and connection status reporting.
- Implement `src/infrastructure/mongo/AuditLog.model.js` with all schema fields and indexes (`occurredAt`, `identityDigest + occurredAt`).
- Implement integration smoke test (`tests/integration/mongo.smoke.test.js`) to verify insert and read.
- Ensure gateway readiness probe reflects MongoDB state without blocking process liveness or hot-path requests.
