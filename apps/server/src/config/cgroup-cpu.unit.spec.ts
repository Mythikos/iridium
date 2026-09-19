/** CPU worker defaults follow the process quota on both cgroup layouts (OPS-58). */
import type * as FileSystem from 'node:fs';
import { readFileSync } from 'node:fs';
import type * as OperatingSystem from 'node:os';
import { availableParallelism } from 'node:os';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cgroupQuota, defaultProjectionWorkers, resolveCpuCeiling } from './cgroup-cpu.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, readFileSync: vi.fn<typeof readFileSync>() };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof OperatingSystem>();
  return { ...actual, availableParallelism: vi.fn<typeof availableParallelism>() };
});

const V2 = '/sys/fs/cgroup/cpu.max';
const V1_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const V1_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

function files(values: Readonly<Record<string, string>>): void {
  vi.mocked(readFileSync).mockImplementation((path) => {
    const value = values[String(path)];
    if (value === undefined)
      throw Object.assign(new Error('unreadable cgroup file'), { code: 'ENOENT' });
    return value;
  });
}

beforeEach(() => {
  files({});
  vi.mocked(availableParallelism).mockReturnValue(16);
});

describe('config.cgroup-cpu.unit [area:ops]', () => {
  it.each([
    { value: '200000 100000', expected: 2 },
    { value: '  150000\t100000\n', expected: 1.5 },
    { value: '50000 100000', expected: 0.5 },
  ])('reads the v2 quota $value without rounding it', ({ value, expected }) => {
    files({ [V2]: value });
    expect(cgroupQuota()).toBe(expected);
    expect(vi.mocked(readFileSync).mock.calls).toEqual([[V2, 'utf8']]);
  });

  it.each([
    'max 100000',
    '',
    '200000',
    'bad 100000',
    'Infinity 100000',
    '200000 bad',
    '200000 Infinity',
    '200000 0',
    '200000 -1',
    '0 100000',
    '-1 100000',
  ])('treats the v2 value %j as unbounded and never falls back to unrelated v1 files', (value) => {
    files({ [V2]: value, [V1_QUOTA]: '100000', [V1_PERIOD]: '100000' });
    expect(cgroupQuota()).toBe(Number.POSITIVE_INFINITY);
    expect(vi.mocked(readFileSync).mock.calls).toEqual([[V2, 'utf8']]);
  });

  it('uses v1 only when the v2 file cannot be read', () => {
    files({ [V1_QUOTA]: ' 250000\n', [V1_PERIOD]: '100000\n' });
    expect(cgroupQuota()).toBe(2.5);
    expect(vi.mocked(readFileSync).mock.calls).toEqual([
      [V2, 'utf8'],
      [V1_QUOTA, 'utf8'],
      [V1_PERIOD, 'utf8'],
    ]);
  });

  it.each([
    {},
    { [V1_QUOTA]: '100000' },
    { [V1_PERIOD]: '100000' },
    { [V1_QUOTA]: '-1', [V1_PERIOD]: '100000' },
    { [V1_QUOTA]: '0', [V1_PERIOD]: '100000' },
    { [V1_QUOTA]: '', [V1_PERIOD]: '100000' },
    { [V1_QUOTA]: 'bad', [V1_PERIOD]: '100000' },
    { [V1_QUOTA]: 'Infinity', [V1_PERIOD]: '100000' },
    { [V1_QUOTA]: '100000', [V1_PERIOD]: 'bad' },
    { [V1_QUOTA]: '100000', [V1_PERIOD]: 'Infinity' },
    { [V1_QUOTA]: '100000', [V1_PERIOD]: '0' },
    { [V1_QUOTA]: '100000', [V1_PERIOD]: '-1' },
  ])('has no quota for absent, unlimited or invalid v1 files: %j', (values) => {
    files(values);
    expect(cgroupQuota()).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    { host: 16, quota: '200000 100000', cpus: 2, cgroupCpus: 2, bound: 'cgroup', workers: 1 },
    { host: 16, quota: '375000 100000', cpus: 3, cgroupCpus: 3.75, bound: 'cgroup', workers: 2 },
    { host: 16, quota: '50000 100000', cpus: 1, cgroupCpus: 0.5, bound: 'cgroup', workers: 1 },
    { host: 4, quota: '800000 100000', cpus: 4, cgroupCpus: 8, bound: 'host', workers: 3 },
    { host: 4, quota: '400000 100000', cpus: 4, cgroupCpus: 4, bound: 'host', workers: 3 },
    {
      host: 1,
      quota: 'max 100000',
      cpus: 1,
      cgroupCpus: Number.POSITIVE_INFINITY,
      bound: 'host',
      workers: 1,
    },
  ])(
    'resolves $host host CPUs with quota $quota to $workers workers',
    ({ host, quota, cpus, cgroupCpus, bound, workers }) => {
      files({ [V2]: quota });
      vi.mocked(availableParallelism).mockReturnValue(host);
      const ceiling = resolveCpuCeiling();
      expect(ceiling).toEqual({ cpus, bound, hostParallelism: host, cgroupCpus });
      expect(defaultProjectionWorkers(ceiling)).toBe(workers);
      expect(defaultProjectionWorkers()).toBe(workers);
    },
  );

  it('uses the host ceiling on systems without cgroup files', () => {
    expect(resolveCpuCeiling()).toEqual({
      cpus: 16,
      bound: 'host',
      hostParallelism: 16,
      cgroupCpus: Number.POSITIVE_INFINITY,
    });
    expect(defaultProjectionWorkers()).toBe(15);
  });
});
