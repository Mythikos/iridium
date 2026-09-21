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

  // ---- MCP and integration tokens --------------------------------------------------------
  /** Burst budget per token per minute on `/mcp`. */
  MCP_TOKEN_BURST_PER_MINUTE: 120,
  /** Sustained budget per token per hour. Env `MCP_RATE_LIMIT_PER_HOUR` (the default only). */
  MCP_TOKEN_PER_HOUR: 3_000,
  /** Points a `search_notes` (and a REST search) call costs. */
  MCP_SEARCH_COST: 3,
  /** Process ceiling on `/mcp`, across all tokens, per minute. */
  MCP_PROCESS_PER_MINUTE: 600,
  /** Characters of note text returned by `get_note` and the note resource, per call. */
  MCP_GET_NOTE_MAX_CHARS: 100_000,
  /** `resource_link` content blocks emitted per tool result (D06-04). */
  MCP_MAX_RESOURCE_LINKS: 50,
  /** Entries in the `iridium://vault/<id>` index resource (D06-04). */
  MCP_VAULT_INDEX_MAX_ENTRIES: 2_000,
  /** Vault ids in a token allowlist or an OAuth consent (D06-04). */
  PAT_MAX_ALLOWLIST_VAULTS: 200,
  /** Lower bound of `access_tokens.rate_limit_per_hour` and `pat_policy` (D06-04). */
  PAT_RATE_LIMIT_PER_HOUR_MIN: 60,
  /** Upper bound of `access_tokens.rate_limit_per_hour` and `pat_policy` (D06-04). */
  PAT_RATE_LIMIT_PER_HOUR_MAX: 100_000,
  /** Characters of `vaults.ai_guidance` (D06-04). */
  AI_GUIDANCE_MAX_CHARS: 4_000,
  /** Note ids recorded on one `access_log` row before `note_ids_truncated` is set. */
  ACCESS_LOG_MAX_NOTE_IDS: 2_000,

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
  /** Dynamic client registrations per IP per hour. */
  OAUTH_DCR_PER_IP_PER_HOUR: 10,
  /** Registered clients that never completed an authorization. */
  OAUTH_MAX_UNUSED_CLIENTS: 1_000,
  /** Days before an unused client is swept. */
  OAUTH_UNUSED_CLIENT_TTL_DAYS: 7,
  /** Redirect URIs per client. */
  OAUTH_MAX_REDIRECT_URIS: 8,
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
