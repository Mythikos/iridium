/**
 * The audit chain: `AuditWriter.record(trx, event)` and `verifyChain()` (03-data-model.md §12.1–§12.3;
 * `A46`, `A47`; invariant I-19).
 *
 * `record` runs **inside the transaction that performs the mutation it describes**. There is no
 * asynchronous audit path and no queue: an action that cannot be audited does not happen. That is the
 * whole design, and everything below follows from it.
 *
 *  - **The head row is the serialisation point.** `SELECT … FROM audit_chain_heads WHERE chain_id = ?
 *    FOR UPDATE` is taken first, and it is always the *last* lock the transaction takes in the global
 *    lock order (`A46`). A per-row `prev_hash` computed from "the last row I can see" forks under
 *    concurrency — two transactions read the same predecessor and both claim it — which is exactly what
 *    `audit.chain.integration` drives 32 concurrent writers at.
 *  - **The genesis head is inserted on first use**, `last_id = 0` and `last_hash` 32 zero bytes. Two
 *    transactions can race that insert; the loser sees `ER_DUP_ENTRY` and re-reads under the lock, which
 *    is why the insert is retried here rather than pre-seeded by a migration.
 *  - **`prev_id` is inside the payload and `id` is not.** `id` is assigned by `AUTO_INCREMENT` after the
 *    pre-image is computed, so it cannot be covered; binding each row to its predecessor's id instead is
 *    what makes a deletion or a re-ordering detectable.
 *  - **The key is chosen by version, per row.** New rows are signed with the version
 *    `schema_meta.audit_key_version` names; verification picks the key from the row's own `key_version`,
 *    so every historical key must stay in the encrypted secrets bundle (`A47`) and a missing version
 *    fails verification closed rather than being skipped.
 *
 * **The pre-image is not this module's.** `@iridium/contracts/audit.ts` owns `AuditChainPayload`,
 * `canonicalJson` and `auditChainPreimage`, because the writer, `iridium audit verify-chain` and the
 * audit export must all produce the same bytes and a second copy is how they stop doing so. What lives
 * here is the part that needs a database and `node:crypto`: the head lock, the HMAC, the insert, and the
 * walk that recomputes both.
 *
 * **What the HMAC key is.** The configured keyring holds each version's material exactly as the
 * environment supplied it — for `AUDIT_HMAC_KEY_V<n>` that is 32 bytes of base64
 * (11-operations-and-deployment.md) — and those bytes are the key. Base64-*decoding* first would be a
 * second interpretation of the same value: it would silently accept a non-base64 value in development,
 * and two spellings that decode alike would produce one chain. The stored form is therefore the
 * canonical key material, which is also what the secrets bundle round-trips and what
 * `iridium config check`'s fingerprint identifies.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  AUDIT_ACTION_CHAIN,
  AUDIT_SCHEMA_VERSION,
  AUDIT_TARGETS_MAX,
  AuditAction,
  auditChainPreimage,
  chainIdForVault,
  GENESIS_CHAIN_HASH,
  idFromBytes,
  idToBytes,
  SERVER_CHAIN_ID,
  toTimestamp,
  type AuditActorType,
  type AuditChainPayload,
  type AuditCredentialType,
  type AuditOutcome,
  type AuditTarget,
  type CanonicalObject,
  type CanonicalValue,
} from '@iridium/contracts';
import type { Kysely, Transaction } from 'kysely';

import { classifyDatabaseFailure } from '../db/failure.ts';
import type { AuditContext, Database } from '../db/schema.ts';
import type { Clock } from '../ops/clock.ts';

/** `audit_chain_heads.last_hash` before a chain has any row: 32 zero bytes (§12.2). */
export const GENESIS_HASH: Buffer = Buffer.from(GENESIS_CHAIN_HASH);

/** How many rows one verification page reads; the walk is streamed so a long chain stays bounded. */
const VERIFY_PAGE_ROWS = 500;

