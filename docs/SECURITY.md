# ShieldAPI — Security Architecture & Threat Model Review

This document details the security posture, threat model, mitigation controls, and verified defensive guarantees of **ShieldAPI**.

---

## 1. Executive Summary & Security Controls Matrix

| Control | Status | Implementation Details |
|---|---|---|
| **Reverse Proxy Trust (`trust proxy`)** | **Documented & Hardened** | Wildcard proxy trust (`app.set('trust proxy', true)`) is intentionally disabled. IP spoofing via attacker-supplied `X-Forwarded-For` is blocked unless deployed behind verified reverse proxy CIDRs. |
| **Request Body Size Limits** | **Implemented** | Strict `100kb` upper limit enforced via `express.json({ limit: '100kb' })` to mitigate payload flooding and resource exhaustion DoS attacks. |
| **Fixed Upstream Target (SSRF Prevention)** | **Implemented** | Proxy routing strictly resolves to `config.UPSTREAM_BASE_URL`. Incoming client headers (`Host`, `X-Forwarded-Host`) and destination query parameters are completely ignored. |
| **Credential & PII Privacy** | **Implemented** | API keys and client IPs are immediately converted to 64-character lowercase `HMAC-SHA256(IDENTITY_HASH_SECRET, id)` digests. Raw secrets never enter Redis, MongoDB, or console logs. |
| **Security Response Headers (Helmet)** | **Implemented** | `helmet()` middleware protects against MIME sniffing (`X-Content-Type-Options: nosniff`), clickjacking (`X-Frame-Options: SAMEORIGIN`), and XSS attacks. |
| **Stack Trace & Diagnostic Shielding** | **Implemented** | Central error handler sanitizes internal exceptions. Network errors (502/504) return uniform JSON payloads without leaking socket details or runtime paths. |
| **Atomic Redis Key Namespacing** | **Implemented** | Redis keys use strictly partitioned namespaces (`shieldapi:rl:v1:<policy>:<digest>`). |
| **Distributed Race Condition Prevention** | **Proved by Test** | Rate limiting decisions and sorted-set mutations execute atomically within a single Redis Lua script (`EVALSHA`), guaranteeing exact quota enforcement under high concurrency. |
| **Fail-Closed Availability Shield** | **Implemented** | In the event of a Redis outage, protected routes return HTTP 503 (`rate_limiter_unavailable`), preventing unmetered traffic surges against internal upstreams. |

---

## 2. Threat Modeling & Specific Attack Vectors

### 2.1 Server-Side Request Forgery (SSRF)
* **Risk:** In typical reverse proxies, dynamic destination configuration allows malicious clients to coerce the gateway into querying internal infrastructure (e.g., `http://169.254.169.254/latest/meta-data/`).
* **ShieldAPI Defense:** The proxy destination is hardcoded to `config.UPSTREAM_BASE_URL` at middleware creation. Path rewriting safely slices the `/gateway/v1` route prefix and appends the path to the fixed target. Host spoofing via `X-Forwarded-Host` or URL manipulation is ignored.

### 2.2 Time-of-Check to Time-of-Use (TOCTOU) Concurrency Races
* **Risk:** Under concurrent bursts, multiple gateway instances reading a counter, verifying the limit, and incrementing separately create race windows where attackers can exceed their allotted quota by orders of magnitude.
* **ShieldAPI Defense:** Quota evaluation and state mutation occur within a single atomic Lua script (`slidingWindowLog.lua`). Redis single-threaded execution guarantees serializability. Time is acquired from the Redis server clock (`TIME`), eliminating clock skew between gateway worker nodes.
* **Verification:** Proved with 50 concurrent requests against single and distributed multi-instance gateways: exactly 10 requests are admitted for a limit of 10, with 40 rejected (429).

### 2.3 IP Spoofing & Quota Circumvention
* **Risk:** Rate limiters relying on `req.ip` without proper proxy configuration can be bypassed if an attacker rotates spoofed `X-Forwarded-For` header values.
* **ShieldAPI Defense:** ShieldAPI does not set `app.set('trust proxy', true)` by default. `req.ip` reflects the direct TCP socket remote address unless explicitly configured for a trusted proxy subnet in production. For authenticated tenants, `X-API-Key` takes precedence over IP address.

### 2.4 Credential Exposure & Compliance (GDPR / HIPAA / PCI-DSS)
* **Risk:** API keys or plaintext client IP addresses recorded in diagnostic logs, Redis sorted-set members, or audit documents leak credentials to internal staff or log aggregation vendors (e.g. Datadog, CloudWatch).
* **ShieldAPI Defense:**
  - `identifyClient` middleware hashes identifiers into 64-character HMAC-SHA256 digests using a cryptographically random secret (`IDENTITY_HASH_SECRET`).
  - Request logging middleware redacts `x-api-key`, `authorization`, and cookie headers.
  - Redis sorted-set members store random request UUIDs, with scores representing timestamps.
  - MongoDB `AuditLog` stores only `identityDigest`.

### 2.5 Denial of Service via Payload Flooding
* **Risk:** Large JSON payloads consume server memory and CPU during parsing, blocking the Node.js event loop.
* **ShieldAPI Defense:** Global JSON body parser applies `{ limit: '100kb' }`. Requests exceeding this size are rejected immediately with HTTP 413 Payload Too Large.

---

## 3. Recommended Production Deployment Hardening

1. **Environment Secrets**: Ensure `IDENTITY_HASH_SECRET` is at least 32 characters long and rotated periodically. Never run production with default development secrets.
2. **Reverse Proxy Configuration**: If terminating TLS at an Application Load Balancer (ALB) or Cloudflare, configure Express `trust proxy` strictly to the known CIDR block:
   ```javascript
   // Example for AWS ALB:
   app.set('trust proxy', '10.0.0.0/16');
   ```
3. **Redis Cluster Mode**: The atomic Lua script is fully compatible with Redis standalone and Redis Sentinel. If using Redis Cluster, ensure the rate-limit key uses hash tags `{tenant}` if keys ever span multiple shards.
