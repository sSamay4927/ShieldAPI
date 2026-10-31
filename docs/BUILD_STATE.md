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
| **Phase 3** | Config, Request IDs, Logging & Errors | PENDING | Scheduled next |
| **Phase 4** | MongoDB Audit Model & Connection | PENDING | |
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
- **Current Phase:** Phase 2 Complete
- **Failing Tests:** 0
- **Running Services:** Standalone Express server verified on live port without external dependencies
- **Endpoints Active:**
  - `GET /health/live` (HTTP 200 JSON with process uptime & ISO timestamp)
  - Unmatched routes (HTTP 404 JSON)
- **Known Limitations:**
  - No database or Redis connected yet (intentional for Phase 2).
  - Environment variables not yet parsed via centralized validator (scheduled in Phase 3).

---

## 5. Next Task
**Phase 3 — Configuration, Request IDs, Logging & Error Handling**
- Implement centralized environment validation (`src/config/env.js`) with strict numeric parsing.
- Create `.env.example` with documented defaults.
- Implement request ID middleware (`src/middleware/requestId.js`) with UUID generation and header propagation.
- Add safe structured logging (omitting credentials/auth headers).
- Add Jest & Supertest automated test suite for config validation and error mapping.
