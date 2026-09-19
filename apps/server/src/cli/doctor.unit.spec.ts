/**
 * `cli.doctor.unit` — the argon2 measurement, the single-instance check and the exit-code rule.
 *
 * The rule under test is S13's decision, which is verbatim that `iridium doctor --argon2` "is
 * specified to warn rather than hard-fail on a host that cannot reach the 150–300 ms window". So a
 * host below the floor and a host above the ceiling both produce `warn` with a remedy, and neither
 * turns the command's exit code into `6` — only a `fail` does, and at M1 the only check that can fail
 * is `yjs_instances`, where a second Yjs copy is a build regression rather than a tuning note.
 *
 * The binding and the clock are injected, so the suite measures the *rule* rather than this machine:
 * hashing twenty times with the real argon2 would take several seconds and would assert the host.
 */
import { describe, expect, it } from 'vitest';

import type { Clock, TimerHandle } from '../ops/clock.ts';
import {
  ARGON2_SAMPLES,
  ARGON2_WINDOW_MS,
  argon2Check,
  DOCTOR_RESERVED_CHECKS,
  measureArgon2,
  percentile,
  reportChecks,
  yjsInstancesCheck,
  type DoctorCheck,
} from './doctor.ts';
import { EXIT } from './exit.ts';
import { BufferedIo } from './output.ts';

/** A clock whose monotonic reading advances by a scripted amount on every other call. */
class ScriptedClock implements Clock {
  readonly #steps: readonly number[];
  #reading = 0;
  #sample = 0;

  constructor(steps: readonly number[]) {
    this.#steps = steps;
  }

  now(): number {
    return this.#reading;
  }

