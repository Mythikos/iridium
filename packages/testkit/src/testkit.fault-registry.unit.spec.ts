import { describe, expect, it } from 'vitest';

import {
  FAULT_CONTROL_PATH,
  FAULT_ENV_VAR,
  assertValidFaultSpec,
  formatFaultEnv,
  formatFaultSpec,
  parseFaultEnv,
  parseFaultSpec,
} from './faults/control.ts';
import { FAULT, FAULT_POINTS, describeFault, pointFromConstantName } from './faults/points.ts';

describe('testkit.fault-registry.unit [area:testkit]', () => {
  it('derives every point string from its constant name', () => {
    for (const descriptor of FAULT_POINTS) {
      expect(pointFromConstantName(descriptor.constant)).toBe(descriptor.point);
    }
  });

  it('keeps FAULT and the registry in step', () => {
    expect(Object.keys(FAULT).toSorted()).toStrictEqual(
      FAULT_POINTS.map((d) => d.constant).toSorted(),
    );
    for (const descriptor of FAULT_POINTS) {
      expect(FAULT[descriptor.constant]).toBe(descriptor.point);
    }
  });

  it('names every point and every constant exactly once', () => {
    expect(new Set(FAULT_POINTS.map((d) => d.point)).size).toBe(FAULT_POINTS.length);
    expect(new Set(FAULT_POINTS.map((d) => d.constant)).size).toBe(FAULT_POINTS.length);
  });

  it('carries the points the fault table of 10-testing-and-quality.md specifies', () => {
    expect(FAULT_POINTS.map((d) => d.point)).toStrictEqual([
      'tree.hold-after-commit-before-notify',
      'tree.crash-after-commit-before-notify',
      'store.throw',
      'store.throw-after-commit-before-ack',
      'store.crash-before-commit',
      'store.crash-after-commit-before-ack',
      'store.hold-before-commit',
      'store.slow',
      'store.kill-after-ack',
      'compact.throw',
      'compact.snapshot-oversize',
      'sv.not-recorded',
      'ws.drop-after-ack',
      'auth.slow',
      'auth.command-after-commit',
      'mcp.skip-ignore-cookies',
    ]);
  });

  it('describes a registered point and refuses an unregistered one', () => {
    expect(describeFault(FAULT.storeSlow)?.argument).toBe('milliseconds');
    expect(describeFault('store.explode')).toBeUndefined();
  });

  it('renders and parses the IRIDIUM_FAULT spellings of the plan', () => {
    expect(formatFaultSpec({ point: FAULT.storeSlow, arg: 3000 })).toBe('store.slow:3000');
    expect(formatFaultSpec({ point: FAULT.storeThrow, count: 2 })).toBe('store.throw:2');
    expect(formatFaultSpec({ point: FAULT.wsDropAfterAck })).toBe('ws.drop-after-ack');
    expect(
      formatFaultEnv([{ point: FAULT.storeSlow, arg: 3000 }, { point: FAULT.wsDropAfterAck }]),
    ).toBe('store.slow:3000,ws.drop-after-ack');
  });

  it('round-trips every spelling it renders', () => {
    const specs = [
      { point: FAULT.storeSlow, arg: 3000 },
      { point: FAULT.authSlow, arg: 250 },
      { point: FAULT.storeThrow, count: 1 },
      { point: FAULT.compactThrow },
      { point: FAULT.storeKillAfterAck },
    ] as const;
    expect(parseFaultEnv(formatFaultEnv([...specs]))).toStrictEqual([...specs]);
    expect(parseFaultSpec('store.slow:3000')).toStrictEqual({ point: 'store.slow', arg: 3000 });
    expect(parseFaultSpec('store.throw:4')).toStrictEqual({ point: 'store.throw', count: 4 });
    expect(parseFaultEnv('')).toStrictEqual([]);
  });

  it('refuses a spec the registry cannot honour', () => {
    expect(() => parseFaultSpec('store.explode')).toThrow(/names no registered fault point/);
    expect(() => assertValidFaultSpec({ point: FAULT.storeSlow })).toThrow(/requires a duration/);
    expect(() => assertValidFaultSpec({ point: FAULT.wsDropAfterAck, arg: 5 })).toThrow(
      /takes no argument/,
    );
    expect(() => assertValidFaultSpec({ point: FAULT.storeKillAfterAck, count: 2 })).toThrow(
      /is one-shot, so it takes no count/,
    );
    expect(() => assertValidFaultSpec({ point: FAULT.storeSlow, arg: -1 })).toThrow(
      /must be an integer >= 0/,
    );
    expect(() => assertValidFaultSpec({ point: FAULT.storeThrow, count: 0 })).toThrow(
      /must be an integer >= 1/,
    );
    expect(() => parseFaultSpec('store.slow:soon')).toThrow(/non-numeric argument/);
  });

  it('points at the test-only control surface by name, never by literal', () => {
    expect(FAULT_CONTROL_PATH).toBe('/__test__/faults');
    expect(FAULT_ENV_VAR).toBe('IRIDIUM_FAULT');
  });

  it('validates runtime acknowledgement selectors without silently losing them in an environment spec', () => {
    const noteId = '01980000-0000-7000-8000-000000000001';
    const spec = { point: FAULT.storeKillAfterAck, ack: { noteId, afterSeq: 4 } };
    expect(assertValidFaultSpec(spec)).toEqual(spec);
    expect(() => formatFaultSpec(spec)).toThrow(/require runtime fault control/);
    expect(() => assertValidFaultSpec({ ...spec, point: FAULT.storeThrow })).toThrow(
      /takes no acknowledgement selector/,
    );
    expect(() => assertValidFaultSpec({ ...spec, ack: { noteId: 'bad', afterSeq: 4 } })).toThrow(
      /UUID/i,
    );
    for (const afterSeq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => assertValidFaultSpec({ ...spec, ack: { noteId, afterSeq } })).toThrow(
        /non-negative safe integer/,
      );
  });
});
