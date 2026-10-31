# ShieldAPI — API Specification & Contract

This document freezes the public API, request lifecycles, rate-limiting policies, headers, and error behaviors for **ShieldAPI**.

---

## 1. System Scope & Boundaries

### What ShieldAPI Is
- An application-layer API Gateway and distributed rate limiter built with Express, Redis (atomic Lua script), and MongoDB.
- Enforces per-client quotas across multiple gateway instances sharing one Redis instance.
- Forwards accepted requests to a configured, fixed upstream service.
- Records security violations and rate-limit events asynchronously in MongoDB.

### What ShieldAPI Is NOT (Explicit Non-Goals)
- **Not network-level DDoS mitigation:** Volumetric network-level attacks (SYN floods, UDP amplification) must be handled upstream at DNS / CDN / infrastructure firewalls (e.g., Cloudflare, AWS Shield).
- **Not a multi-region globally distributed consensus engine:** State is centralized per Redis cluster/instance. Cross-region multi-master synchronization is out of scope.
- **Not an authentication provider:** The `X-API-Key` serves strictly as an identity token for quota accounting. It does not validate scopes, cryptographic credentials, or identity federation unless integrated with an external IAM.
- **Not an arbitrary reverse proxy:** The gateway proxies traffic strictly to a configured upstream service (`UPSTREAM_BASE_URL`). Dynamic client-specified proxy destinations are strictly forbidden to prevent SSRF vulnerabilities.

---

## 2. Request Lifecycles

### 2.1 Allowed Request Lifecycle
```text
Client
  │
  ▼
[1] Gateway Ingress (Express)
  │  ├── Generate or validate X-Request-Id (UUID v4)
  │  └── Extract client identity (X-API-Key or IP fallback)
  │
[2] Identity Hashing
  │  └── Compute HMAC-SHA256(IDENTITY_HASH_SECRET, identity) -> identityDigest
  │
[3] Atomic Rate-Limit Decision (Redis Lua Script)
  │  ├── Fetch current Redis server time via Redis TIME
  │  ├── Remove sorted-set entries older than (now - windowMs)
  │  ├── Count remaining active entries (ZCARD)
  │  └── If count < limit:
  │        ├── Atomically insert current request { member: UUID, score: nowMs }
  │        ├── Set key TTL (windowMs + 1000ms)
  │        └── Return: allowed=1, remaining, resetAfterMs, nowMs
  │
[4] Response Decoration & Proxy
  │  ├── Attach X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Request-Id
  │  └── Forward request to UPSTREAM_BASE_URL via HTTP proxy
  │
[5] Gateway Egress
     └── Return upstream status, upstream headers, and upstream body to Client
```

### 2.2 Rate-Limited Request Lifecycle (HTTP 429)
```text
Client
  │
  ▼
[1] Gateway Ingress (Express)
  │  ├── Assign X-Request-Id
  │  └── Extract & compute HMAC identityDigest
  │
[2] Atomic Rate-Limit Decision (Redis Lua Script)
  │  ├── Remove expired entries
  │  ├── Count remaining entries
  │  └── If count >= limit:
  │        ├── Find score of oldest accepted request in active window
  │        ├── Calculate retryAfterMs = oldestTimestamp + windowMs - nowMs
  │        └── Return: allowed=0, remaining=0, retryAfterMs, nowMs
  │
[3] Short-Circuit Execution (No Upstream Call)
  │  ├── DO NOT call UPSTREAM_BASE_URL
  │  ├── Enqueue audit event (asynchronous via BullMQ / Mongo)
  │  └── Set HTTP headers:
  │        ├── Retry-After: <retryAfterSeconds>
  │        ├── X-RateLimit-Limit: <limit>
  │        ├── X-RateLimit-Remaining: 0
  │        └── X-RateLimit-Reset: <resetEpochSeconds>
  │
[4] Client Response
     └── Return HTTP 429 Too Many Requests (JSON error body)
```

### 2.3 Failure Lifecycles (Infrastructure & Upstream Issues)

