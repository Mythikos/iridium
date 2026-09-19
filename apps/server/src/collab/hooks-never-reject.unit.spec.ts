/**
 * `collab.hooks-never-reject.unit` — every registered Hocuspocus hook resolves, or rejects only with
 * a typed marker from a hook whose contract is "throw to reject" (05-collaboration-and-durability.md,
 * "Instance configuration"; 09-api-reference.md §3.8; D14-09; HP-2).
 *
 * Hocuspocus 4.7.0 turns a rejected hook into an unhandled promise rejection for most events, which
 * ends the process; a rejected `onStoreDocument` keeps the document in memory but records nothing.
 * So the rule is: a dependency that throws inside a hook body is logged as `collab.hook.error`,
 * counted in `iridium_collab_hook_errors_total{hook}` and contained; a store failure travels as
 * `persist-failed` plus a retry and never as a rejection; the identity hooks fail closed with a
 * typed refusal rather than authenticating nobody as someone.
 *
 * The table enumerates every hook the four extensions register — a hook added without a row fails
 * the completeness check at the end — and drives each with the dependency it reaches made to throw.
 */
import { SkipFurtherHooksError } from '@hocuspocus/common';
import {
  decodeServerNoteMessage,
  noteDocName,
  vaultDocName,
  type ServerNoteMessage,
} from '@iridium/contracts';
import { getContent } from '@iridium/crdt';
import { describe, expect, it, vi } from 'vitest';

import { EpochTable } from '../authz/epochs.ts';
import { createAuthExtension } from './hooks/auth.ts';
import { createLimitsExtension } from './hooks/limits.ts';
import { createPersistenceExtension } from './hooks/persistence.ts';
import { AdmissionBudget } from './limits.ts';
import type { CollabMetrics } from './metrics.ts';
import { CompactionUnavailable } from './persistence/errors.ts';
import { createHarness, HARNESS_ACTOR, settle } from './persistence/testing/harness.ts';
import { CollabRejection, isHookSignal, StoreRejected, UnloadVeto } from './rejection.ts';
import { COLLAB_HOOK_NAMES, RETHROWING_HOOKS, type CollabHookName } from './safe-hook.ts';
import {
  closeReasons,
  fakeConnection,
  fakeDocumentOf,
  statelessPayloads,
} from './testing/fake-hocuspocus.ts';
import { updateFrame } from './testing/frames.ts';
import {
  afterLoadPayload,
  afterUnloadPayload,
  authenticatedContext,
  authenticatePayload,
  awarenessPayload,
  beforeUnloadPayload,
  connectedPayloadFor,
  disconnectPayload,
  hookHarness,
  hookOf,
  loadPayload,
  messagePayload,
  preAuthContext,
  registeredHooks,
  statelessPayload,
  storePayload,
  tokenSyncPayload,
} from './testing/hook-deps.ts';
import { createVaultChannelExtension } from './vault-channel.ts';

/** What one row of the table expects of the hook's promise. */
type Outcome =
  | { readonly kind: 'resolves'; readonly contained: boolean }
  | { readonly kind: 'signal'; readonly matches: (error: unknown) => boolean };

interface Row {
  readonly extension: string;
  readonly hook: CollabHookName;
  readonly title: string;
  run(): Promise<unknown>;
  readonly outcome: Outcome;
  /** The registry the row's extension counts into, for the containment assertion. */
  readonly metrics: CollabMetrics;
}

/** What a run of a row observed, in a shape one `toEqual` compares against the expectation. */
interface Observation {
  readonly settled: 'resolved' | 'rejected';
  readonly value: unknown;
  readonly typed: boolean;
  readonly matched: boolean;
  readonly rethrowingHook: boolean;
  readonly counted: 'incremented' | 'unchanged';
  /** The untyped error, when one escaped: named in the diff rather than hidden behind a boolean. */
  readonly escaped: string | null;
}

const BOOM = new Error('the dependency failed');

const resolves = (contained = true): Outcome => ({ kind: 'resolves', contained });
const rejection = (reason: string): Outcome => ({
  kind: 'signal',
  matches: (error) => error instanceof CollabRejection && error.reason === reason,
});

