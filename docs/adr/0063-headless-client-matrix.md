# AG10 — Real-client observation at M3 is headless; the nightly matrix is advisory until M8, and GUI clients are observed by hand

**Status:** Accepted (2026-09-24), answering G10. Supersedes in part AG1 (Verification: Standing), A32 (Verification: the nightly matrix's client list), A52 (Decision: the nightly real MCP client matrix's client list) and the S9 method of `12-milestones.md` §4.4 and `14-risks-and-open-questions.md`.

## Context

AG1's Standing verification, A32's Verification and A52's nightly job list name one nightly matrix that drives VS Code, Cursor and Claude Desktop beside the headless clients. A GUI client cannot be driven headlessly in CI, the connector products need a publicly reachable HTTPS origin, and several rows need prerequisites — an API key, a staging deployment, a hosted client metadata document — that do not exist at M3. The matrix also has to observe clients over the TLS a user runs, which the product's in-process TLS profile provides only once its listener carries the plain listener's `node:http` options. The owner answered G10 on 2026-09-24.

## Decision

S9 runs before M3 exit, headless, as a `workflow_dispatch` of `nightly.yml › mcp-clients` at target M3, which runs the committed harness `apps/e2e/mcp-clients` in the nightly-only Vitest project `mcp-clients` (D10-43); the S9 note's evidence is the run id, the `versions.json` rows and each row's recording-listener trace.