| Failure Event | Gateway Mode | Response Status | Error Code | Client Description |
|---|---|---|---|---|
| **Redis Unreachable / Down** | Fail-Closed (Default) | `503 Service Unavailable` | `rate_limiter_unavailable` | The rate limiting service is unavailable. Traffic is not allowed blindly. |
| **Upstream Response Timeout** | Timeout enforcement | `504 Gateway Timeout` | `gateway_timeout` | The upstream service failed to respond within `PROXY_TIMEOUT_MS`. |
| **Upstream Unreachable / Refused** | Connection failure | `502 Bad Gateway` | `bad_gateway` | Gateway could not establish a connection to the configured upstream. |
| **MongoDB Down** | Graceful degradation | `200` or `429` (Normal) | None (Request path unaffected) | Mongo is decoupled from the hot path; audit persistence fails or retries in queue without disrupting rate limiting. |

---

## 3. Endpoints Contract

### 3.1 Health & Diagnostics Routes

#### `GET /health/live`
- **Purpose:** Process liveness probe (orchestrator check).
- **Rate-Limited:** No.
- **Dependencies Checked:** None (pure Node.js event-loop check).
- **Status:** `200 OK`
- **Response Example:**
  ```json
  {
    "status": "ok",
    "uptime": 124.5,
    "timestamp": "2026-10-31T17:00:00.000Z"
  }
  ```

#### `GET /health/ready`
- **Purpose:** Gateway readiness probe (traffic ingress check).
- **Rate-Limited:** No.
- **Dependencies Checked:** Redis connectivity (mandatory); MongoDB connectivity (reported status).
- **Status:** `200 OK` if Redis is connected; `503 Service Unavailable` if Redis is disconnected.
- **Response Example:**
  ```json
  {
    "status": "ready",
    "redis": "connected",
    "mongo": "connected",
    "queue": "active"
  }
  ```

---

### 3.2 Gateway Protected Proxy Routes

All `/gateway/v1/*` routes pass through the identification and atomic rate-limiting pipeline before forwarding.

#### `GET /gateway/v1/catalog`
- **Purpose:** Demonstrates standard proxying of read traffic under rate limiting.
- **Rate-Limited:** Yes.
- **Proxied To:** `GET ${UPSTREAM_BASE_URL}/catalog`
- **Expected Allowed Response:**
  - Status: `200 OK` (from upstream)
  - Headers: Rate-limit headers + upstream headers
  - Body:
    ```json
    {
      "items": [
        { "id": "item-1", "name": "Standard Widget" },
        { "id": "item-2", "name": "Premium Widget" }
      ]
    }
    ```

#### `GET /gateway/v1/slow`
- **Purpose:** Demonstrates timeout enforcement and safe error propagation.
- **Rate-Limited:** Yes.
- **Proxied To:** `GET ${UPSTREAM_BASE_URL}/slow` (endpoint delays response beyond `PROXY_TIMEOUT_MS`).
- **Expected Response:**
  - Status: `504 Gateway Timeout`
  - Body:
    ```json
    {
      "error": "gateway_timeout",
      "message": "Upstream service response timed out.",
      "requestId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
    }
    ```

#### `POST /gateway/v1/echo`
- **Purpose:** Demonstrates body forwarding with strict payload boundaries.
- **Rate-Limited:** Yes.
- **Request Body Limit:** `100kb` strict limit (enforced at gateway layer).
- **Proxied To:** `POST ${UPSTREAM_BASE_URL}/echo`
- **Expected Allowed Response:**
  - Status: `200 OK`
  - Body: Echoes the sent JSON payload.

---

## 4. Rate-Limit Policy & Identity Rules

### 4.1 Development Policy Parameters

| Parameter | Env Variable | Default Dev Value | Description |
|---|---|---|---|
| Window Length | `RATE_LIMIT_WINDOW_MS` | `60000` (60s) | The duration of the sliding window log in milliseconds. |
| Max Requests | `RATE_LIMIT_MAX_REQUESTS` | `5` | Maximum accepted requests per window per identity. |
| Fail Mode | `RATE_LIMIT_FAIL_MODE` | `closed` | Fail mode when Redis is unreachable (`closed` = 503, `open` = pass). |
| Identity Mode | `RATE_LIMIT_IDENTITY_MODE`| `api-key-or-ip` | Precedence rule for identifying clients. |

