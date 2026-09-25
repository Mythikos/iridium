/**
 * The single limits policy (02-system-architecture.md, "The single limits policy"; ARCH-16,
 * D01-12). Every numeric limit in Iridium is a member of `LIMITS` and is named exactly as the
 * policy table's "Constant in `limits.ts`" column names it — that column is the sole naming
 * authority, because `limits.policy.unit` and `limits.single-source.guard` compare identifiers
 * rather than values. Environment variables are never constant names: `MAX_UPLOAD_BYTES`
 * overrides `UPLOAD_MAX_BYTES`, `COLLAB_MAX_LOADED_DOCS` overrides `LOADED_DOCS_MAX`, and the
 * `NOTE_*` and `MARKDOWN_*` caps have no environment form at all.
 *
 * Adding a limit means adding a member to this policy and an enforcement site. Browser-required
 * Markdown values live once in markdown-limits.ts and are aggregated here without duplication.
 */

/** One rung of the preview debounce ladder: `[sourceBytesAtMost, debounceMs]`. */
export type PreviewDebounceTier = readonly [sourceBytesAtMost: number, debounceMs: number];

import { MARKDOWN_LIMITS } from './markdown-limits.ts';

const OTHER_LIMITS = {
  // ---- WebSocket transport (02 policy; 09-api-reference.md section 3.10) ------------------
  /** `@fastify/websocket` `maxPayload`; a larger frame is closed by `ws` with 1009. 2 MiB. */
  WS_MAX_PAYLOAD_BYTES: 2_097_152,
  /** A single Yjs update, checked in `beforeHandleMessage`; close `too-large`. 1 MiB. */
  YJS_UPDATE_MAX_BYTES: 1_048_576,
  /**
   * UTF-8 bytes per chunk of `insertChunked()` (`packages/crdt/src/insert-chunked.ts`), the only
   * way first-party code inserts a large string into a `Y.Text`. 256 KiB, which is what makes
   * `YJS_UPDATE_MAX_BYTES` unreachable rather than merely enforced (D05-16).
   */
  INSERT_CHUNK_MAX_BYTES: 262_144,
  /** Yjs messages per connection per `YJS_MESSAGE_WINDOW_MS`; close `rate-limited`. */
  YJS_MESSAGES_PER_WINDOW: 200,
  /** The sliding window `YJS_MESSAGES_PER_WINDOW` is counted over. */
  YJS_MESSAGE_WINDOW_MS: 10_000,
  /** Awareness messages per connection per second; excess is dropped, never closed. */
  AWARENESS_MESSAGES_PER_SECOND: 10,
  /** Distinct one-second awareness windows per socket; excess new names are dropped. */
  AWARENESS_DOCUMENTS_PER_SOCKET: 100,
  /** Optional Hocuspocus routing session suffix; ASCII identifier characters, never another NUL. */
  COLLAB_SESSION_ID_MAX_CHARS: 64,
  /** Client to server stateless payload cap; the handler closes with `protocol-error`. 4 KiB. */
  STATELESS_PAYLOAD_MAX_BYTES: 4_096,
  /** `flush` (Ctrl/Cmd+S) budget per connection per minute; excess is answered `projected`. */
  FLUSH_PER_MINUTE: 6,

  // ---- Connections and admission ---------------------------------------------------------
  /** Document connections per user (one per open note plus one per open vault channel). */
  CONNECTIONS_PER_USER: 20,
  /** Sockets per IP, refused at the upgrade with `429 rate_limited`. */
  CONNECTIONS_PER_IP: 50,
  /** Sockets per process, refused at the upgrade with `429 rate_limited`. */
  CONNECTIONS_PER_PROCESS: 5_000,
  /** Loaded-document admission budget; close `capacity`. Env `COLLAB_MAX_LOADED_DOCS`. */
  LOADED_DOCS_MAX: 2_000,
  /** Loaded-state byte budget; close `capacity`. 1 GiB. Env `COLLAB_MAX_STATE_BYTES_TOTAL`. */
  LOADED_STATE_BYTES_MAX: 1_073_741_824,

  // ---- Note size and snapshots -----------------------------------------------------------
  /** Soft note cap in UTF-16 units: client paste guard, compactor flags `notes.oversize`. */
  NOTE_SOFT_MAX_UTF16: 1_000_000,
  /** A V2 snapshot above this size alerts and latches `notes.oversize`. 8 MB. */
  SNAPSHOT_ALERT_BYTES: 8_000_000,
  /** A V2 snapshot above this size is refused (the blob only, D05-14). 64 MB. */
  SNAPSHOT_REFUSE_BYTES: 64_000_000,

  // ---- Persistence writer ----------------------------------------------------------------
  /** Writer queue depth before backpressure (`persist-failed {reason:'backpressure'}`). */
  WRITER_QUEUE_MAX_UPDATES: 5_000,
  /** Writer queue bytes before backpressure. 32 MiB. */
  WRITER_QUEUE_MAX_BYTES: 33_554_432,
  /** Updates coalesced into one writer transaction (05, "Coalescing"). */
  WRITER_BATCH_MAX_UPDATES: 512,
  /** Raw update bytes coalesced into one writer transaction. 8 MiB. */
  WRITER_BATCH_MAX_RAW_BYTES: 8_388_608,
  /** Compaction debounce. Env `COLLAB_DEBOUNCE_MS`. */
  COMPACTION_DEBOUNCE_MS: 2_000,
  /** Compaction maximum debounce. Env `COLLAB_MAX_DEBOUNCE_MS`. */
  COMPACTION_MAX_DEBOUNCE_MS: 10_000,
  /**
   * How long `enqueueCompaction`/`compactNow` await the note's FIFO before rejecting with
   * `CompactionTimeout` (05, "Compaction"; D05-20). The integration project overrides it to 1 s
   * through the `limits` boot option, the chaos project keeps the production value.
   */
  COMPACTION_AWAIT_TIMEOUT_MS: 15_000,
  /** Retention of `note_updates` rows at or below `snapshot_through_seq`. */
  UPDATE_LOG_RETENTION_DAYS: 7,
  /** Default for `vaults.auto_checkpoint_interval_min`. */
  CHECKPOINT_MIN_INTERVAL_MIN: 10,

  // ---- Collaboration tickets and re-validation -------------------------------------------
  /** Collaboration ticket time to live, in seconds; single use. */
  TICKET_TTL_S: 60,
  /** Tickets per `POST /auth/collab-tickets` request. */
  TICKET_BATCH_MAX: 50,
  /** Ticket issuance budget per session per minute. */
  TICKETS_PER_MINUTE_PER_SESSION: 300,
  /** Ticket issuance budget per IP per minute. */
  TICKETS_PER_MINUTE_PER_IP: 1_000,
  /** `onTokenSync` re-validation interval. 15 min. */
  TOKEN_REVALIDATION_MS: 900_000,
  /** Jitter applied to `TOKEN_REVALIDATION_MS`. 3 min. */
  TOKEN_REVALIDATION_JITTER_MS: 180_000,
  /** Grace period for an unanswered `requestToken()` before close `unauthorized`. 5 min. */
  TOKEN_REVALIDATION_GRACE_MS: 300_000,

  // ---- REST and login hardening ----------------------------------------------------------
  /** Authenticated REST budget per principal per minute. */
  REST_AUTHENTICATED_PER_MINUTE: 600,
  /** Unauthenticated REST budget per IP per minute. */
  REST_UNAUTHENTICATED_PER_MINUTE: 60,
  /** Retained keys per REST limiter, including each independent per-route override. */
  REST_RATE_LIMIT_CACHE_MAX_ENTRIES: 5_000,
  /**
   * Accepted length of the opaque keyset `cursor` query parameter, in characters
   * (09-api-reference.md section 1.6). One bound for every listing, because there is one cursor
   * format: a signed payload whose size is set by the longest after-key any listing emits, not by
   * the route that happens to carry it. A longer string is refused by schema validation before the
   * signature is verified, which keeps an unbounded query string away from the HMAC path.
   */
  CURSOR_MAX_CHARS: 4_096,
  /**
   * How long a page cursor stays valid from issue, on every paginated REST route and MCP tool: one
   * member shared with the cursor codec (A35; D06-48). 1 h.
   */
  CURSOR_TTL_SECONDS: 3_600,
  /**
   * UTF-8 bytes of a path-led keyset's path, measured as its JSON-string encoding, that a cursor
   * carries literally; a longer path travels as a head cut to this budget, the anchor id and a
   * digest of the full path, which keeps every issued cursor within `CURSOR_MAX_CHARS` (A35 as
   * amended 2026-09-25).
   */
  CURSOR_PATH_HEAD_MAX_BYTES: 1_024,
  /** `POST /auth/sessions` budget per IP per minute. */
  LOGIN_PER_MINUTE_PER_IP: 10,
  /** Consecutive failures per `email_key|ip` before a block. */
  LOGIN_FAILURES_PER_ACCOUNT_SOURCE: 5,
  /** First block length, doubling per block. 900 s. */
  LOGIN_BLOCK_BASE_SECONDS: 900,
  /** Block ceiling. 86 400 s. */
  LOGIN_BLOCK_MAX_SECONDS: 86_400,
  /** Login failures per IP per day. */
  LOGIN_FAILURES_PER_IP_PER_DAY: 100,
  /**
   * Live sessions per user per kind (`web`, `desktop`); `SessionIssuer.issue()` revokes the oldest by
   * `last_seen_at` with `revoked_reason='replaced'` (04, D04-01).
   */
  SESSIONS_PER_USER_PER_KIND: 20,

  // ---- Lists REST and MCP share (09-api-reference.md section 1.6; D06-04; D06-48) --------
  /**
   * Rows in a bounded `{items}` response, which carries no cursor: `GET /vaults` and the other
   * un-paginated lists, and the index resources of an `all_vaults` token.
   */
  BOUNDED_LIST_MAX: 1_000,
  /** The `limit` ceiling of the paginated list queries, the activity readers and `list_notes`. */
  LIST_PAGE_MAX: 500,
  /** The `limit` those list queries and `list_notes` use when the request names none. */
  LIST_PAGE_DEFAULT: 200,

  // ---- MCP and integration tokens --------------------------------------------------------
  /**
   * Burst layer of the per-credential budget (a PAT or an OAuth grant): 1 point per request
   * whatever the weight, consumed before the hourly layer on both MCP mounts and the ★ REST reads
   * (D04-37). Env `MCP_RATE_LIMIT_BURST_PER_MIN`.
   */
  MCP_TOKEN_BURST_PER_MINUTE: 120,
  /**
   * Hourly points of a credential whose row names no capacity: the default of both per-kind
   * baselines `PAT_DEFAULT_RATE_LIMIT_PER_HOUR` and `OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR` (D03-28;
   * D04-37).
   */
  MCP_TOKEN_PER_HOUR: 3_000,
  /**
   * Hourly points `search_notes`, `search.vault` and `search.all` cost, decided only by `weightOf`
   * in `auth/tokens/budget.ts` (D04-37).
   */
  MCP_SEARCH_COST: 3,
  /**
   * Requests per minute across all credentials, one ceiling shared by `/mcp` and `/mcp/connect`
   * (D04-37). Env `MCP_PROCESS_CEILING_PER_MIN`.
   */
  MCP_PROCESS_PER_MINUTE: 600,
  /**
   * UTF-8 bytes of a presented bearer credential, checked before it is parsed on every mount the
   * one verifier serves (`/mcp`, `/mcp/connect` and the ★ REST reads): a longer one is the mount's
   * one `401` with no database read (06-mcp-and-agent-access.md, the verifier's step 1; D06-48).
   */
  BEARER_MAX_BYTES: 128,
  /**
   * Failed bearer verifications per IP per minute on the two MCP mounts, a count of failures
   * rather than of requests: once spent, `mcpIpGate` answers `429` before any `access_tokens` read
   * (D06-48).
   */
  MCP_AUTH_FAILURES_PER_IP_PER_MINUTE: 60,
  /**
   * The server-side deadline of one MCP exchange, armed on the injected `Clock` and read in band
   * through `extra.deadline` (D06-04 as amended; D06-48). 30 s. Env `MCP_REQUEST_TIMEOUT_MS`.
   */
  MCP_REQUEST_DEADLINE_MS: 30_000,
  /**
   * The writer grace after `MCP_REQUEST_DEADLINE_MS`: the exchange backstop answers
   * `504 deadline_exceeded` when nothing answered, and the drain disconnects a peer that stopped
   * reading, this much later (D06-48). 2 s; no environment form.
   */
  MCP_DEADLINE_GRACE_MS: 2_000,
  /**
   * UTF-16 units of committed Markdown one `get_note` call or note-resource read returns: whole
   * lines, a grapheme cut only when the first selected line alone exceeds it; trailer lines never
   * count (D06-04; D06-39).
   */
  MCP_GET_NOTE_MAX_CHARS: 100_000,
  /**
   * Characters of `get_note`'s `heading` argument; a longer one is the SDK's input-validation
   * `isError` (D06-09 as amended; D06-48).
   */
  MCP_GET_NOTE_HEADING_MAX_CHARS: 512,
  /**
   * Headings the `get_note` heading-not-found answer lists, in document order (D06-09 as amended;
   * D06-48).
   */
  MCP_HEADING_LIST_MAX: 50,
  /**
   * Characters of each heading that answer lists, cut at a grapheme boundary (D06-09 as amended;
   * D06-48).
   */
  MCP_HEADING_LIST_ITEM_MAX_CHARS: 120,
  /** `resource_link` content blocks emitted per tool result (D06-04). */
  MCP_MAX_RESOURCE_LINKS: 50,
  /** The `limit` ceiling of a `list_vaults` page (D06-38). */
  MCP_LIST_VAULTS_PAGE_MAX: 100,
  /** The `list_vaults` page size when the call names no `limit` (D06-38). */
  MCP_LIST_VAULTS_PAGE_DEFAULT: 50,
  /**
   * Rendered characters of vault descriptions and guidance one `list_vaults` page carries, in both
   * the text block and `structuredContent`; an item that does not fit is flagged as omitted (D06-04
   * as amended).
   */
  MCP_LIST_VAULTS_FREE_TEXT_MAX_CHARS: 12_000,
  /**
   * The text-block ceiling of a maximal `list_vaults` page, every field at its maximum. A derived
   * ceiling: the page and free-text caps imply it, and `mcp.tools.unit` asserts it (D06-04 as
   * amended).
   */
  MCP_LIST_VAULTS_PAGE_TEXT_MAX_CHARS: 50_000,
  /** Entries in the `iridium://vault/<id>` index resource (D06-04). */
  MCP_VAULT_INDEX_MAX_ENTRIES: 2_000,
  /** Recently changed notes the vault index resource lists (D06-04 as amended; D06-48). */
  MCP_VAULT_INDEX_RECENT_NOTES: 50,
  /** Completion values returned per template variable (D06-04 as amended; D06-48). */
  MCP_COMPLETION_MAX: 20,
  /** Open `subscriptions/listen` streams per MCP handler, its `maxSubscriptions` (D06-48). */
  MCP_MAX_SUBSCRIPTIONS: 1_024,
  /** Keep-alive comment cadence on an open listen stream, its `keepAliveMs` (D06-48). 15 s. */
  MCP_KEEPALIVE_MS: 15_000,
  /** UTF-8 bytes of the server `instructions`, each of both variants (D06-48). 2 KiB. */
  MCP_INSTRUCTIONS_MAX_BYTES: 2_048,
  /** UTF-8 bytes of every registered tool description (D06-48). 2 KiB. */
  MCP_TOOL_DESCRIPTION_MAX_BYTES: 2_048,
  /** Vault ids in a token allowlist or an OAuth consent (D06-04). */
  PAT_MAX_ALLOWLIST_VAULTS: 200,
  /**
   * Active PATs one user holds, counted under the owner's `users` row lock; creation beyond it is
   * `422 validation_failed` with `errors[].code` `token_limit_reached`, and a rotation replaces a
   * token rather than adding one (D06-50).
   */
  PAT_MAX_ACTIVE_PER_USER: 100,
  /** The `limit` ceiling of the cursored `GET /me/tokens` and `GET /admin/tokens` (D06-48). */
  TOKEN_LIST_MAX: 200,
  /** The token-list page size when the request names no `limit` (D06-48). */
  TOKEN_LIST_DEFAULT: 50,
  /**
   * Characters of an administrator's free-text reason: `DELETE /admin/tokens/:tokenId` and
   * `POST /admin/tokens/revoke-all` at M3, `DELETE /admin/oauth-consents/:consentId` at M7
   * (D06-48).
   */
  ADMIN_NOTE_MAX_CHARS: 120,
  /** Characters of `vaults.ai_guidance` (D06-04). */
  AI_GUIDANCE_MAX_CHARS: 4_000,

  // ---- Token and OAuth settings bounds (03-data-model.md section 13.1; D03-28) -----------
  /**
   * Floor of every hourly budget: `access_tokens.rate_limit_per_hour`, `patPolicy` and
   * `oauthPolicy` `defaultRateLimitPerHour`, and the baselines `PAT_DEFAULT_RATE_LIMIT_PER_HOUR`
   * and `OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR` (D03-28; D06-04).
   */
  PAT_RATE_LIMIT_PER_HOUR_MIN: 60,
  /**
   * Ceiling of every hourly budget: `access_tokens.rate_limit_per_hour`, `patPolicy` and
   * `oauthPolicy` `defaultRateLimitPerHour`, and the baselines `PAT_DEFAULT_RATE_LIMIT_PER_HOUR`
   * and `OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR` (D03-28; D06-04).
   */
  PAT_RATE_LIMIT_PER_HOUR_MAX: 100_000,
  /**
   * Ceiling of both `patPolicy` lifetime members, their environment baselines
   * (`PAT_DEFAULT_LIFETIME_DAYS`, `PAT_MAX_LIFETIME_DAYS`) and `expiresInDays`. 366 days (D03-28).
   */
  PAT_LIFETIME_DAYS_MAX: 366,
  /** Ceiling of `patPolicy.rotationOverlapMaxHours` and its environment baseline. 24 h. */
  PAT_ROTATION_OVERLAP_HOURS_MAX: 24,
  /** Floor of `oauthPolicy.accessTokenTtlMinutes` and its environment baseline. */
  OAUTH_ACCESS_TOKEN_TTL_MINUTES_MIN: 5,
  /** Ceiling of `oauthPolicy.accessTokenTtlMinutes` and its environment baseline. 24 h. */
  OAUTH_ACCESS_TOKEN_TTL_MINUTES_MAX: 1_440,
  /** Ceiling of both OAuth refresh windows and their environment baselines. 366 days. */
  OAUTH_REFRESH_DAYS_MAX: 366,

  // ---- Audit (04-auth-and-access-control.md D04-16, D04-19 as amended) -------------------
  /**
   * The failure-audit window of `user.login.failed`, `collab.connection.rejected` and
   * `collab.write.rejected`: one chained row per key per window (D04-16 as amended). 60 s.
   */
  AUDIT_DEDUP_SHORT_WINDOW_MS: 60_000,
  /**
   * The failure-audit window of `token.denied`, `mcp.access.denied` and `oauth.authorize.denied`
   * (D04-16 as amended). 10 min.
   */
  AUDIT_DEDUP_LONG_WINDOW_MS: 600_000,
  /** Keys one `FailureAuditGate` holds; a full gate evicts its oldest key (D04-16 as amended). */
  AUDIT_DEDUP_KEYS_MAX: 10_000,
  /**
   * `targets` entries on one chained audit row, so a bulk action is one verifiable event; beyond
   * it the writer sets its reserved `targets_truncated` marker (03-data-model.md section 12.2;
   * D04-19 as amended).
   */
  AUDIT_TARGETS_MAX: 1_000,

  // ---- Access-log writer and last-used tracker (D06-11 as amended; D06-49) ---------------
  /** Note ids recorded on one `access_log` row before `note_ids_truncated` is set. */
  ACCESS_LOG_MAX_NOTE_IDS: 2_000,
  /** The access-log writer flushes at least this often (D06-11 as amended). 2 s. */
  ACCESS_LOG_FLUSH_INTERVAL_MS: 2_000,
  /** Queued rows that trigger an access-log flush before the interval ends (D06-11 as amended). */
  ACCESS_LOG_FLUSH_ROWS: 200,
  /** Rows the access-log queue holds; the oldest are dropped beyond it (D06-11 as amended). */
  ACCESS_LOG_QUEUE_MAX_ROWS: 10_000,
  /**
   * Serialised bytes the access-log queue holds, charged per row as the `INSERT` sends it; the
   * oldest rows are dropped beyond it (D06-11 as amended). 16 MiB.
   */
  ACCESS_LOG_QUEUE_MAX_BYTES: 16_777_216,
  /**
   * `LastUsedTracker` flush cadence, in every process that verifies tokens whatever `JOBS_ENABLED`
   * says (D06-49). 10 min.
   */
  TOKEN_LAST_USED_FLUSH_INTERVAL_MS: 600_000,
  /** Tokens the last-used map holds; a new token observed beyond it is dropped (D06-49). */
  TOKEN_LAST_USED_PENDING_MAX: 10_000,

  // ---- stdio bridge (D06-13 as amended) --------------------------------------------------
  /** How often `iridium-mcp` refreshes its cached tool and resource lists. 5 min. */
  BRIDGE_LIST_REFRESH_MS: 300_000,
  /** The upstream request timeout `--timeout-ms` defaults to. 60 s. */
  BRIDGE_UPSTREAM_TIMEOUT_DEFAULT_MS: 60_000,
  /** The floor `--timeout-ms` accepts. 5 s. */
  BRIDGE_UPSTREAM_TIMEOUT_MIN_MS: 5_000,

  // ---- OAuth 2.1 authorization server ----------------------------------------------------
  /** Authorization code lifetime, single use. */
  OAUTH_CODE_TTL_SECONDS: 60,
  /** Consent request lifetime. */
  OAUTH_CONSENT_REQUEST_TTL_SECONDS: 600,
  /** Pending consent requests held at once. */
  OAUTH_MAX_PENDING_CONSENTS: 1_000,
  /** Client ID metadata document fetch cap. 32 KiB. */
  OAUTH_CIMD_MAX_BYTES: 32_768,
  /** Client ID metadata document fetch timeout. */
  OAUTH_CIMD_TIMEOUT_MS: 5_000,
  /** Client ID metadata document cache lifetime. 24 h. */
  OAUTH_CIMD_CACHE_SECONDS: 86_400,
  /**
   * Client ID metadata document fetches or revalidations per signed-in user per hour, a fixed
   * window on the injected clock (D06-41).
   */
  OAUTH_CIMD_FETCHES_PER_USER_PER_HOUR: 20,
  /** Characters of a presented `client_id`; a CIMD `client_id` is an ASCII `https` URL (D06-41). */
  OAUTH_CLIENT_ID_MAX_CHARS: 512,
  /** Dynamic client registrations per IP per hour. */
  OAUTH_DCR_PER_IP_PER_HOUR: 10,
  /** Registered clients that never completed an authorization. */
  OAUTH_MAX_UNUSED_CLIENTS: 1_000,
  /** Days before an unused client is swept. */
  OAUTH_UNUSED_CLIENT_TTL_DAYS: 7,
  /** Redirect URIs per client. */
  OAUTH_MAX_REDIRECT_URIS: 8,
  /** Characters of one registered or presented redirect URI (D06-47). */
  OAUTH_MAX_REDIRECT_URI_CHARS: 512,
  /** Shortest PKCE `code_verifier`, in unreserved characters (RFC 7636 section 4.1; D06-47). */
  OAUTH_CODE_VERIFIER_MIN: 43,
  /** Longest PKCE `code_verifier`, in unreserved characters (RFC 7636 section 4.1; D06-47). */
  OAUTH_CODE_VERIFIER_MAX: 128,
  /**
   * `POST /oauth/token` and `POST /oauth/revoke` requests per IP per minute, a separate bucket on
   * each route (D06-47).
   */
  OAUTH_TOKEN_ENDPOINT_PER_IP_PER_MINUTE: 60,
  /**
   * `GET /oauth/authorize` requests per session per hour; a request without a session falls back to
   * `REST_UNAUTHENTICATED_PER_MINUTE` per IP (D06-47).
   */
  OAUTH_AUTHORIZE_PER_SESSION_PER_HOUR: 30,

  // ---- Projection, search, revisions and maintenance jobs (M2) ---------------------------
  /** Server projection timeout. Env `PROJECTION_TIMEOUT_MS`. */
  PROJECTION_TIMEOUT_SERVER_MS: 10_000,
  /** Client preview worker timeout. */
  PROJECTION_TIMEOUT_CLIENT_MS: 2_000,
  /**
   * Preview debounce ladder as `[sourceBytesAtMost, debounceMs]` pairs. The last rung's ceiling
   * is `Number.MAX_SAFE_INTEGER` spelled as a literal — `isolatedDeclarations` cannot write the
   * name and a literal `Infinity` loses precision — and it means "every source above the rung
   * before it", which `MARKDOWN_SOURCE_MAX_BYTES` already bounds at 2 MiB.
   */
  PREVIEW_DEBOUNCE: [
    [65_536, 150],
    [524_288, 500],
    [9_007_199_254_740_991, 1_500],
  ],
  /** Matching source lines returned per search hit. */
  SNIPPET_MAX_LINES: 3,
  /** Characters per returned snippet line. */
  SNIPPET_MAX_CHARS: 240,
  SEARCH_QUERY_MAX_CHARS: 512,
  SEARCH_LIMIT_MAX: 100,
  SEARCH_LIMIT_DEFAULT: 20,
  SEARCH_VAULTS_MAX: 50,
  SNIPPET_CHARS_MIN: 80,
  SNIPPET_CHARS_MAX: 1000,
  SNIPPET_CACHE_MAX: 500,
  SNIPPET_CACHE_TTL_MS: 120000,
  REVISION_LIST_MAX: 200,
  REVISION_LIST_DEFAULT: 50,
  REVISION_LABEL_MAX: 200,
  /** Target-side rename warnings report complete counts and at most this many source samples. */
  AFFECTED_LINK_SAMPLE_MAX: 50,
  /** Beyond this retained lookup-entry budget, projections resolve through bounded indexed queries. */
  VAULT_INDEX_MAX_ENTRIES: 100_000,
  OBSIDIAN_SAMPLE_MAX: 20,
  /** Bounded worker admission and per-worker memory (08 section 2.11). */
  PROJECTION_QUEUE_MAX: 1_000,
  REINDEX_RATE_PER_SECOND: 20,
  JOB_LOCK_TIMEOUT_MS: 900000,
  JOB_HEARTBEAT_MS: 30000,
  JOB_MAX_ATTEMPTS: 5,
  JOB_PROGRESS_INTERVAL_MS: 1000,
  JOB_POLL_INTERVAL_MS: 1000,
  JOB_BATCH_SIZE: 100,
  JOB_LIST_MAX: 200,
  JOB_LIST_DEFAULT: 50,
  JOB_REINDEX_NOTE_MAX: 200,
  JOB_ARCHIVE_BATCH_SIZE: 1000,
  JOB_RETENTION_DAYS: 30,
  SESSION_ROW_RETENTION_DAYS: 30,
  ATTACHMENT_TEMP_RETENTION_MS: 3600000,
  REVISION_KEEP_ALL_HOURS: 24,
  REVISION_HOURLY_DAYS: 30,
  /** Maximum revision metadata rows examined before a thinning job yields its durable cursor. */
  REVISION_THINNING_ROWS_PER_RUN: 100,
  PROJECTION_WORKER_HEAP_MB: 512,
  PROJECTION_WORKER_STACK_MB: 8,
  PROJECTION_WORKER_IDLE_MS: 60_000,

  // ---- Transfer --------------------------------------------------------------------------
  /** Attachment upload cap. 50 MiB. Env `MAX_UPLOAD_BYTES`. */
  UPLOAD_MAX_BYTES: 52_428_800,
  /** Signature prefix needed by the S8-pinned MIME detector. */
  ATTACHMENT_SNIFF_BYTES: 4_100,
  /** Attachment storage and upload admission bounds (08 section 9). */
  ATTACHMENT_NAME_MAX_BYTES: 255,
  ATTACHMENT_PATH_MAX_CHARS: 760,
  ATTACHMENT_NAME_COLLISION_ATTEMPTS: 50,
  ATTACHMENT_UPLOAD_CONCURRENCY: 8,
  ATTACHMENT_UPLOADS_PER_MINUTE: 60,
  ATTACHMENT_MULTIPART_THRESHOLD_BYTES: 8_388_608,
  ATTACHMENT_REFERENCE_SAMPLE_MAX: 50,
  ATTACHMENT_DELETE_REFERENCE_SAMPLE_MAX: 20,
  ATTACHMENT_SCAN_BATCH: 100,
  ATTACHMENT_LIST_MAX: 200,
  ATTACHMENT_LIST_DEFAULT: 100,
  /** Import payload cap. 2 GiB. Env `MAX_IMPORT_BYTES`. */
  IMPORT_MAX_BYTES: 2_147_483_648,
  /** Files in one import. */
  IMPORT_MAX_FILES: 50_000,
  /** Directory depth the import scanner accepts; its own copy of `TREE_MAX_DEPTH`. */
  IMPORT_MAX_DEPTH: 64,
  /** Parts per `PUT /imports/:jobId/upload` batch. */
  IMPORT_UPLOAD_BATCH_FILES: 200,
  /** Bytes per `PUT /imports/:jobId/upload` batch. 64 MiB. */
  IMPORT_UPLOAD_BATCH_BYTES: 67_108_864,

  // ---- Tree ------------------------------------------------------------------------------
  /** Maximum node depth below the root row. */
  TREE_MAX_DEPTH: 64,
  /** `nodes.name` length in UTF-8 bytes. */
  NODE_NAME_MAX_BYTES: 255,
  /** A maximum-depth note path, including separators and its .md suffix. */
  NODE_PATH_MAX_CHARS: 16_387,
  /**
   * The request head the parser will read, past which it answers 431 without reaching a route.
   *
   * Node's default is 16 KiB, which is smaller than `NODE_PATH_MAX_CHARS` alone: a maximal
   * `pathPrefix` could never be sent, so the published bound described a request the transport
   * refused. The budget carries the documented query maxima with their percent-encoding
   * expansion and the ordinary cookie and authorization headers beside them.
   */
  REQUEST_HEADERS_MAX_BYTES: 65_536,
  /** Maximum change records in one vault notification. */
  TREE_CHANGES_MAX: 500,
  /** `vaults.name` length in characters. */
  VAULT_NAME_MAX_CHARS: 120,

  // ---- Process ---------------------------------------------------------------------------
  /** Fastify `bodyLimit` for JSON routes. 1 MiB. */
  BODY_MAX_BYTES_JSON: 1_048_576,
  /** Fastify `bodyLimit` on the two MCP mounts. 1 MiB. */
  BODY_MAX_BYTES_MCP: 1_048_576,
  /** Shutdown drain window. Env `SHUTDOWN_DRAIN_MS`. */
  SHUTDOWN_DRAIN_MS: 20_000,
  /**
   * How long before the drain budget ends each close-time write-behind flush stops, covering the
   * idle-connection pool close and the final log flush (ARCH-06 as amended). 1 s.
   */
  SHUTDOWN_FLUSH_MARGIN_MS: 1_000,
} as const;

