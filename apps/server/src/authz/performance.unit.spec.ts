/** The real preloaded-row authorization path's no-I/O micro-budget (10-testing-and-quality.md). */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { arch, availableParallelism, platform } from 'node:os';
import { join, resolve } from 'node:path';

import {
  SessionId,
  TokenId,
  UserId,
  VaultId,
  type Decision,
  type Permission,
  type Principal,
  type TokenPrincipal,
  type UserPrincipal,
} from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { createAuthorizer, type AuthzScope } from './authorize.ts';

const CALL_BUDGET_US = 50;
const CALLS_PER_BATCH = 256;
const BATCHES_PER_CASE = 20;
const WARMUP_CALLS = 128;
const STEP_UP_WINDOW_MS = 600_000;
const NOW = 1_000_000_000;
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const OTHER = VaultId.parse('019948c4-0000-7000-8000-0000000000b0');
const USER: UserPrincipal = {
  kind: 'user',
  userId: UserId.parse('019948c4-0000-7000-8000-000000000001'),
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
  sessionKind: 'web',
  isServerAdmin: false,
  authzVersion: 1,
  lastAuthenticatedAt: new Date(NOW),
};
const TOKEN: TokenPrincipal = {
  kind: 'token',
  tokenKind: 'pat',
  tokenId: TokenId.parse('019948c4-0000-7000-8000-00000000f001'),
  publicTokenId: 'ABCDEFGHIJKLMNOP',
  userId: USER.userId,
  clientId: null,
  consentId: null,
  resource: null,
  scopes: ['vault:read', 'note:read'],
  vaultScope: { vaultIds: [VAULT] },
  isServerAdmin: false,
  adminOwned: false,
  surface: 'rest',
  rateLimitPerHour: 3_000,
  expiresAt: new Date(NOW + 1),
};
const ACTIVE_VAULT = { id: VAULT, status: 'active', mcp_enabled: true } as const;
const EDITOR_SCOPE: AuthzScope = {
  vault: ACTIVE_VAULT,
  member: { role: 'editor', version: 1 },
  surface: 'rest',
};
interface Case {
  readonly name: string;
  readonly principal: Principal;
  readonly permission: Permission;
  readonly scope: AuthzScope;
  readonly expected: Decision;
}
const CASES: readonly Case[] = [
  {
    name: 'editor write',
    principal: USER,
    permission: 'note:write',
    scope: EDITOR_SCOPE,
    expected: 'allow',
  },
  {
    name: 'viewer write refusal',
    principal: USER,
    permission: 'note:write',
    scope: { ...EDITOR_SCOPE, member: { role: 'viewer', version: 1 } },
    expected: { deny: 'forbidden' },
  },
  {
    name: 'missing membership',
    principal: USER,
    permission: 'note:read',
    scope: { ...EDITOR_SCOPE, member: null },
    expected: { deny: 'not_found' },
  },
  {
    name: 'archived write refusal',
    principal: USER,
    permission: 'note:write',
    scope: { ...EDITOR_SCOPE, vault: { ...ACTIVE_VAULT, status: 'archived' } },
    expected: { deny: 'forbidden' },
  },
  {
    name: 'token read',
    principal: TOKEN,
    permission: 'note:read',
    scope: { ...EDITOR_SCOPE, surface: 'mcp' },
    expected: 'allow',
  },
  {
    name: 'token scope refusal',
    principal: { ...TOKEN, scopes: ['vault:read'] },
    permission: 'note:read',
    scope: EDITOR_SCOPE,
    expected: { deny: 'forbidden' },
  },
  {
    name: 'token allowlist refusal',
    principal: { ...TOKEN, vaultScope: { vaultIds: [OTHER] } },
    permission: 'note:read',
    scope: EDITOR_SCOPE,
    expected: { deny: 'not_found' },
  },
  {
    name: 'administrator server permission',
    principal: { ...USER, isServerAdmin: true },
    permission: 'server:users',
    scope: { requireStepUp: true },
    expected: 'allow',
  },
  {
    name: 'expired step-up',
    principal: { ...USER, lastAuthenticatedAt: new Date(NOW - STEP_UP_WINDOW_MS - 1) },
    permission: 'vault:archive',
    scope: { ...EDITOR_SCOPE, member: { role: 'manager', version: 1 }, requireStepUp: true },
    expected: { deny: 'step_up_required' },
  },
];