  date(): Date {
    return new Date(this.#reading);
  }

  /** Even calls open a sample, odd calls close it by advancing the scripted duration. */
  monotonic(): number {
    const opening = this.#sample % 2 === 0;
    this.#sample += 1;
    if (opening) return this.#reading;
    this.#reading += this.#steps[Math.floor((this.#sample - 1) / 2) % this.#steps.length] ?? 0;
    return this.#reading;
  }

  after(_ms: number, _fn: () => void): TimerHandle {
    return { cancel: () => undefined };
  }

  every(_ms: number, _fn: () => void): TimerHandle {
    return { cancel: () => undefined };
  }
}

/** A measurement of `samples` hashes that each took `durations[i]` milliseconds. */
async function measure(durations: readonly number[]) {
  return measureArgon2({
    memoryKib: 131_072,
    timeCost: 6,
    samples: durations.length,
    clock: new ScriptedClock(durations),
    hash: () => Promise.resolve('$argon2id$v=19$m=131072,t=6,p=1$c2FsdA$aGFzaA'),
  });
}

describe('cli.doctor.unit [area:ops]', () => {
  describe('percentile', () => {
    it('interpolates linearly, as S13’s harness does', () => {
      expect(percentile([10, 20, 30, 40], 50)).toBe(25);
      expect(percentile([10, 20, 30, 40], 0)).toBe(10);
      expect(percentile([10, 20, 30, 40], 100)).toBe(40);
    });

    it('answers a single sample as itself and an empty list as NaN', () => {
      expect(percentile([7], 95)).toBe(7);
      expect(Number.isNaN(percentile([], 50))).toBe(true);
    });
  });

  describe('measureArgon2', () => {
    it('times each hash sequentially and reports p50 and p95 of the durations', async () => {
      const measurement = await measure([200, 210, 220, 230]);
      expect(measurement.samples).toBe(4);
      expect(measurement.p50Ms).toBe(215);
      expect(measurement.p95Ms).toBeCloseTo(228.5, 5);
      expect(measurement.memoryKib).toBe(131_072);
      expect(measurement.timeCost).toBe(6);
      expect(measurement.parallelism).toBe(1);
    });

    it('hashes the configured pair, so the figure is the cost a login pays', async () => {
      const seen: { memoryCost: number; timeCost: number }[] = [];
      await measureArgon2({
        memoryKib: 65_536,
        timeCost: 3,
        samples: 2,
        clock: new ScriptedClock([50]),
        hash: (_password, params) => {
          seen.push({ memoryCost: params.memoryCost, timeCost: params.timeCost });
          return Promise.resolve('phc');
        },
      });
      expect(seen).toEqual([
        { memoryCost: 65_536, timeCost: 3 },
        { memoryCost: 65_536, timeCost: 3 },
      ]);
    });

    it('defaults to the sample count S13 measured with', () => {
      expect(ARGON2_SAMPLES).toBe(20);
    });
  });

  describe('argon2Check warns, and never fails, outside the window', () => {
    it('is ok inside 150–300 ms and carries no remedy', async () => {
      const check = argon2Check(await measure([200, 210, 220, 230]));
      expect(check).toMatchObject({ name: 'argon2', status: 'ok', remedy: null });
      expect(check.detail).toContain('p50 215.0 ms');
      expect(check.detail).toContain('target 150–300 ms');
    });

    it('warns below the floor and says which knob to raise', async () => {
      const check = argon2Check(await measure([48, 49, 50, 51]));
      expect(check.status).toBe('warn');
      expect(check.remedy).toContain('raise ARGON2_MEMORY_KIB');
      expect(check.remedy).toContain('131072 / 6');
    });

    it('warns above the ceiling and says which knob to lower', async () => {
      const check = argon2Check(await measure([800, 810, 820, 830]));
      expect(check.status).toBe('warn');
      expect(check.remedy).toContain('lower ARGON2_TIME_COST');
      expect(check.remedy).toContain('UV_THREADPOOL_SIZE');
    });

    it('treats the two boundary values as inside the window', async () => {
      const floor = argon2Check(await measure([ARGON2_WINDOW_MS.floor]));
      const ceiling = argon2Check(await measure([ARGON2_WINDOW_MS.ceiling]));
      expect(floor.status).toBe('ok');
      expect(ceiling.status).toBe('ok');
    });
  });

  describe('yjsInstancesCheck', () => {
    it('passes in this process, where exactly one Yjs copy is loaded', () => {
      const check = yjsInstancesCheck();
      expect(check.status).toBe('ok');
      expect(check.remedy).toBeNull();
    });
  });

  describe('reportChecks decides the exit code', () => {
    const ok: DoctorCheck = { name: 'argon2', status: 'ok', detail: 'in window', remedy: null };
    const warn: DoctorCheck = {
      name: 'argon2',
      status: 'warn',
      detail: 'out of window',
      remedy: 'raise ARGON2_MEMORY_KIB',
    };
    const fail: DoctorCheck = {
      name: 'yjs_instances',
      status: 'fail',
      detail: 'two copies',
      remedy: 'pnpm why yjs',
    };

    it('exits 0 for ok, and 0 for a warning, which is what S13 specifies', () => {
      expect(reportChecks(new BufferedIo(), [ok], false)).toBe(EXIT.success);
      expect(reportChecks(new BufferedIo(), [ok, warn], false)).toBe(EXIT.success);
    });

    it('exits 6 as soon as one check fails', () => {
      expect(reportChecks(new BufferedIo(), [ok, warn, fail], false)).toBe(EXIT.findings);
    });

    it('prints the table on stdout and the remedies under it', () => {
      const io = new BufferedIo();
      reportChecks(io, [ok, warn], false);
      expect(io.stdout).toContain('check');
      expect(io.stdout).toContain('out of window');
      expect(io.stdout).toContain('remedies');
      expect(io.stdout).toContain('argon2: raise ARGON2_MEMORY_KIB');
      expect(io.stderr).toBe('');
    });

    it('prints `{checks:[…]}` under --json, and nothing else', () => {
      const io = new BufferedIo();
      reportChecks(io, [ok, warn], true);
      expect(JSON.parse(io.stdout)).toEqual({ checks: [ok, warn] });
    });
  });

  describe('the reserved check table', () => {
    it('names every check of 11’s table that this build does not carry', () => {
      expect(DOCTOR_RESERVED_CHECKS).toContain('triggers');
      expect(DOCTOR_RESERVED_CHECKS).toContain('db-roles');
      expect(DOCTOR_RESERVED_CHECKS).toContain('verify-note');
      // The three this build *does* carry are absent, or a runbook would be told they are missing.
      expect(DOCTOR_RESERVED_CHECKS).not.toContain('argon2');
      expect(DOCTOR_RESERVED_CHECKS).not.toContain('yjs-instances');
      expect(DOCTOR_RESERVED_CHECKS).not.toContain('repair-content');
    });
  });
});