function decoded(payloads: readonly string[]): ServerNoteMessage[] {
  return payloads.flatMap((payload) => {
    const result = decodeServerNoteMessage(payload);
    return result.ok ? [result.message] : [];
  });
}

async function hookErrorCount(metrics: CollabMetrics, hook: string): Promise<number> {
  const snapshot = await metrics.collabHookErrorsTotal.get();
  return snapshot.values
    .filter((sample) => Reflect.get(sample.labels, 'hook') === hook)
    .reduce((sum, sample) => sum + sample.value, 0);
}

async function observe(row: Row): Promise<Observation> {
  const before = await hookErrorCount(row.metrics, row.hook);
  let settled: Observation['settled'] = 'resolved';
  let value: unknown;
  let thrown: unknown = null;
  try {
    value = await row.run();
  } catch (error) {
    settled = 'rejected';
    thrown = error;
  }
  const after = await hookErrorCount(row.metrics, row.hook);
  return {
    settled,
    value,
    typed: settled === 'rejected' ? isHookSignal(thrown) : true,
    matched: row.outcome.kind === 'signal' ? row.outcome.matches(thrown) : true,
    rethrowingHook: settled === 'rejected' ? RETHROWING_HOOKS.includes(row.hook) : true,
    counted: after > before ? 'incremented' : 'unchanged',
    escaped: settled === 'rejected' && !isHookSignal(thrown) ? String(thrown) : null,
  };
}

function expected(row: Row): Observation {
  return row.outcome.kind === 'resolves'
    ? {
        settled: 'resolved',
        value: undefined,
        typed: true,
        matched: true,
        rethrowingHook: true,
        counted: row.outcome.contained ? 'incremented' : 'unchanged',
        escaped: null,
      }
    : {
        settled: 'rejected',
        value: undefined,
        typed: true,
        matched: true,
        rethrowingHook: true,
        counted: 'unchanged',
        escaped: null,
      };
}

// ---- the scenes, one per extension ------------------------------------------------------------

type AuthScene = ReturnType<typeof hookHarness> & {
  readonly extension: ReturnType<typeof createAuthExtension>;
  readonly noteName: string;
  readonly connection: ReturnType<typeof fakeConnection>;
};

function authScene(): AuthScene {
  const harness = hookHarness({ random: () => 0.5 });
  const { world } = harness;
  const vaultId = world.vault();
  const noteId = world.note(vaultId);
  const userId = world.user();
  world.member(vaultId, userId, 'editor');
  const sessionId = world.session(userId);
  world.epochs.user(userId, 1);
  world.epochs.member(vaultId, userId, 1);
  const document = fakeDocumentOf(noteDocName(noteId));
  harness.documents.set(document.name, document);
  const connection = fakeConnection(
    document,
    authenticatedContext(world.clock, { userId, sessionId, vaultId, noteId }),
  );
  const extension = createAuthExtension(harness.deps);
  return { ...harness, extension, noteName: document.name, connection };
}

interface LimitsScene {
  readonly extension: ReturnType<typeof createLimitsExtension>;
  readonly budget: AdmissionBudget;
  readonly harness: ReturnType<typeof hookHarness>;
  readonly connection: ReturnType<typeof fakeConnection>;
  readonly noteName: string;
}

function limitsScene(): LimitsScene {
  const harness = hookHarness();
  const budget = new AdmissionBudget({ maxLoadedDocs: 8, maxStateBytesTotal: 1_000_000 });
  const extension = createLimitsExtension({
    budget,
    reads: harness.world.reads,
    channel: harness.channel,
    documents: () => harness.documents,
    clock: harness.clock,
    audit: harness.audit,
    logger: harness.logger,
    metrics: () => null,
    collabMetrics: () => harness.metrics,
  });
  const world = harness.world;
  const vaultId = world.vault();
  const noteId = world.note(vaultId);
  const userId = world.user();
  const document = fakeDocumentOf(noteDocName(noteId));
  const connection = fakeConnection(
    document,
    authenticatedContext(world.clock, {
      userId,
      sessionId: world.session(userId),
      vaultId,
      noteId,
    }),
  );
  return { extension, budget, harness, connection, noteName: document.name };
}