function decisionKey(decision: Decision): string {
  return decision === 'allow' ? 'allow' : decision.deny;
}

describe('authz.performance.unit [area:authz]', () => {
  it('keeps every preloaded authorization path below 50 microseconds per call with no lookup', async () => {
    let lookups = 0;
    const authorizer = createAuthorizer({
      lookup: async () => {
        lookups += 1;
        throw new Error('The preloaded authorization micro-budget must perform no I/O.');
      },
      now: () => NOW,
      stepUpWindowMs: STEP_UP_WINDOW_MS,
      mcpServerEnabled: () => true,
    });
    const measurements: Array<{
      name: string;
      expected: string;
      calls: number;
      microsecondsPerCall: number;
      batchesNs: number[];
    }> = [];
    for (const scenario of CASES) {
      const expected = decisionKey(scenario.expected);
      for (let index = 0; index < WARMUP_CALLS; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- warm up the same sequential production call measured below
        const decision = await authorizer.authorize(
          scenario.principal,
          scenario.permission,
          scenario.scope,
        );
        expect(decisionKey(decision)).toBe(expected);
      }
      const batchesNs: number[] = [];
      let correctDecisions = 0;
      for (let batch = 0; batch < BATCHES_PER_CASE; batch += 1) {
        const started = process.hrtime.bigint();
        for (let index = 0; index < CALLS_PER_BATCH; index += 1) {
          // eslint-disable-next-line no-await-in-loop -- per-call latency includes the real async wrapper, never Promise.all throughput
          const decision = await authorizer.authorize(
            scenario.principal,
            scenario.permission,
            scenario.scope,
          );
          if (decisionKey(decision) === expected) correctDecisions += 1;
        }
        batchesNs.push(Number(process.hrtime.bigint() - started));
      }
      const calls = BATCHES_PER_CASE * CALLS_PER_BATCH;
      expect(correctDecisions).toBe(calls);
      measurements.push({
        name: scenario.name,
        expected,
        calls,
        microsecondsPerCall:
          batchesNs.reduce((total, elapsed) => total + elapsed, 0) / calls / 1_000,
        batchesNs,
      });
    }
    const root = resolve(import.meta.dirname, '../../../../');
    const directory = join(root, 'reports/perf');
    mkdirSync(directory, { recursive: true });
    const value = Math.max(...measurements.map((measurement) => measurement.microsecondsPerCall));
    const report = {
      metric: 'authz.authorize.microseconds_per_call',
      value,
      unit: 'microseconds',
      gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sourceSha256: createHash('sha256')
        .update(readFileSync(new URL('./authorize.ts', import.meta.url)))
        .digest('hex'),
      runnerClass: `${platform()}/${arch()}/${String(availableParallelism())}-cpu-affinity`,
      date: new Date().toISOString(),
      node: process.version,
      budgetMicroseconds: CALL_BUDGET_US,
      calculation:
        'maximum per-scenario mean of sequential awaited calls; timer and decision checksum overhead included',
      warmupCallsPerScenario: WARMUP_CALLS,
      callsPerBatch: CALLS_PER_BATCH,
      batchesPerScenario: BATCHES_PER_CASE,
      lookups,
      measurements,
    };
    appendFileSync(
      join(directory, `authz-performance-${String(process.pid)}.jsonl`),
      JSON.stringify(report) + '\n',
    );
    console.info(
      JSON.stringify({ metric: report.metric, value, budgetMicroseconds: CALL_BUDGET_US, lookups }),
    );
    expect(lookups).toBe(0);
    for (const measurement of measurements)
      expect(measurement.microsecondsPerCall, measurement.name).toBeLessThan(CALL_BUDGET_US);
  });
});
