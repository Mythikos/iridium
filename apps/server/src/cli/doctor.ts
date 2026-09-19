/**
 * `iridium doctor [--argon2 | --yjs-instances | --repair-content <note>]`
 * (12-milestones.md §5.2, the `apps/server/src/cli` row; 11-operations-and-deployment.md, the
 * "`doctor` checks" table; spike S13's follow-up, which specifies the argon2 check by name).
 *
 * The invariant and health suite. With no check flag it runs every **non-mutating** check this build
 * carries and exits `0`, or `6` with the findings table; `--json` emits
 * `{checks:[{name,status,detail,remedy}]}` exactly as 11 spells it.
 *
 * **`warn` is not a finding, `fail` is.** S13's decision is verbatim that `iridium doctor --argon2`
 * "is specified to warn rather than hard-fail on a host that cannot reach the 150–300 ms window",
 * and the three-value vocabulary `ok | warn | fail` is the readiness one (`ops/readiness.ts`), reused
 * rather than re-spelled. So a host whose hashing is out of window prints its measurement, prints the
 * remedy, and exits `0`; only a `fail` makes the command exit `6`. A calibration note that stopped a
 * cron job would be a calibration note nobody leaves running.
 *
 * **Most of 11's check table is not in this build.** Each of those flags is accepted and refused with
 * exit `3` `not_implemented` naming what it will do, for the same reason the reserved *command* table
 * exists: a runbook that says `iridium doctor --triggers` should be told the check is not here yet,
 * not that it mistyped a flag.
 *
 * **`--repair-content` is the one mutation** and is therefore excluded from the no-argument run. It
 * is a documented alias for `repair content <note-id>` (11, "Repair"), delegates to
 * `app.notes.repairContent`, and the audit row is written by that service inside its own transaction —
 * an audit row belongs in the transaction of the change it describes, and the CLI holds no
 * transaction here.
 */
import { NoteId, type Principal } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

import { ARGON2_OUTPUT_LEN, NODE_RS_ARGON2 } from '../auth/credentials/hasher.ts';
import { ARGON2_PARALLELISM } from '../auth/credentials/phc.ts';
import { idBytes } from '../auth/ids.ts';
import type { IridiumConfig } from '../config/env.ts';
import type { RepairReport } from '../notes/repair.ts';
import { systemClock, type Clock } from '../ops/clock.ts';
import { worstStatus, type ReadyzStatus } from '../ops/readiness.ts';
import { capturedYjsWarnings, yjsIsLoaded } from '../ops/yjs-single-instance.ts';
import { requireDatabase } from './app.ts';
import { EXIT } from './exit.ts';
import { renderJson, renderPairs, renderTable, type CliIo } from './output.ts';

/**
 * The window S13 calibrated against (A29; the spike's question is worded "do the settled argon2id
 * parameters land in the 150–300 ms window on the reference hardware").
 *
 * It is a hardware-calibration target rather than a payload or rate limit, so it is not a member of
 * `@iridium/contracts`' `LIMITS`: nothing validates a request against it, `GET /meta.limits` does not
 * publish it, and a client cannot pre-check anything with it. It lives with the one check that reads
 * it, spelled `floor`/`ceiling` so it reads as a target band and not as a cap.
 */
export const ARGON2_WINDOW_MS = Object.freeze({ floor: 150, ceiling: 300 });

/** The sample count S13's harness used, kept equal so a measurement here is comparable to its note. */
export const ARGON2_SAMPLES = 20;

/**
 * The checks 11's table names that this build does not carry, each accepted and refused with exit `3`
 * `not_implemented` (`--verify-note` takes a note id; the rest stand alone).
 *
 * Accepting them is the point. An operator following a runbook that says `iridium doctor --triggers`
 * should be told the check has not landed yet, with the milestone that brings it — not that they
 * mistyped a flag, which is what an unknown-flag refusal would claim.
 */
