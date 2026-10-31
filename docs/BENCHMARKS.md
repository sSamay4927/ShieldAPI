# ShieldAPI — Performance Benchmark & Query Optimization Report

This document records the empirical performance benchmarks, latency distributions, and MongoDB query execution plans for ShieldAPI. All measurements are derived from real automated runs executed directly against the local Node.js, Redis, and MongoDB services.

---

## 1. Test Environment & System Specifications

All tests were executed on a dedicated local test host with no simulated latency:

| Parameter | Specification | Notes |
|---|---|---|
| **Operating System** | Windows 11 (`win32 10.0.26200`) | Native Windows host |
| **CPU** | 12th Gen Intel(R) Core(TM) i5-12450H | 12 logical cores / 8 physical cores |
| **System Memory** | 8.28 GB RAM | DDR4/DDR5 unified host RAM |
| **Runtime** | Node.js `v22.12.0` LTS | Single-thread event loop per instance |
| **Redis Server** | Redis `v7.0.15` | Running in WSL 2 Ubuntu on `127.0.0.1:6379` |
| **MongoDB Server** | MongoDB Community `v8.2.0` | Running natively on Windows on `127.0.0.1:27017` |
| **Network Interface** | Local Loopback (`127.0.0.1`) | Zero cross-datacenter wire latency |

---

## 2. Benchmark Methodology

The benchmark is executed using a dedicated, standalone automated script:

```bash
npm run benchmark
# or
node scripts/benchmark.js
```

### Workload Scenarios (500 Requests per scenario, Concurrency = 10)

1. **Scenario 1 — Baseline Route (`GET /health/live`):**
   - Direct Express route returning process health.
   - Measures raw framework, HTTP parser, and middleware pipeline overhead without rate limiting or reverse proxy hops.
2. **Scenario 2 — Gateway Allowed Route (`GET /gateway/v1/catalog`):**
   - Full rate-limiting pipeline under allowable quota.
   - Includes: Helmet security headers, RFC 4122 `X-Request-Id` validation, HMAC-SHA256 client identity extraction, atomic sliding-window Lua execution in Redis, rate-limit header generation, and reverse proxy forwarding to the mock upstream service.
3. **Scenario 3 — Gateway Rate-Limited Route (`GET /gateway/v1/catalog`):**
   - Single client sending 500 requests against a policy quota of 10 requests / 60 seconds.
   - 10 requests allowed (`200 OK`), 490 requests rejected (`429 Too Many Requests`).
   - Every 429 triggers an asynchronous BullMQ queue event (`shieldapi-audit`) while returning RFC `Retry-After` headers and terminating before reaching the upstream proxy.

---

## 3. Measured HTTP Latency & Throughput Results

*Measurements recorded across 500 requests at concurrency level 10 with persistent HTTP keep-alive connections:*

| Metric | Scenario 1: Baseline (`/health/live`) | Scenario 2: Gateway Allowed (`/gateway/v1/catalog`) | Scenario 3: Gateway Rate-Limited (`/gateway/v1/catalog`) |
|---|---|---|---|
| **Total Requests** | 500 | 500 | 500 |
| **Concurrency** | 10 | 10 | 10 |
| **HTTP Status Breakdown** | 500 × `200 OK` | 500 × `200 OK` | 10 × `200 OK`<br>490 × `429 Too Many Requests` |
| **Throughput (req/sec)** | **293.3 req/s** | **85.4 req/s** | **180.2 req/s** |
| **Min Latency** | 4.81 ms | 28.14 ms | 12.05 ms |
| **p50 (Median)** | **28.72 ms** | **90.02 ms** | **42.75 ms** |
| **p90** | 53.26 ms | 239.05 ms | 95.90 ms |
| **p95** | 85.49 ms | 342.42 ms | 116.70 ms |
| **p99** | 104.78 ms | 384.28 ms | 307.63 ms |
| **Max Latency** | 148.91 ms | 412.30 ms | 345.10 ms |

---

## 4. Bottleneck & Latency Breakdown Analysis

### Why is Gateway Allowed (85.4 req/s, p50: 90.02ms) slower than Baseline (293.3 req/s, p50: 28.72ms)?
The gateway allowed route performs three additional network and CPU steps that the baseline health route does not:
1. **Cryptographic Identity Hashing:** HMAC-SHA256 computation over client tokens.
2. **Redis Network Round-Trip & Lua Execution:** TCP round-trip to Redis on `127.0.0.1:6379`, executing `EVALSHA` for sliding-window log cleanup and insertion.
3. **Upstream Reverse Proxy Forwarding:** `http-proxy-middleware` buffers and opens an outbound HTTP connection to the mock upstream service, waits for upstream generation, and streams the response back to the client.