/** One public policy; each bound is defined once in its owning policy leaf. */
export const LIMITS: typeof MARKDOWN_LIMITS & typeof OTHER_LIMITS = {
  ...MARKDOWN_LIMITS,
  ...OTHER_LIMITS,
};

/** Every member of the single limits policy. `limits.policy.unit` is exhaustive over it. */
export type LimitId = keyof typeof LIMITS;

/**
 * The environment keys that override a limit, and the constant each one overrides. Environment
 * names are never constant names (rule 2 of the policy), so this is the only place the two
 * vocabularies meet; `limits.policy.unit` asserts that no `EnvSchema` key is a `LimitId`.
 */
export const LIMIT_ENV_OVERRIDES = {
  MAX_UPLOAD_BYTES: 'UPLOAD_MAX_BYTES',
  MAX_IMPORT_BYTES: 'IMPORT_MAX_BYTES',
  COLLAB_DEBOUNCE_MS: 'COMPACTION_DEBOUNCE_MS',
  COLLAB_MAX_DEBOUNCE_MS: 'COMPACTION_MAX_DEBOUNCE_MS',
  COLLAB_MAX_LOADED_DOCS: 'LOADED_DOCS_MAX',
  COLLAB_MAX_STATE_BYTES_TOTAL: 'LOADED_STATE_BYTES_MAX',
  COLLAB_MAX_CONNECTIONS_PER_PROCESS: 'CONNECTIONS_PER_PROCESS',
  COLLAB_MAX_CONNECTIONS_PER_USER: 'CONNECTIONS_PER_USER',
  COLLAB_MAX_CONNECTIONS_PER_IP: 'CONNECTIONS_PER_IP',
  MCP_RATE_LIMIT_PER_HOUR: 'MCP_TOKEN_PER_HOUR',
  MCP_RATE_LIMIT_BURST_PER_MIN: 'MCP_TOKEN_BURST_PER_MINUTE',
  MCP_PROCESS_CEILING_PER_MIN: 'MCP_PROCESS_PER_MINUTE',
  MCP_REQUEST_TIMEOUT_MS: 'MCP_REQUEST_DEADLINE_MS',
  PROJECTION_TIMEOUT_MS: 'PROJECTION_TIMEOUT_SERVER_MS',
  REINDEX_RATE_PER_SECOND: 'REINDEX_RATE_PER_SECOND',
  UPDATE_LOG_RETENTION_DAYS: 'UPDATE_LOG_RETENTION_DAYS',
  SHUTDOWN_DRAIN_MS: 'SHUTDOWN_DRAIN_MS',
} as const;