interface PersistenceScene {
  readonly extension: ReturnType<typeof createPersistenceExtension>;
  readonly harness: ReturnType<typeof createHarness>;
  readonly hooks: ReturnType<typeof hookHarness>;
  readonly document: ReturnType<typeof fakeDocumentOf>;
  readonly connection: ReturnType<typeof fakeConnection>;
  readonly loadFailures: string[];
  readonly unloaded: string[];
}

async function persistenceScene(): Promise<PersistenceScene> {
  const harness = createHarness();
  const hooks = hookHarness();
  const loadFailures: string[] = [];
  const unloaded: string[] = [];
  const extension = createPersistenceExtension({
    persistence: harness.persistence,
    gateway: hooks.gateway,
    clock: harness.clock,
    logger: hooks.logger,
    metrics: () => hooks.metrics,
    onLoadFailed: (name) => loadFailures.push(name),
    onUnloaded: (name) => unloaded.push(name),
  });
  const world = hooks.world;
  const vaultId = world.vault();
  const userId = world.user();
  const noteId = world.note(vaultId);
  harness.store.seed({
    noteId,
    vaultId,
    markdownLf: 'seed',
    actor: HARNESS_ACTOR,
    now: harness.clock.date(),
  });
  const document = fakeDocumentOf(noteDocName(noteId));
  const context = authenticatedContext(world.clock, {
    userId,
    sessionId: world.session(userId),
    vaultId,
    noteId,
  });
  // Load through the hooks, so the document and the writer are the product's own.
  await hookOf(extension, 'onLoadDocument')(loadPayload(document, context));
  await hookOf(extension, 'afterLoadDocument')(afterLoadPayload(document, context));
  const connection = fakeConnection(document, context);
  return { extension, harness, hooks, document, connection, loadFailures, unloaded };
}

interface VaultScene {
  readonly extension: ReturnType<typeof createVaultChannelExtension>;
  readonly hooks: ReturnType<typeof hookHarness>;
  readonly connection: ReturnType<typeof fakeConnection>;
  readonly vaultName: string;
}

function vaultScene(): VaultScene {
  const hooks = hookHarness();
  const extension = createVaultChannelExtension({
    logger: hooks.logger,
    metrics: () => hooks.metrics,
  });
  const world = hooks.world;
  const vaultId = world.vault();
  const userId = world.user();
  const document = fakeDocumentOf(vaultDocName(vaultId));
  const connection = fakeConnection(
    document,
    authenticatedContext(world.clock, {
      userId,
      sessionId: world.session(userId),
      vaultId,
      noteId: null,
    }),
    { readOnly: true },
  );
  return { extension, hooks, connection, vaultName: document.name };
}

// ---- the table ---------------------------------------------------------------------------------

