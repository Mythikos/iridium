# Iridium Development Plan

Plan of record, 2026-09-11. Status: proposed, awaiting approval before implementation begins.

Iridium is an internal documentation platform that merges three things: the vault-and-markdown workflow people know from Obsidian, the simultaneous multi-author editing people expect from Google Docs, and first-class access for AI agents over the Model Context Protocol. A centrally administered server owns the vaults, the accounts and the permissions. Employees read and edit ordinary Markdown in a workspace that runs identically in a browser and in a hardened desktop application. Agents enumerate, read and search the same content through scoped tokens that a user grants and can revoke at any moment.

The source wishlist is `docs/spec/collaborative-markdown-vault-feature-spec.md`. This plan implements it, deviates from it in fifteen places that are each listed and justified, and keeps every one of its deferrals deferred.

## The architecture in one paragraph

One Node 24 process built on Fastify 5 owns all input and output: the REST API under `/api/v1`, the collaboration WebSocket at `/collab` (Hocuspocus 4.7.0 embedded as a library, not a sidecar), the MCP endpoint at `/mcp` (official SDK v2, stateless), the attachment routes, the background jobs and the `iridium` command-line tool. MySQL 9.7 is the system of record for accounts, memberships, the category tree, note metadata, the authoritative Yjs document state, an append-only update log, revision checkpoints, the hash-chained audit log, integration tokens and rebuildable projections. Clients never touch the database or the storage volume. One React codebase serves both the browser host and the Electron 44.3.0 shell through a single platform seam, so there is one UI to build and one UI to test. A reverse proxy terminates TLS.

## The decisions that shape everything else

- **Saved means committed.** A note is "Saved" only when a MySQL transaction containing that user's edits has committed and the server has broadcast a state vector that covers the client's entire local state. Connectivity and server memory are never enough. This is enforced by a per-note writer queue with a compare-and-swap on the note's head sequence, and proven by a test that kills the process immediately after the acknowledgement.
- **One authorization core.** A single `authorize()` function over a single `Principal` union serves REST, the WebSocket and MCP alike. Knowing an identifier grants nothing: non-members receive 404 for every vault-scoped resource. Revoking a role or a membership reaches already-open sessions through version epochs and an in-process bus, not just the next login.
- **Agents read committed content, never live CRDT state.** A shared read core returns Markdown at a named revision, so an agent and a person always see a coherent document. Tokens carry explicit scopes intersected with the owner's live role, a vault allowlist, a mandatory expiry, per-token rate limits and a per-call access log that records which notes were read.
- **The Yjs state is authoritative and is never rebuilt from Markdown.** A document is initialized once, then loaded from its persisted binary state. Markdown is the readable text inside that state, plus rebuildable projections for search, outline and links.
- **Markdown source is preserved byte for byte.** Line endings and byte-order marks are normalized once at import and restored on export from recorded metadata, because the editor and the CRDT disagree about `\r\n`. Obsidian-specific syntax is detected, reported and indexed, never silently reinterpreted.
- **Rendered notes are untrusted content.** Sanitization happens on the parsed tree as the single security boundary, parsing runs in workers under hard caps, and the desktop shell exposes no Node capability to note content.
- **Everything has a limit.** One limits table governs payloads, document sizes, queue depths, rate limits and the loaded-document budget; the server refuses work past the budget rather than degrading silently.

## Milestone sequence

Ordering only. Each milestone exits when its named automated tests pass, and no milestone carries a time or effort estimate.

| # | Milestone | Exit means |
|---|---|---|
| M0 | Repository bootstrap, harnesses, spikes | An empty repository becomes a working monorepo with pinned toolchain, CI lanes, a development stack and ten closed spikes. |
| M1 | The kernel, headless | The spec's own first milestone is proven without any UI: one authenticated note, two editors, one viewer, MySQL persistence, a server restart, plus live revocation and truthful save acknowledgement under a kill test. |
| M2 | Structure, lifecycle, revisions, projections, search | The complete tree, trash, revisions, projections and vault-scoped search exist and enforce structural concurrency. |
| M3 | MCP and agent access | Six read-only tools, two resource shapes, the token lifecycle, the stdio bridge and the per-call audit trail work against real clients. |
| M4 | Shared UI and web host | The workspace runs in the browser: tree, tabs, editor, preview, presence, search, history and status states. |
| M5 | Electron desktop shell | The same bundle runs hardened in Electron on Windows, macOS and Linux with signed installers and a server-hosted update feed. |
| M6 | Import, export, attachments | A Markdown directory or ZIP becomes a vault with a full findings report, and a vault exports back to ordinary files with a manifest. |
| M7 | Admin console and enterprise surface | Every administrative action is authorized, step-up protected and audited through the UI. |
| M8 | Operations hardening and release readiness | A clean virtual machine restores from the documented backup set, passes the drill and produces a 1.0 release. |

