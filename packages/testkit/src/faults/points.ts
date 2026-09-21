/**
 * The `IRIDIUM_FAULT` point registry, mirrored from the product's `apps/server/src/ops/faults.ts`
 * (10-testing-and-quality.md, "Fault injection: `IRIDIUM_FAULT`"; 05-collaboration-and-durability.md).
 *
 * Tests reference points through `FAULT`, never as string literals, and
 * `guards.fault-registry.guard.spec.ts` asserts that this list and the server's are identical.
 * The point string is mechanically derived from the constant name — `storeCrashBeforeCommit` →
 * `store.crash-before-commit` — and `testkit.fault-registry.unit` asserts the derivation, so a typo in
 * either half fails before it reaches a chaos lane.
 */

/**
 * The constants tests spell. Point strings never appear as literals in a test
 * (10-testing-and-quality.md, "Fault injection": *"never as string literals in tests"*).
 */
export const FAULT = {
  treeHoldAfterCommitBeforeNotify: 'tree.hold-after-commit-before-notify',
  treeCrashAfterCommitBeforeNotify: 'tree.crash-after-commit-before-notify',
  storeThrow: 'store.throw',
  storeThrowAfterCommitBeforeAck: 'store.throw-after-commit-before-ack',
  storeCrashBeforeCommit: 'store.crash-before-commit',
  storeCrashAfterCommitBeforeAck: 'store.crash-after-commit-before-ack',
  storeSlow: 'store.slow',
  storeHoldBeforeCommit: 'store.hold-before-commit',
  storeKillAfterAck: 'store.kill-after-ack',
  compactThrow: 'compact.throw',
  compactSnapshotOversize: 'compact.snapshot-oversize',
  svNotRecorded: 'sv.not-recorded',
  wsDropAfterAck: 'ws.drop-after-ack',
  authSlow: 'auth.slow',
  authCommandAfterCommit: 'auth.command-after-commit',
  mcpSkipIgnoreCookies: 'mcp.skip-ignore-cookies',
} as const;

/** Every point string in the registry. */
export type FaultPoint = (typeof FAULT)[keyof typeof FAULT];

/** Every `FAULT` key. */
export type FaultConstantName = keyof typeof FAULT;

/** How a point's `:<n>` suffix is read. */
export type FaultArgument = 'none' | 'milliseconds';

/** How long an armed point stays armed. */
export type FaultLifetime = 'one-shot' | 'per-connection' | 'counted' | 'until-disarmed';

export interface FaultPointDescriptor {
  /** The wire string: the `point` field of `POST /__test__/faults` and a member of `IRIDIUM_FAULT`. */
  readonly point: FaultPoint;
  /** The `FAULT` key tests spell. */
  readonly constant: FaultConstantName;
  /** What a `:<n>` suffix means for this point. */
  readonly argument: FaultArgument;
  /** Whether the point disarms itself, counts down, or stays until `DELETE /__test__/faults`. */
  readonly lifetime: FaultLifetime;
  /** Where in the product the point fires. */
  readonly firesIn: string;
  /** The plan section that specifies it. */
  readonly specifiedIn: string;
}

/**
 * The registry, in the order of the fault table of 10-testing-and-quality.md followed by the two
 * points 05-collaboration-and-durability.md adds and the one 04/06 add for the MCP cookie layers.
 */
