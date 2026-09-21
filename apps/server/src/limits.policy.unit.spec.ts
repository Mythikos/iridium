/**
 * HP-5: an exhaustive limits register, its actual source bindings, and boundary behavior.
 * Future feature limits remain declared but ratchet into this check at their owning milestone.
 * The real-wire suites prove transport/status outcomes; this suite prevents a new or disconnected
 * policy constant from silently having no enforcement owner.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkNodeName,
  CreateCollabTicketsBody,
  CreateNodeBody,
  decodeClientNoteMessage,
  LIMIT_ENV_OVERRIDES,
  LIMITS,
  safePath,
  SessionId,
  UserId,
  VaultName,
  type LimitId,
} from '@iridium/contracts';
import { parseSync, Visitor } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../test/support/manual-clock.ts';
import { blockSeconds, createMemoryLimiters, LoginThrottle } from './auth/credentials/throttle.ts';
import { WindowedBudget } from './auth/tickets/ip-budget.ts';
import { InMemoryTicketStore } from './auth/tickets/store.ts';
import { AdmissionBudget, SocketCaps } from './collab/limits.ts';
import { RateWindow } from './collab/rate.ts';
import { ENV_SCHEMA_KEYS, envShape } from './config/env.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER = 'apps/server/src/';
const CONTRACTS = 'packages/contracts/src/';
type Milestone = 1 | 2 | 3 | 4 | 6;
interface Wiring {
  readonly file: string;
  readonly expression: RegExp;
  readonly property?: string;
}
interface Enforcement {
  readonly since: Milestone;
  readonly owner: string;
  readonly outcome: string;
  readonly wiring: readonly Wiring[];
}
function at(since: Milestone, owner: string, outcome: string, ...wiring: Wiring[]): Enforcement {
  return { since, owner, outcome, wiring };
}
function wire(file: string, expression: RegExp, property?: string): Wiring {
  return { file: SERVER + file, expression, ...(property === undefined ? {} : { property }) };
}
function configured(outcome: string, ...wiring: Wiring[]): Enforcement {
  return at(1, SERVER + 'config/env.ts', outcome, ...wiring);
}

// This is intentionally not generated from LIMITS: adding or renaming a member must select its
// actual owner and outcome. The type check rejects both missing members and invented spellings.
const ENFORCEMENT = {
  WS_MAX_PAYLOAD_BYTES: configured(
    'ws closes 1009',
    wire('collab/server.ts', /maxPayload:\s*limits\.wsMaxPayloadBytes/),
  ),
  YJS_UPDATE_MAX_BYTES: at(1, SERVER + 'collab/hooks/limits.ts', 'too-large'),
  INSERT_CHUNK_MAX_BYTES: at(
    1,
    'packages/crdt/src/insert-chunked.ts',
    'split insertion at UTF-8 boundary',
  ),
  YJS_MESSAGES_PER_WINDOW: at(1, SERVER + 'collab/hooks/limits.ts', 'rate-limited'),
  YJS_MESSAGE_WINDOW_MS: at(1, SERVER + 'collab/hooks/limits.ts', 'window expiry'),
  AWARENESS_MESSAGES_PER_SECOND: at(1, SERVER + 'collab/server.ts', 'drop excess awareness'),
  AWARENESS_DOCUMENTS_PER_SOCKET: at(
    1,
    SERVER + 'collab/server.ts',
    'drop new awareness keys until a fixed window expires',
  ),
  COLLAB_SESSION_ID_MAX_CHARS: at(
    1,
    SERVER + 'collab/server.ts',
    'protocol-error before routing-key retention',
  ),
  STATELESS_PAYLOAD_MAX_BYTES: at(
    1,
    CONTRACTS + 'collab.ts',
    'too_large decoder result; protocol-error close',
  ),
  FLUSH_PER_MINUTE: at(
    1,
    SERVER + 'collab/hooks/persistence.ts',
    'projected reply without another flush',
  ),
  CONNECTIONS_PER_USER: configured(
    'rate-limited',
    wire(
      'collab/hooks/auth.ts',
      /countConnectionsOf\(identity\.principal\.userId\)\s*>=\s*deps\.limits\.maxConnectionsPerUser/,
    ),
  ),
  CONNECTIONS_PER_IP: configured(
    '429 rate_limited',
    wire('collab/limits.ts', /this\.#maxPerIp\s*=\s*limits\.maxConnectionsPerIp/),
  ),
  CONNECTIONS_PER_PROCESS: configured(
    '429 rate_limited',
    wire('collab/limits.ts', /this\.#maxTotal\s*=\s*limits\.maxConnections/),
  ),
  LOADED_DOCS_MAX: configured(
    'capacity; no eviction',
    wire('collab/limits.ts', /this\.#maxDocs\s*=\s*limits\.maxLoadedDocs/),
  ),
  LOADED_STATE_BYTES_MAX: configured(
    'capacity; no eviction',
    wire('collab/limits.ts', /this\.#maxBytes\s*=\s*limits\.maxStateBytesTotal/),
  ),
  NOTE_SOFT_MAX_UTF16: at(1, SERVER + 'collab/persistence/compactor.ts', 'oversize latch'),
  NOTE_HARD_MAX_UTF16: at(1, SERVER + 'notes/service.ts', '422 validation_failed'),
  SNAPSHOT_ALERT_BYTES: at(1, SERVER + 'collab/persistence/compactor.ts', 'oversize latch'),
  SNAPSHOT_REFUSE_BYTES: at(
    1,
    SERVER + 'collab/persistence/compactor.ts',
    'refuse snapshot; preserve log and projection',
  ),
  WRITER_QUEUE_MAX_UPDATES: at(
    1,
    SERVER + 'collab/persistence/writer.ts',
    'read-only backpressure',
  ),
  WRITER_QUEUE_MAX_BYTES: at(1, SERVER + 'collab/persistence/writer.ts', 'read-only backpressure'),
  WRITER_BATCH_MAX_UPDATES: at(1, SERVER + 'collab/persistence/writer.ts', 'split FIFO batch'),
  WRITER_BATCH_MAX_RAW_BYTES: at(1, SERVER + 'collab/persistence/writer.ts', 'split FIFO batch'),
  COMPACTION_DEBOUNCE_MS: configured(
    'schedule compaction',
    wire('collab/server.ts', /debounce:\s*config\.collab\.debounceMs/),
  ),
  COMPACTION_MAX_DEBOUNCE_MS: configured(
    'bound compaction postponement',
    wire('collab/server.ts', /maxDebounce:\s*config\.collab\.maxDebounceMs/),
  ),
  COMPACTION_AWAIT_TIMEOUT_MS: at(
    1,
    SERVER + 'collab/limits.ts',
    'CompactionTimeout; queued work remains',
    wire('collab/persistence/writer.ts', /this\.#clock\.after\(this\.#compactionAwaitTimeoutMs/),
  ),
  UPDATE_LOG_RETENTION_DAYS: configured(
    'prune only strictly old snapshot-covered rows',
    wire(
      'jobs/plugin.ts',
      /pruneUpdates\(\s*appDb\(app\),\s*app\.clock\.date\(\),\s*app\.iridiumConfig\.collab\.updateLogRetentionDays\s*,/,
    ),
  ),
  CHECKPOINT_MIN_INTERVAL_MIN: at(
    1,
    SERVER + 'vaults/service.ts',
    'checkpoint cadence default',
    wire('collab/persistence/compactor.ts', /since\s*>=\s*intervalMs/),
  ),
  TICKET_TTL_S: configured(
    'expired ticket refused',
    wire('auth/plugin.ts', /config\.collab\.ticketTtlSeconds\s*\*\s*MS_PER_SECOND/, 'ttlMs'),
    wire('auth/tickets/store.ts', /this\.#clock\.now\(\)\s*>=\s*entry\.expiresAt/),
  ),
  TICKET_BATCH_MAX: at(
    1,
    CONTRACTS + 'rest/auth.ts',
    '422 validation_failed',
    wire('auth/routes.ts', /body:\s*CreateCollabTicketsBody/),
  ),
  TICKETS_PER_MINUTE_PER_SESSION: at(1, SERVER + 'auth/routes.ts', '429 rate_limited'),
  TICKETS_PER_MINUTE_PER_IP: at(1, SERVER + 'auth/plugin.ts', '429 rate_limited'),
  TOKEN_REVALIDATION_MS: at(1, SERVER + 'collab/hooks/auth.ts', 'request fresh token'),
  TOKEN_REVALIDATION_JITTER_MS: at(1, SERVER + 'collab/hooks/auth.ts', 'spread token revalidation'),
  TOKEN_REVALIDATION_GRACE_MS: at(
    1,
    SERVER + 'collab/hooks/auth.ts',
    'unauthorized after unanswered request',
  ),
  REST_RATE_LIMIT_CACHE_MAX_ENTRIES: at(
    1,
    SERVER + 'security/rate-limit-store.ts',
    'bounded REST counters; evict the least recently used key on new-key admission',
  ),
  REST_AUTHENTICATED_PER_MINUTE: at(1, SERVER + 'security/rate-limits.ts', '429 rate_limited'),
  REST_UNAUTHENTICATED_PER_MINUTE: at(1, SERVER + 'security/rate-limits.ts', '429 rate_limited'),
  LOGIN_PER_MINUTE_PER_IP: at(1, SERVER + 'security/rate-limits.ts', '429 rate_limited'),
  LOGIN_FAILURES_PER_ACCOUNT_SOURCE: configured(
    'account/source block',
    wire('auth/plugin.ts', /maxFailures:\s*config\.auth\.loginThrottleMaxFailures/),
  ),
  LOGIN_BLOCK_BASE_SECONDS: configured(
    'initial block duration',
    wire(
      'auth/plugin.ts',
      /config\.auth\.loginThrottleBlockMinutes\s*\*\s*SECONDS_PER_MINUTE/,
      'blockBaseSeconds',
    ),
  ),
  LOGIN_BLOCK_MAX_SECONDS: at(1, SERVER + 'auth/plugin.ts', 'cap exponential block'),
  LOGIN_FAILURES_PER_IP_PER_DAY: configured(
    'source-wide block',
    wire('auth/plugin.ts', /sourcePerDay:\s*config\.auth\.loginThrottleIpPerDay/),
  ),
  SESSIONS_PER_USER_PER_KIND: at(1, SERVER + 'auth/sessions/issuer.ts', 'replace oldest session'),
  MCP_TOKEN_BURST_PER_MINUTE: at(3, SERVER + 'mcp', '429 token burst'),
  MCP_TOKEN_PER_HOUR: at(3, SERVER + 'mcp', '429 token sustained budget'),
  MCP_SEARCH_COST: at(3, SERVER + 'mcp', 'charge search points'),
  MCP_PROCESS_PER_MINUTE: at(3, SERVER + 'mcp', '429 process ceiling'),
  MCP_GET_NOTE_MAX_CHARS: at(3, SERVER + 'mcp', 'bounded note response'),
  MCP_MAX_RESOURCE_LINKS: at(3, SERVER + 'mcp', 'bounded resource links'),
  MCP_VAULT_INDEX_MAX_ENTRIES: at(3, SERVER + 'mcp', 'bounded vault index'),
  PAT_MAX_ALLOWLIST_VAULTS: at(3, SERVER + 'auth/tokens', '422 validation_failed'),
  PAT_RATE_LIMIT_PER_HOUR_MIN: at(3, SERVER + 'auth/tokens', 'reject below policy floor'),
  PAT_RATE_LIMIT_PER_HOUR_MAX: at(3, SERVER + 'auth/tokens', 'reject above policy ceiling'),
  AI_GUIDANCE_MAX_CHARS: at(1, CONTRACTS + 'settings.ts', '422 validation_failed'),
  ACCESS_LOG_MAX_NOTE_IDS: at(3, SERVER + 'audit', 'truncate logged note ids'),
  OAUTH_CODE_TTL_SECONDS: at(3, SERVER + 'oauth', 'expired code refused'),
  OAUTH_CONSENT_REQUEST_TTL_SECONDS: at(3, SERVER + 'oauth', 'expired consent refused'),
  OAUTH_MAX_PENDING_CONSENTS: at(3, SERVER + 'oauth', 'refuse excess pending consent'),
  OAUTH_CIMD_MAX_BYTES: at(3, SERVER + 'oauth', 'refuse oversized metadata'),
  OAUTH_CIMD_TIMEOUT_MS: at(3, SERVER + 'oauth', 'abort metadata fetch'),
  OAUTH_CIMD_CACHE_SECONDS: at(3, SERVER + 'oauth', 'expire metadata cache'),
  OAUTH_DCR_PER_IP_PER_HOUR: at(3, SERVER + 'oauth', '429 registration budget'),
  OAUTH_MAX_UNUSED_CLIENTS: at(3, SERVER + 'oauth', 'refuse excess unused clients'),
  OAUTH_UNUSED_CLIENT_TTL_DAYS: at(3, SERVER + 'oauth', 'sweep unused clients'),
  OAUTH_MAX_REDIRECT_URIS: at(3, SERVER + 'oauth', 'refuse oversized redirect list'),
  MARKDOWN_SOURCE_MAX_BYTES: at(2, 'packages/markdown/src', 'too_large measured in UTF-8 bytes'),
  MARKDOWN_BLOCKQUOTE_MAX_DEPTH: at(2, 'packages/markdown/src', 'too_complex'),
  MARKDOWN_LIST_INDENT_MAX_COLS: at(2, 'packages/markdown/src', 'too_complex'),
  MARKDOWN_LINES_PER_PARAGRAPH_MAX: at(2, 'packages/markdown/src', 'too_complex'),
  MARKDOWN_FOOTNOTE_REFS_MAX: at(2, 'packages/markdown/src', 'too_complex footnotes'),
  MARKDOWN_BRACKETS_MAX: at(2, 'packages/markdown/src', 'too_complex brackets'),
  PROJECTION_TIMEOUT_SERVER_MS: at(
    2,
    SERVER + 'config/env.ts',
    'timeout projection',
    wire('projection/pool.ts', /timeout/),
  ),
  PROJECTION_TIMEOUT_CLIENT_MS: at(4, 'packages/markdown-react/src', 'timeout preview'),
  PREVIEW_DEBOUNCE: at(4, 'packages/markdown-react/src', 'size-tier preview scheduling'),
  SNIPPET_MAX_LINES: at(2, SERVER + 'search', 'bounded search snippet lines'),
  SNIPPET_MAX_CHARS: at(2, SERVER + 'search', 'bounded search snippet characters'),
  FM_TAG_MAX_LEN: at(2, 'packages/markdown/src', 'bound extracted tags'),
  FM_TAGS_MAX: at(2, 'packages/markdown/src', 'bound extracted tags'),
  FM_ALIAS_MAX_LEN: at(2, 'packages/markdown/src', 'bound extracted aliases'),
  FM_ALIASES_MAX: at(2, 'packages/markdown/src', 'bound extracted aliases'),
  YAML_MAX_ALIAS_COUNT: at(2, 'packages/markdown/src', 'reject excessive YAML alias expansion'),
  LINK_TARGET_MAX_CHARS: at(2, 'packages/markdown/src', 'reject oversized link targets'),
  JOB_LOCK_TIMEOUT_MS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  JOB_HEARTBEAT_MS: at(2, 'apps/server/src/jobs', 'enforce maintenance lifetime and batch policy'),
  JOB_MAX_ATTEMPTS: at(2, 'apps/server/src/jobs', 'enforce maintenance lifetime and batch policy'),
  JOB_PROGRESS_INTERVAL_MS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  JOB_POLL_INTERVAL_MS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  JOB_BATCH_SIZE: at(2, 'apps/server/src/jobs', 'enforce maintenance lifetime and batch policy'),
  JOB_LIST_MAX: at(2, 'packages/contracts/src/rest/jobs.ts', 'bound maintenance job inputs'),
  JOB_LIST_DEFAULT: at(2, 'packages/contracts/src/rest/jobs.ts', 'bound maintenance job inputs'),
  JOB_REINDEX_NOTE_MAX: at(
    2,
    'packages/contracts/src/rest/jobs.ts',
    'bound maintenance job inputs',
  ),
  JOB_ARCHIVE_BATCH_SIZE: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  JOB_RETENTION_DAYS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  SESSION_ROW_RETENTION_DAYS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  ATTACHMENT_TEMP_RETENTION_MS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  REVISION_KEEP_ALL_HOURS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  REVISION_HOURLY_DAYS: at(
    2,
    'apps/server/src/jobs',
    'enforce maintenance lifetime and batch policy',
  ),
  REVISION_THINNING_ROWS_PER_RUN: at(
    2,
    'apps/server/src/jobs/retention.ts',
    'yield a bounded revision scan with durable continuation',
  ),
  SEARCH_QUERY_MAX_CHARS: at(2, 'packages/contracts/src/rest/search.ts', 'bound search input'),
  SEARCH_LIMIT_MAX: at(2, 'packages/contracts/src/rest/search.ts', 'bound search pages'),
  SEARCH_LIMIT_DEFAULT: at(2, 'packages/contracts/src/rest/search.ts', 'default search page'),
  SEARCH_VAULTS_MAX: at(2, 'packages/contracts/src/rest/search.ts', 'bound explicit search vaults'),
  SNIPPET_CHARS_MIN: at(
    2,
    'packages/contracts/src/rest/search.ts',
    'minimum requested snippet length',
  ),
  SNIPPET_CHARS_MAX: at(
    2,
    'packages/contracts/src/rest/search.ts',
    'maximum requested snippet length',
  ),
  SNIPPET_CACHE_MAX: at(2, 'apps/server/src/search', 'bound mapped snippet cache'),
  SNIPPET_CACHE_TTL_MS: at(2, 'apps/server/src/search', 'expire mapped snippets'),
  REVISION_LIST_MAX: at(2, 'packages/contracts/src/rest/revisions.ts', 'bound revision pages'),
  REVISION_LIST_DEFAULT: at(2, 'packages/contracts/src/rest/revisions.ts', 'default revision page'),
  REVISION_LABEL_MAX: at(2, 'packages/contracts/src/rest/revisions.ts', 'bound checkpoint labels'),
  LINK_FRAGMENT_MAX_CHARS: at(2, 'packages/markdown/src', 'bound persisted link fragments'),
  MARKDOWN_LINKS_MAX: at(2, 'packages/markdown/src', 'bound links extracted from one note'),
  LINK_CANDIDATES_MAX: at(2, 'packages/markdown/src', 'bound ambiguous link suggestions'),
  AFFECTED_LINK_SAMPLE_MAX: at(
    2,
    'apps/server/src/tree/rename-impact.ts',
    'bound rename warning source samples in SQL',
  ),
  VAULT_INDEX_MAX_ENTRIES: at(
    2,
    'apps/server/src/projection',
    'switch large vault link resolution to indexed bounded lookup',
  ),
  CODE_LANGUAGE_MAX_CHARS: at(2, 'packages/markdown/src', 'bound code language metadata'),
  CODE_LANGUAGES_MAX: at(2, 'packages/markdown/src', 'bound distinct code languages'),
  OBSIDIAN_FINDING_MAX_CHARS: at(2, 'packages/markdown/src', 'bound finding source excerpts'),
  OBSIDIAN_FINDINGS_PER_CODE_MAX: at(2, 'packages/markdown/src', 'bound per-code finding samples'),
  OBSIDIAN_FINDINGS_MAX: at(2, 'packages/markdown/src', 'bound total finding samples'),
  OBSIDIAN_SAMPLE_MAX: at(
    2,
    'apps/server/src/projection/derived.ts',
    'bound persisted detector summaries',
  ),
  HEADING_TITLE_MAX_CODEPOINTS: at(
    2,
    'packages/markdown/src',
    'truncate complete heading graphemes',
  ),
  PROJECTION_QUEUE_MAX: at(
    2,
    'apps/server/src/projection/pool.ts',
    'refuse excess queued projections',
  ),
  REINDEX_RATE_PER_SECOND: at(
    2,
    'apps/server/src/config/env.ts',
    'throttle projection rebuild admission',
    wire('collab/plugin.ts', /ratePerSecond:\s*config\.projection\.reindexRatePerSecond/),
    wire('projection/reindex.ts', /this\.#deps\.ratePerSecond/),
  ),
  PROJECTION_WORKER_HEAP_MB: at(2, 'apps/server/src/projection/pool.ts', 'bound worker heap'),
  PROJECTION_WORKER_STACK_MB: at(2, 'apps/server/src/projection/pool.ts', 'bound worker stack'),
  PROJECTION_WORKER_IDLE_MS: at(2, 'apps/server/src/projection/pool.ts', 'release idle workers'),
  ATTACHMENT_SNIFF_BYTES: at(2, 'apps/server/src/attachments', 'bound MIME signature prefix'),
  ATTACHMENT_NAME_MAX_BYTES: at(2, 'apps/server/src/attachments', 'refuse oversized filenames'),
  ATTACHMENT_PATH_MAX_CHARS: at(2, 'apps/server/src/attachments', 'bound stored attachment paths'),
  ATTACHMENT_NAME_COLLISION_ATTEMPTS: at(
    2,
    'apps/server/src/attachments',
    'bound collision suffix attempts',
  ),
  ATTACHMENT_UPLOAD_CONCURRENCY: at(2, 'apps/server/src/attachments', 'bound simultaneous uploads'),
  ATTACHMENT_UPLOADS_PER_MINUTE: at(2, 'apps/server/src/attachments', 'refuse excess uploads'),
  ATTACHMENT_MULTIPART_THRESHOLD_BYTES: at(
    2,
    'apps/server/src/attachments',
    'switch to bounded S3 multipart streaming',
  ),
  ATTACHMENT_REFERENCE_SAMPLE_MAX: at(
    2,
    'apps/server/src/attachments',
    'bound reference report examples',
  ),
  ATTACHMENT_DELETE_REFERENCE_SAMPLE_MAX: at(
    2,
    'apps/server/src/attachments',
    'bound referenced-delete response',
  ),
  ATTACHMENT_SCAN_BATCH: at(
    2,
    'apps/server/src/attachments',
    'bound retained-reference scan batches',
  ),
  ATTACHMENT_LIST_MAX: at(
    2,
    'packages/contracts/src/rest/attachments.ts',
    'bound attachment pages',
  ),
  ATTACHMENT_LIST_DEFAULT: at(
    2,
    'packages/contracts/src/rest/attachments.ts',
    'default attachment page size',
  ),
  NODE_PATH_MAX_CHARS: at(
    2,
    'packages/contracts/src/collab.ts',
    'bound maximum-depth paths including Markdown suffix',
  ),
  TREE_CHANGES_MAX: at(2, 'packages/contracts/src/collab.ts', 'bound changes per vault frame'),
  UPLOAD_MAX_BYTES: at(
    2,
    SERVER + 'config/env.ts',
    '413 upload refused',
    wire('rest/plugin.ts', /maxUploadBytes:\s*config\.transfer\.maxUploadBytes/),
    wire('attachments/routes.ts', /stageAttachment\([\s\S]*?deps\.maxUploadBytes/),
    wire('attachments/staging.ts', /sizeBytes\s*>\s*maxBytes/),
  ),
  IMPORT_MAX_BYTES: at(
    6,
    SERVER + 'config/env.ts',
    '413 import refused',
    wire('transfer', /importMaxBytes/),
  ),
  IMPORT_MAX_FILES: at(6, SERVER + 'transfer', 'refuse excess files'),
  IMPORT_MAX_DEPTH: at(6, SERVER + 'transfer', 'refuse excess directory depth'),
  IMPORT_UPLOAD_BATCH_FILES: at(6, SERVER + 'transfer', 'refuse excess batch files'),
  IMPORT_UPLOAD_BATCH_BYTES: at(6, SERVER + 'transfer', '413 batch refused'),
  TREE_MAX_DEPTH: at(1, CONTRACTS + 'paths.ts', 'too_deep'),
  NODE_NAME_MAX_BYTES: at(1, CONTRACTS + 'paths.ts', 'too_long measured in UTF-8 bytes'),
  VAULT_NAME_MAX_CHARS: at(1, CONTRACTS + 'rest/common.ts', '422 validation_failed'),
  BODY_MAX_BYTES_JSON: at(1, SERVER + 'app.ts', '413 payload_too_large'),
  BODY_MAX_BYTES_MCP: at(3, SERVER + 'mcp', '413 request refused'),
  SHUTDOWN_DRAIN_MS: configured(
    'bounded drain then nonzero watchdog termination',
    wire('app.ts', /const budgetMs\s*=\s*app\.iridiumConfig\.ops\.shutdownDrainMs/),
  ),
} satisfies Record<LimitId, Enforcement>;

/** Comments and quoted prose cannot satisfy a reference check. Offsets are irrelevant here. */
function codeOnly(source: string): string {
  const parsed = parseSync('policy-source.ts', source);
  if (parsed.errors.length > 0)
    throw new Error(`Policy source could not be parsed: ${parsed.errors[0]?.message}`);
  const ranges: { start: number; end: number }[] = [...parsed.comments];
  new Visitor({
    Literal(node) {
      if (typeof node.value === 'string' || 'regex' in node) ranges.push(node);
    },
    TemplateElement(node) {
      ranges.push(node);
    },
  }).visit(parsed.program);
  let cursor = 0;
  const result: string[] = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    if (range.start < cursor) continue;
    result.push(source.slice(cursor, range.start), ' ');
    cursor = range.end;
  }
  result.push(source.slice(cursor));
  return result.join('');
}
function sourceFiles(owner: string): readonly string[] {
  const absolute = join(ROOT, owner);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [owner];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.(?:spec\.tsx?|d\.ts)$/.test(entry.name) &&
        !/[\\/]testing(?:[\\/]|$)/.test(entry.parentPath),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}