/**
 * `audit_events.context` as 03-data-model.md §12.1 spells it, with every member optional and nullable.
 *
 * The width is deliberate: the three surfaces that write audit rows (`auth`, `rest`, `collab`) each know
 * a different subset — a CLI mutation has an `os_user` and no `ip`, an MCP denial has an `mcp_client` — and
 * a required member would force one of them to invent a value. `null` and an absent member are two
 * distinguishable things here and both survive into the pre-image unchanged, because the hash is taken
 * over exactly what is stored.
 */
export interface AuditEventContext {
  readonly ip?: string | null;
  readonly user_agent?: string | null;
  readonly request_id?: string | null;
  readonly client?: string | null;
  readonly mcp_client?: string | null;
  readonly os_user?: string | null;
  /** The host a CLI mutation ran on (OPS-19); absent for every request-borne event. */
  readonly host?: string | null;
  /** A CLI mutation's command path with every value elided (OPS-19), never the raw argv. */
  readonly argv_shape?: string | null;
}

/**
 * One audited action, as a caller describes it. The chain, the hash and the `BINARY(16)` conversions are
 * this module's.
 *
 * The members are the **column names** of §12.1 rather than a nested shape, for the same reason the
 * pre-image is: an audit row is read by an auditor against that table, and a second vocabulary between
 * the caller and the column is a translation step that eventually gets one field wrong.
 */
export interface AuditEventInput {
  readonly action: AuditAction;
  /**
   * The chain to write to. Omit it and the action's own scope decides (§12.6); pass it and it must equal
   * what the scope implies, which is what lets a caller that only ever writes server-chain events say so
   * at the call site.
   */
  readonly chainId?: string;
  readonly actorType: AuditActorType;
  /** A canonical user or token actor id, or `null` for an unattributable action. */
  readonly actorId?: string | null;
  /** `actor_display`: a name the auditor needs, never an email. */
  readonly actorDisplay?: string | null;
  /** Set when an agent or a job acted for a user. */
  readonly onBehalfOfUserId?: string | null;
  readonly credentialType: AuditCredentialType;
  /** The session, token or link row id the credential came from. */
  readonly credentialId?: string | null;
  /** Required for every action `AUDIT_ACTION_CHAIN` scopes to a vault. */
  readonly vaultId?: string | null;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  /** Used when one action affects many rows; capped at `AUDIT_TARGETS_MAX` with a marker (§12.2). */
  readonly targets?: readonly AuditTarget[];
  readonly outcome: AuditOutcome;
  /** A short machine reason (`csrf`, `no_grant_option`), never a sentence. */
  readonly reason?: string | null;
  readonly context: AuditEventContext;
  /** Before/after values of non-content fields only. Never note bodies (§12.2). */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

/** What `record` resolves to, so the caller can log or publish the position it wrote. */
export interface RecordedAuditEvent {
  readonly id: number;
  readonly chainId: string;
  readonly occurredAt: Date;
  readonly keyVersion: number;
  readonly prevHash: Buffer;
  readonly hash: Buffer;
}

/** The keyring `AuditWriter` signs with and `verifyChain` verifies against. */
export interface AuditKeys {
  /** The version `schema_meta.audit_key_version` names: what new rows are signed with. */
  readonly signingVersion: number;
  /** The material for one version, or `undefined` when that version is not configured. */
  keyFor(version: number): Uint8Array | undefined;
}

/** Thrown when the version a row was signed with is not in the running configuration. */
export class AuditKeyMissingError extends Error {
  readonly code = 'audit.key_version_missing';
  readonly keyVersion: number;

  constructor(keyVersion: number) {
    super(
      `AUDIT_HMAC_KEY_V${String(keyVersion)} is not configured, so rows signed with it can be neither ` +
        'verified nor extended. Audit keys are never retired: restore the version from the encrypted ' +
        'secrets bundle of the backup set (A47) and add its AUDIT_HMAC_KEY_V<n>_FILE entry.',
    );
    this.name = 'AuditKeyMissingError';
    this.keyVersion = keyVersion;
  }
}

/** Thrown when an action that is scoped to a vault was recorded without one. */
export class AuditChainUnresolvedError extends Error {
  readonly code = 'audit.chain_unresolved';

