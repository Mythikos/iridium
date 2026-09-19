/**
 * `CollabReads` — the four reads the identity hooks perform, behind one port
 * (04-auth-and-access-control.md §6.4 step 4, §8.6; 05-collaboration-and-durability.md,
 * "`participants`: server-authoritative identity").
 *
 * A `note:<uuid>` name resolves the `nodes` row with its vault (all three columns `authorize()`
 * accepts as a pre-loaded row), the note's `initialized_at` and the `note_docs.snapshot_size` the
 * admission budget reserves — one statement, so a document costs one session lookup plus one
 * vault/membership lookup plus this. A `vault:<uuid>` name resolves the vault alone. The epoch
 * re-authorization reads the user's live `authz_version`, and `connected` reads the display name and
 * colour the participant list carries.
 *
 * The port exists so the hooks are testable with a table of rows rather than a database: the
 * Kysely binding is the only implementation the product uses, and the unit suites drive the same hook
 * code over a fake.
 *
 * The refusals never distinguish "does not exist" from "not yours": both are `note-not-found`.
 */
import type { NoteId, UserId, VaultId } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes, vaultIdFromBytes } from '../../auth/ids.ts';
import type { MemberForAuthz, VaultForAuthz } from '../../authz/authorize.ts';
import type { Database, NodeKind, UserStatus, VaultStatus } from '../../db/schema.ts';

/** What a `note:` name resolved to. */
export interface ResolvedNote {
  readonly kind: 'note';
  readonly vault: VaultForAuthz;
  readonly vaultStatus: VaultStatus;
  readonly nodeKind: NodeKind;
  readonly deletedAt: Date | null;
  readonly initializedAt: Date | null;
  /** `note_docs.snapshot_size`, the admission estimate; `0` when the row is absent. */
  readonly snapshotSize: number;
}

/** What a `vault:` name resolved to. */
export interface ResolvedVault {
  readonly kind: 'vault';
  readonly vault: VaultForAuthz;
  readonly vaultStatus: VaultStatus;
}

/** Either resolution. */
export type Resolved = ResolvedNote | ResolvedVault;

/** The `users` columns the epoch re-authorization reads (04 §8.6). */
export interface UserAuthzRow {
  readonly authzVersion: number;
  readonly status: UserStatus;
  readonly isServerAdmin: boolean;
}

/** `users.display_name` and `users.color_hue`, what the participant list carries. */
export interface ParticipantIdentity {
  readonly name: string;
  readonly colorHue: number;
}

/** The document and membership refreshed by one query when an epoch becomes stale. */
export interface ResolvedAuthorization {
  readonly resolved: Resolved;
  readonly member: MemberForAuthz | null;
}

export interface AuthorizationTarget {
  readonly noteId: NoteId | null;
  readonly vaultId: VaultId;
  readonly userId: UserId;
}

/** The port. */
export interface CollabReads {
  resolveNote(noteId: string): Promise<ResolvedNote | null>;
  resolveVault(vaultId: string): Promise<ResolvedVault | null>;
  userAuthz(userId: UserId): Promise<UserAuthzRow | null>;
  resolveAuthorization(target: AuthorizationTarget): Promise<ResolvedAuthorization | null>;
  participantIdentity(userId: UserId): Promise<ParticipantIdentity | null>;
}

/** Thrown when a read is attempted before `dbApp` connected; the hooks refuse the document. */
export class CollabReadsUnavailable extends Error {
  readonly code = 'collab.reads_unavailable';

  constructor() {
    super('the collaboration identity reads need dbApp, which is not connected');
    this.name = 'CollabReadsUnavailable';
  }
}

