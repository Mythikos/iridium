/**
 * `cgroupQuota()` — the container CPU ceiling that `PROJECTION_WORKERS` defaults against
 * (11-operations-and-deployment.md, "Configuration and secrets", `PROJECTION_WORKERS`).
 *
 * `os.availableParallelism()` reports the host's processors: it honours an affinity mask, not a
 * cgroup quota. On a 16-core host running the `server` service at `cpus: "2.0"` a host-derived
 * default would spawn 15 projection workers sharing two CPUs, each holding a projection input
 * buffer against a 2 GB memory limit — the opposite of the sizing intent, on the exact path the
 * SLOs measure. This module reads the quota the kernel actually enforces and never throws:
 * `Infinity` means "no quota", which is the correct answer on a bare host and on Windows.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

/** cgroup v2: `<quota> <period>`, or `max <period>` when unlimited. */
const CGROUP_V2_CPU_MAX = '/sys/fs/cgroup/cpu.max';
/** cgroup v1: two files, quota in microseconds per period and the period itself. */
const CGROUP_V1_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const CGROUP_V1_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * The CPU quota this process is limited to, in whole CPUs (fractional quotas are reported as they
 * are; the caller rounds). `Infinity` when no quota applies or the files are unreadable.
 */
export function cgroupQuota(): number {
  const v2 = readOrNull(CGROUP_V2_CPU_MAX);
  if (v2 !== null) {
    const [quota, period] = v2.split(/\s+/);
    if (quota === 'max' || quota === undefined || period === undefined)
      return Number.POSITIVE_INFINITY;
    const quotaValue = Number(quota);
    const periodValue = Number(period);
    if (!Number.isFinite(quotaValue) || !Number.isFinite(periodValue) || periodValue <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return quotaValue / periodValue;
  }

  const quotaRaw = readOrNull(CGROUP_V1_QUOTA);
  const periodRaw = readOrNull(CGROUP_V1_PERIOD);
  if (quotaRaw === null || periodRaw === null) return Number.POSITIVE_INFINITY;
  const quotaValue = Number(quotaRaw);
  const periodValue = Number(periodRaw);
  if (
    !Number.isFinite(quotaValue) ||
    quotaValue <= 0 ||
    !Number.isFinite(periodValue) ||
    periodValue <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return quotaValue / periodValue;
}

/** Which of the two bounds decided the worker count, so `iridium config check` can print it. */
export type CpuBound = 'host' | 'cgroup';

/** The resolved CPU ceiling and which bound won. */
export interface CpuCeiling {
  readonly cpus: number;
  readonly bound: CpuBound;
  readonly hostParallelism: number;
  /** `Infinity` when no cgroup quota applies. */
  readonly cgroupCpus: number;
}

/** `min(os.availableParallelism(), cgroupQuota())`, floored at 1. */
export function resolveCpuCeiling(): CpuCeiling {
  const hostParallelism = availableParallelism();
  const cgroupCpus = cgroupQuota();
  const cpus = Math.max(1, Math.floor(Math.min(hostParallelism, cgroupCpus)));
  return {
    cpus,
    bound: cgroupCpus < hostParallelism ? 'cgroup' : 'host',
    hostParallelism,
    cgroupCpus,
  };
}

/** `PROJECTION_WORKERS` default: `max(1, min(hostParallelism, cgroupQuota()) - 1)`. */
export function defaultProjectionWorkers(ceiling: CpuCeiling = resolveCpuCeiling()): number {
  return Math.max(1, ceiling.cpus - 1);
}