function authRows(): Row[] {
  const rows: Row[] = [];
  {
    const scene = authScene();
    scene.world.readsFailure = BOOM;
    const credentials = scene.world.credentials(scene.world.user());
    rows.push({
      extension: 'IridiumAuth',
      hook: 'onAuthenticate',
      title: 'a failing read refuses the document instead of authenticating nobody as someone',
      run: () =>
        hookOf(
          scene.extension,
          'onAuthenticate',
        )(
          authenticatePayload({
            documentName: scene.noteName,
            token: credentials.ticket,
            context: preAuthContext(scene.clock),
          }),
        ),
      outcome: rejection('unauthorized'),
      metrics: scene.metrics,
    });
  }
  {
    const scene = authScene();
    scene.world.readsFailure = BOOM;
    const userId = scene.connection.connection.context.userId;
    if (userId === undefined) throw new Error('the scene context is authenticated');
    const credentials = scene.world.credentials(userId);
    rows.push({
      extension: 'IridiumAuth',
      hook: 'onTokenSync',
      title: 'a failing read on re-validation closes the connection with a typed reason',
      run: () =>
        hookOf(
          scene.extension,
          'onTokenSync',
        )(tokenSyncPayload(scene.connection.connection, credentials.ticket)),
      outcome: rejection('unauthorized'),
      metrics: scene.metrics,
    });
  }
  {
    const scene = authScene();
    const context = scene.connection.connection.context;
    if (context.userId === undefined || context.vaultId === undefined) throw new Error('scene');
    scene.world.epochs.member(context.vaultId, context.userId, 2);
    scene.world.readsFailure = BOOM;
    rows.push({
      extension: 'IridiumAuth',
      hook: 'beforeHandleMessage',
      title: 'a failing re-authorization of a stale connection closes it, typed',
      run: () =>
        hookOf(
          scene.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            scene.connection.connection,
            updateFrame(scene.noteName, new Uint8Array()),
          ),
        ),
      outcome: rejection('unauthorized'),
      metrics: scene.metrics,
    });
  }
  {
    const scene = authScene();
    vi.spyOn(scene.gateway, 'setMode').mockImplementation(() => {
      throw BOOM;
    });
    const userId = scene.connection.connection.context.userId;
    rows.push({
      extension: 'IridiumAuth',
      hook: 'beforeHandleAwareness',
      title: 'a failing participant update is contained; a valid state is not refused for it',
      run: () =>
        hookOf(
          scene.extension,
          'beforeHandleAwareness',
        )(
          awarenessPayload(
            scene.connection.connection,
            new Map([[1, { user: { id: userId }, mode: 'source' }]]),
          ),
        ),
      outcome: resolves(),
      metrics: scene.metrics,
    });
  }
  {
    const scene = authScene();
    scene.world.readsFailure = BOOM;
    rows.push({
      extension: 'IridiumAuth',
      hook: 'connected',
      title: 'a failing identity read is contained; the connection stays up',
      run: () =>
        hookOf(scene.extension, 'connected')(connectedPayloadFor(scene.connection.connection)),
      outcome: resolves(),
      metrics: scene.metrics,
    });
  }
  {
    const scene = authScene();
    vi.spyOn(scene.connection.connection.document, 'getConnections').mockImplementation(() => {
      throw BOOM;
    });
    rows.push({
      extension: 'IridiumAuth',
      hook: 'onDisconnect',
      title: 'a failing walk of the remaining connections is contained',
      run: () =>
        hookOf(scene.extension, 'onDisconnect')(disconnectPayload(scene.connection.connection)),
      outcome: resolves(),
      metrics: scene.metrics,
    });
  }
  return rows;
}

function limitsRows(): Row[] {
  const rows: Row[] = [];
  {
    const scene = limitsScene();
    scene.harness.world.readsFailure = BOOM;
    rows.push({
      extension: 'IridiumLimits',
      hook: 'onLoadDocument',
      title: 'a failed direct-load estimate refuses capacity rather than bypassing admission',
      run: () =>
        hookOf(
          scene.extension,
          'onLoadDocument',
        )(loadPayload(scene.connection.connection.document, scene.connection.connection.context)),
      outcome: rejection('capacity'),
      metrics: scene.harness.metrics,
    });
  }

  {
    const scene = limitsScene();
    vi.spyOn(scene.budget, 'reserve').mockImplementation(() => {
      throw BOOM;
    });
    rows.push({
      extension: 'IridiumLimits',
      hook: 'onAuthenticate',
      title: 'a failing reservation is contained',
      run: () =>
        hookOf(
          scene.extension,
          'onAuthenticate',
        )(
          authenticatePayload({
            documentName: scene.noteName,
            token: 'irrelevant',
            context: preAuthContext(scene.harness.clock),
          }),
        ),
      outcome: resolves(),
      metrics: scene.harness.metrics,
    });
  }
  {
    const scene = limitsScene();
    vi.spyOn(scene.budget, 'confirm').mockImplementation(() => {
      throw BOOM;
    });
    rows.push({
      extension: 'IridiumLimits',
      hook: 'afterLoadDocument',
      title: 'a failing measurement is contained',
      run: () =>
        hookOf(
          scene.extension,
          'afterLoadDocument',
        )(
          afterLoadPayload(
            scene.connection.connection.document,
            scene.connection.connection.context,
          ),
        ),
      outcome: resolves(),
      metrics: scene.harness.metrics,
    });
  }
  {
    const scene = limitsScene();
    vi.spyOn(scene.budget, 'release').mockImplementation(() => {
      throw BOOM;
    });
    rows.push({
      extension: 'IridiumLimits',
      hook: 'afterUnloadDocument',
      title: 'a failing release is contained',
      run: () => hookOf(scene.extension, 'afterUnloadDocument')(afterUnloadPayload(scene.noteName)),
      outcome: resolves(),
      metrics: scene.harness.metrics,
    });
  }
  {
    const scene = limitsScene();
    vi.spyOn(scene.harness.clock, 'now').mockImplementation(() => {
      throw BOOM;
    });
    rows.push({
      extension: 'IridiumLimits',
      hook: 'beforeHandleMessage',
      title: 'a failing rate window is contained; the message is neither refused nor lost',
      run: () =>
        hookOf(
          scene.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            scene.connection.connection,
            updateFrame(scene.noteName, new Uint8Array(4)),
          ),
        ),
      outcome: resolves(),
      metrics: scene.harness.metrics,
    });
  }
  return rows;
}