*Transport and trust.* Every matrix run serves `PUBLIC_ORIGIN` over real TLS through the product's in-process TLS profile (`TLS_CERT_FILE`, `TLS_KEY_FILE`). For each run `packages/testkit/src/harness/test-ca.ts` generates one CA and one leaf certificate with the runner's `openssl` — SANs `IP:127.0.0.1` and `DNS:localhost`, valid for 90 days, beyond the 30-day `tls_cert` warning window — adding no dependency. Every client process receives `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `CURL_CA_BUNDLE` naming the CA, and no row sets `NODE_TLS_REJECT_UNAUTHORIZED` or an insecure flag. `buildApp` implements the profile from M3: Fastify 5.12.4 passes only the `https` object to `https.createServer` once `https` is given, so one frozen `nodeServerOptions` object (`{maxHeaderSize: LIMITS.REQUEST_HEADERS_MAX_BYTES}`) is passed as `http` on the plain path and spread into `https` with `key`, `cert` and `minVersion: 'TLSv1.2'` on the TLS path, and an unreadable key or certificate file exits 2 naming the path.

*The rows.* The static-header rows are the Claude Code CLI (≥ 2.1.232, with `MCP_SDK_GENERATION` `v1` and `v2`), `mcp-remote@0.13.5`, the `iridium-mcp` bridge downloaded from `/desktop/tools/iridium-mcp-latest.mjs`, the SDK client and `curl` against `/api/v1`. Each drives the snippet the server renders for it, with exactly the client UI's substitutions (`{{IRIDIUM_MCP_TOKEN}}`, `<bridge-path>`) and, for a static-header row, only its origin changed to that of its own TLS recording listener. The OAuth rows are `claude mcp login` (`--no-browser` under `script(1)`, the redirect pasted back) and `mcp-remote` in OAuth mode, both through a headless sign-in shim that always signs in through `POST /auth/sessions` and never drives a page; the scripted `dynamic` client against the matrix container; and the scripted `cimd` client, which runs in process through `buildApp`'s `cimdTransport` (D06-44), outside the coexistence container, until its production row, backed by a publicly hosted client metadata document, joins at M8. The model-visible tool-list check belongs to a Claude Code model-driven row due at M8; at M3 it is proven indirectly — `claude mcp list` reports Connected and no discovery request reached the row's listener — and the S9 note says so. VS Code, Cursor, Windsurf, Claude Desktop (through the bridge and through `mcp-remote`) and the claude.ai Request-headers beta are `versions.json` rows with driver `manual`, due at M4; they are observed in `docs/acceptance/mcp-gui-clients.md` before M4 exit and again against the M8 release candidate, and each observed row records the Iridium version it was made against. S15 keeps the OAuth half. Rows that need an unprovisioned prerequisite — `ANTHROPIC_API_KEY`, a staging origin running the release-candidate digest, a hosted client metadata document — are named skips due at M8, never passes. `messages-api` calls the Messages API with the runtime's `fetch` and never adds `@anthropic-ai/sdk` to the workspace.

*The gate.* `nightly.yml › mcp-clients` is advisory from M3 to M7 (D12-21) and a gate at M8: every nightly row green with no skip against one release-candidate digest, locally or on its staging deployment, whose served commit and build id must equal the image's. Before a staging row runs, the job reads staging's `GET /healthz` and fails unless its version, commit and build equal the image's labels (`org.opencontainers.image.revision`, `io.iridium.build-id`) and the values `iridium version --json` prints from that image, with neither commit nor build `unknown`; the `workflow_dispatch` digest input is recorded as a label and is never the proof. At M8 every manual and spike row carries its executed fallback or an observation in the M8 section of `docs/acceptance/mcp-gui-clients.md` whose Iridium version is at or above `0.8.0`, a floor derived from the tag scheme (D12-1) and never from the moving root version; none may remain not yet observed. A failing client takes S9's fallback within the milestone that observes it: its row becomes `fallback` with the reason and its snippet is rewritten or withdrawn, and the discovery split never changes. `guards.mcp-client-versions.guard` keeps `versions.json` enforceable.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Plain-HTTP container rows | A client that reaches the server over HTTP is not configured as a user's client is; every row connects over HTTPS as a user's would. |
| A harness TLS terminator | Would prove the harness's TLS rather than the product's in-process profile, whose missing `node:http` options this decision fixes. |
| Disabling certificate verification | Proves a configuration no user may run. |
| GUI automation in CI | Drives vendor interfaces the project does not control; the GUI record observes them by hand, with exact versions, twice before 1.0. |
| Omitting GUI clients | Leaves the clients the documentation configures unobserved before 1.0. |
| Merging the GUI rows into S15 | S15 is the OAuth half; the static-header GUI observations are S9's. |
| A blocking job at M3 | Several rows wait on prerequisites provisioned only before M8; the job becomes a gate there. |
| An SDK-based Messages API row | `@anthropic-ai/sdk` would enter the workspace and the lockfile, which `guards.non-goals.guard`'s built-in-AI-features case refuses. |
| A UI-driven sign-in shim | Would make a nightly row depend on the M4 screens and on G13's answer. |
| A native pty dependency | `script(1)` on the Ubuntu runner provides the terminal `claude mcp login --no-browser` needs. |
| Comparing observations with the root `package.json` version | A post-1.0 version commit would turn `ci.yml › static` red although no observation changed, and a later re-observation against a newer version must still pass. |

## Consequences

Positive: every headless client the documentation configures is exercised nightly over the TLS a user runs, with each request attributed to the client that sent it; the product's own TLS listener is fixed and proven at M3; GUI evidence becomes a versioned, checkable record instead of an unaccountable lane. Negative: GUI clients are observed by hand, before M4 exit and again at M8, rather than nightly; three rows depend on prerequisites the owner provisions before M8 (`12-milestones.md` §12.7), and until then they are named skips that fail the M8 gate.

## Verification

`ops.tls-profile.integration` (the TLS profile at M3, in process and in container mode); `clients.static-header.mcp`, `clients.oauth.mcp` and `clients.coexistence.mcp` (nightly, advisory until M8); `guards.mcp-client-versions.guard` and `guards.nightly-policy.guard`; the S9 note; `docs/acceptance/mcp-gui-clients.md` before M4 exit and at M8.

## References

Owner's answer to open question G10, 2026-09-24 (`14-risks-and-open-questions.md` §G); AG1, A32, A48, A52, D12-1, D12-11 and D12-21. Implemented in `06-mcp-and-agent-access.md`, `09-api-reference.md`, `10-testing-and-quality.md`, `11-operations-and-deployment.md`, `12-milestones.md`, `14-risks-and-open-questions.md` and `15-requirements-traceability.md`.

---

Source: docs/plan/13-decision-log.md, decision AG10. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
