# A29 — Password hashing and login hardening: argon2id via prebuilt napi, versioned pepper, NIST policy, DB-backed throttling

**Status:** Accepted (2026-09-11); amended 2026-09-13 by spike S13 (`docs/spikes/S13-argon2-calibration.md`, pass): the parameters below are unchanged and stay the `EnvSchema` defaults, which apply to every developer machine and CI runner. The measured production pair is separate — `ARGON2_MEMORY_KIB=131072`, `ARGON2_TIME_COST=6`, p50 213.51 ms on the 4 vCPU reference container against the schema defaults' 47.80 ms — and it is set at the deployment layer, in `infra/compose.prod.yaml` and `docs/ops/configuration.md`, never as a schema default.

## Context

Digest §6.2 verifies the OWASP Argon2id floor (m=19456 KiB, t=2, p=1), that peppers are shared across hashes and must be stored separately from them, and that the PHC string format is what makes parameter upgrades possible later. It also verifies that `@node-rs/argon2` 2.2.1 (Rust/napi-rs, published 2026-09-10) produces PHC-format Argon2 digests, whereas the reference `argon2` 0.45.1 binds to libargon2 through node-gyp. The NIST SP 800-63B-4 and OWASP authentication requirements are also verified: 15 characters minimum without MFA, allow ≥64 characters and any Unicode, no composition or rotation rules, block breached passwords, generic error messages with equalised timing, and per-account throttling. Digest §6.2 records the `rate-limiter-flexible` 11.2.0 login pattern (two limiters, `RateLimiterMySQL` with an in-memory insurance limiter).

## Decision

`@node-rs/argon2` 2.2.1 with argon2id, `memoryCost 65536` KiB, `timeCost 3`, `parallelism 1`, `hashLength 32`, and `secret = pepper[pepper_version]`, producing a PHC string in `user_credentials.password_hash`. A `needsRehash` result or a pepper-version drift triggers a transparent re-hash on the next successful login. `iridium doctor --argon2` calibrates the host to a 150–300 ms verify (`ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`). Policy: minimum 15 characters (8 once MFA exists), maximum 128, any Unicode, no composition or rotation rules, checked offline against a bundled top-100k breached-password list. One login path with a dummy verify for unknown users and a generic `invalid_credentials` response. Throttling uses `rate-limiter-flexible` 11.2.0 `RateLimiterMySQL` against a `login_throttle` table: limiter A keyed `email|ip` (5 consecutive failures → 15-minute block, doubling to a 24-hour ceiling), limiter B per IP per day (100), with `RateLimiterMemory` as the insurance limiter if MySQL is unavailable. `UV_THREADPOOL_SIZE=8` is set explicitly because hashing occupies libuv threads.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| `argon2` 0.45.1 (node-argon2) | node-gyp means a C toolchain in the Docker build, on Windows developer machines, and in CI; `@node-rs/argon2` ships prebuilt napi binaries and emits identical PHC output, so the hash format is not a lock-in. |
| bcrypt 6.0.0 | 72-byte input truncation and OWASP's "legacy only" classification. |
| PBKDF2-HMAC-SHA256 | 600 000 iterations for a weaker memory-hardness profile. |
| No pepper | A database-only compromise then yields directly crackable hashes; the pepper lives in the secrets bundle (A47) and is versioned so it can be rotated with `iridium keys rotate pepper`. |
| Composition rules and 90-day rotation | Explicitly rejected by NIST SP 800-63B-4 and OWASP; they reduce entropy in practice. |
| In-memory-only throttling | Lost on restart, which is a trivial bypass; MySQL-backed with a memory insurance limiter survives both restarts and a database blip. |
| An online breach API (e.g. range queries) | An outbound dependency on the login path and a privacy question for an on-premises product; a bundled list is offline and deterministic. |

## Consequences

Positive: no native toolchain anywhere in the build; parameters and pepper version are both upgradable without a migration because they live in the PHC string; the login path has one shape for existing and unknown users. Negative: the pepper becomes a restore-critical secret (A47 verifies key versions and the restore fails if they mismatch — which is the intended behaviour, because a wrong pepper silently invalidates every password); 150–300 ms per verify is a deliberate CPU cost that `UV_THREADPOOL_SIZE` and the login rate limits bound; the breached-password list adds a few megabytes to the image.

## Verification

`auth.hasher.unit` (argon2id parameters, versioned pepper, `needsRehash` on parameter or pepper-version drift, transparent re-hash on the next successful login) and `auth.phc.unit` (PHC round trip; an unparseable or unknown-variant hash is a typed failure, never a silent accept); `auth.policy.unit` (15–128 characters, any Unicode, no composition or rotation rules) and `auth.policy.blocklist-hash.unit` (the bundled list is consulted offline by hash prefix and the candidate is never logged); `auth.login-timing.unit` (equalised timing for unknown user versus wrong password, within tolerance); `auth.throttle.integration` (limiter A blocks after 5 failures and doubles; limiter B caps per IP per day; the insurance limiter engages when MySQL is down); `auth.pepper-rotation.integration` (after `iridium keys rotate pepper` old-pepper users still log in and are re-hashed, and a version downgrade refuses to boot); `iridium doctor --argon2` in the M8 operations checklist; `logging-redaction.integration` (no password or hash in logs).

## References

Digest §6.2 (OWASP password storage and authentication, NIST SP 800-63B-4, `@node-rs/argon2` 2.2.1, `rate-limiter-flexible` 11.2.0), §11.14; spec §8; plan-risk-first ADR-08; judges 1, 2. Implemented in `04-auth-and-access-control.md` and `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A29. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