  constructor(action: string) {
    super(
      `the audit action ${action} is vault-scoped (03-data-model.md §12.6) and was recorded without a ` +
        'vaultId. Every action carrying a vault goes to chain vault:<32 hex>, which is what lets a ' +
        'manager be shown a verifiable chain for their own vault; pass the vault id, or record an ' +
        'action that is server-scoped.',
    );
    this.name = 'AuditChainUnresolvedError';
  }
}

/** Thrown when a caller's explicit `chainId` is not the chain the action's scope implies. */
export class AuditChainMismatchError extends Error {
  readonly code = 'audit.chain_mismatch';

  constructor(action: string, given: string, derived: string) {
    super(
      `the audit action ${action} belongs to chain ${derived} (03-data-model.md §12.6) and was recorded ` +
        `with chainId ${given}. Pass the chain the action's scope implies, or omit chainId and let the ` +
        'writer derive it.',
    );
    this.name = 'AuditChainMismatchError';
  }
}

/** Thrown when a value bound for the pre-image is not a JSON value (a `Date`, a `Buffer`, a function). */
export class AuditValueNotJsonError extends Error {
  readonly code = 'audit.value_not_json';

  constructor(path: string, kind: string) {
    super(
      `the audit row carries a ${kind} at ${path}, and the chain's pre-image is JSON (RFC 8785). ` +
        'Convert it before it reaches the writer: ids to canonical UUID strings, instants to ' +
        'YYYY-MM-DDTHH:MM:SS.ffffffZ, bytes to a documented encoding.',
    );
    this.name = 'AuditValueNotJsonError';
  }
}

/**
 * The chain one event is written to, and the consistency check on an explicit `chainId`.
 *
 * A caller that passes a chain is stating an expectation, so a mismatch is a programming error rather
 * than a value to reconcile: writing a vault-scoped action onto the `server` chain would put it where no
 * vault manager can read it, and the mistake would be invisible until an audit.
 */
function resolveChainId(event: AuditEventInput): string {
  const derived = chainIdFor(event.action, event.vaultId);
  if (event.chainId !== undefined && event.chainId !== derived) {
    throw new AuditChainMismatchError(event.action, event.chainId, derived);
  }
  return derived;
}

/** The chain an action is written to (§12.6): a vault-scoped action to its vault, the rest to `server`. */
export function chainIdFor(action: AuditAction, vaultId: string | null | undefined): string {
  if (AUDIT_ACTION_CHAIN[action] === 'server') return SERVER_CHAIN_ID;
  if (vaultId === null || vaultId === undefined) throw new AuditChainUnresolvedError(action);
  return chainIdForVault(vaultId);
}

/** `BINARY(16)` for a canonical id, or `null`. */
function idBytesOrNull(id: string | null | undefined): Buffer | null {
  return id === null || id === undefined ? null : Buffer.from(idToBytes(id));
}

/** A canonical id string for a `BINARY(16)` column, or `undefined` so the pre-image omits it. */
function idOrUndefined(bytes: Buffer | null): string | undefined {
  return bytes === null ? undefined : idFromBytes(bytes);
}

/** `null` and `undefined` both mean "omit from the pre-image" (§12.2). */
function omitNull<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/**
 * Narrows an arbitrary value to a JSON value, throwing on anything else.
 *
 * This is a boundary check, not a formality: `context` and `metadata` are JSON columns, so what comes
 * back from MySQL is `unknown` as far as the type system is concerned, and the pre-image has to be
 * reproducible from exactly those values. A type assertion here would claim a shape nothing verified and
 * would turn a `Date` written by mistake into an unverifiable chain a year later.
 */
function toCanonicalValue(value: unknown, path: string): CanonicalValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      throw new AuditValueNotJsonError(path, typeof value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toCanonicalValue(item, `${path}[${String(index)}]`));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new AuditValueNotJsonError(path, value.constructor.name);
  }
  return toCanonicalObject(value, path);
}