export const DOCTOR_RESERVED_CHECKS: readonly string[] = Object.freeze([
  'config',
  'db-roles',
  'backup-role',
  'migrations',
  'triggers',
  'keys',
  'heads',
  'stale-projections',
  'checkpoint-stale',
  'content-invalid',
  'oversize',
  'sizes',
  'orphans',
  'attachments',
  'verify-note',
  'pitr-window',
  'oauth',
  'tls',
  'alerts',
  'repair-heads',
]);

/**
 * A 32-byte scratch secret for the measurement.
 *
 * The pepper is not the subject of this check — argon2's `secret` is mixed in at a fixed cost — and
 * using a scratch value keeps `doctor --argon2` runnable on a host with no database and keeps real
 * key material out of a diagnostic path. The parameters that *do* decide the cost, `memoryCost` and
 * `timeCost`, are the configured ones.
 */
const MEASUREMENT_SECRET = new Uint8Array(32);

/** The password the measurement hashes. Its content is irrelevant; its length is a realistic one. */
const MEASUREMENT_PASSWORD = 'iridium-doctor-argon2-measurement';

/** One line of the `doctor` report, as 11's `--json` shape spells it. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: ReadyzStatus;
  readonly detail: string;
  /** What to do about it; `null` for a check that passed. */
  readonly remedy: string | null;
}

