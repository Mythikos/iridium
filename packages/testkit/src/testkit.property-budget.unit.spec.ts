import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOSTILE_UNITS, hostileString, noteText, textInsertion } from './property/arbitraries.ts';
import { PROP, PROP_DB } from './property/config.ts';

/**
 * The two budgets and the shared arbitraries.
 *
 * The first case is a type test as much as a value test: `test.prop([a, b])(…, PROP)` takes an
 * `fc.Parameters<[A, B]>`, and a budget annotated `fc.Parameters<unknown>` is not assignable to one
 * — which is why `apps/server/test/property/token.effective-permissions.prop.spec.ts` had to carry a
 * local `dbBudget()` helper. The assignments below fail to compile if that regresses, so the check
 * runs in `tsc` as well as in the runner.
 */

describe('testkit.property-budget.unit [area:testkit]', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it('hands one budget to a property of any generated tuple', () => {
    const one: fc.Parameters<[string]> = PROP;
    const two: fc.Parameters<[string, number]> = PROP;
    const db: fc.Parameters<[Uint8Array, number]> = PROP_DB;

    expect(one.numRuns).toBe(PROP.numRuns);
    expect(two.markInterruptAsFailure).toBe(true);
    expect(db.numRuns).toBe(PROP_DB.numRuns);
  });

  it('never reports a truncated run as a pass', () => {
    // With `markInterruptAsFailure: false` fast-check abandons the run at the time limit and reports
    // success if it has not yet found a counterexample.
    expect(PROP.markInterruptAsFailure).toBe(true);
    expect(PROP_DB.markInterruptAsFailure).toBe(true);
    expect(PROP.interruptAfterTimeLimit).toBeGreaterThan(0);
    expect(PROP_DB.interruptAfterTimeLimit).toBeGreaterThan(0);
  });

  it('bounds the DB-backed command count separately from the run count', () => {
    expect(PROP_DB.maxCommands).toBeGreaterThan(0);
    expect(PROP_DB.numRuns).toBe(Number(process.env['IRIDIUM_PROP_DB_RUNS'] ?? 200));
    expect(PROP_DB.maxCommands).toBe(Number(process.env['IRIDIUM_PROP_DB_COMMANDS'] ?? 60));
  });

  it('curates an alphabet of the characters that actually break a Markdown pipeline', () => {
    for (const unit of ['\r', '\n', '\r\n', '﻿', '\t', '\0']) {
      expect(HOSTILE_UNITS).toContain(unit);
    }
    // Bidirectional controls, combining marks, astral pairs and Markdown sigils, one probe each.
    expect(HOSTILE_UNITS).toContain('‮');
    expect(HOSTILE_UNITS).toContain('́');
    expect(HOSTILE_UNITS).toContain('😀');
    expect(HOSTILE_UNITS).toContain('```');
  });

  it('generates hostile strings that reach the curated alphabet', () => {
    const samples = fc.sample(hostileString({ minLength: 40, maxLength: 80 }), {
      numRuns: 200,
      seed: 20260914,
    });
    expect(samples).toHaveLength(200);
    expect(samples.some((s) => [...HOSTILE_UNITS].some((unit) => s.includes(unit)))).toBe(true);
  });

  it('never generates a carriage return for text that goes into a Y.Text', () => {
    // Principle 5 and `collab.lf-invariant.guard`: `\r` never reaches the CRDT, so a generator that
    // produced one would be generating a state the product refuses rather than one it must survive.
    for (const sample of fc.sample(noteText({ maxLength: 120 }), { numRuns: 500, seed: 7 })) {
      expect(sample).not.toContain('\r');
    }
  });

  it('generates an insertion as a relative position, so a command outlives its document', () => {
    for (const insertion of fc.sample(textInsertion(), { numRuns: 100, seed: 11 })) {
      expect(insertion.at).toBeGreaterThanOrEqual(0);
      expect(insertion.at).toBeLessThanOrEqual(1);
      expect(insertion.text.length).toBeGreaterThan(0);
      expect(insertion.text).not.toContain('\r');
    }
  });

  it.each(['xsmall', 'small', 'medium', 'large', 'xlarge', 'max', '=', '+1', '+2', '-1'])(
    'reads the configured generation size %s when the budget module loads',
    async (size) => {
      vi.stubEnv('IRIDIUM_PROP_SIZE', size);
      vi.resetModules();
      const configured = await import('./property/config.ts');
      expect(configured.PROP_SIZE).toBe(size);
    },
  );

  it.each([undefined, 'invalid-size'])(
    'uses the shared default for an absent or unknown generation size: %s',
    async (size) => {
      vi.stubEnv('IRIDIUM_PROP_SIZE', size);
      vi.resetModules();
      const configured = await import('./property/config.ts');
      expect(configured.PROP_SIZE).toBe('=');
    },
  );
});