async function persistenceRows(): Promise<Row[]> {
  const rows: Row[] = [];
  {
    const scene = await persistenceScene();
    scene.connection.connection.readOnly = true;
    vi.spyOn(scene.harness.persistence, 'writerOfDocument').mockImplementation(() => {
      throw BOOM;
    });
    rows.push({
      extension: 'IridiumPersistence',
      hook: 'beforeHandleMessage',
      title:
        'a failed latch notice is contained while protocol read-only enforcement remains active',
      run: () =>
        hookOf(
          scene.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            scene.connection.connection,
            updateFrame(scene.document.name, new Uint8Array([0, 0])),
          ),
        ),
      outcome: resolves(),
      metrics: scene.hooks.metrics,
    });
  }

  const scenes = await Promise.all(Array.from({ length: 7 }, () => persistenceScene()));
  const [
    loadScene,
    attachScene,
    connectedScene,
    statelessScene,
    unloadedScene,
    storeScene,
    vetoScene,
  ] = scenes;
  if (
    loadScene === undefined ||
    attachScene === undefined ||
    connectedScene === undefined ||
    statelessScene === undefined ||
    unloadedScene === undefined ||
    storeScene === undefined ||
    vetoScene === undefined
  ) {
    throw new Error('seven scenes were built');
  }

  vi.spyOn(loadScene.harness.persistence, 'load').mockRejectedValue(BOOM);
  const other = fakeDocumentOf(
    noteDocName(loadScene.hooks.world.note(loadScene.hooks.world.vault())),
  );
  rows.push({
    extension: 'IridiumPersistence',
    hook: 'onLoadDocument',
    title:
      'a failing load refuses the document rather than serving it empty, and releases the budget',
    run: async () => {
      try {
        return await hookOf(
          loadScene.extension,
          'onLoadDocument',
        )(loadPayload(other, loadScene.connection.connection.context));
      } finally {
        expect(loadScene.loadFailures).toEqual([other.name]);
      }
    },
    outcome: rejection('note-not-found'),
    metrics: loadScene.hooks.metrics,
  });

  vi.spyOn(attachScene.harness.persistence, 'attach').mockImplementation(() => {
    throw BOOM;
  });
  rows.push({
    extension: 'IridiumPersistence',
    hook: 'afterLoadDocument',
    title: 'a failing attach is contained',
    run: async () => {
      // A second load of the same document leaves a loaded state for `afterLoadDocument` to attach.
      const context = attachScene.connection.connection.context;
      await hookOf(
        attachScene.extension,
        'onLoadDocument',
      )(loadPayload(attachScene.document, context));
      return hookOf(
        attachScene.extension,
        'afterLoadDocument',
      )(afterLoadPayload(attachScene.document, context));
    },
    outcome: resolves(),
    metrics: attachScene.hooks.metrics,
  });

  for (const [scene, hook] of [
    [connectedScene, 'connected'],
    [statelessScene, 'onStateless'],
    [unloadedScene, 'afterUnloadDocument'],
  ] as const) {
    const method = hook === 'afterUnloadDocument' ? 'detach' : 'writerOfDocument';
    vi.spyOn(scene.harness.persistence, method).mockImplementation(() => {
      throw BOOM;
    });
    rows.push({
      extension: 'IridiumPersistence',
      hook,
      title: `a failing writer lookup in ${hook} is contained`,
      run: () => {
        const invoke = hookOf(scene.extension, hook);
        if (hook === 'connected') return invoke(connectedPayloadFor(scene.connection.connection));
        if (hook === 'onStateless') {
          return invoke(statelessPayload(scene.connection.connection, '{"v":1,"t":"flush"}'));
        }
        return invoke(afterUnloadPayload(scene.document.name));
      },
      outcome: resolves(),
      metrics: scene.hooks.metrics,
    });
  }

  // The row the inventory names: a store failure is `persist-failed` plus a retry, and the store
  // hook that follows keeps the document with a typed marker whose cause is the writer's own.
  storeScene.harness.store.failNext({ kind: 'write', error: new Error('MySQL is away') });
  storeScene.document.transact(
    () => {
      getContent(storeScene.document).insert(0, 'x');
    },
    { source: 'connection', connection: storeScene.connection.connection },
  );
  await settle(20);
  rows.push({
    extension: 'IridiumPersistence',
    hook: 'onStoreDocument',
    title:
      'a store failure is persist-failed plus a retry; the store hook keeps the document, typed',
    run: async () => {
      const writer = storeScene.harness.persistence.writerOfDocument(storeScene.document.name);
      expect(writer?.state).toBe('retrying');
      expect(decoded(statelessPayloads(storeScene.connection.socket)).map((m) => m.t)).toContain(
        'persist-failed',
      );
      try {
        return await hookOf(
          storeScene.extension,
          'onStoreDocument',
        )(storePayload(storeScene.document, storeScene.connection.connection.context));
      } finally {
        // The retry commits: the acknowledgement follows once the backoff elapses.
        await storeScene.harness.clock.advance(5_000);
        await writer?.drain();
        expect(writer?.lastPersisted.seq).toBe(2);
        expect(decoded(statelessPayloads(storeScene.connection.socket)).map((m) => m.t)).toContain(
          'persisted',
        );
      }
    },
    outcome: {
      kind: 'signal',
      matches: (error) =>
        error instanceof StoreRejected && error.cause instanceof CompactionUnavailable,
    },
    metrics: storeScene.hooks.metrics,
  });

  const vetoWriter = vetoScene.harness.persistence.writerOfDocument(vetoScene.document.name);
  if (vetoWriter === undefined) throw new Error('the scene attached no writer');
  vi.spyOn(vetoWriter, 'unloadVeto').mockRejectedValue(BOOM);
  rows.push({
    extension: 'IridiumPersistence',
    hook: 'beforeUnloadDocument',
    title: 'a veto check that cannot run is a veto, never an unload',
    run: () =>
      hookOf(vetoScene.extension, 'beforeUnloadDocument')(beforeUnloadPayload(vetoScene.document)),
    outcome: { kind: 'signal', matches: (error) => error instanceof UnloadVeto },
    metrics: vetoScene.hooks.metrics,
  });
  return rows;
}