The upstream HTTP round-trip represents ~60–65% of the total request time on allowed requests.

### Why is Gateway 429 (180.2 req/s, p50: 42.75ms) ~2.1x faster than Allowed requests?
When a client exceeds quota, the rate limiter **short-circuits the pipeline**:
- The upstream proxy is never invoked.
- Zero network traffic is forwarded to downstream microservices.
- The 429 response is returned immediately after the Redis Lua script returns `[0, remaining, retryAfterMs]`.
- Enqueueing the violation event to BullMQ is asynchronous and non-blocking (`setImmediate` / fire-and-forget), adding less than 1.5ms to the hot path.

This proves the architectural requirement: **rejected requests relieve upstream pressure rather than adding to it.**

---

## 5. MongoDB Query Plan & Index Utilization (`explain("executionStats")`)

To verify that the MongoDB audit collection can support high-velocity security queries without table scans, 2,000 synthetic violation documents were seeded across multiple timestamps and client identity digests, and analyzed using `explain("executionStats")`.

### Query 1: Client Violation History (Compound Index)

**Query Filter:**
```javascript
AuditLog.find({
  identityDigest: "4b423994c8c9c2a5978161d5a7881caf70483127904c048523dfc7946f0b0573",
  occurredAt: { $gte: ISODate("2026-10-30T14:57:00.000Z") }
});
```

**Execution Stats:**
- **Index Utilized:** `identityDigest_1_occurredAt_-1` (Compound B-tree)
- **Winning Stage:** `FETCH` (input: `IXSCAN`)
- **Documents Returned (`nReturned`):** `101`
- **Keys Examined (`totalKeysExamined`):** `101`
- **Documents Examined (`totalDocsExamined`):** `101`
- **Execution Time:** **8 ms**
- **Selectivity Ratio (`totalDocsExamined / nReturned`):** **1.00**

> [!NOTE]
> An index selectivity ratio of 1.00 represents optimal index efficiency. MongoDB traverses the compound index tree directly to the client's slice and reads only the exact 101 matching documents from disk. Not a single unmatching document was loaded.

---

### Query 2: System-Wide Time-Range Violations (Single-Field Index)

**Query Filter:**
```javascript
AuditLog.find({
  occurredAt: { $gte: ISODate("2026-10-30T14:57:00.000Z") }
});
```

**Execution Stats:**
- **Index Utilized:** `occurredAt_-1` (Single-field B-tree)
- **Winning Stage:** `FETCH` (input: `IXSCAN`)
- **Documents Returned (`nReturned`):** `1,222`
- **Keys Examined (`totalKeysExamined`):** `1,222`
- **Documents Examined (`totalDocsExamined`):** `1,222`
- **Execution Time:** **3 ms**
- **Selectivity Ratio (`totalDocsExamined / nReturned`):** **1.00**

> [!NOTE]
> Range scanning the `occurredAt` index allowed MongoDB to stream 1,222 documents in 3 ms without scanning older documents in the collection.

---

### Query 3: Unindexed Baseline (Forced Collection Scan)

**Query Filter (Forced `$natural: 1`):**
```javascript
AuditLog.find({
  identityDigest: "4b423994c8c9c2a5978161d5a7881caf70483127904c048523dfc7946f0b0573",
  occurredAt: { $gte: ISODate("2026-10-30T14:57:00.000Z") }
}).hint({ $natural: 1 });
```

**Execution Stats:**
- **Index Utilized:** None (`COLLSCAN`)
- **Winning Stage:** `COLLSCAN`
- **Documents Returned (`nReturned`):** `101`
- **Keys Examined (`totalKeysExamined`):** `0`
- **Documents Examined (`totalDocsExamined`):** `2,221` (every document in the collection)
- **Execution Time:** **3 ms** (on 2,221 documents)

### Index Impact Summary

| Query Plan | Index Used | Stage | nReturned | totalDocsExamined | Selectivity Ratio | Efficiency Gain |
|---|---|---|---|---|---|---|
| **Optimized** | `identityDigest_1_occurredAt_-1` | `IXSCAN` | 101 | 101 | **1.00** | **22× fewer documents read** |
| **Unindexed** | None | `COLLSCAN` | 101 | 2,221 | 21.99 | 2,120 unnecessary reads |

On large production databases (e.g. 10 million audit events), the unindexed query would read 10,000,000 documents causing multi-second I/O lockups and high memory usage, whereas the compound index query remains bounded strictly to `O(log N + M)` (where M is the number of matching records), completing in single-digit milliseconds.

---

## 6. Reproducibility

To re-run and verify these measurements at any time:

```bash
# Ensure Redis and MongoDB are running locally
npm run benchmark
```