/** The same narrowing for an object, which is what `context` and `metadata` always are. */
function toCanonicalObject(value: object, path: string): CanonicalObject {
  const members: Record<string, CanonicalValue> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    members[key] = toCanonicalValue(member, path === '' ? key : `${path}.${key}`);
  }
  return members;
}

/** `HMAC-SHA256(key, prev_hash ‖ utf8(canonicalJSON(row)))` (§12.1). */
export function auditHash(key: Uint8Array, prevHash: Buffer, payload: AuditChainPayload): Buffer {
  const hmac = createHmac('sha256', key);
  hmac.update(prevHash);
  hmac.update(auditChainPreimage(payload), 'utf8');
  return hmac.digest();
}

/** Constant-time digest comparison, so a verifier is not a timing oracle for a forged hash. */
function digestsEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

interface ChainHead {
  readonly last_id: number;
  readonly last_hash: Buffer;
}

/**
 * The writer. One instance per process, built by the audit plugin from the configured keyring and the
 * injected clock; it holds no connection of its own, because every write joins the caller's transaction.
 */
export class AuditWriter {
  readonly #keys: AuditKeys;
  readonly #clock: Clock;

  constructor(options: { readonly keys: AuditKeys; readonly clock: Clock }) {
    this.#keys = options.keys;
    this.#clock = options.clock;
  }

  /** The version new rows are signed with. */
  get signingVersion(): number {
    return this.#keys.signingVersion;
  }