/** An environment key that overrides a limit. */
export type LimitEnvKey = keyof typeof LIMIT_ENV_OVERRIDES;

/**
 * The limits a client must know before it sends a request, published additively at
 * `GET /meta.limits` under these wire names (02, "The single limits policy"; ARCH-16). Wire names
 * and constant names are two deliberately separate vocabularies, so this map is the only place the
 * two meet and `GET /meta` builds its `limits` object from it rather than from eight hand-written
 * field assignments. The first two are also environment-overridable (`LIMIT_ENV_OVERRIDES`), which
 * is why 02's prose singles them out; the other six are published because a client pre-validates
 * against them (09-api-reference.md section 2.2).
 */
export const PUBLISHED_LIMIT_WIRE_NAMES = {
  uploadBytes: 'UPLOAD_MAX_BYTES',
  importBytes: 'IMPORT_MAX_BYTES',
  importFiles: 'IMPORT_MAX_FILES',
  importDepth: 'IMPORT_MAX_DEPTH',
  noteSoftChars: 'NOTE_SOFT_MAX_UTF16',
  noteHardChars: 'NOTE_HARD_MAX_UTF16',
  bodyBytes: 'BODY_MAX_BYTES_JSON',
  wsMaxPayloadBytes: 'WS_MAX_PAYLOAD_BYTES',
} as const;

/** A member of `GET /meta.limits`. */
export type PublishedLimitWireName = keyof typeof PUBLISHED_LIMIT_WIRE_NAMES;

/**
 * The `GET /meta.limits` object. Spelled out rather than folded out of the map above so that no
 * cast is needed to type it; `rest.dtos.unit` asserts that its key set is exactly
 * `PUBLISHED_LIMIT_WIRE_NAMES` and that each value is the constant that map pairs with the name, so
 * the two cannot disagree.
 */
export function publishedLimits(): Readonly<Record<PublishedLimitWireName, number>> {
  return {
    uploadBytes: LIMITS.UPLOAD_MAX_BYTES,
    importBytes: LIMITS.IMPORT_MAX_BYTES,
    importFiles: LIMITS.IMPORT_MAX_FILES,
    importDepth: LIMITS.IMPORT_MAX_DEPTH,
    noteSoftChars: LIMITS.NOTE_SOFT_MAX_UTF16,
    noteHardChars: LIMITS.NOTE_HARD_MAX_UTF16,
    bodyBytes: LIMITS.BODY_MAX_BYTES_JSON,
    wsMaxPayloadBytes: LIMITS.WS_MAX_PAYLOAD_BYTES,
  };
}