/** What `--argon2` measured. */
export interface Argon2Measurement {
  readonly memoryKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

/** What `measureArgon2` needs; the binding and the clock are injected so a unit test is instant. */
export interface Argon2MeasurementOptions {
  readonly memoryKib: number;
  readonly timeCost: number;
  readonly clock?: Clock;
  readonly samples?: number;
  /** Defaults to the product's own binding, so the measurement is the cost a login actually pays. */
  readonly hash?: (password: string, options: Argon2MeasurementParams) => Promise<string>;
}

/** The binding options one measured hash carries. */
export interface Argon2MeasurementParams {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly outputLen: number;
  readonly secret: Uint8Array;
}

/**
 * Linear-interpolation percentile over an ascending sample list (S13's `lib.mjs`, so the numbers this
 * command prints are comparable with the ones the spike note records).
 */
export function percentile(ascending: readonly number[], p: number): number {
  const first = ascending[0];
  if (first === undefined) return Number.NaN;
  if (ascending.length === 1) return first;
  const position = (p / 100) * (ascending.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = ascending[lower] ?? first;
  const high = ascending[upper] ?? first;
  return lower === upper ? low : low + (high - low) * (position - lower);
}

/** Times `samples` sequential hashes with the configured parameters. */
export async function measureArgon2(options: Argon2MeasurementOptions): Promise<Argon2Measurement> {
  const clock = options.clock ?? systemClock;
  const samples = options.samples ?? ARGON2_SAMPLES;
  const hash = options.hash ?? ((password, params) => NODE_RS_ARGON2.hash(password, params));
  const params: Argon2MeasurementParams = {
    memoryCost: options.memoryKib,
    timeCost: options.timeCost,
    parallelism: ARGON2_PARALLELISM,
    outputLen: ARGON2_OUTPUT_LEN,
    secret: MEASUREMENT_SECRET,
  };

  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = clock.monotonic();
    // Sequential by design: the figure an operator needs is the cost of one login's hash, and
    // hashing concurrently would measure this host's core count instead.
    // eslint-disable-next-line no-await-in-loop -- the samples are a sequential measurement, not independent work
    await hash(MEASUREMENT_PASSWORD, params);
    durations.push(clock.monotonic() - started);
  }

  const ascending = durations.toSorted((left, right) => left - right);
  return {
    memoryKib: options.memoryKib,
    timeCost: options.timeCost,
    parallelism: ARGON2_PARALLELISM,
    samples,
    p50Ms: percentile(ascending, 50),
    p95Ms: percentile(ascending, 95),
  };
}

/** One decimal place, which is the precision a calibration reading is meaningful to. */
function ms(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)} ms`;
}

/** Turns a measurement into the reported check. Out of window is a `warn`, never a `fail` (S13). */
export function argon2Check(measurement: Argon2Measurement): DoctorCheck {
  const detail =
    `memoryCost ${String(measurement.memoryKib)} KiB, timeCost ${String(measurement.timeCost)}, ` +
    `parallelism ${String(measurement.parallelism)}: p50 ${ms(measurement.p50Ms)}, ` +
    `p95 ${ms(measurement.p95Ms)} over ${String(measurement.samples)} sequential hashes ` +
    `(target ${String(ARGON2_WINDOW_MS.floor)}–${String(ARGON2_WINDOW_MS.ceiling)} ms)`;

  if (measurement.p50Ms < ARGON2_WINDOW_MS.floor) {
    return {
      name: 'argon2',
      status: 'warn',
      detail,
      remedy:
        'this host hashes faster than the window, so the stored hashes are cheaper than intended: ' +
        'raise ARGON2_MEMORY_KIB, then ARGON2_TIME_COST, and re-run until p50 is in window ' +
        '(S13 measured 131072 / 6 on the reference container)',
    };
  }
  if (measurement.p50Ms > ARGON2_WINDOW_MS.ceiling) {
    return {
      name: 'argon2',
      status: 'warn',
      detail,
      remedy:
        'this host hashes slower than the window, so a login burst will occupy the libuv thread ' +
        'pool: lower ARGON2_TIME_COST, then ARGON2_MEMORY_KIB, and check UV_THREADPOOL_SIZE is 8',
    };
  }
  return { name: 'argon2', status: 'ok', detail, remedy: null };
}

/**
 * The single-instance report (`--yjs-instances`).
 *
 * The startup guard of `ops/yjs-single-instance.ts` is the mechanism: Yjs announces a second copy on
 * `console.error` at module evaluation and the guard captures it, so this check reports what that
 * interception observed in **this** process rather than re-walking the module graph. A `fail` here is
 * a dependency regression, and the remedy is a build fix and never a production patch (A14).
 */
export function yjsInstancesCheck(): DoctorCheck {
  const captured = capturedYjsWarnings();
  if (captured.length > 0) {
    return {
      name: 'yjs_instances',
      status: 'fail',
      detail: `a second Yjs copy announced itself: ${captured.join(' | ')}`,
      remedy:
        '`pnpm why yjs lib0 y-protocols` must report exactly one version each, and only ' +
        '@iridium/crdt may import them; fail the build rather than patching production',
    };
  }
  return {
    name: 'yjs_instances',
    status: 'ok',
    detail: yjsIsLoaded()
      ? 'one yjs copy is loaded and no second copy announced itself'
      : 'no yjs copy is loaded in this process and none announced itself',
    remedy: null,
  };
}

/** The checks a bare `iridium doctor` runs: every non-mutating check this build carries. */
export async function runAllChecks(
  config: IridiumConfig,
  clock: Clock,
): Promise<readonly DoctorCheck[]> {
  return [
    yjsInstancesCheck(),
    argon2Check(
      await measureArgon2({
        memoryKib: config.auth.argon2MemoryKib,
        timeCost: config.auth.argon2TimeCost,
        clock,
      }),
    ),
  ];
}

/** Prints the checks and answers the exit code: `6` when any check failed, `0` otherwise. */
export function reportChecks(io: CliIo, checks: readonly DoctorCheck[], json: boolean): number {
  if (json) {
    io.out(renderJson({ checks }));
  } else {
    const table = renderTable(
      ['check', 'status', 'detail'],
      checks.map((check) => [check.name, check.status, check.detail]),
    );
    const remedies = checks.flatMap((check) =>
      check.remedy === null ? [] : [`  ${check.name}: ${check.remedy}`],
    );
    io.out(remedies.length === 0 ? table : `${table}\n\nremedies\n${remedies.join('\n')}`);
  }
  return worstStatus(checks.map((check) => check.status)) === 'fail' ? EXIT.findings : EXIT.success;
}

/** What `--repair-content <note>` needs. */
export interface RepairContentInput {
  readonly io: CliIo;
  /**
   * The booted application, or `null` for an invocation the dispatcher did not boot one for.
   *
   * The two refusals below — a note id that is not one, and a repair without `--yes` — are decided
   * from the command line alone, so they must be answerable without a pool. `commands.ts` mirrors the
   * second rule in `needsApp`, which answers the different question "will this open a connection".
   */
  readonly app: FastifyInstance | null;
  /** The note id as the operator typed it; validated here, so a typo is a usage error. */
  readonly noteId: string;
  /** `{ kind: 'system', job: 'cli:doctor --repair-content' }`, with `onBehalfOf` under `--actor`. */
  readonly principal: Principal;
  /** `--dry-run`: report what the repair would change and commit nothing. */
  readonly dryRun: boolean;
  /** `--yes`, which every `repair` subcommand requires (11, "Repair"). */
  readonly confirmed: boolean;
  readonly json: boolean;
}

/**
 * `iridium doctor --repair-content <note>` — the documented alias for `repair content <note-id>`
 * (11-operations-and-deployment.md, "Repair"; 05-collaboration-and-durability.md, "The repair CLI").
 *
 * The repair itself is `app.notes.repairContent`: a `DirectConnection` with origin
 * `{source:'local', context:{reason:'repair'}}` that removes `\r`, re-inserts attributed spans as
 * plain text, clears `notes.content_invalid` and forces a compaction. **That service writes the
 * `note.content.repaired` audit row**, because the row belongs inside the transaction of the change
 * it describes and this command holds no transaction; the `credential_type='cli'` the milestone
 * requires comes from the `cli:` prefix of the system principal's `job`.
 *
 * The existence check is this command's own, so an operator who mistyped a note id is told that
 * rather than handed whatever the service raises for an absent row.
 */
export async function runRepairContent(input: RepairContentInput): Promise<number> {
  const parsed = NoteId.safeParse(input.noteId);
  if (!parsed.success) {
    input.io.err(
      `iridium doctor --repair-content: ${JSON.stringify(input.noteId)} is not a note id ` +
        '(a canonical lowercase UUID, as `GET /notes/:noteId` answers)',
    );
    return EXIT.usage;
  }
  if (!input.dryRun && !input.confirmed) {
    input.io.err(
      'iridium doctor --repair-content: add --yes to confirm. Every repair is a mutation of a live ' +
        'note and 11-operations-and-deployment.md requires the confirmation; --dry-run reports what ' +
        'would change and commits nothing.',
    );
    return EXIT.refused;
  }

  const app = input.app;
  if (app === null) {
    throw new Error(
      'the `doctor` row of CLI_COMMANDS returns false from needsApp() for an invocation that ' +
        'reaches the note service; correct the table in apps/server/src/cli/commands.ts',
    );
  }

  const db = requireDatabase(app, 'doctor --repair-content');
  // A note *is* a node of kind `note`, so its primary key is `notes.node_id` (03-data-model.md §4).
  const note = await db
    .selectFrom('notes')
    .select('node_id')
    .where('node_id', '=', idBytes(parsed.data))
    .executeTakeFirst();
  if (note === undefined) {
    input.io.err(`iridium doctor --repair-content: no note ${parsed.data} exists`);
    return EXIT.refused;
  }

  const report = await app.notes.repairContent(parsed.data, {
    actor: input.principal,
    dryRun: input.dryRun,
  });
  input.io.out(input.json ? renderJson(report) : describeRepair(report));
  return EXIT.success;
}

/** The human rendering of a repair report. */
function describeRepair(report: RepairReport): string {
  return renderPairs([
    ['note', report.noteId],
    ['outcome', report.outcome],
    ['reason', report.reason ?? 'none'],
    ['characters', `${String(report.charsBefore)} → ${String(report.charsAfter)}`],
    ['attribute runs', String(report.attributeRuns)],
    ['dropped embeds', String(report.droppedEmbeds)],
    [
      'pre-repair revision',
      report.preRepairRevisionId === null ? 'none' : String(report.preRepairRevisionId),
    ],
  ]);
}
