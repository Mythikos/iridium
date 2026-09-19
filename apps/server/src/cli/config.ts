/**
 * `iridium config check [--json]` (11-operations-and-deployment.md, "Serving and diagnostics";
 * 12-milestones.md §5.2, `apps/server/src/config`).
 *
 * The same parse `serve` performs — `EnvSchema` including the `_FILE` reads, the permission checks
 * and the production refusals — printed as the redacted summary, and the first `ExecStartPre` of the
 * systemd unit. It opens no database on purpose: a deployment whose environment is wrong must be
 * told so before anything connects, which is what exit `2` with nothing started means.
 *
 * 11's row also spells `[--env-file <path>]`. That flag has no implementation anywhere in the tree
 * and none of M1's scope names it, so this build does not accept it rather than accept and ignore it;
 * the discrepancy is reported rather than papered over.
 */
import type { LoadedConfig } from '../config/env.ts';
import { EXIT } from './exit.ts';
import { renderJson, renderPairs, type CliIo } from './output.ts';

/** Runs `iridium config check`. */
export function runConfigCheck(io: CliIo, loaded: LoadedConfig, json: boolean): number {
  if (json) {
    io.out(
      renderJson({
        config: loaded.redacted,
        ignoredHarnessKeys: loaded.diagnostics.ignoredHarnessKeys,
        warnings: loaded.diagnostics.warnings,
        cpu: loaded.diagnostics.cpuCeiling,
      }),
    );
    return EXIT.success;
  }

  const cpu = loaded.diagnostics.cpuCeiling;
  const lines: string[] = [
    'configuration',
    renderPairs(Object.entries(loaded.redacted).map(([key, value]) => [key, value] as const)),
    '',
    'cpu',
    renderPairs([
      ['host parallelism', String(cpu.hostParallelism)],
      ['cgroup quota', Number.isFinite(cpu.cgroupCpus) ? String(cpu.cgroupCpus) : 'none'],
      ['resolved ceiling', `${String(cpu.cpus)} (${cpu.bound} bound won)`],
    ]),
  ];
  if (loaded.diagnostics.ignoredHarnessKeys.length > 0) {
    lines.push(
      '',
      'ignored harness keys (recognised, deliberately not used)',
      ...loaded.diagnostics.ignoredHarnessKeys.map((key) => `  ${key}`),
    );
  }
  if (loaded.diagnostics.warnings.length > 0) {
    lines.push('', 'warnings', ...loaded.diagnostics.warnings.map((warning) => `  ${warning}`));
  }
  io.out(lines.join('\n'));
  return EXIT.success;
}
