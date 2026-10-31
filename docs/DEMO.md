# ShieldAPI — 3-Minute Terminal Walkthrough & Demonstration Guide

This guide provides a step-by-step interactive demo of ShieldAPI. It is designed for reviewers, hiring managers, and engineers to observe distributed rate limiting, identity isolation, TOCTOU concurrency guarantees, and asynchronous audit persistence in action.

---

## Prerequisites

Ensure the ShieldAPI stack is running. You can run it either via **Docker Compose** or **Local Node.js**:

### Option A: Docker Compose
```bash
docker compose up --build -d
```

### Option B: Local Node.js
```bash
# Terminal 1: Gateway Server
npm start

# Terminal 2: BullMQ Audit Worker
npm run worker
```

---

## Step 1: Health & Readiness Inspection

Verify that the gateway is live and that all downstream dependencies (Redis, MongoDB, BullMQ queue) are reachable and healthy.

```bash
# Check Process Liveness
curl -i http://localhost:3000/health/live
```
**Expected Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: 8e5f1b14-9b88-4229-9e8c-8f9f6e6ec1d1

{
  "status": "ok",
  "timestamp": "2026-10-31T20:30:00.000Z",
  "service": "shieldapi-gateway",
  "uptime": 12.4
}
```

```bash
# Check Dependency Readiness
curl -i http://localhost:3000/health/ready
```
**Expected Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "status": "ok",
  "dependencies": {
    "redis": "connected",
    "mongo": "connected",
    "queue": "ready"
  }
}
```

---

## Step 2: Rate Limiting Enforcement (Exhausting Quota)

The default rate limit policy permits **5 requests per 60-second window**. Dispatch 6 rapid requests using an API key (`client-alpha`):

```bash
# In Bash / macOS / Linux:
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "Request $i: HTTP %{http_code}\n" \
    -H "X-API-Key: client-alpha" \
    http://localhost:3000/gateway/v1/catalog
done
```

```powershell
# In Windows PowerShell:
1..6 | ForEach-Object {
    $res = Invoke-WebRequest -Uri "http://localhost:3000/gateway/v1/catalog" -Headers @{"X-API-Key"="client-alpha"} -SkipHttpErrorCheck
    Write-Host "Request $_`: HTTP $($res.StatusCode)"
}
```

**Expected Terminal Output:**
```
Request 1: HTTP 200
Request 2: HTTP 200
Request 3: HTTP 200
Request 4: HTTP 200
Request 5: HTTP 200
Request 6: HTTP 429
```

### Inspect the HTTP 429 Response Details
Inspect the headers and JSON payload of the rejected request:

```bash
curl -i -H "X-API-Key: client-alpha" http://localhost:3000/gateway/v1/catalog
```
**Expected Response:**
```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1793478660
Retry-After: 60
X-Request-Id: f47ac10b-58cc-4372-a567-0e02b2c3d479

{
  "error": "too_many_requests",
  "message": "Rate limit exceeded. Try again in 60 seconds.",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "retryAfter": 60
}
```

---

## Step 3: Client Identity Isolation

Verify that quotas are strictly partitioned per client identity. Sending a request from `client-alpha` returns `429`, but an immediate request from `client-beta` succeeds with `200`:

```bash
# Client Alpha (Already exhausted)
curl -s -o /dev/null -w "Client Alpha: HTTP %{http_code}\n" \
  -H "X-API-Key: client-alpha" \
  http://localhost:3000/gateway/v1/catalog

# Client Beta (Fresh quota)
curl -s -o /dev/null -w "Client Beta:  HTTP %{http_code}\n" \
  -H "X-API-Key: client-beta" \
  http://localhost:3000/gateway/v1/catalog
```

**Expected Output:**
```
Client Alpha: HTTP 429
Client Beta:  HTTP 200
```

---

## Step 4: Atomic Concurrency Proof (50 Simultaneous Requests)

Execute the concurrency verification script to prove that atomic Lua execution prevents TOCTOU race conditions under high concurrency:

```bash
node scripts/concurrency-test.js
```

**Expected Output:**
```
======================================================================
 ShieldAPI — 50-Request Concurrency Test
