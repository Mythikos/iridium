/**
 * `cli.attribution.unit` — the audit context and the system principal a CLI mutation carries.
 *
 * OPS-19 is one sentence and these are its checkable halves: the context carries `os_user`, `host`,
 * `request_id` and `argv_shape` and **nothing that belongs to a request**, and the principal a service
 * is handed is a system one whose `job` names the command. The `--actor` half needs a `users` row and
 * is asserted in `cli.audit-coverage.integration`, against the database rather than against a double.
 */
import { UserId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { cliAuditContext, cliPrincipal, newRequestId, SYSTEM_ACTOR } from './attribution.ts';

/** A branded id parsed rather than cast, so the fixture proves the same thing the product does. */
const ADMIN_ID = UserId.parse('018f2b1e-0000-7000-8000-0000000000aa');

describe('cli.attribution.unit [area:ops]', () => {
  describe('the audit context (OPS-19)', () => {
    it('carries os_user, host, request_id and argv_shape', () => {
      const context = cliAuditContext({
        requestId: 'a-request-id',
        argvShape: 'admin create-user --email <value>',
      });
      expect(context.request_id).toBe('a-request-id');
      expect(context.argv_shape).toBe('admin create-user --email <value>');
      expect(typeof context.host).toBe('string');
      expect(context.host).not.toBe('');
      // `os_user` is `null` only where the platform cannot name one (a container on an arbitrary uid).
      expect(context.os_user === null || typeof context.os_user === 'string').toBe(true);
    });

    it('omits the four members that belong to a request, rather than nulling them', () => {
      const context = cliAuditContext({ requestId: 'r', argvShape: 'version' });
      // Absent and `null` are distinguishable in the stored JSON and in the hashed pre-image, and
      // "this surface has no such thing" is the honest one for a command run at a terminal.
      expect('ip' in context).toBe(false);
      expect('user_agent' in context).toBe(false);
      expect('client' in context).toBe(false);
      expect('mcp_client' in context).toBe(false);
    });

    it('never carries a value from the command line, only the shape', () => {
      const context = cliAuditContext({
        requestId: 'r',
        argvShape: 'admin create-user --email <value> --display-name <value>',
      });
      expect(JSON.stringify(context)).not.toContain('@');
    });
  });

  describe('newRequestId', () => {
    it('is a fresh id per invocation, so one run’s rows correlate and two runs do not', () => {
      expect(newRequestId()).not.toBe(newRequestId());
    });
  });

  describe('the default actor', () => {
    it('is a system actor attributable to no human, which is what an operator is', () => {
      expect(SYSTEM_ACTOR).toEqual({
        actorType: 'system',
        actorId: null,
        actorDisplay: null,
        userId: null,
      });
    });
  });

  describe('cliPrincipal', () => {
    it('names the command in `job`, prefixed `cli:` (D04-21)', () => {
      const principal = cliPrincipal('admin create-user', SYSTEM_ACTOR);
      expect(principal).toEqual({ kind: 'system', job: 'cli:admin create-user' });
    });

    it('carries the resolved administrator as `onBehalfOf`, and omits it otherwise', () => {
      const withActor = cliPrincipal('sessions revoke-all', {
        actorType: 'user',
        actorId: ADMIN_ID,
        actorDisplay: 'Ops Team',
        userId: ADMIN_ID,
      });
      expect(withActor).toMatchObject({ onBehalfOf: ADMIN_ID });
      expect('onBehalfOf' in cliPrincipal('sessions revoke-all', SYSTEM_ACTOR)).toBe(false);
    });
  });
});