function readCode(file: string): string {
  return codeOnly(readFileSync(isAbsolute(file) ? file : join(ROOT, file), 'utf8'));
}
/** A property's expression may contain mutation-instrumented ternaries and comma expressions.
 * Track balanced delimiters so only that initializer can prove its config reference; a reference
 * in a later property or an unused variable cannot accidentally satisfy the binding.
 */
function hasWiring(source: string, sink: Wiring): boolean {
  if (sink.property === undefined) return sink.expression.test(source);
  const properties = new RegExp(`\\b${sink.property}\\s*:`, 'g');
  for (const property of source.matchAll(properties)) {
    const start = property.index + property[0].length;
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      const token = source[end];
      if (token === '(' || token === '{' || token === '[') depth += 1;
      else if (token === ')' || token === '}' || token === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if ((token === ',' || token === ';') && depth === 0) break;
    }
    if (sink.expression.test(source.slice(start, end))) return true;
  }
  return false;
}
function gaps(
  ids: readonly string[],
  registry: Readonly<Record<string, Enforcement>>,
  milestone: number,
  read: (file: string) => string = readCode,
): readonly string[] {
  return ids.flatMap((id) => {
    const entry = registry[id];
    if (entry === undefined) return [`${id}: no policy owner`];
    if (entry.since > milestone) return [];
    const missing: string[] = [];
    if (
      !sourceFiles(entry.owner).some((file) => new RegExp(`\\bLIMITS\\.${id}\\b`).test(read(file)))
    ) {
      missing.push(`${id}: no policy reference in ${entry.owner}`);
    }
    for (const sink of entry.wiring) {
      if (!sourceFiles(sink.file).some((file) => hasWiring(read(file), sink))) {
        missing.push(`${id}: disconnected enforcement in ${sink.file}`);
      }
    }
    return missing;
  });
}
function targetMilestone(): number {
  const selected =
    // eslint-disable-next-line node/no-process-env -- test-only exit rehearsal selector, never application configuration
    process.env['IRIDIUM_TEST_TARGET_MILESTONE'] ??
    readFileSync(join(ROOT, 'docs/milestones/CURRENT'), 'utf8').trim();
  const parsed = /^M([0-8])$/.exec(selected);
  if (parsed === null) throw new Error(`Invalid milestone: ${selected}`);
  return Math.max(1, Number(parsed[1]));
}
const env = envShape({
  defaultProjectionWorkers: 1,
  defaultPressureHeapBytes: 1,
  cpuCeiling: { cpus: 1, bound: 'host', hostParallelism: 1, cgroupCpus: 1 },
});