function vaultRows(): Row[] {
  const rows: Row[] = [];
  const scene = vaultScene();
  rows.push({
    extension: 'IridiumVaultChannel',
    hook: 'onLoadDocument',
    title: 'a vault document loads empty',
    run: () =>
      hookOf(
        scene.extension,
        'onLoadDocument',
      )(loadPayload(scene.connection.connection.document, scene.connection.connection.context)),
    outcome: resolves(false),
    metrics: scene.hooks.metrics,
  });
  rows.push({
    extension: 'IridiumVaultChannel',
    hook: 'onStoreDocument',
    title: 'a vault document stores nothing and ends the store chain with the library marker',
    run: () =>
      hookOf(
        scene.extension,
        'onStoreDocument',
      )(storePayload(scene.connection.connection.document, scene.connection.connection.context)),
    outcome: { kind: 'signal', matches: (error) => error instanceof SkipFurtherHooksError },
    metrics: scene.hooks.metrics,
  });
  rows.push({
    extension: 'IridiumVaultChannel',
    hook: 'beforeHandleMessage',
    title: 'content on a vault channel is refused, typed',
    run: () =>
      hookOf(
        scene.extension,
        'beforeHandleMessage',
      )(
        messagePayload(
          scene.connection.connection,
          updateFrame(scene.vaultName, new Uint8Array(2)),
        ),
      ),
    outcome: rejection('protocol-error'),
    metrics: scene.hooks.metrics,
  });
  rows.push({
    extension: 'IridiumVaultChannel',
    hook: 'beforeHandleAwareness',
    title: 'a malformed vault awareness state is refused, typed, and the connection closed',
    run: async () => {
      try {
        return await hookOf(
          scene.extension,
          'beforeHandleAwareness',
        )(awarenessPayload(scene.connection.connection, new Map([[1, { user: { id: 'nope' } }]])));
      } finally {
        expect(closeReasons(scene.connection.socket)).toEqual(['awareness-spoof']);
      }
    },
    outcome: rejection('awareness-spoof'),
    metrics: scene.hooks.metrics,
  });
  const closing = vaultScene();
  vi.spyOn(closing.connection.connection, 'close').mockImplementation(() => {
    throw BOOM;
  });
  rows.push({
    extension: 'IridiumVaultChannel',
    hook: 'onStateless',
    title: 'a close that fails while refusing a stateless message is contained',
    run: () =>
      hookOf(
        closing.extension,
        'onStateless',
      )(statelessPayload(closing.connection.connection, '{"v":1,"t":"flush"}')),
    outcome: resolves(),
    metrics: closing.hooks.metrics,
  });
  return rows;
}

