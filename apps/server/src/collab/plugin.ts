/**
 * Boot step 8, the `collab` plugin (02-system-architecture.md, "Boot sequence and plugin order";
 * 12-milestones.md §5.2, the `collab`, `notes` and `projection` rows; 05-collaboration-and-durability.md).
 *
 * What lands here, in order: the effective limits, the socket caps and the admission budget, the
 * owner lease over one dedicated `dbPersist` connection, the persistence layer (store, scheduler,
 * writers), the gateway, the four extensions, the one `Hocuspocus` instance and its `/collab` mount,
 * the note kernel, the two decorators (`app.collab`, `app.notes`), the four readiness checks, the
 * `collab` problem mapper, the `AuthzBus` subscription — and, at `onReady`, the collaboration metrics
 * on the process registry and the four drain hooks, because `app.metrics` and `app.onDrain` are the
 * ops plugin's (step 10) and exist only after every plugin has registered.
 *
 * Everything the plugin reaches from a later step is read lazily and at call time; nothing here
 * assumes the order of steps beyond what `app.ts` states.
 */
import type { Document } from '@hocuspocus/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import type { DatabaseHandle } from '../boot/db.ts';
import type { IridiumConfig } from '../config/env.ts';
import type { Database } from '../db/schema.ts';
import {
  AlreadyInitializedError,
  createNoteServices,
  NoteOversizedError,
  type NoteServices,
} from '../notes/service.ts';
import type { Clock } from '../ops/clock.ts';
import type { ServerLogger } from '../ops/logging.ts';
import { docBudgetOutcome, persistBacklogOutcome, type Readiness } from '../ops/readiness.ts';
import { ProjectionPool } from '../projection/pool.ts';
import { createProjectionPreparer } from '../projection/prepare.ts';
import { ReindexService } from '../projection/reindex.ts';
import { ProblemError } from '../security/problem.ts';
import { collabOriginPolicy, createCollabOriginGuard } from '../security/ws-origin.ts';
import { CollabAuditSink } from './audit.ts';
import { CollabGateway } from './gateway.ts';
import { createAuthExtension } from './hooks/auth.ts';
import { createLimitsExtension } from './hooks/limits.ts';
import { createPersistenceExtension } from './hooks/persistence.ts';
import { createKyselyCollabReads, ResolutionChannel } from './hooks/resolution.ts';
import {
  AdmissionBudget,
  createConnectionCapsHook,
  resolveCollabLimits,
  SocketCaps,
  type CollabLimitOverrides,
  type CollabLimits,
} from './limits.ts';
import type { CollabMetrics } from './metrics.ts';
import { COLLAB_OWNER_LEASE_LABEL, CollabOwnerLease, CollabOwnershipLost } from './owner-lease.ts';
import { isCompactionRejection, PersistenceDrainUnavailable } from './persistence/errors.ts';
import { CollabPersistenceService } from './persistence/index.ts';
import { KyselyPersistenceStore } from './persistence/kysely-store.ts';
import { createCollabServer, type CollabServer } from './server.ts';
import { createVaultChannelExtension } from './vault-channel.ts';

export type { CollabLimitOverrides } from './limits.ts';

/** The collaboration services as the instance decorates them (`app.collab`). */
export interface CollabServices {
  readonly gateway: CollabGateway;
  readonly persistence: CollabPersistenceService;
  readonly server: CollabServer;
  readonly limits: CollabLimits;
  readonly ownerLease: CollabOwnerLease;
  /** The counters this plugin registers on the process registry at `onReady`. */
  readonly metrics: () => CollabMetrics | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Boot step 8: the Hocuspocus instance behind its three interfaces, the lease and the limits. */
    collab: CollabServices;
    /** Boot step 8: the note kernel — initialisation, lifecycle, repair and the committed read. */
    notes: NoteServices;
    /** The bounded process-owned pool shared with reference scans and reindex. */
    projectionPool: ProjectionPool;
    /** Shared durable-source rebuilding for maintenance and the CLI. */
    reindexService: ReindexService;
  }
}

