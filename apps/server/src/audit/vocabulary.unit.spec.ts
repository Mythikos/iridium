/**
 * Exhaustive writer/row/preimage cases for the closed audit vocabulary (03 section 12.6).
 * These are accepted audit-row shapes, not evidence that later-milestone producers or export exist.
 */
import { createHmac } from 'node:crypto';

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_CHAIN,
  AuditAction,
  auditChainPreimage,
  chainIdForVault,
  idToBytes,
  type AuditChainPayload,
  type AuditChainScope,
  type AuditCredentialType,
  type AuditOutcome,
} from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { fakeDatabase, type ExecutedQuery } from '../../test/support/fake-driver.ts';
import { ManualClock } from '../../test/support/manual-clock.ts';
import { AuditWriter, GENESIS_HASH, verifyChain, type AuditKeys } from './chain.ts';

type VocabularyCase = readonly [
  scope: AuditChainScope,
  credential: AuditCredentialType,
  outcome: AuditOutcome,
  target: string,
];

// An action added to the public enum must supply a deliberate row example here.
const CASES = {
  'user.login.succeeded': ['server', 'session', 'success', 'user'],
  'user.login.failed': ['server', 'none', 'failure', 'user'],
  'user.logout': ['server', 'session', 'success', 'session'],
  'user.reauth.succeeded': ['server', 'session', 'success', 'session'],
  'user.password.set': ['server', 'setpw', 'success', 'user'],
  'user.password.changed': ['server', 'session', 'success', 'user'],
  'session.revoked': ['server', 'session', 'success', 'session'],
  'session.revoked_all': ['server', 'cli', 'success', 'session'],
  'token.created': ['server', 'session', 'success', 'token'],
  'token.rotated': ['server', 'pat', 'success', 'token'],
  'token.revoked': ['server', 'session', 'success', 'token'],
  'token.revoked_all': ['server', 'cli', 'success', 'token'],
  'token.denied': ['server', 'none', 'failure', 'token'],
  'oauth.client.registered': ['server', 'none', 'success', 'oauth_client'],
  'oauth.client.disabled': ['server', 'session', 'success', 'oauth_client'],
  'oauth.client.deleted': ['server', 'session', 'success', 'oauth_client'],
  'oauth.client.expired': ['server', 'system', 'success', 'oauth_client'],
  'oauth.consent.granted': ['server', 'session', 'success', 'oauth_grant'],
  'oauth.consent.updated': ['server', 'session', 'success', 'oauth_grant'],
  'oauth.consent.revoked': ['server', 'session', 'success', 'oauth_grant'],
  'oauth.refresh.reuse_detected': ['server', 'oauth', 'failure', 'oauth_grant'],
  'oauth.code.replayed': ['server', 'oauth', 'failure', 'oauth_code'],
  'oauth.authorize.denied': ['server', 'session', 'failure', 'oauth_client'],
  'vault.created': ['vault', 'session', 'success', 'vault'],
  'vault.updated': ['vault', 'session', 'success', 'vault'],
  'vault.archived': ['vault', 'session', 'success', 'vault'],
  'vault.restored': ['vault', 'session', 'success', 'vault'],
  'vault.settings.changed': ['vault', 'session', 'success', 'vault'],
  'vault.member.added': ['vault', 'session', 'success', 'user'],
  'vault.member.role_changed': ['vault', 'session', 'success', 'user'],
  'vault.member.removed': ['vault', 'session', 'success', 'user'],
  'node.created': ['vault', 'session', 'success', 'node'],
  'node.renamed': ['vault', 'session', 'success', 'node'],
  'node.moved': ['vault', 'session', 'success', 'node'],
  'node.trashed': ['vault', 'session', 'success', 'node'],
  'node.restored': ['vault', 'session', 'success', 'node'],
  'node.purged': ['vault', 'cli', 'success', 'node'],
  'note.revision.named': ['vault', 'session', 'success', 'note'],
  'note.revision.restored': ['vault', 'session', 'success', 'note'],
  'note.content.invalid': ['vault', 'system', 'failure', 'note'],
  'note.content.repaired': ['vault', 'cli', 'success', 'note'],
  'attachment.uploaded': ['vault', 'session', 'success', 'attachment'],
  'attachment.deleted': ['vault', 'session', 'success', 'attachment'],
  'export.created': ['vault', 'pat', 'success', 'export'],
  'import.scanned': ['vault', 'session', 'success', 'import'],
  'import.committed': ['vault', 'session', 'success', 'import'],
  'import.aborted': ['vault', 'session', 'success', 'import'],
  'admin.user.created': ['server', 'cli', 'success', 'user'],
  'admin.user.updated': ['server', 'session', 'success', 'user'],
  'admin.user.disabled': ['server', 'session', 'success', 'user'],
  'admin.user.enabled': ['server', 'session', 'success', 'user'],
  'admin.user.deleted': ['server', 'cli', 'success', 'user'],
  'admin.user.password_reset': ['server', 'session', 'success', 'user'],
  'admin.settings.changed': ['server', 'session', 'success', 'settings'],
  'admin.job.triggered': ['server', 'session', 'success', 'job'],
  'admin.job.cancelled': ['server', 'cli', 'success', 'job'],
  'admin.audit.exported': ['server', 'cli', 'success', 'audit'],
  'admin.backup.verified': ['server', 'cli', 'success', 'backup'],
  'admin.release.published': ['server', 'cli', 'success', 'release'],
  'admin.release.withdrawn': ['server', 'cli', 'success', 'release'],
  'mcp.access.denied': ['vault', 'pat', 'failure', 'note'],
  'collab.connection.rejected': ['vault', 'ticket', 'failure', 'note'],
  'collab.write.rejected': ['vault', 'ticket', 'failure', 'note'],
  'system.migration.applied': ['server', 'cli', 'success', 'migration'],
  'system.key.rotated': ['server', 'cli', 'success', 'key'],
  'system.audit.archived': ['server', 'system', 'success', 'chain'],
} as const satisfies Record<AuditAction, VocabularyCase>;