async function allRows(): Promise<Row[]> {
  return [...authRows(), ...limitsRows(), ...(await persistenceRows()), ...vaultRows()];
}

describe('collab.hooks-never-reject.unit [hp:HP-2]', () => {
  it('drives every registered hook with its dependency failing, and none rejects untyped', async () => {
    const table = await allRows();
    for (const row of table) {
      const label = `${row.extension}.${row.hook}: ${row.title}`;
      // eslint-disable-next-line no-await-in-loop -- one row at a time keeps a failure attributable
      const observation = await observe(row);
      expect({ label, ...observation }).toEqual({ label, ...expected(row) });
    }
  });

  it('covers every hook each extension registers, so a new hook needs a row here', async () => {
    const harness = hookHarness();
    const persistence = createHarness();
    const extensions = [
      createAuthExtension(harness.deps),
      createLimitsExtension({
        budget: new AdmissionBudget({ maxLoadedDocs: 1, maxStateBytesTotal: 1 }),
        reads: harness.world.reads,
        channel: harness.channel,
        documents: () => harness.documents,
        clock: harness.clock,
        audit: harness.audit,
        logger: harness.logger,
        metrics: () => null,
        collabMetrics: () => null,
      }),
      createPersistenceExtension({
        persistence: persistence.persistence,
        gateway: harness.gateway,
        clock: harness.clock,
        logger: harness.logger,
        metrics: () => null,
        onLoadFailed: () => undefined,
        onUnloaded: () => undefined,
      }),
      createVaultChannelExtension({ logger: harness.logger, metrics: () => null }),
    ];
    const covered = new Set((await allRows()).map((row) => `${row.extension}.${row.hook}`));
    const registered = extensions.flatMap((extension) =>
      registeredHooks(extension).map((hook) => `${extension.extensionName ?? '?'}.${hook}`),
    );
    expect(registered.length).toBeGreaterThan(0);
    expect([...covered].toSorted()).toEqual([...new Set(registered)].toSorted());
    // Nothing outside the twelve Iridium names is registered.
    const foreign = extensions.flatMap((extension) =>
      Object.keys(extension).filter(
        (key) =>
          key !== 'extensionName' &&
          key !== 'priority' &&
          !COLLAB_HOOK_NAMES.some((name) => name === key),
      ),
    );
    expect(foreign).toEqual([]);
    // The epoch table the auth scene seeds is the product's, not a stub.
    expect(harness.world.epochs).toBeInstanceOf(EpochTable);
  });
});
