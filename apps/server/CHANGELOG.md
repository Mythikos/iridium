# @iridium/server

## 0.2.0

### Minor Changes

- [migration] [long-running] [api] Complete the headless content model: structural tree operations, trash and purge fencing, revisions and collaborative restore, source-preserving Markdown projection and sanitized preview, indexed links and search, attachments, and resumable maintenance jobs. The additive REST surface contains 62 operations and preserves the v0.1.0 wire contract.

  Before starting the new server, stop serving writes, inspect `iridium migrate status`, and run `iridium migrate up --allow-long-running` in a maintenance window. Migrations 0056–0059 widen raw frontmatter storage, replace unused historical metadata indexes with bounded term memberships, apply grants, and backfill those memberships. Boot leaves these migrations pending until explicitly authorized. Keep a verified backup; production schema rollback uses restore.

  The Markdown pipeline advances from version 1 to 2. Run `iridium reindex --stale` to publish existing notes through the complete pipeline and populate search and link data; interrupted reindex jobs resume from their committed cursor. [config] `REINDEX_RATE_PER_SECOND` controls the rebuild rate while normal collaboration remains available. The markdown-it token parser and typed adapter replace remark parsing after the measured S11 browser budget failure, preserving canonical source bytes and the sanitize-last policy.

### Patch Changes

- @iridium/contracts@0.2.0
  - @iridium/crdt@0.2.0
  - @iridium/markdown@0.2.0

## 0.1.0

The runtime image applies Debian security updates, removes unused package-manager tooling, and retains signed MySQL client metadata and licenses for an accurate SBOM. The release vulnerability threshold is unchanged.

### Minor Changes

- 2915519: Add the M1 headless kernel: authenticated sessions, password setup and reset, scoped tokens, vault membership, note APIs, live permission changes, and an audited operator CLI. Collaborative edits converge through the shared client and reach Saved only after MySQL commits and the acknowledgement covers both insertion clocks and deleted ranges. The pre-release v1 acknowledgement requires its `ds` witness, so server and clients ship together. Persistence includes restart recovery, bounded queues, compaction, and a single serving owner per database.

  Bound document CLOSE handshakes and grace retries so pending edits can recover after a missing reply. Preserve content U+FEFF characters after the encoding BOM is removed, and destroy refused document loads so their awareness timers cannot prevent clean shutdown.

  Reject unknown initial vault members with a transactional 404 and accept both single and repeated user-status query filters.

  Enforce a reattached note's persistence latches before its first queued sync frame, including while participant identity lookup is still pending. Invalid and oversized notes stay read-only across role changes and reauthentication.

  Build the server image for AMD64 and ARM64 with the same signed, hash-pinned MySQL 9.7.2 client tools. Embed the source commit in the image and CLI, with release verification against the tagged commit.

  [migration] Apply forward migrations 0049–0055 with `iridium migrate up`. The administrator mutex serializes user creation and last-administrator checks, and durable session-revocation commands execute in the serving owner, and an ownership-generation fence prevents a replaced owner from committing stale collaboration transactions; migration 0054 records actual per-table grant application or skip provenance, and 0055 seeds the client-version floor without lowering an existing operator value. Existing audit and note history is retained.

  [config] Readiness now checks the active audit key, collaboration ownership, writer backlog, and database durability. Keep the configured password pepper and audit keys available, and run `iridium config check` and `iridium doctor` before serving traffic. A configured `WS_MAX_PAYLOAD_BYTES` must be positive. `DB_QUERY_TIMEOUT_MS` bounds serving-pool acquisition and SQL commands (default 10 seconds, minimum 3 seconds to include the InnoDB timeout sweep and response margin); serving row and metadata lock waits use the whole-second floor of half that budget, and timed-out connections are destroyed and ambiguous COMMIT outcomes are resolved through durable replay.

### Patch Changes

- Updated dependencies [2915519]
  - @iridium/contracts@0.1.0
  - @iridium/crdt@0.1.0
  - @iridium/markdown@0.1.0
