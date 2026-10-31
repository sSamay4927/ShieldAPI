# ShieldAPI — Build State

This document is the single source of truth for the project's current implementation state. It is updated at the conclusion of every completed phase.

---

## 1. Project Goal & Overview
Build a demonstrable, production-quality distributed API gateway and rate limiter using Express, Redis (atomic Lua script), and MongoDB. The system enforces shared sliding-window-log quotas across multiple gateway instances, rejects over-quota requests with HTTP 429, forwards accepted requests to a fixed mock upstream, and records security violation events asynchronously via BullMQ into MongoDB.

---

## 2. Technical Stack & Architecture Decisions
- **Runtime & Environment:** Node.js v22 LTS (`v22.12.0`)
- **Module System:** CommonJS (`require` / `module.exports`) consistently throughout
- **Web Framework:** Express.js
- **Rate-Limiter Storage & Engine:** Redis (v7+) with atomic Lua script execution (`ioredis`)
- **Audit Store:** MongoDB (v7+) with Mongoose ODM
- **Async Queue:** BullMQ (Phase 8)
- **Containerization:** Docker & Docker Compose (Phase 11)

---

## 3. Phase Status

| Phase | Description | Status | Verification & Evidence |
|---|---|---|---|
| **Phase 0** | Workspace & Project Controls | **COMPLETED** | Git repo initialized, `.gitignore`, minimal `package.json`, `docs/BUILD_STATE.md`, `docs/DECISIONS.md`. |
| **Phase 1** | Requirements & API Contract | **COMPLETED** | `docs/API.md` created with routes, lifecycles, headers, errors; `docs/DECISIONS.md` populated with ADR-001 through ADR-006. |
| **Phase 2** | Express Application Skeleton | PENDING | Scheduled next |
| **Phase 3** | Config, Request IDs, Logging & Errors | PENDING | |
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
- **Current Phase:** Phase 1 Complete
- **Failing Tests:** 0 (test framework scheduled in Phase 3)
- **Application Code:** 0 source files created prematurely (clean contract freeze)
- **Known Limitations:**
  - Upstream destination is fixed to `UPSTREAM_BASE_URL` by design.
  - Rate-limit decisions assume a single shared Redis deployment.
  - Key expiry is sliding window based on Redis server time (`TIME`).

---

## 5. Next Task
**Phase 2 — Express Application Skeleton**
- Create `src/app.js` (Express app factory without port binding).
- Create `src/server.js` (listens on configured `PORT`).
- Create `src/routes/health.routes.js` with `GET /health/live`.
- Add JSON 404 handler and central JSON error handler.
- Update `package.json` with `express` dependency and start scripts.
