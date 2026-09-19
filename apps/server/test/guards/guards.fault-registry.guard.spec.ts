/**
 * `guards.fault-registry.guard` — the product's fault registry and the testkit's point list are the same
 * list (10-testing-and-quality.md, "Fault injection: `IRIDIUM_FAULT`", and the guard table; D10-20).
 *
 * Tests spell fault points through `@iridium/testkit`'s `FAULT` constants and never as string literals,
 * and the product fires them by the same strings. Two lists that are only *meant* to agree drift in the
 * one direction nobody notices: a point renamed in the product makes every suite that armed it pass by
 * arming nothing at all, silently, because arming an unknown point is the harness's error and firing an
 * unarmed point is a no-op. So the guard compares them in both directions and additionally holds the two
 * halves of each descriptor — the `:<n>` meaning and the lifetime — equal, because a `counted` point the
 * product treats as `until-disarmed` is the same silent failure with a different shape.
 *
 * It proves it refuses the shape it exists to catch: the last case runs the same comparison over a
 * deliberately divergent pair of lists and asserts it reports the divergence, so the guard cannot pass
 * vacuously if the imports ever resolve to the same object.
 */
import { FAULT, FAULT_POINTS as TESTKIT_POINTS, pointFromConstantName } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { FAULT_POINT_NAMES, FAULT_POINTS as SERVER_POINTS } from '../../src/ops/faults.ts';

/** Sorted, so the comparison is of sets rather than of declaration order. */
function sortedNames(points: readonly { readonly point: string }[]): readonly string[] {
  return points.map((descriptor) => descriptor.point).toSorted((a, b) => a.localeCompare(b));
}

/** `point → {argument, lifetime}`, the two members both halves declare. */
function shapes(
  points: readonly {
    readonly point: string;
    readonly argument: string;
    readonly lifetime: string;
  }[],
): Map<string, string> {
  return new Map(points.map((d) => [d.point, `${d.argument}/${d.lifetime}`]));
}

/** The divergence report the guard is built on, so the last case can drive it on purpose. */
function divergence(
  left: readonly { readonly point: string }[],
  right: readonly { readonly point: string }[],
): readonly string[] {
  const leftNames = new Set(sortedNames(left));
  const rightNames = new Set(sortedNames(right));
  return [
    ...[...leftNames]
      .filter((name) => !rightNames.has(name))
      .map((name) => `only in the first: ${name}`),
    ...[...rightNames]
      .filter((name) => !leftNames.has(name))
      .map((name) => `only in the second: ${name}`),
  ];
}

describe('guards.fault-registry.guard [area:ops]', () => {
  it('declares the same point names in the product and in the testkit', () => {
    expect(sortedNames(SERVER_POINTS)).toEqual(sortedNames(TESTKIT_POINTS));
  });

  it('gives every point the same argument meaning and lifetime on both sides', () => {
    expect(Object.fromEntries(shapes(SERVER_POINTS))).toEqual(
      Object.fromEntries(shapes(TESTKIT_POINTS)),
    );
  });

  it('exposes a name list that matches its own descriptor table', () => {
    expect([...FAULT_POINT_NAMES].toSorted((a, b) => a.localeCompare(b))).toEqual(
      sortedNames(SERVER_POINTS),
    );
  });

  it('has a FAULT constant per point, spelled by the documented derivation', () => {
    // `storeCrashBeforeCommit` → `store.crash-before-commit`. Tests reference the constants, so a point
    // with no constant is a point no test can arm.
    const fromConstants = Object.entries(FAULT).map(([constant, point]) => {
      expect(pointFromConstantName(constant)).toBe(point);
      return point;
    });
    expect(fromConstants.toSorted((a, b) => a.localeCompare(b))).toEqual(
      sortedNames(SERVER_POINTS),
    );
  });

  it('reports a divergence when the two lists disagree', () => {
    // The guard proves it refuses the shape it exists to catch: if the comparison above ever became a
    // comparison of one list with itself, this case would fail.
    const missing = SERVER_POINTS.filter((descriptor) => descriptor.point !== 'store.throw');
    expect(divergence(SERVER_POINTS, missing)).toEqual(['only in the first: store.throw']);
    expect(divergence(SERVER_POINTS, SERVER_POINTS)).toEqual([]);
  });
});