  /**
   * Writes one event inside `trx` — the last statement of the mutating transaction, after every row the
   * action changed and before `COMMIT`.
   *
   * @throws AuditKeyMissingError when the signing version is not configured. The boot check catches that
   * first; here it is the fail-closed backstop, and it aborts the mutation it would have described.
   * @throws AuditChainUnresolvedError when a vault-scoped action carries no vault id.
   */
  async record(trx: Transaction<Database>, event: AuditEventInput): Promise<RecordedAuditEvent> {
    const keyVersion = this.#keys.signingVersion;
    const key = this.#keys.keyFor(keyVersion);
    if (key === undefined) throw new AuditKeyMissingError(keyVersion);

    const chainId = resolveChainId(event);
    const head = await lockHead(trx, chainId);
    const occurredAt = this.#clock.date();

    const capped = capTargets(event.targets);
    const rawMetadata: Readonly<Record<string, unknown>> | null = capped.truncated
      ? { ...event.metadata, targets_truncated: true }
      : (event.metadata ?? null);
    const metadata: CanonicalObject | null =
      rawMetadata === null ? null : toCanonicalObject(rawMetadata, 'metadata');
    const context = toCanonicalObject(event.context, 'context');

    const actorId = omitNull(event.actorId);
    const actorDisplay = omitNull(event.actorDisplay);
    const onBehalfOf = omitNull(event.onBehalfOfUserId);
    const credentialId = omitNull(event.credentialId);
    const vaultId = omitNull(event.vaultId);
    const targetType = omitNull(event.targetType);
    const targetId = omitNull(event.targetId);
    const reason = omitNull(event.reason);

    const payload: AuditChainPayload = {
      prev_id: head.last_id,
      occurred_at: toTimestamp(occurredAt),
      schema_version: AUDIT_SCHEMA_VERSION,
      chain_id: chainId,
      action: event.action,
      actor_type: event.actorType,
      ...(actorId === undefined ? {} : { actor_id: actorId }),
      ...(actorDisplay === undefined ? {} : { actor_display: actorDisplay }),
      ...(onBehalfOf === undefined ? {} : { on_behalf_of_user_id: onBehalfOf }),
      credential_type: event.credentialType,
      ...(credentialId === undefined ? {} : { credential_id: credentialId }),
      ...(vaultId === undefined ? {} : { vault_id: vaultId }),
      ...(targetType === undefined ? {} : { target_type: targetType }),
      ...(targetId === undefined ? {} : { target_id: targetId }),
      ...(capped.targets === null ? {} : { targets: capped.targets }),
      outcome: event.outcome,
      ...(reason === undefined ? {} : { reason }),
      context,
      ...(metadata === null ? {} : { metadata }),
    };

    const hash = auditHash(key, head.last_hash, payload);

    const inserted = await trx
      .insertInto('audit_events')
      .values({
        occurred_at: occurredAt,
        schema_version: AUDIT_SCHEMA_VERSION,
        chain_id: chainId,
        action: event.action,
        actor_type: event.actorType,
        actor_id: idBytesOrNull(event.actorId),
        actor_display: event.actorDisplay ?? null,
        on_behalf_of_user_id: idBytesOrNull(event.onBehalfOfUserId),
        credential_type: event.credentialType,
        credential_id: idBytesOrNull(event.credentialId),
        vault_id: idBytesOrNull(event.vaultId),
        target_type: event.targetType ?? null,
        target_id: idBytesOrNull(event.targetId),
        targets: capped.targets === null ? null : JSON.stringify(capped.targets),
        outcome: event.outcome,
        reason: event.reason ?? null,
        // The stored JSON and the hashed pre-image are the *same* values: `context` and `metadata` are
        // serialised from the narrowed objects, never from the caller's originals.
        context: JSON.stringify(context),
        metadata: metadata === null ? null : JSON.stringify(metadata),
        prev_hash: head.last_hash,
        hash,
        key_version: keyVersion,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId ?? 0n);
    await trx
      .updateTable('audit_chain_heads')
      .set({ last_id: id, last_hash: hash })
      .where('chain_id', '=', chainId)
      .executeTakeFirst();

    return { id, chainId, occurredAt, keyVersion, prevHash: head.last_hash, hash };
  }
}

/** `targets` capped at `AUDIT_TARGETS_MAX`, so a bulk action is one verifiable event (§12.2). */
function capTargets(targets: readonly AuditTarget[] | undefined): {
  readonly targets: readonly AuditTarget[] | null;
  readonly truncated: boolean;
} {
  if (targets === undefined || targets.length === 0) return { targets: null, truncated: false };
  if (targets.length <= AUDIT_TARGETS_MAX) return { targets, truncated: false };
  return { targets: targets.slice(0, AUDIT_TARGETS_MAX), truncated: true };
}

/**
 * Locks the chain head, creating the genesis row when the chain has never been written.
 *
 * **The genesis row is upserted *before* the `FOR UPDATE` read, not after it**, and that order is not
 * interchangeable. §12.2's pseudocode reads the head first and inserts the genesis row when it is absent;
 * under `REPEATABLE READ` a `SELECT … FOR UPDATE` that matches **no row** takes a next-key (gap) lock on
 * the gap where the row would go, gap locks held by different transactions are compatible with each other,
 * and the insert that follows needs an insert-intention lock that conflicts with the other transaction's
 * gap lock — so two transactions creating two *different* chains deadlock, which
 * `audit.chain.integration` reproduces in one line. An idempotent `INSERT … ON DUPLICATE KEY UPDATE`
 * takes an insert-intention lock (compatible with another insert intention in the same gap) for a new
 * chain and an exclusive row lock for an existing one — which is the serialisation point §12.2 asks for,
 * reached without the gap.
 *
 * The self-assignment `chain_id = chain_id` is the idempotent no-op form; the deprecated
 * VALUES-function form of `ON DUPLICATE KEY UPDATE` is banned on both required lines by
 * `db.dialect-floor.guard`.
 */
async function lockHead(trx: Transaction<Database>, chainId: string): Promise<ChainHead> {
  try {
    await trx
      .insertInto('audit_chain_heads')
      .values({ chain_id: chainId, last_id: 0, last_hash: GENESIS_HASH })
      .onDuplicateKeyUpdate((eb) => ({ chain_id: eb.ref('audit_chain_heads.chain_id') }))
      .executeTakeFirst();
  } catch (error) {
    // Two transactions creating the same chain can still collide on the duplicate-key check; the loser
    // re-reads under the lock below, which is the same resolution the read-then-insert form needed.
    if (classifyDatabaseFailure(error).kind !== 'duplicate_entry') throw error;
  }

  const head = await selectHeadForUpdate(trx, chainId);
  if (head === undefined) {
    throw new Error(
      `the audit chain head for ${chainId} could be neither created nor read. The app role holds ` +
        'SELECT, INSERT and UPDATE on audit_chain_heads (03-data-model.md §2); check that migration ' +
        '0034_grants has been applied to this schema.',
    );
  }
  return head;
}

async function selectHeadForUpdate(
  trx: Transaction<Database>,
  chainId: string,
): Promise<ChainHead | undefined> {
  return trx
    .selectFrom('audit_chain_heads')
    .select(['last_id', 'last_hash'])
    .where('chain_id', '=', chainId)
    .forUpdate()
    .executeTakeFirst();
}

/** Why a chain did not verify. */
export type ChainDivergenceReason =
  | 'hash_mismatch'
  | 'prev_hash_mismatch'
  | 'head_mismatch'
  | 'key_version_missing'
  | 'unknown_action';

/** Where a chain first diverges, with everything an operator needs to find the row. */
export interface ChainDivergence {
  readonly id: number;
  readonly occurredAt: Date | null;
  readonly action: string;
  readonly reason: ChainDivergenceReason;
}

/** The outcome of verifying one chain. */
export interface ChainVerification {
  readonly chainId: string;
  readonly rows: number;
  readonly lastId: number;
  readonly ok: boolean;
  readonly divergence: ChainDivergence | null;
}

/** One row as the verifier reads it back. */
interface StoredAuditRow {
  readonly id: number;
  readonly occurred_at: Date;
  readonly schema_version: number;
  readonly chain_id: string;
  readonly action: string;
  readonly actor_type: AuditActorType;
  readonly actor_id: Buffer | null;
  readonly actor_display: string | null;
  readonly on_behalf_of_user_id: Buffer | null;
  readonly credential_type: AuditCredentialType;
  readonly credential_id: Buffer | null;
  readonly vault_id: Buffer | null;
  readonly target_type: string | null;
  readonly target_id: Buffer | null;
  readonly targets: readonly AuditTarget[] | null;
  readonly outcome: AuditOutcome;
  readonly reason: string | null;
  readonly context: AuditContext;
  readonly metadata: Record<string, unknown> | null;
  readonly prev_hash: Buffer;
  readonly hash: Buffer;
  readonly key_version: number;
}

/**
 * Walks a chain in ascending `id` over `ix_audit_chain`, recomputes every HMAC and compares it, then
 * compares the last row with `audit_chain_heads` (§12.2).
 *
 * This is what `iridium audit verify-chain` and the blocking step of `restore --verify` run. It fails
 * **closed**: a row whose `key_version` is not configured, or whose action is outside the closed
 * vocabulary this version writes, is a divergence and never a skipped row.
 */
export async function verifyChain(
  db: Kysely<Database>,
  chainId: string,
  keys: AuditKeys,
): Promise<ChainVerification> {
  let carriedId = 0;
  let carriedHash: Buffer = GENESIS_HASH;
  let rows = 0;
  let page: readonly StoredAuditRow[] = [];

  do {
    // Sequential by design: each page continues where the previous one stopped, and the carried
    // `(prev_id, prev_hash)` pair is the whole point of the walk.
    // eslint-disable-next-line no-await-in-loop -- the pages are an ordered walk, not independent reads
    page = await readChainPage(db, chainId, carriedId);
    for (const row of page) {
      rows += 1;
      const divergence = verifyRow(row, carriedId, carriedHash, keys);
      if (divergence !== null) return { chainId, rows, lastId: carriedId, ok: false, divergence };
      carriedId = row.id;
      carriedHash = row.hash;
    }
  } while (page.length === VERIFY_PAGE_ROWS);

  const head = await db
    .selectFrom('audit_chain_heads')
    .select(['last_id', 'last_hash'])
    .where('chain_id', '=', chainId)
    .executeTakeFirst();

  // A chain with no rows and no head row was never written, and that verifies.
  if (head === undefined) {
    return { chainId, rows, lastId: carriedId, ok: rows === 0, divergence: null };
  }
  if (head.last_id !== carriedId || !digestsEqual(head.last_hash, carriedHash)) {
    return {
      chainId,
      rows,
      lastId: carriedId,
      ok: false,
      divergence: {
        id: head.last_id,
        occurredAt: null,
        action: 'audit_chain_heads',
        reason: 'head_mismatch',
      },
    };
  }
  return { chainId, rows, lastId: carriedId, ok: true, divergence: null };
}

/** Every chain that has a head row, so `verify-chain` without `--chain` can walk all of them. */
export async function listChainIds(db: Kysely<Database>): Promise<readonly string[]> {
  const rows = await db
    .selectFrom('audit_chain_heads')
    .select('chain_id')
    .orderBy('chain_id', 'asc')
    .execute();
  return rows.map((row) => row.chain_id);
}

async function readChainPage(
  db: Kysely<Database>,
  chainId: string,
  afterId: number,
): Promise<readonly StoredAuditRow[]> {
  return db
    .selectFrom('audit_events')
    .selectAll()
    .where('chain_id', '=', chainId)
    .where('id', '>', afterId)
    .orderBy('id', 'asc')
    .limit(VERIFY_PAGE_ROWS)
    .execute();
}

function verifyRow(
  row: StoredAuditRow,
  carriedId: number,
  carriedHash: Buffer,
  keys: AuditKeys,
): ChainDivergence | null {
  const where = { id: row.id, occurredAt: row.occurred_at, action: row.action };
  if (!digestsEqual(row.prev_hash, carriedHash)) {
    return { ...where, reason: 'prev_hash_mismatch' };
  }
  const key = keys.keyFor(row.key_version);
  if (key === undefined) return { ...where, reason: 'key_version_missing' };

  // The stored action is a `VARCHAR(64)`; the pre-image's is a member of the closed vocabulary. A row
  // outside it was written by another version of this server or by a forgery, and either way this
  // version cannot reproduce its pre-image — so it is a divergence rather than a silently accepted row.
  const action = AuditAction.safeParse(row.action);
  if (!action.success) return { ...where, reason: 'unknown_action' };

  const actorId = idOrUndefined(row.actor_id);
  const actorDisplay = omitNull(row.actor_display);
  const onBehalfOf = idOrUndefined(row.on_behalf_of_user_id);
  const credentialId = idOrUndefined(row.credential_id);
  const vaultId = idOrUndefined(row.vault_id);
  const targetType = omitNull(row.target_type);
  const targetId = idOrUndefined(row.target_id);
  const reason = omitNull(row.reason);
  const targets = omitNull(row.targets);
  const metadata = row.metadata === null ? undefined : toCanonicalObject(row.metadata, 'metadata');

  const payload: AuditChainPayload = {
    prev_id: carriedId,
    occurred_at: toTimestamp(row.occurred_at),
    schema_version: row.schema_version,
    chain_id: row.chain_id,
    action: action.data,
    actor_type: row.actor_type,
    ...(actorId === undefined ? {} : { actor_id: actorId }),
    ...(actorDisplay === undefined ? {} : { actor_display: actorDisplay }),
    ...(onBehalfOf === undefined ? {} : { on_behalf_of_user_id: onBehalfOf }),
    credential_type: row.credential_type,
    ...(credentialId === undefined ? {} : { credential_id: credentialId }),
    ...(vaultId === undefined ? {} : { vault_id: vaultId }),
    ...(targetType === undefined ? {} : { target_type: targetType }),
    ...(targetId === undefined ? {} : { target_id: targetId }),
    ...(targets === undefined ? {} : { targets }),
    outcome: row.outcome,
    ...(reason === undefined ? {} : { reason }),
    context: toCanonicalObject(row.context, 'context'),
    ...(metadata === undefined ? {} : { metadata }),
  };

  return digestsEqual(auditHash(key, carriedHash, payload), row.hash)
    ? null
    : { ...where, reason: 'hash_mismatch' };
}