/** What the collab plugin needs; slices, never the whole instance's later decorators. */
export interface CollabPluginOptions {
  readonly config: IridiumConfig;
  readonly database: DatabaseHandle;
  readonly clock: Clock;
  readonly logger: ServerLogger;
  readonly readiness: Readiness;
  /**
   * What this process is (`buildApp({ role })`). A `server` competes for the owner lease and mounts
   * `/collab`; a `cli` boot does neither — a command must never hold the lease for its own length
   * beside a stopped server, nor be refused it beside a running one — and its content repair takes
   * the lease itself for the duration of the repair.
   */
  readonly role: 'server' | 'cli';
  /** Per-boot overrides (`buildApp({ limits })`), for the suites that drive a budget to its edge. */
  readonly limits?: CollabLimitOverrides;
}

/** The `Retry-After` a `503 unavailable` for a compaction that could not run carries. */
const COMPACTION_RETRY_AFTER_MS = 1_000;

/** Applies boot step 8. */
export async function applyCollabPlugin(
  app: FastifyInstance,
  options: CollabPluginOptions,
): Promise<void> {
  const { config, database, clock, logger, readiness, role } = options;
  const limits = resolveCollabLimits(config, options.limits);
  const dbApp = (): Kysely<Database> | null => database.dbApp;
  const dbPersist = (): Kysely<Database> | null => database.dbPersist;

  // ---- metrics: the ops plugin's registry (step 10), read lazily because it exists after this step
  const opsMetrics = (): FastifyInstance['metrics'] | null =>
    app.hasDecorator('metrics') ? app.metrics : null;
  const metrics = (): CollabMetrics | null => opsMetrics();

  // ---- the caps, the budget, the lease -----------------------------------------------------------
  const caps = new SocketCaps(limits);
  const budget = new AdmissionBudget(limits);
  const ownerLease = new CollabOwnerLease({
    db: dbPersist,
    poolSize: config.db.poolPersist,
    logger,
    closeWith: app,
    onLost: async () => {
      // Both calls fence synchronously before either yields. In-flight SQL retains its generation's
      // shared row lock until it settles; the claimant cannot publish ownership before that.
      await Promise.all([persistence.fenceAll(), server.fenceConnections()]);
      await server.settleLoads();
      await persistence.fenceAll();
      await server.unloadAll();
    },
  });
  if (role === 'server' && database.mode !== 'none') {
    readiness.blockWhen('collab_owner_lease', () => !ownerLease.held);
  }

  // ---- persistence ---------------------------------------------------------------------------------
  const projectionPool = new ProjectionPool({ ...config.projection, clock });
  const prepareProjection = createProjectionPreparer(
    projectionPool,
    logger,
    clock,
    () => app.metrics,
  );
  app.decorate('projectionPool', projectionPool);
  app.addHook('onClose', () => projectionPool.close());
  app.decorate(
    'reindexService',
    new ReindexService({
      logger,
      searchIndex: app.searchIndex,
      database: () => {
        const db = database.dbApp;
        if (db === null) throw new ProblemError('unavailable');
        return db;
      },
      prepare: prepareProjection,
      clock,
      ratePerSecond: config.projection.reindexRatePerSecond,
      drainAccepted: async (noteId) => {
        await persistence.writerOf(noteId)?.drainAccepted();
      },
      projected: (noteId, seq) =>
        app.collab.gateway.broadcastNote(noteId, { v: 1, t: 'projected', seq }),
    }),
  );
  const audit = new CollabAuditSink({
    db: dbApp,
    audit: app.audit,
    now: () => clock.now(),
    logger,
  });
  const reads = createKyselyCollabReads(dbApp);
  const gateway = new CollabGateway({
    clock,
    logger,
    authorize: app.authz.authorize,
    reads,
    captureOwner: () => ownerLease.captureFence(),
    principalBlocked: (userId) => app.authz.sessionFence.blocked(userId),
    applyWriterLatches: (connection) =>
      persistence.writerOfDocument(connection.document.name)?.applyLatches(connection),
  });
  const store = new KyselyPersistenceStore({
    logger,
    db: dbPersist,
    audit: app.audit,
    searchIndex: app.searchIndex,
  });
  const persistence = new CollabPersistenceService({
    prepareProjection,
    store,
    writerStore: () =>
      new KyselyPersistenceStore({
        logger,
        searchIndex: app.searchIndex,
        db: dbPersist,
        audit: app.audit,
        ownership: ownerLease.captureFence(),
      }),
    principalBlocked: (userId) => app.authz.sessionFence.blocked(userId),
    clock,
    logger,
    metrics: () => opsMetrics(),
    gauges: () => {
      const ops = opsMetrics();
      return ops === null
        ? null
        : {
            persistQueueDepth: ops.persistQueueDepth,
            persistBacklogAgeSeconds: ops.persistBacklogAgeSeconds,
            persistWritersFailed: ops.persistWritersFailed,
          };
    },
    faults: {
      fire: (point, connectionId) => app.faults.fire(point, connectionId),
      delay: (point) => app.faults.delay(point),
      crash: (point) => app.faults.crash(point),
      maybeThrow: (point, error) => app.faults.maybeThrow(point, error),
      hold: (point) => app.faults.hold(point),
    },
    limits,
    // One connection of the persist pool holds the owner lease for the life of the process.
    slots: Math.max(1, config.db.poolPersist - 1),
    callbacks: {
      onTrashed: (noteId) => {
        void gateway.closeNote(noteId, 'note-trashed');
      },
      requestUnload: async (documentName) => {
        const document = server.hocuspocus.documents.get(documentName);
        if (document !== undefined) await server.hocuspocus.unloadDocument(document);
      },
      onWriteRejected: (noteId, vaultId, reason) => {
        void audit.record({
          action: 'collab.write.rejected',
          vaultId,
          userId: null,
          sessionId: null,
          noteId,
          reason,
          ip: null,
          requestId: null,
          subject: noteId,
        });
      },
    },
  });

  // ---- the four extensions and the server ----------------------------------------------------------
  const channel = new ResolutionChannel();
  const documents = (): Map<string, Document> => server.hocuspocus.documents;
  const extensions = [
    createAuthExtension({
      tickets: app.auth.tickets,
      sessions: app.auth.sessions,
      authorize: app.authz.authorize,
      authorizeDetailed: app.authz.authorizeDetailed,
      epochs: app.authz.epochs,
      sessionFence: app.authz.sessionFence,
      reads,
      gateway,
      audit,
      channel,
      clock,
      logger,
      faults: { delay: (point) => app.faults.delay(point) },
      limits,
      documents,
      metrics,
    }),
    createLimitsExtension({
      budget,
      reads,
      channel,
      documents,
      clock,
      audit,
      logger,
      metrics: () => {
        const ops = opsMetrics();
        return ops === null
          ? null
          : {
              docsLoaded: ops.docsLoaded,
              collabStateBytes: ops.collabStateBytes,
              collabAdmissionRefusedTotal: ops.collabAdmissionRefusedTotal,
            };
      },
      collabMetrics: metrics,
    }),
    createPersistenceExtension({
      persistence,
      gateway,
      clock,
      logger,
      metrics,
      onLoadFailed: (documentName) => budget.release(documentName),
      onUnloaded: (documentName) => {
        budget.release(documentName);
        const ops = opsMetrics();
        ops?.docsLoaded.set(server.hocuspocus.documents.size);
        ops?.collabStateBytes.set(budget.stateBytes);
      },
    }),
    createVaultChannelExtension({ logger, metrics }),
  ];

  const server = createCollabServer({
    config,
    limits,
    clock,
    logger,
    extensions,
    ownerLease,
    faults: {
      get enabled(): boolean {
        return app.faults.enabled;
      },
      fire: (point, connectionId, acknowledgement) =>
        app.faults.fire(point, connectionId, acknowledgement),
      crash: (point, acknowledgement) => app.faults.crash(point, acknowledgement),
    },
    metrics,
    preValidation: [
      createCollabOriginGuard(collabOriginPolicy(config)),
      createConnectionCapsHook({
        caps,
        onRefused: (request: FastifyRequest, refusal) => {
          request.log.warn(
            {
              event: 'collab.connection.rejected',
              reason: 'rate_limited',
              cap: refusal,
              ip: request.ip,
            },
            'a collaboration upgrade was refused by a socket cap',
          );
        },
      }),
    ],
    wsConnections: () => opsMetrics()?.wsConnections ?? null,
  });
  gateway.bind(server.hocuspocus);
  app.addHook('onReady', () => gateway.sweepTrashedOnBoot());
  const unsubscribeFence = app.authz.sessionFence.subscribe((userId) => {
    gateway.refreshPrincipalFence(userId);
  });
  app.addHook('onClose', async () => unsubscribeFence());
  // A CLI boot serves no socket: the instance exists for `openServerEdit`, nothing listens on it.
  if (role === 'server') await server.mount(app);

  // ---- the note kernel -----------------------------------------------------------------------------
  const notes = createNoteServices({
    logger,
    searchIndex: app.searchIndex,
    prepareProjection,
    gateway,
    persistence,
    db: dbApp,
    clock,
    repair: { audit: app.audit, logger, captureOwner: () => ownerLease.captureFence() },
    role,
    ownerLease,
  });

  app.decorate('collab', { gateway, persistence, server, limits, ownerLease, metrics });
  app.decorate('notes', notes);

  // ---- the bus: between the reconciler and the ticket store (seams/auth.md §4) -------------------
  app.authz.bus.subscribe((event) => gateway.handle(event));

  // ---- the problem mapper --------------------------------------------------------------------------
  app.problems.register('collab', (error) => {
    if (error instanceof AlreadyInitializedError) {
      return new ProblemError('invalid_state', { detail: error.message });
    }
    if (error instanceof NoteOversizedError) {
      return new ProblemError('note_oversized', {
        detail: error.message,
        current: { sizeChars: error.sizeChars, max: error.max },
      });
    }
    if (error instanceof CollabOwnershipLost || error instanceof PersistenceDrainUnavailable) {
      return new ProblemError('unavailable', {
        detail: error.message,
        retryAfterMs: COMPACTION_RETRY_AFTER_MS,
      });
    }
    if (isCompactionRejection(error)) {
      return new ProblemError('unavailable', {
        detail: 'The committed projection could not be refreshed; retry shortly.',
        retryAfterMs: COMPACTION_RETRY_AFTER_MS,
      });
    }
    return null;
  });

  // ---- the four readiness checks this subsystem owns ----------------------------------------------
  // The lease probe is the acquisition point, so a CLI boot registers none: it never competes.
  if (role === 'server') {
    readiness.register('collab_owner_lease', async () => {
      if (database.mode === 'none') {
        return { status: 'warn', detail: 'no database in this boot (mode: none)' };
      }
      if (dbPersist() === null) return { status: 'fail', detail: 'dbPersist is not connected' };
      const held = await ownerLease.tryAcquire();
      return held
        ? { status: 'ok', detail: `${COLLAB_OWNER_LEASE_LABEL} held on a dedicated connection` }
        : {
            status: 'fail',
            detail: 'the schema owner lease is unavailable; only operational endpoints are served',
          };
    });
  }
  readiness.register('doc_budget', () => docBudgetOutcome(budget.reading()));
  readiness.register('persist_backlog', () => {
    persistence.refreshGauges();
    return persistBacklogOutcome(persistence.backlog());
  });
  readiness.register('projection_workers', () => ({
    status: projectionPool.closed ? 'fail' : 'ok',
    detail: `${projectionPool.pending} projection tasks admitted; ${config.projection.workers} worker slots`,
  }));

  // ---- what exists only after step 10: the registry and the drain --------------------------------
  app.addHook('onReady', async () => {
    const ops = opsMetrics();
    if (ops !== null) {
      ops.docsLoaded.set(0);
      ops.collabStateBytes.set(0);
      persistence.refreshGauges();
    }
    app.onDrain({
      phase: 'collab',
      name: 'collab.close-connections',
      run: () => server.closeAll(),
    });
    app.onDrain({
      phase: 'writers',
      name: 'collab.drain-writers',
      capture: () => persistence.beginShutdown(),
      run: () => persistence.drainAll(),
      progress: () => ({ undrained: persistence.undrained() }),
    });
    app.onDrain({
      phase: 'unload',
      name: 'collab.unload-documents',
      run: async () => {
        await server.unloadAll();
        persistence.assertShutdownComplete();
      },
      progress: () => ({ undrained: server.loadedDocuments().map((document) => document.name) }),
    });
    app.onDrain({
      phase: 'resources',
      name: 'collab.release-owner-lease',
      run: () => ownerLease.release(),
    });
  });

  app.addHook('onClose', async () => {
    await ownerLease.release();
  });
}