## Open questions for you

Each has a default already encoded in the plan, so work can begin without an answer. Answering differently changes scope at the milestone named in `14-risks-and-open-questions.md`.

| # | Question | Default in this plan |
|---|---|---|
| G1 | Must claude.ai and Claude Desktop custom connectors work natively at launch, rather than through the bundled bridge? | No. Static token headers for Claude Code, IDEs and the API; the bridge for stdio-only clients; an OAuth authorization server is the first post-launch epic. |
| G2 | Should Obsidian syntax render read-only at launch? | No. Detect, report and index now; rendering ships behind a per-vault flag afterwards. |
| G3 | Is MySQL 8.4 a required target alongside 9.7? | Yes, as a nightly compatibility lane. |
| G4 | Application-level attachment encryption, or volume and database encryption only? | Volume and database encryption, with schema columns reserved. |
| G5 | CJK search at launch? | No. Default parser with a two-character minimum token. |
| G6 | Firefox and WebKit as supported targets at 1.0? | No. Chromium-class browsers supported, others best-effort. |
| G7 | Publish the MCP bridge to the public npm registry? | No. Bundled with the desktop app and downloadable from the server. |
| G8 | Windows installer formats, managed-fleet update policy, and who owns the signing identities? | Per-machine installer plus MSI, prompted updates, identities to be provisioned before the first external desktop build. |

## Reading guide

| File | What it answers | Read it if you are |
|---|---|---|
| `01-vision-scope-and-principles.md` | What Iridium is, who uses it, what each object means, what is in and out of scope, the fifteen deviations, the glossary | Everyone, first |
| `02-system-architecture.md` | How the pieces fit, what runs where, the monorepo layout and package boundaries, configuration, the limits table | Anyone writing code |
| `03-data-model.md` | Every table, column, index, invariant and migration, in order | Anyone touching the database |
| `04-auth-and-access-control.md` | Accounts, sessions, the permission matrix, enforcement points, live revocation, the threat model | Anyone touching a route or a socket |
| `05-collaboration-and-durability.md` | The collaboration kernel, the writer, the exact Saved protocol, compaction, restore, recovery | Anyone touching note content |
| `06-mcp-and-agent-access.md` | The token product, the MCP surface, the read core, the bridge, agent-facing limits | Anyone building agent access |
| `07-client-applications.md` | The shared UI, the editor, the browser host, the Electron shell and its hardening | Anyone building the client |
| `08-markdown-pipeline-import-export.md` | Parsing, sanitizing, projections, normalization, Obsidian detection, import, export, attachments | Anyone touching Markdown or files |
| `09-api-reference.md` | Every endpoint, message, tool and IPC channel, with shapes and error codes | Anyone integrating with the server |
| `10-testing-and-quality.md` | The test pyramid, the harnesses, the named tests behind every acceptance row, the CI lanes | Everyone, before writing tests |
| `11-operations-and-deployment.md` | Deployment, configuration, secrets, observability, backup and restore, upgrades, the CLI, runbooks | Whoever operates the server |
| `12-milestones.md` | What each milestone contains and the tests that close it | Everyone, when planning work |
| `13-decision-log.md` | Fifty-eight architecture decisions with alternatives, consequences and verification, plus an index of the plan's section-level decisions | Anyone questioning a choice |
| `14-risks-and-open-questions.md` | Sixty-two tracked risks, the open questions above, the spikes, the assumptions | Whoever owns delivery risk |
| `15-requirements-traceability.md` | Every requirement in the brief and the spec, where the plan covers it, which test proves it, which milestone retires it | Whoever signs off |