export const FAULT_POINTS: readonly FaultPointDescriptor[] = [
  {
    point: 'tree.hold-after-commit-before-notify',
    constant: 'treeHoldAfterCommitBeforeNotify',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn:
      'hold a committed trash before note closure and tree notifications until explicit disarm',
    specifiedIn: '05-collaboration-and-durability.md, Trash crash-window reconciliation',
  },
  {
    point: 'tree.crash-after-commit-before-notify',
    constant: 'treeCrashAfterCommitBeforeNotify',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: 'after the trash transaction COMMIT, before note closure and tree notifications',
    specifiedIn: '12-milestones.md §6.2, lifecycle completion crash window',
  },
  {
    point: 'store.throw',
    constant: 'storeThrow',
    argument: 'none',
    lifetime: 'counted',
    firesIn: 'NoteWriter.flush() before BEGIN',
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'store.throw-after-commit-before-ack',
    constant: 'storeThrowAfterCommitBeforeAck',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn:
      'discard the successful COMMIT result before the writer acknowledges it, without exiting',
    specifiedIn: '05-collaboration-and-durability.md, Failure handling, retry and persist-failed',
  },
  {
    point: 'store.crash-before-commit',
    constant: 'storeCrashBeforeCommit',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: 'inside the writer transaction, after INSERT … note_updates, before COMMIT',
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'store.crash-after-commit-before-ack',
    constant: 'storeCrashAfterCommitBeforeAck',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: "after COMMIT, before broadcastStateless({t:'persisted'})",
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'store.hold-before-commit',
    constant: 'storeHoldBeforeCommit',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: 'hold one writer transaction before COMMIT until the harness disarms the point',
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'store.slow',
    constant: 'storeSlow',
    argument: 'milliseconds',
    lifetime: 'until-disarmed',
    firesIn: 'await delay(ms) inside the transaction, after the insert, before COMMIT',
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'store.kill-after-ack',
    constant: 'storeKillAfterAck',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: 'the /collab socket layer, immediately after `persisted` is written to the wire',
    specifiedIn: '10-testing-and-quality.md, Fault injection (CH-1)',
  },
  {
    point: 'compact.throw',
    constant: 'compactThrow',
    argument: 'none',
    lifetime: 'counted',
    firesIn: 'Compactor.run() before writing the snapshot',
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'compact.snapshot-oversize',
    constant: 'compactSnapshotOversize',
    argument: 'none',
    lifetime: 'until-disarmed',
    firesIn: 'the compactor snapshot guard, arming the 64 MB refusal without a 64 MB document',
    specifiedIn: '05-collaboration-and-durability.md, Additional fault points',
  },
  {
    point: 'sv.not-recorded',
    constant: 'svNotRecorded',
    argument: 'none',
    lifetime: 'until-disarmed',
    firesIn: 'the writer, forcing the recorded state vector to degrade to zero length (D03-01)',
    specifiedIn: '05-collaboration-and-durability.md, Additional fault points',
  },
  {
    point: 'ws.drop-after-ack',
    constant: 'wsDropAfterAck',
    argument: 'none',
    lifetime: 'per-connection',
    firesIn: 'the /collab socket layer, after `persisted` is written to the wire',
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'auth.slow',
    constant: 'authSlow',
    argument: 'milliseconds',
    lifetime: 'until-disarmed',
    firesIn: 'onAuthenticate',
    specifiedIn: '10-testing-and-quality.md, Fault injection',
  },
  {
    point: 'auth.command-after-commit',
    constant: 'authCommandAfterCommit',
    argument: 'milliseconds',
    lifetime: 'one-shot',
    firesIn: 'the owner session command relay after COMMIT, before live revocation delivery',
    specifiedIn: '04-auth-and-access-control.md, Owner-executed CLI session commands',
  },
  {
    point: 'mcp.skip-ignore-cookies',
    constant: 'mcpSkipIgnoreCookies',
    argument: 'none',
    lifetime: 'until-disarmed',
    firesIn: 'the /mcp and /mcp/connect route-level `ignoreCookies` hook, which it skips',
    specifiedIn: '04-auth-and-access-control.md D04-28; 06-mcp-and-agent-access.md',
  },
];

/**
 * The point string a constant name implies: the leading camelCase word is the domain, the rest is
 * kebab-cased. This is the rule `FAULT` and `FAULT_POINTS` are both written against.
 */
export function pointFromConstantName(constant: string): string {
  const kebab = constant.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const firstDash = kebab.indexOf('-');
  if (firstDash === -1) {
    return kebab;
  }
  return `${kebab.slice(0, firstDash)}.${kebab.slice(firstDash + 1)}`;
}

/** The descriptor for a point, or `undefined` when the point is not in the registry. */
export function describeFault(point: string): FaultPointDescriptor | undefined {
  return FAULT_POINTS.find((d) => d.point === point);
}
