/** Operator maintenance submits durable intent; only the real owner executes content mutations. */
import {
  JobId,
  JobStatus,
  JobType,
  LIMITS,
  ListJobsQuery,
  MaintenanceJobType,
  NoteId,
  VaultId,
  type Job,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

import type { JobActor } from '../jobs/scheduler.ts';
import { trashPurgeCandidates } from '../jobs/trash.ts';
import { CursorCodec, readPromotedCursorKeyVersion } from '../mcp/cursor.ts';
import { ProblemError } from '../security/problem.ts';
import { requireDatabase } from './app.ts';
import type { CommandInput } from './commands.ts';
import { EXIT } from './exit.ts';
import { renderJson, renderTable } from './output.ts';

function application(input: CommandInput): FastifyInstance {
  if (input.app === null) throw new Error('A maintenance command requires the CLI application.');
  requireDatabase(input.app, input.path);
  return input.app;
}
function actor(input: CommandInput): JobActor {
  return {
    userId: input.actor.actorId,
    sessionId: null,
    displayName: input.actor.actorDisplay,
    context: input.auditContext,
    credentialType: 'cli',
  };
}
function integerFlag(input: CommandInput, name: string): number | undefined {
  const value = input.args.value(name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number))
    throw new ProblemError('validation_failed', {
      detail: `--${name} must be a positive integer.`,
    });
  return number;
}
/** Prints a committed request id before waiting, keeping stdout valid for --json. */
async function execute(
  input: CommandInput,
  type: MaintenanceJobType,
  payload: Record<string, unknown>,
): Promise<number> {
  const app = application(input);
  const job = await app.jobs.scheduler.enqueueFromCli(type, payload, actor(input));
  input.io.err(`iridium ${input.path}: job ${job.id}`);
  const ownedInitially = app.collab.ownerLease.held;
  let completed: Job;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- wait for this durable intent and safely take over after an owner exits
      completed = await app.jobs.scheduler.get(job.id);
      if (completed.status !== 'queued' && completed.status !== 'running') break;
      // eslint-disable-next-line no-await-in-loop -- the real lease is the only authority to execute a queued job
      if (await app.collab.ownerLease.tryAcquire()) {
        // eslint-disable-next-line no-await-in-loop -- finish the bounded executor before checking its committed result
        await app.jobs.scheduler.runQueuedOnce();
      } else {
        // eslint-disable-next-line no-await-in-loop -- the serving owner polls the queue using this same cadence
        await new Promise<void>((resolve) => {
          app.clock.after(LIMITS.JOB_POLL_INTERVAL_MS, resolve);
        });
      }
    }
  } finally {
    if (!ownedInitially) await app.collab.ownerLease.relinquish();
  }
  input.io.out(
    input.args.has('json')
      ? renderJson(completed)
      : renderTable(
          ['job', 'type', 'status', 'result'],
          [[completed.id, completed.type, completed.status, JSON.stringify(completed.result)]],
        ),
  );
  if (completed.result?.['status'] === 'skipped_no_ddl_credential') {
    input.io.err(
      'The executing server has no DATABASE_MIGRATE_URL. Configure its maintenance credential, or stop the server and run this command with the migrator credential so the CLI can acquire the real owner lease.',
    );
    return EXIT.refused;
  }
  if (completed.status === 'succeeded') return EXIT.success;
  input.io.err(
    `Job ${completed.id} ${completed.status}: ${completed.error ?? 'inspect jobs list and the server logs'}`,
  );
  return completed.status === 'cancelled' ? EXIT.refused : EXIT.internal;
}
/** Convert usage errors into CLI exit 2 before enqueuing any work. */
async function validated(input: CommandInput, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'validation_failed') {
      input.io.err(
        `iridium ${input.path}: ${error.extensions.detail ?? 'invalid maintenance arguments'}`,
      );
      return EXIT.usage;
    }
    if (error instanceof ProblemError) {
      input.io.err(`iridium ${input.path}: ${error.message}`);
      return EXIT.refused;
    }
    throw error;
  }
}
export function runReindex(input: CommandInput): Promise<number> {
  return validated(input, () => {
    const vault = input.args.value('vault'),
      note = input.args.value('note');
    if (
      (vault !== undefined && !VaultId.safeParse(vault).success) ||
      (note !== undefined && !NoteId.safeParse(note).success)
    )
      throw new ProblemError('validation_failed', {
        detail: '--vault and --note must be canonical UUIDs.',
      });
    return execute(input, 'reindex', {
      ...(vault === undefined ? {} : { vaultId: vault }),
      ...(note === undefined ? {} : { noteIds: [note] }),
      ...(input.args.has('stale') ? { stale: true } : {}),
      ...(input.args.has('pipeline-version') ? { pipelineVersion: true } : {}),
    });
  });
}
export function runJob(input: CommandInput): Promise<number> {
  return validated(input, () => {
    const parsed = MaintenanceJobType.safeParse(input.args.positionals[0]);
    if (!parsed.success)
      throw new ProblemError('validation_failed', {
        detail: 'Choose a maintenance type listed by jobs list or --help.',
      });
    const vaultId = input.args.value('vault');
    return execute(input, parsed.data, {
      ...(vaultId === undefined ? {} : { vaultId }),
      ...(input.args.has('dry-run') ? { dryRun: true } : {}),
    });
  });
}
export function runTrashPurge(input: CommandInput): Promise<number> {
  return validated(input, async () => {
    const vault = input.args.value('vault');
    if (!VaultId.safeParse(vault).success)
      throw new ProblemError('validation_failed', {
        detail: '--vault requires a canonical vault UUID.',
      });
    const olderThanDays = integerFlag(input, 'older-than-days');
    if (input.args.has('dry-run')) {
      const app = application(input);
      let count = 0;
      for await (const row of trashPurgeCandidates(
        requireDatabase(app, input.path),
        app.clock.date(),
        {
          vaultId: VaultId.parse(vault),
          ...(olderThanDays === undefined ? {} : { olderThanDays }),
        },
        { rootsOnly: false },
      )) {
        const line = input.args.has('json')
          ? JSON.stringify(row)
          : `${row.nodeId}  ${row.path}  expires ${row.expiresAt}`;
        if (input.io.writeLine !== undefined) await input.io.writeLine(line);
        else input.io.out(line);
        count += 1;
      }
      input.io.err(`Dry run: ${String(count)} eligible nodes; no job or purge was submitted.`);
      return EXIT.success;
    }
    return execute(input, 'trash_purge', {
      vaultId: vault,
      dryRun: input.args.has('dry-run'),
      ...(olderThanDays === undefined ? {} : { olderThanDays }),
    });
  });
}
export function runAuditArchive(input: CommandInput): Promise<number> {
  return validated(input, () => {
    const olderThanDays = integerFlag(input, 'older-than-days');
    return execute(input, 'audit_archive', {
      dryRun: input.args.has('dry-run'),
      ...(olderThanDays === undefined ? {} : { olderThanDays }),
    });
  });
}
export function runJobsList(input: CommandInput): Promise<number> {
  return validated(input, async () => {
    const app = application(input);
    const type = input.args.value('type'),
      status = input.args.value('status');
    if (
      (type !== undefined && !JobType.safeParse(type).success) ||
      (status !== undefined && !JobStatus.safeParse(status).success)
    )
      throw new ProblemError('validation_failed', { detail: 'Unknown job type or status.' });
    const cursors = new CursorCodec({
      keyring: app.iridiumConfig.keys.mcpCursor,
      signingVersion: await readPromotedCursorKeyVersion(requireDatabase(app, input.path)),
      now: () => app.clock.now(),
    });
    const query = ListJobsQuery.safeParse({
      ...(type === undefined ? {} : { type: JobType.parse(type) }),
      ...(status === undefined ? {} : { status: JobStatus.parse(status) }),
      ...(input.args.value('cursor') === undefined ? {} : { cursor: input.args.value('cursor') }),
      limit: integerFlag(input, 'limit') ?? LIMITS.JOB_LIST_DEFAULT,
    });
    if (!query.success)
      throw new ProblemError('validation_failed', { detail: 'Invalid job list limit or filters.' });
    const page = await app.jobs.scheduler.list(query.data, cursors, 'cli:jobs');
    input.io.out(
      input.args.has('json')
        ? renderJson(page)
        : renderTable(
            ['id', 'type', 'status', 'progress'],
            page.items.map((job) => [job.id, job.type, job.status, JSON.stringify(job.progress)]),
          ),
    );
    if (page.nextCursor !== undefined && !input.args.has('json'))
      input.io.err(`Next page: jobs list --cursor ${page.nextCursor}`);
    return EXIT.success;
  });
}
export function runJobsCancel(input: CommandInput): Promise<number> {
  return validated(input, async () => {
    const id = input.args.value('id');
    if (!JobId.safeParse(id).success)
      throw new ProblemError('validation_failed', {
        detail: '--id requires a canonical job UUID.',
      });
    const job = await application(input).jobs.scheduler.cancelFromCli(
      JobId.parse(id),
      actor(input),
    );
    input.io.out(input.args.has('json') ? renderJson(job) : `${job.id}: ${job.status}`);
    return EXIT.success;
  });
}