======================================================================
Configured Policy Quota:    10 requests / 60000 ms
Test Client API Key:        bench-key-29f1b4a7
Computed Identity Digest:   e3b0c44298fc1c149afbf4c8996fb92427ae41e464...
Dispatching 50 concurrent requests simultaneously...

Results:
  Total Requests Dispatched:  50
  Requests Allowed (200 OK): 10
  Requests Denied (429):     40
  Rate-Limit Invariant:      PASSED (Allowed count matched limit: 10)
  Execution Duration:        167 ms
======================================================================
```

---

## Step 5: Asynchronous MongoDB Audit Persistence

When a `429 Too Many Requests` event occurs, the gateway asynchronously enqueues the violation to BullMQ without blocking the response. The background worker then writes the event into MongoDB.

Inspect the most recent violation record in MongoDB:

```bash
node -e "const mongoose = require('mongoose'); const AuditLog = require('./src/infrastructure/mongo/AuditLog.model'); mongoose.connect('mongodb://127.0.0.1:27017/shieldapi').then(async () => { const doc = await AuditLog.findOne().sort({ occurredAt: -1 }).lean(); console.log(JSON.stringify(doc, null, 2)); await mongoose.disconnect(); });"
```

**Expected Output:**
```json
{
  "_id": "672439a2f1b4a8e29d01c4e7",
  "eventId": "audit_8e5f1b14-9b88-4229-9e8c-8f9f6e6ec1d1",
  "occurredAt": "2026-10-31T14:57:29.707Z",
  "route": "/gateway/v1/catalog",
  "method": "GET",
  "policyId": "default",
  "identityType": "api-key",
  "identityDigest": "4b423994c8c9c2a5978161d5a7881caf70483127904c048523dfc7946f0b0573",
  "decision": "RATE_LIMITED",
  "requestId": "0d7d6f76-17b1-4b53-bf5f-98002455517b",
  "limit": 5,
  "windowMs": 60000,
  "retryAfterMs": 60000,
  "expireAt": "2026-11-30T14:57:29.707Z"
}
```

> [!NOTE]
> Notice that the raw API key (`client-alpha`) is nowhere in the audit log document. Only the salted `identityDigest` (`4b423994...`) is stored, satisfying privacy compliance and preventing credential leakage.

---

## Step 6: Upstream Timeout & SSRF Protection

### 1. 504 Gateway Timeout Enforcement
Call the slow upstream simulation endpoint:
```bash
curl -i http://localhost:3000/gateway/v1/slow?delayMs=7000
```
**Expected Response:**
```http
HTTP/1.1 504 Gateway Timeout
Content-Type: application/json; charset=utf-8

{
  "error": "gateway_timeout",
  "message": "The upstream target failed to respond within 5000ms",
  "requestId": "2a9e403d-815a-4ff1-b663-8a9d186b4f74"
}
```

### 2. SSRF Protection
Attempt an SSRF header injection:
```bash
curl -i -H "X-Forwarded-Host: evil-attacker.com" http://localhost:3000/gateway/v1/catalog
```
**Expected Response:**
The proxy ignores `X-Forwarded-Host` and forwards strictly to `UPSTREAM_BASE_URL` (`http://localhost:4001`), returning `200 OK` from the legitimate mock upstream.

---

## Summary of Verified Invariants

| Capability | Invariant Verified |
|---|---|
| **Atomic Quota Enforcement** | Exactly 5 requests allowed; 6th rejected with 429. |
| **Header RFC Compliance** | `X-RateLimit-*` and `Retry-After` headers accurately generated. |
| **Identity Separation** | Quotas for `client-alpha` and `client-beta` do not interfere. |
| **TOCTOU Elimination** | 50 concurrent requests result in exactly 10 admissions under limit 10. |
| **Privacy Preservation** | Only HMAC-SHA256 digests exist in Redis keys and MongoDB logs. |
| **Decoupled Persistence** | 429 violations persist asynchronously into MongoDB via BullMQ without slowing the gateway. |