/** The Kysely binding over `dbApp`, resolved per call because the pool may connect after boot. */
export function createKyselyCollabReads(db: () => Kysely<Database> | null): CollabReads {
  const executor = (): Kysely<Database> => {
    const current = db();
    if (current === null) throw new CollabReadsUnavailable();
    return current;
  };
  return {
    async resolveNote(noteId) {
      const row = await executor()
        .selectFrom('nodes as n')
        .innerJoin('vaults as v', 'v.id', 'n.vault_id')
        .leftJoin('notes as t', 't.node_id', 'n.id')
        .leftJoin('note_docs as d', 'd.note_id', 'n.id')
        .select([
          'n.kind',
          'n.deleted_at',
          'v.id as vault_id',
          'v.status',
          'v.mcp_enabled',
          't.initialized_at',
          'd.snapshot_size',
        ])
        .where('n.id', '=', idBytes(noteId))
        .executeTakeFirst();
      if (row === undefined) return null;
      const vaultId: VaultId = vaultIdFromBytes(row.vault_id);
      return {
        kind: 'note',
        vault: { id: vaultId, status: row.status, mcp_enabled: row.mcp_enabled },
        vaultStatus: row.status,
        nodeKind: row.kind,
        deletedAt: row.deleted_at,
        initializedAt: row.initialized_at,
        snapshotSize: row.snapshot_size ?? 0,
      };
    },
    async resolveVault(vaultId) {
      const row = await executor()
        .selectFrom('vaults')
        .select(['id', 'status', 'mcp_enabled'])
        .where('id', '=', idBytes(vaultId))
        .executeTakeFirst();
      if (row === undefined) return null;
      const id: VaultId = vaultIdFromBytes(row.id);
      return {
        kind: 'vault',
        vault: { id, status: row.status, mcp_enabled: row.mcp_enabled },
        vaultStatus: row.status,
      };
    },
    async userAuthz(userId) {
      const row = await executor()
        .selectFrom('users')
        .select(['authz_version', 'status', 'is_server_admin'])
        .where('id', '=', idBytes(userId))
        .executeTakeFirst();
      return row === undefined
        ? null
        : {
            authzVersion: row.authz_version,
            status: row.status,
            isServerAdmin: row.is_server_admin,
          };
    },
    async resolveAuthorization(target) {
      const row = await executor()
        .selectFrom('vaults as v')
        .leftJoin('vault_members as m', (join) =>
          join.onRef('m.vault_id', '=', 'v.id').on('m.user_id', '=', idBytes(target.userId)),
        )
        .leftJoin('nodes as n', (join) =>
          join
            .onRef('n.vault_id', '=', 'v.id')
            .on('n.id', '=', target.noteId === null ? Buffer.alloc(16) : idBytes(target.noteId)),
        )
        .leftJoin('notes as t', 't.node_id', 'n.id')
        .leftJoin('note_docs as d', 'd.note_id', 'n.id')
        .select([
          'v.id as vault_id',
          'v.status',
          'v.mcp_enabled',
          'n.kind',
          'n.deleted_at',
          't.initialized_at',
          'd.snapshot_size',
          'm.role',
          'm.version',
        ])
        .where('v.id', '=', idBytes(target.vaultId))
        .executeTakeFirst();
      if (row === undefined || (target.noteId !== null && row.kind !== 'note')) return null;
      const vault = {
        id: vaultIdFromBytes(row.vault_id),
        status: row.status,
        mcp_enabled: row.mcp_enabled,
      };
      const resolved: Resolved =
        target.noteId === null
          ? { kind: 'vault', vault, vaultStatus: row.status }
          : {
              kind: 'note',
              vault,
              vaultStatus: row.status,
              nodeKind: 'note',
              deletedAt: row.deleted_at,
              initializedAt: row.initialized_at,
              snapshotSize: row.snapshot_size ?? 0,
            };
      return {
        resolved,
        member:
          row.role === null || row.version === null
            ? null
            : { role: row.role, version: row.version },
      };
    },
    async participantIdentity(userId) {
      const row = await executor()
        .selectFrom('users')
        .select(['display_name', 'color_hue'])
        .where('id', '=', idBytes(userId))
        .executeTakeFirst();
      return row === undefined ? null : { name: row.display_name, colorHue: row.color_hue };
    },
  };
}

/**
 * The per-event channel between the two `onAuthenticate` implementations. Keyed by the payload object
 * Hocuspocus hands every extension of one event, so nothing leaks past the event and the wire
 * context stays exactly the plan's member list.
 */
export class ResolutionChannel {
  readonly #resolved = new WeakMap<object, Resolved>();

  set(payload: object, resolved: Resolved): void {
    this.#resolved.set(payload, resolved);
  }

  get(payload: object): Resolved | undefined {
    return this.#resolved.get(payload);
  }
}