const ACTOR_ID = '0190f2a0-0000-7000-8000-0000000000ab';
const CREDENTIAL_ID = '0190f2a0-0000-7000-8000-0000000000ac';
const TARGET_ID = '0190f2a0-0000-7000-8000-0000000000ad';
const VAULT_ID = '0190f2a0-0000-7000-8000-0000000000ae';
const KEY = Buffer.from('audit-vocabulary-not-a-secret');
const KEYS: AuditKeys = {
  signingVersion: 1,
  keyFor: (version) => (version === 1 ? KEY : undefined),
};
const OCCURRED_AT = '2026-09-18T12:34:56.123000Z';

/** Rehydrate only the real compiler's INSERT bind values, as mysql2 does for JSON result columns. */
function storedRow(query: ExecutedQuery): Record<string, unknown> {
  const matched = /^insert into `audit_events` \(([^)]+)\) values/.exec(query.sql);
  if (matched?.[1] === undefined) throw new Error('Expected the actual audit INSERT.');
  const columns = matched[1].split(', ').map((column) => column.slice(1, -1));
  expect(columns).toHaveLength(query.parameters.length);
  const row: Record<string, unknown> = { id: 41 };
  for (const [index, column] of columns.entries()) row[column] = query.parameters[index];
  for (const column of ['context', 'metadata', 'targets']) {
    const serialized = row[column];
    if (typeof serialized === 'string') row[column] = JSON.parse(serialized) as unknown;
  }
  return row;
}

