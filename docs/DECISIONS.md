# ShieldAPI — Architectural Decision Records (ADRs)

This document records the architectural and design decisions confirmed for ShieldAPI.

---

### ADR-001: Consistent CommonJS Module System

- **Status:** Accepted (Phase 0 / Phase 1)
- **Context:** Node.js supports both CommonJS (`require`) and ES Modules (`import`). Mixing both or using experimental ESM with tools like Jest can cause module resolution failures and runtime complexity.
- **Decision:** Use CommonJS (`require` and `module.exports`) consistently across the entire codebase, including all tests, tools, and scripts.
- **Consequences:** Eliminates transpile steps, simplifies Jest/Supertest configuration, and guarantees predictable imports across Node LTS versions.

---

### ADR-002: Atomic Sliding-Window Log Rate Limiting in Redis Lua

- **Status:** Accepted (Phase 1)
- **Context:** Under concurrent load, multiple gateway instances checking and incrementing counters separately in JavaScript introduce time-of-check to time-of-use (TOCTOU) race conditions, leading to over-admission.
- **Decision:** Execute the full cleanup, count, decision, and sorted-set insertion inside a single atomic Redis Lua script.
- **Consequences:**
  - Guarantees zero race conditions across distributed gateway instances sharing Redis.
  - Redis server clock (`redis.call('TIME')`) provides single-source-of-truth timestamps independent of application-server clock skew.
  - Memory trade-off: Storing request timestamps in sorted sets consumes memory proportional to active window traffic. Acceptable for targeted gateway protection.

---

### ADR-003: Fail-Closed (503 Service Unavailable) on Redis Failure

- **Status:** Accepted (Phase 1)
- **Context:** When Redis crashes or becomes unreachable, the gateway must decide whether to let traffic pass unthrottled (fail-open) or reject traffic (fail-closed).
- **Decision:** Implement **fail-closed** mode for all protected routes: if Redis cannot make an authoritative rate-limit decision, return `HTTP 503 Service Unavailable` with error code `rate_limiter_unavailable`.
- **Consequences:**
  - Protects upstream systems from catastrophic overload during Redis outages.
  - Clearly differentiates infrastructure failures (503) from client quota violations (429).
  - Can be made configurable via `RATE_LIMIT_FAIL_MODE` for non-critical routes if desired in future iterations.

---

### ADR-004: Client Identity Privacy via HMAC-SHA256 Digest

- **Status:** Accepted (Phase 1)
- **Context:** Rate limiting requires identifying clients across requests (via `X-API-Key` or IP address). Storing raw API keys or plain IPs in Redis keys or MongoDB violates data privacy and credential hygiene standards.
- **Decision:** Compute `HMAC-SHA256(IDENTITY_HASH_SECRET, identity)` and use the resulting hexadecimal digest as the Redis key suffix and audit identifier.
- **Consequences:**
  - Raw credentials never leak into Redis keys, console logs, or MongoDB audit records.
  - Provides deterministic, fixed-length keys for fast indexing and lookup.
  - Requires `IDENTITY_HASH_SECRET` to be securely injected via environment configuration.

---

### ADR-005: Decoupling Audit Persistence via Asynchronous Queue

- **Status:** Accepted (Phase 1)
- **Context:** Writing audit records synchronously to MongoDB on every rate-limited event places the database on the critical path, impacting latency and creating vulnerability to database slowdowns.
- **Decision:** The gateway enqueues audit payloads to BullMQ (backed by Redis) and returns immediately. A separate worker process persists documents to MongoDB with bounded retries.
- **Consequences:**
  - Gateway latency remains independent of MongoDB write speed.
  - Temporary MongoDB downtime does not interrupt the gateway's ability to reject abusive traffic.
  - Audit durability is eventually consistent and bounded by Redis queue retention settings.

---

### ADR-006: Strict Reverse Proxy Trust Configuration

- **Status:** Accepted (Phase 1)
- **Context:** When extracting client IP addresses for rate limiting, blindly setting `app.set('trust proxy', true)` trusts any `X-Forwarded-For` header sent by malicious clients, allowing attackers to spoof IPs and bypass IP-based rate limits.
- **Decision:** Do not enable wildcard proxy trust. Only configure `trust proxy` for explicit trusted upstream proxy CIDRs or local loops in container topologies.
- **Consequences:**
  - Prevents header spoofing attacks on client IP extraction.
  - Requires documentation for reverse proxy deployment scenarios.

---

### ADR-007: Client Identity Extraction Precedence and Response Header Contract

- **Status:** Accepted (Phase 6)
- **Context:** Requests arrive with various identifiers (API keys, IP addresses). The rate limiter must determine a single authoritative identity and communicate quota state transparently to clients using standardized HTTP headers.
- **Decision:**
  - **Identity Precedence:** `X-API-Key` takes precedence over IP fallback. If present, it represents an authenticated tenant; otherwise, `req.ip` is used.
  - **Digestion:** All identities are transformed into 64-character HMAC-SHA256 digests prior to Redis key creation (`shieldapi:rl:v1:<policy>:<digest>`).
  - **Headers Contract:** All evaluated responses return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix epoch seconds). Over-quota responses (429) also attach `Retry-After` (duration in seconds) and stop further execution immediately.
- **Consequences:**
  - Standardized client integration with transparent retry backoff.
  - Cryptographic decoupling ensures zero raw API key exposure across Redis, memory traces, or external probes.

---

### ADR-008: Fixed-Target Reverse Proxy Routing and SSRF Prevention

- **Status:** Accepted (Phase 7)
- **Context:** An API Gateway forwarding client requests can become an open proxy or Server-Side Request Forgery (SSRF) vector if destination hosts are determined by request headers, query parameters, or client payloads.
- **Decision:**
  - Target destination is strictly hardcoded to `config.UPSTREAM_BASE_URL`.
  - Client headers (`Host`, `X-Forwarded-Host`, `X-Forwarded-Server`) and URL query parameters are completely ignored for upstream destination resolution.
  - Incoming request bodies are size-bounded to 100kb and re-streamed to upstream via `fixRequestBody`.
  - Upstream network errors return sanitized `502 Bad Gateway` (`bad_gateway`) or `504 Gateway Timeout` (`gateway_timeout`) without leaking internal addresses or stack traces.
- **Consequences:**
  - Completely eliminates SSRF attack vectors.
  - Provides consistent distributed tracing via propagated `X-Request-Id`.