describe('limits.policy.unit [hp:HP-5]', () => {
  it('requires a real enforcement binding for every limit active at this milestone', () => {
    expect(Object.keys(ENFORCEMENT).toSorted()).toEqual(Object.keys(LIMITS).toSorted());
    expect(gaps(Object.keys(LIMITS), ENFORCEMENT, targetMilestone())).toEqual([]);
  });

  it('refuses absent owners, a constant replaced by a literal, comment-only references, and disconnected config wiring', () => {
    expect(gaps(['UNREGISTERED_LIMIT'], ENFORCEMENT, 1)).toEqual([
      'UNREGISTERED_LIMIT: no policy owner',
    ]);
    expect(
      gaps(['YJS_UPDATE_MAX_BYTES'], ENFORCEMENT, 1, (file) =>
        readCode(file).replaceAll('LIMITS.YJS_UPDATE_MAX_BYTES', '1048576'),
      ),
    ).toHaveLength(1);
    expect(
      gaps(['YJS_UPDATE_MAX_BYTES'], ENFORCEMENT, 1, () =>
        codeOnly('// LIMITS.YJS_UPDATE_MAX_BYTES\n"LIMITS.YJS_UPDATE_MAX_BYTES"'),
      ),
    ).toHaveLength(1);
    expect(
      gaps(['WS_MAX_PAYLOAD_BYTES'], ENFORCEMENT, 1, (file) =>
        readCode(file).replace('maxPayload: limits.wsMaxPayloadBytes', 'maxPayload: 0'),
      ),
    ).toHaveLength(1);
  });

  it('recognizes instrumented configuration expressions while rejecting a reference outside the bound property', () => {
    const sink = wire(
      'auth/plugin.ts',
      /config\.collab\.ticketTtlSeconds\s*\*\s*MS_PER_SECOND/,
      'ttlMs',
    );
    expect(
      hasWiring(
        codeOnly(
          'const options = { ttlMs: mutant() ? config.collab.ticketTtlSeconds / MS_PER_SECOND : (covered(), config.collab.ticketTtlSeconds * MS_PER_SECOND), later: 0 };',
        ),
        sink,
      ),
    ).toBe(true);
    expect(
      hasWiring(
        codeOnly(
          'const options = { ttlMs: 0, unrelated: config.collab.ticketTtlSeconds * MS_PER_SECOND };',
        ),
        sink,
      ),
    ).toBe(false);
  });
  it('keeps policy references after quoted regex characters while removing literal-only references', () => {
    const source = String.raw`const pattern = /["\x27\x60]/; const active = LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH;`;
    expect(codeOnly(source)).toContain('LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH');
    expect(
      codeOnly(String.raw`const pattern = /LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH/;`),
    ).not.toContain('LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH');
  });
  it('ratchets future limits at their owning milestone, rather than treating configuration defaults as enforcement', () => {
    expect(gaps(['MARKDOWN_SOURCE_MAX_BYTES'], ENFORCEMENT, 1, () => '')).toEqual([]);
    expect(gaps(['MARKDOWN_SOURCE_MAX_BYTES'], ENFORCEMENT, 2, () => '')).toHaveLength(1);
    expect(ENFORCEMENT.MARKDOWN_SOURCE_MAX_BYTES.owner).not.toBe(
      ENFORCEMENT.NOTE_HARD_MAX_UTF16.owner,
    );
    expect(LIMITS.MARKDOWN_SOURCE_MAX_BYTES).toBe(LIMITS.NOTE_HARD_MAX_UTF16);
  });

  it('keeps policy ids separate from environment keys except documented public identity overrides', () => {
    const overlap = Object.keys(LIMITS)
      .filter((id) => ENV_SCHEMA_KEYS.includes(id))
      .toSorted();
    expect(overlap).toEqual([
      'REINDEX_RATE_PER_SECOND',
      'SHUTDOWN_DRAIN_MS',
      'UPDATE_LOG_RETENTION_DAYS',
      'WS_MAX_PAYLOAD_BYTES',
    ]);
    const isEnvKey = (key: string): key is keyof typeof env => Object.hasOwn(env, key);
    for (const [key, id] of Object.entries(LIMIT_ENV_OVERRIDES)) {
      if (!isEnvKey(key)) throw new Error(`The override ${key} has no environment schema.`);
      expect(env[key].parse(undefined)).toBe(LIMITS[id]);
    }
    expect(env.WS_MAX_PAYLOAD_BYTES.parse(undefined)).toBe(LIMITS.WS_MAX_PAYLOAD_BYTES);
    expect(env.WS_MAX_PAYLOAD_BYTES.safeParse('0').success).toBe(false);
    expect(env.WS_MAX_PAYLOAD_BYTES.safeParse('2GiB').success).toBe(false);
    expect(env.WS_MAX_PAYLOAD_BYTES.parse('1')).toBe(1);
    expect(env.UPDATE_LOG_RETENTION_DAYS.safeParse('0').success).toBe(false);
    expect(env.UPDATE_LOG_RETENTION_DAYS.parse('1')).toBe(1);
    expect(env.SHUTDOWN_DRAIN_MS.safeParse('-1').success).toBe(false);
    expect(env.SHUTDOWN_DRAIN_MS.parse('0')).toBe(0);
  });

  it.each([
    [LIMITS.YJS_MESSAGES_PER_WINDOW, LIMITS.YJS_MESSAGE_WINDOW_MS],
    [LIMITS.AWARENESS_MESSAGES_PER_SECOND, 1_000],
    [LIMITS.FLUSH_PER_MINUTE, 60_000],
  ])(
    'allows exactly %i events per %i ms and resets precisely at the boundary',
    (count, windowMs) => {
      const window = new RateWindow(count, windowMs);
      for (let index = 0; index < count; index += 1) expect(window.take(0)).toBe(true);
      expect(window.take(windowMs - 1)).toBe(false);
      expect(window.take(windowMs - 1)).toBe(false);
      expect(window.take(windowMs)).toBe(true);
    },
  );

  it.each([LIMITS.TICKETS_PER_MINUTE_PER_SESSION, LIMITS.TICKETS_PER_MINUTE_PER_IP])(
    'refuses ticket request %i + 1, preserves key isolation and reports the exact remaining window',
    (count) => {
      const clock = new ManualClock(0);
      const budget = new WindowedBudget({ clock, max: count, windowMs: 60_000 });
      try {
        for (let index = 0; index < count; index += 1)
          expect(budget.hit('subject').allowed).toBe(true);
        clock.jump(59_999);
        expect(budget.hit('subject')).toEqual({ allowed: false, retryAfterMs: 1 });
        expect(budget.hit('other').allowed).toBe(true);
        clock.jump(60_000);
        expect(budget.hit('subject').allowed).toBe(true);
      } finally {
        budget.close();
      }
      expect(clock.pendingTimers).toBe(0);
    },
  );

  it('enforces both socket caps at their exact default boundaries and releases the reservation', () => {
    const caps = new SocketCaps({
      maxConnectionsPerIp: LIMITS.CONNECTIONS_PER_IP,
      maxConnections: LIMITS.CONNECTIONS_PER_PROCESS,
    });
    const releases: (() => void)[] = [];
    const reserve = (ip: string): void => {
      const admitted = caps.admit(ip);
      expect(admitted.admitted).toBe(true);
      if (admitted.admitted) releases.push(() => admitted.release());
    };
    for (let index = 0; index < LIMITS.CONNECTIONS_PER_IP; index += 1) reserve('source-0');
    expect(caps.admit('source-0')).toEqual({ admitted: false, refusal: 'ip' });
    for (let index = LIMITS.CONNECTIONS_PER_IP; index < LIMITS.CONNECTIONS_PER_PROCESS; index += 1)
      reserve(`source-${Math.floor(index / LIMITS.CONNECTIONS_PER_IP)}`);
    expect(caps.admit('new-source')).toEqual({ admitted: false, refusal: 'process' });
    for (const release of releases) release();
    expect(caps.total).toBe(0);
    expect(caps.admit('source-0').admitted).toBe(true);
  });

  it('refuses the next document or byte without evicting anything already admitted', () => {
    const docs = new AdmissionBudget({
      maxLoadedDocs: LIMITS.LOADED_DOCS_MAX,
      maxStateBytesTotal: LIMITS.LOADED_STATE_BYTES_MAX,
    });
    for (let index = 0; index < LIMITS.LOADED_DOCS_MAX; index += 1)
      expect(docs.reserve(String(index), 0).admitted).toBe(true);
    expect(docs.reserve('excess', 0)).toEqual({ admitted: false, refusal: 'docs' });
    expect(docs.loadedDocs).toBe(LIMITS.LOADED_DOCS_MAX);
    expect(docs.reserve('0', LIMITS.LOADED_STATE_BYTES_MAX).admitted).toBe(true);
    const bytes = new AdmissionBudget({
      maxLoadedDocs: LIMITS.LOADED_DOCS_MAX,
      maxStateBytesTotal: LIMITS.LOADED_STATE_BYTES_MAX,
    });
    expect(bytes.reserve('at-limit', LIMITS.LOADED_STATE_BYTES_MAX).admitted).toBe(true);
    expect(bytes.reserve('one-more-byte', 1)).toEqual({ admitted: false, refusal: 'bytes' });
    expect(bytes.stateBytes).toBe(LIMITS.LOADED_STATE_BYTES_MAX);
    bytes.release('at-limit');
    expect(bytes.reserve('one-more-byte', 1).admitted).toBe(true);
  });

  it('expires tickets at the policy TTL and accepts exactly the maximum HTTP ticket batch', () => {
    const clock = new ManualClock(0);
    const store = new InMemoryTicketStore({
      clock,
      ttlMs: LIMITS.TICKET_TTL_S * 1_000,
      sweepIntervalMs: 10_000,
    });
    const identity = {
      userId: UserId.parse('019948c4-0000-7000-8000-000000000001'),
      sessionId: SessionId.parse('019948c4-0000-7000-8000-000000000002'),
    };
    try {
      const [justBefore, atExpiry] = store.issue(identity, 2);
      clock.jump(LIMITS.TICKET_TTL_S * 1_000 - 1);
      expect(store.consume(justBefore ?? '')).toMatchObject(identity);
      clock.jump(LIMITS.TICKET_TTL_S * 1_000);
      expect(store.consume(atExpiry ?? '')).toBeNull();
    } finally {
      store.close();
    }
    expect(CreateCollabTicketsBody.safeParse({ count: LIMITS.TICKET_BATCH_MAX }).success).toBe(
      true,
    );
    expect(CreateCollabTicketsBody.safeParse({ count: LIMITS.TICKET_BATCH_MAX + 1 }).success).toBe(
      false,
    );
    expect(CreateCollabTicketsBody.safeParse({ count: 0 }).success).toBe(false);
  });

  it('blocks exactly the policy failure threshold and caps exponential block duration', async () => {
    const policy = {
      maxFailures: LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE,
      blockBaseSeconds: LIMITS.LOGIN_BLOCK_BASE_SECONDS,
      blockMaxSeconds: LIMITS.LOGIN_BLOCK_MAX_SECONDS,
      sourcePerDay: LIMITS.LOGIN_FAILURES_PER_IP_PER_DAY,
    };
    const throttle = new LoginThrottle(createMemoryLimiters(policy), policy, () => null);
    for (let index = 1; index < LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- consecutive login failures are ordered
      const failed = await throttle.recordFailure('limit@example.test', '192.0.2.1');
      expect(failed.blockedForMs).toBeNull();
    }
    expect((await throttle.recordFailure('limit@example.test', '192.0.2.1')).blockedForMs).toBe(
      LIMITS.LOGIN_BLOCK_BASE_SECONDS * 1_000,
    );
    expect(blockSeconds(0, policy)).toBe(LIMITS.LOGIN_BLOCK_BASE_SECONDS);
    expect(blockSeconds(100, policy)).toBe(LIMITS.LOGIN_BLOCK_MAX_SECONDS);
    const source = new LoginThrottle(createMemoryLimiters(policy), policy, () => null);
    for (let index = 0; index < LIMITS.LOGIN_FAILURES_PER_IP_PER_DAY; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- distinct accounts share one ordered IP budget
      await source.recordFailure(`limit-${index}@example.test`, '192.0.2.2');
    }
    expect(await source.check('new@example.test', '192.0.2.2')).toMatchObject({
      allowed: false,
      scope: 'source',
    });
  });

  it('measures names in UTF-8 bytes, note content in UTF-16 units, and tree depth in segments', () => {
    expect(checkNodeName('a'.repeat(LIMITS.NODE_NAME_MAX_BYTES)).ok).toBe(true);
    expect(checkNodeName('a'.repeat(LIMITS.NODE_NAME_MAX_BYTES + 1))).toMatchObject({
      ok: false,
      reason: 'too_long',
    });
    expect(checkNodeName('é'.repeat(127) + 'a').ok).toBe(true);
    expect(checkNodeName('é'.repeat(128))).toMatchObject({ ok: false, reason: 'too_long' });
    expect(safePath(Array.from({ length: LIMITS.TREE_MAX_DEPTH }, () => 'a').join('/')).ok).toBe(
      true,
    );
    expect(
      safePath(Array.from({ length: LIMITS.TREE_MAX_DEPTH + 1 }, () => 'a').join('/')),
    ).toMatchObject({ ok: false, reason: 'too_deep' });
    expect(VaultName.safeParse('a'.repeat(LIMITS.VAULT_NAME_MAX_CHARS)).success).toBe(true);
    expect(VaultName.safeParse('a'.repeat(LIMITS.VAULT_NAME_MAX_CHARS + 1)).success).toBe(false);
    const markdown = '😀'.repeat(LIMITS.NOTE_HARD_MAX_UTF16 / 2);
    expect(Buffer.byteLength(markdown, 'utf8')).toBeGreaterThan(LIMITS.MARKDOWN_SOURCE_MAX_BYTES);
    const body = {
      kind: 'note',
      parentId: '019948c4-0000-7000-8000-000000000001',
      name: 'Boundary',
      markdown,
    };
    expect(CreateNodeBody.safeParse(body).success).toBe(true);
    expect(CreateNodeBody.safeParse({ ...body, markdown: markdown + 'x' }).success).toBe(false);
  });

  it('accepts a valid stateless frame at the byte boundary and rejects the next byte before parsing', () => {
    const message = '{"v":1,"t":"baseline"}';
    const atBoundary =
      message + ' '.repeat(LIMITS.STATELESS_PAYLOAD_MAX_BYTES - Buffer.byteLength(message));
    expect(decodeClientNoteMessage(atBoundary).ok).toBe(true);
    expect(decodeClientNoteMessage(atBoundary + ' ')).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
  });
});