describe('audit.vocabulary.unit [area:audit]', () => {
  it('names every current action exactly once and admits no undeclared spelling', () => {
    expect(Object.keys(CASES).toSorted()).toEqual([...AUDIT_ACTIONS].toSorted());
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const invalid of [
      'note.deleted',
      'User.login.succeeded',
      'user.login.succeeded ',
      '__proto__',
      'toString',
    ]) {
      expect(AuditAction.safeParse(invalid).success).toBe(false);
    }
  });

  it.each(AUDIT_ACTIONS)(
    'round-trips %s through real writer binds, canonical bytes and verification',
    async (action) => {
      const [scope, credential, outcome, targetType] = CASES[action];
      const chainId = scope === 'vault' ? chainIdForVault(VAULT_ID) : 'server';
      const actorType =
        credential === 'cli' || credential === 'system'
          ? 'system'
          : credential === 'pat' || credential === 'oauth'
            ? 'token'
            : 'user';
      const attributed = actorType !== 'system' && credential !== 'none';
      const hasCredentialId = !['cli', 'system', 'none'].includes(credential);

      // Deliberately ordered by canonical key order, including nested objects. JSON.stringify is an
      // independent byte oracle here; neither the expected HMAC nor expected JSON uses product code.
      const payload: AuditChainPayload = {
        action,
        ...(attributed ? { actor_display: 'Auditor Ω', actor_id: ACTOR_ID } : {}),
        actor_type: actorType,
        chain_id: chainId,
        context: { client: 'web', request_id: 'vocabulary-row', user_agent: 'line\n"quoted"' },
        ...(hasCredentialId ? { credential_id: CREDENTIAL_ID } : {}),
        credential_type: credential,
        metadata: { after: { active: true, version: 2 }, before: { active: false, version: 1 } },
        occurred_at: OCCURRED_AT,
        outcome,
        prev_id: 0,
        ...(outcome === 'failure' ? { reason: 'fixture_denial' } : {}),
        schema_version: 1,
        target_id: TARGET_ID,
        target_type: targetType,
        targets: [{ id: TARGET_ID, type: targetType }],
        ...(scope === 'vault' ? { vault_id: VAULT_ID } : {}),
      };
      const expectedBytes = JSON.stringify(payload);
      const expectedHash = createHmac('sha256', KEY)
        .update(GENESIS_HASH)
        .update(expectedBytes, 'utf8')
        .digest();
      const state: { row: Record<string, unknown> | null; lastId: number; lastHash: Buffer } = {
        row: null,
        lastId: 0,
        lastHash: GENESIS_HASH,
      };
      const fake = fakeDatabase({
        script(query) {
          if (query.sql.startsWith('insert into `audit_chain_heads`'))
            return { numAffectedRows: 1n };
          if (query.sql.startsWith('insert into `audit_events`')) {
            state.row = storedRow(query);
            return { insertId: 41n };
          }
          if (query.sql.startsWith('update `audit_chain_heads`')) {
            const [lastId, lastHash] = query.parameters;
            if (typeof lastId !== 'number' || !Buffer.isBuffer(lastHash))
              throw new Error('Invalid head update.');
            state.lastId = lastId;
            state.lastHash = lastHash;
            return { numAffectedRows: 1n };
          }
          if (query.sql.includes('from `audit_chain_heads`')) {
            return { rows: [{ last_id: state.lastId, last_hash: state.lastHash }] };
          }
          if (
            query.sql.includes('from `audit_events`') ||
            query.sql.includes('FROM audit_events WHERE')
          )
            return { rows: state.row === null ? [] : [state.row] };
          throw new Error('Unexpected SQL in audit vocabulary fixture: ' + query.sql);
        },
      });
      try {
        const writer = new AuditWriter({ keys: KEYS, clock: new ManualClock(OCCURRED_AT) });
        const recorded = await fake.db.transaction().execute((transaction) =>
          writer.record(transaction, {
            action,
            actorType,
            actorId: attributed ? ACTOR_ID : null,
            actorDisplay: attributed ? 'Auditor Ω' : null,
            credentialType: credential,
            credentialId: hasCredentialId ? CREDENTIAL_ID : null,
            vaultId: scope === 'vault' ? VAULT_ID : null,
            targetType,
            targetId: TARGET_ID,
            targets: [{ type: targetType, id: TARGET_ID }],
            outcome,
            reason: outcome === 'failure' ? 'fixture_denial' : null,
            context: { user_agent: 'line\n"quoted"', request_id: 'vocabulary-row', client: 'web' },
            metadata: {
              before: { version: 1, active: false },
              after: { version: 2, active: true },
              absent: undefined,
            },
          }),
        );
        expect(AUDIT_ACTION_CHAIN[action]).toBe(scope);
        expect(AuditAction.parse(action)).toBe(action);
        expect(auditChainPreimage(payload)).toBe(expectedBytes);
        expect(recorded).toMatchObject({
          id: 41,
          chainId,
          hash: expectedHash,
          prevHash: GENESIS_HASH,
        });
        expect(state.row).toMatchObject({
          action,
          chain_id: chainId,
          actor_type: actorType,
          credential_type: credential,
          target_type: targetType,
          target_id: Buffer.from(idToBytes(TARGET_ID)),
          outcome,
          actor_id: attributed ? Buffer.from(idToBytes(ACTOR_ID)) : null,
          credential_id: hasCredentialId ? Buffer.from(idToBytes(CREDENTIAL_ID)) : null,
          vault_id: scope === 'vault' ? Buffer.from(idToBytes(VAULT_ID)) : null,
          context: payload.context,
          metadata: payload.metadata,
          targets: payload.targets,
          hash: expectedHash,
        });
        expect(fake.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
        expect(await verifyChain(fake.db, chainId, KEYS)).toEqual({
          chainId,
          rows: 1,
          lastId: 41,
          ok: true,
          divergence: null,
        });
      } finally {
        await fake.db.destroy();
      }
    },
  );
});
