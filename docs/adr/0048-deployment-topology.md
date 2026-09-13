# A48 — Deployment topology: one server container, MySQL, an attachment volume, behind Caddy; hardened production compose; an air-gapped in-process TLS profile

**Status:** Accepted (2026-09-11).

## Context

Spec §8 requires a repeatable server deployment with database migrations, health checks, and operational logging, states that infrastructure can initially be one application deployment plus MySQL plus persistent attachment storage, and requires that MySQL and writable server storage are never exposed to clients; horizontal scaling is explicitly not an MVP requirement. Digest §6.2 records the prevailing pattern: TLS terminated at a reverse proxy with the Node application on loopback, nginx needing `proxy_http_version 1.1` plus `Upgrade`/`Connection` headers for WebSockets and raised read/idle timeouts for long-lived sockets, and Caddy providing automatic ACME certificates with transparent WebSocket proxying. Digest §3.2 adds an MCP-specific requirement no plan had tested: requests carry `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers, and digest §3.4 warns that these "must pass any WAF or gateway in front of /mcp" — a silently stripped header degrades or breaks the primary feature. Digest §9.2 notes that `turbo prune --docker` previously dropped unknown `pnpm-lock.yaml` settings (issue #12442, fixed), which is why the Docker build installs with `--frozen-lockfile` from the pruned lockfile.

## Decision

`infra/compose.yaml` for development: `mysql:9.7.2-oraclelinux9` with the baked `my.cnf` and `init/01_roles.sql` (A8, A9), port bound to `127.0.0.1`, plus profiles `s3` (SeaweedFS on a pinned numeric tag) and `full` (the server with Compose Watch).

`infra/compose.prod.yaml` for production: Caddy 2 (pinned tag) with automatic ACME or provided certificates, `reverse_proxy` with WebSocket passthrough, a `/collab` idle timeout of at least 120 s, and `/mcp` with `flush_interval -1`; the server image `ghcr.io/<org>/iridium-server:<version>` running non-root with `read_only: true` rootfs plus `tmpfs /tmp`, `cap_drop: [ALL]`, `no-new-privileges`, resource limits, secrets supplied as files through `*_FILE` variables, volumes `attachments-data`, `staging-data`, `exports-data`, `updates-data`, `depends_on mysql: service_healthy`, and a `HEALTHCHECK` on `/healthz`. An nginx equivalent is documented (`proxy_http_version 1.1`, `Upgrade`/`Connection`, `proxy_buffering off`, `proxy_read_timeout 3600`). **Both proxy configurations forward `Mcp-Method`, `Mcp-Name`, and `MCP-Protocol-Version`, and a nightly test through the proxied stack asserts it.** Node binds `127.0.0.1:4000` with `TRUST_PROXY` set to the proxy CIDR only. The air-gapped profile uses Fastify `https: {key, cert}` (HTTP/1.1) with no proxy. A systemd unit is documented for non-container deployments. The Dockerfile is multi-stage on `node:24.21.0-bookworm-slim` using `turbo prune --docker`, `pnpm install --frozen-lockfile` from the pruned lockfile (verified in CI), `pnpm deploy --prod`, `@node-rs/argon2` prebuilt binaries only, and an SBOM produced by syft with grype scanning (both pinned at M0).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Kubernetes manifests as the primary deployment | Spec §8 asks for one deployment plus MySQL plus storage; A23's in-process `AuthzBus` and A17's single collaboration process make multi-replica incorrect today. Compose plus a documented systemd unit is honest about that, and F9 records the interfaces that a multi-process topology would swap. |
| Node terminating TLS in production | Loses ACME automation, HTTP/2 for static assets, and operator-familiar access logging; kept only for the air-gapped profile where no proxy is permitted. |
| Exposing MySQL on a host port by default | Spec §8 forbids exposing the database to clients; development binds to `127.0.0.1` and production exposes nothing. |
| A writable container filesystem | `read_only: true` plus explicit volumes makes every writable path deliberate (attachments, staging, exports, updates) and prevents an attacker from persisting anywhere else. |
| Secrets as environment variables | Digest §6.2 discourages it (readable by all processes, leaks into logs and dumps); `*_FILE` reads mounted files and the environment holds only the paths. |
| A public update service for desktop releases | A48 serves `/desktop/updates/<channel>/` from the same server (A53), so no third party is in the update path. |
| Trusting all proxies (`trustProxy: true`) | Lets a client spoof `X-Forwarded-For` and defeat IP-based rate limits (A29, A.1); the CIDR list is explicit. |

## Consequences

Positive: a clean virtual machine plus `compose.prod.yaml` plus secrets produces a working deployment, and a nightly CI job proves it; the MCP header passthrough test converts a silent, hard-to-diagnose failure mode into a build failure; the hardened container settings are enumerated once and reviewed once. Negative: single-node is a real limitation for availability, and the plan says so rather than implying otherwise; `IRIDIUM_MIGRATE_ON_BOOT` must be turned off for any future multi-instance rollout (A7 documents it); the air-gapped TLS profile is a second serving path that needs its own test lane.

## Verification

`ops.compose-prod.clean-vm` (nightly: boot `compose.prod.yaml` on a clean machine, reach `/readyz`, log in, edit a note, call `/mcp`); `proxied-stack.headers.mcp` (nightly, through both Caddy and nginx: `Mcp-Method`, `Mcp-Name` and `MCP-Protocol-Version` arrive intact, an absent `Mcp-Method` arrives absent rather than present-and-empty, and a `/collab` connection survives beyond the idle timeout under both proxies); `docker-image` (the image builds from the pruned lockfile with `--frozen-lockfile`, boots as a non-root user with `read_only: true`, writes only to the declared volumes, and answers `/readyz`) together with `supply-chain.sbom` (syft SBOM and grype policy scan on the pushed digest); `ops.trust-proxy.integration` (a spoofed `X-Forwarded-For` from an untrusted source does not change the rate-limit key); the air-gapped in-process TLS profile is exercised as a second mode of `ops.compose-prod.clean-vm`, which boots it without a proxy and drives REST, `/collab` and `/mcp` over Fastify's own `https` listener.

## References

Digest §6.2 (reverse-proxy pattern, secrets management, `trustProxy`), §3.2 and §3.4 (MCP headers, buffering), §5.2, §9.2 (`turbo prune --docker` lockfile issue); spec §8; plan-risk-first and plan-enterprise grafts; gap fix (header passthrough test). Implemented in `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A48. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