### 4.2 Client Identification Hierarchy
1. **API Key Priority:**
   - The gateway inspects the incoming `X-API-Key` HTTP header.
   - If present, the identity string is the raw key value.
   - The identity is immediately hashed: `identityDigest = HMAC-SHA256(IDENTITY_HASH_SECRET, apiKey)`.
   - `identityType` is recorded as `"api-key"`.
2. **IP Fallback:**
   - If `X-API-Key` is missing, the gateway extracts the client IP address (`req.ip`).
   - The IP is hashed: `identityDigest = HMAC-SHA256(IDENTITY_HASH_SECRET, clientIp)`.
   - `identityType` is recorded as `"ip"`.
3. **Privacy & Security Guarantee:**
   - **No raw credentials:** Raw API keys, Authorization headers, or plaintext IP addresses are NEVER stored in Redis keys, log entries, or MongoDB documents.

### 4.3 Redis Key Schema
```text
shieldapi:rl:v1:<policyId>:<identityDigest>
```
- Example: `shieldapi:rl:v1:default:a4f8e9102c4b...`
- **Data Structure:** Redis Sorted Set (ZSET).
- **Score:** Timestamp in milliseconds (`nowMs` returned from Redis server `TIME`).
- **Member:** Unique Request UUID (`uuidv4`).
- **TTL:** Key expires automatically via `PEXPIRE` set to `windowMs + 1000ms`.

---

## 5. HTTP Response Headers Contract

Every response on protected routes includes the following standard rate-limiting headers:

| Header | Present On | Format | Example | Description |
|---|---|---|---|---|
| `X-Request-Id` | All responses | UUID v4 | `f47ac10b-58cc-4372-a567-0e02b2c3d479` | Unique ID tracing the request across logs and proxy. |
| `X-RateLimit-Limit` | All protected responses | Integer | `5` | Configured maximum requests allowed in the active window. |
| `X-RateLimit-Remaining` | All protected responses | Integer | `3` (or `0`) | Number of available requests remaining in the current window. |
| `X-RateLimit-Reset` | All protected responses | Epoch Seconds | `1761922860` | Unix timestamp in seconds when the oldest consumed quota slot expires. |
| `Retry-After` | `429 Too Many Requests` only | Integer Seconds | `12` | Number of seconds the client must wait before sending another request. |

---

## 6. Standardized Error Response Formats

All gateway errors return consistent, predictable JSON payloads without internal stack traces or server leaks.

### 6.1 Quota Exceeded (`429 Too Many Requests`)
```json
{
  "error": "rate_limit_exceeded",
  "message": "Rate limit exceeded. Please retry after 12 seconds.",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "remaining": 0,
  "retryAfter": 12
}
```

### 6.2 Redis Unavailable (`503 Service Unavailable`)
```json
{
  "error": "rate_limiter_unavailable",
  "message": "Rate limiting service is temporarily unavailable. Fail-closed policy active.",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

### 6.3 Upstream Connection Failure (`502 Bad Gateway`)
```json
{
  "error": "bad_gateway",
  "message": "Failed to connect to upstream service.",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

### 6.4 Upstream Timeout (`504 Gateway Timeout`)
```json
{
  "error": "gateway_timeout",
  "message": "Upstream service response timed out.",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

### 6.5 Route Not Found (`404 Not Found`)
```json
{
  "error": "not_found",
  "message": "The requested gateway endpoint does not exist.",
  "path": "/gateway/v1/invalid"
}
```

---

## 7. Assumptions & Technical Constraints

1. **Clock Source:** Clocks on distributed Node.js gateway nodes can drift. Therefore, all timestamp decisions and cutoff math rely exclusively on `redis.call('TIME')` inside the Redis Lua script.
2. **Reverse Proxy Trust:** `trust proxy` in Express will NOT be enabled globally. It will only be configured when explicit trusted reverse-proxy subnet CIDRs are provided in production.
3. **Queue Durability:** BullMQ audit queue jobs are backed by Redis. Audit event persistence is eventually consistent and asynchronous; audit service unavailability will never fail or bypass an allowed rate-limit decision.
