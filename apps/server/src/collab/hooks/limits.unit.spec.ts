/**
 * `collab.limits-hook.unit` — `IridiumLimits`: the admission budget at `onAuthenticate`, the
 * measured size at `afterLoadDocument`, the release at `afterUnloadDocument`, and the per-message
 * caps of `beforeHandleMessage` (05-collaboration-and-durability.md, "Admission control", "Limits
 * relevant to collaboration"; 09-api-reference.md §3.10; skeleton A50; HP-5).
 *
 * The budget and the rate window are the product's; the frames are written the way a client writes
 * them; the resolved row reaches the hook on the same payload `IridiumAuth` filled.
 */
import { LIMITS, noteDocName, vaultDocName } from '@iridium/contracts';
import { encodeState, getContent } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { AdmissionBudget } from '../limits.ts';
import { fakeConnection, fakeDocumentOf } from '../testing/fake-hocuspocus.ts';
import {
  awarenessFrameOf,
  pingFrame,
  statelessFrameOf,
  step1Frame,
  step2Frame,
  updateFrame,
} from '../testing/frames.ts';
import {
  afterLoadPayload,
  afterUnloadPayload,
  authenticatedContext,
  authenticatePayload,
  hookHarness,
  hookOf,
  messagePayload,
  preAuthContext,
  type HookHarness,
} from '../testing/hook-deps.ts';
import { createLimitsExtension } from './limits.ts';

interface GaugeValues {
  docsLoaded: number;
  stateBytes: number;
  refused: Array<{ reason: string }>;
}

function scene(limits: { maxLoadedDocs: number; maxStateBytesTotal: number }): HookHarness & {
  readonly budget: AdmissionBudget;
  readonly extension: ReturnType<typeof createLimitsExtension>;
  readonly gauges: GaugeValues;
} {
  const harness = hookHarness();
  const budget = new AdmissionBudget(limits);
  const gauges: GaugeValues = { docsLoaded: -1, stateBytes: -1, refused: [] };
  const extension = createLimitsExtension({
    budget,
    reads: harness.world.reads,
    channel: harness.channel,
    documents: () => harness.documents,
    clock: harness.clock,
    audit: harness.audit,
    logger: harness.logger,
    metrics: () => ({
      docsLoaded: { set: (value) => void (gauges.docsLoaded = value) },
      collabStateBytes: { set: (value) => void (gauges.stateBytes = value) },
      collabAdmissionRefusedTotal: { inc: (labels) => void gauges.refused.push(labels) },
    }),
    collabMetrics: () => harness.metrics,
  });
  return { ...harness, budget, extension, gauges };
}

/** `onAuthenticate` for a note, with the resolved row `IridiumAuth` would have put on the channel. */
async function admit(
  s: ReturnType<typeof scene>,
  noteName: string,
  snapshotSize: number,
  context = preAuthContext(s.clock),
): Promise<unknown> {
  const payload = authenticatePayload({ documentName: noteName, token: 'irrelevant', context });
  const vaultId = s.world.vault();
  s.channel.set(payload, {
    kind: 'note',
    vault: { id: vaultId, status: 'active', mcp_enabled: true },
    vaultStatus: 'active',
    nodeKind: 'note',
    deletedAt: null,
    initializedAt: s.clock.date(),
    snapshotSize,
  });
  return hookOf(s.extension, 'onAuthenticate')(payload);
}

async function messagesTotal(s: ReturnType<typeof scene>, type: string): Promise<number> {
  const snapshot = await s.metrics.collabMessagesTotal.get();
  return snapshot.values
    .filter((sample) => Reflect.get(sample.labels, 'type') === type)
    .reduce((sum, sample) => sum + sample.value, 0);
}

/** A connection on a fresh note document, for the per-message caps. */
function connected(
  s: ReturnType<typeof scene>,
  readOnly = false,
): {
  connection: ReturnType<typeof fakeConnection>['connection'];
  socket: ReturnType<typeof fakeConnection>['socket'];
  name: string;
} {
  const vaultId = s.world.vault();
  const noteId = s.world.note(vaultId);
  const userId = s.world.user();
  const document = fakeDocumentOf(noteDocName(noteId));
  const { connection, socket } = fakeConnection(
    document,
    authenticatedContext(s.clock, {
      userId,
      sessionId: s.world.session(userId),
      vaultId,
      noteId,
    }),
    { readOnly },
  );
  return { connection, socket, name: document.name };
}

describe('collab.limits-hook.unit [hp:HP-5]', () => {
  describe('the admission budget', () => {
    it('reserves the estimate on the first load, charges a second connection nothing, and refuses the ninth', async () => {
      const s = scene({ maxLoadedDocs: 8, maxStateBytesTotal: 1_000_000 });
      const names = Array.from({ length: 8 }, () => noteDocName(s.world.note(s.world.vault())));
      for (const name of names) {
        // eslint-disable-next-line no-await-in-loop -- eight loads, one after the other
        await admit(s, name, 1_000);
      }
      expect(s.budget.loadedDocs).toBe(8);
      expect(s.budget.stateBytes).toBe(8_000);
      // A second connection to a loaded document reserves nothing.
      const first = names[0] ?? '';
      s.documents.set(first, fakeDocumentOf(first));
      await admit(s, first, 1_000);
      expect(s.budget.loadedDocs).toBe(8);
      // The ninth is refused with `capacity`, counted, logged and audited against its vault.
      const ninth = noteDocName(s.world.note(s.world.vault()));
      const vaultId = s.world.vault();
      const userId = s.world.user();
      const context = authenticatedContext(s.clock, {
        userId,
        sessionId: s.world.session(userId),
        vaultId,
        noteId: s.world.note(vaultId),
      });
      await expect(admit(s, ninth, 1_000, context)).rejects.toMatchObject({
        reason: 'capacity',
        auditReason: 'capacity_docs',
      });
      expect(s.gauges.refused).toEqual([{ reason: 'docs' }]);
      expect(s.logger.events()).toContain('collab.admission.refused');
      expect(s.audit.events).toEqual([
        expect.objectContaining({
          action: 'collab.connection.rejected',
          reason: 'capacity_docs',
          vaultId,
        }),
      ]);
      expect(s.budget.loadedDocs).toBe(8);
    });

    it('refuses on bytes as well, and a vault channel costs no bytes', async () => {
      const s = scene({ maxLoadedDocs: 8, maxStateBytesTotal: 2_000 });
      await admit(s, noteDocName(s.world.note(s.world.vault())), 1_500);
      await expect(admit(s, noteDocName(s.world.note(s.world.vault())), 600)).rejects.toMatchObject(
        {
          reason: 'capacity',
          auditReason: 'capacity_bytes',
        },
      );
      const vaultName = vaultDocName(s.world.vault());
      const payload = authenticatePayload({
        documentName: vaultName,
        token: 'irrelevant',
        context: preAuthContext(s.clock),
      });
      await expect(hookOf(s.extension, 'onAuthenticate')(payload)).resolves.toBeUndefined();
      expect(s.budget.stateBytes).toBe(1_500);
      expect(s.budget.loadedDocs).toBe(2);
    });

    it('replaces the estimate with the measured V2 size after the load and releases it at unload', async () => {
      const s = scene({ maxLoadedDocs: 8, maxStateBytesTotal: 1_000_000 });
      const name = noteDocName(s.world.note(s.world.vault()));
      await admit(s, name, 12_345);
      const document = fakeDocumentOf(name);
      getContent(document).insert(0, 'measured');
      s.documents.set(name, document);
      await hookOf(
        s.extension,
        'afterLoadDocument',
      )(afterLoadPayload(document, preAuthContext(s.clock)));
      const measured = encodeState(document, 2).byteLength;
      expect(s.budget.stateBytes).toBe(measured);
      expect(s.gauges).toMatchObject({ docsLoaded: 1, stateBytes: measured });
      s.documents.delete(name);
      await hookOf(s.extension, 'afterUnloadDocument')(afterUnloadPayload(name));
      expect(s.budget.loadedDocs).toBe(0);
      expect(s.budget.stateBytes).toBe(0);
      expect(s.gauges).toMatchObject({ docsLoaded: 0, stateBytes: 0 });
      // A vault document measures as zero.
      const vaultDocument = fakeDocumentOf(vaultDocName(s.world.vault()));
      await hookOf(
        s.extension,
        'afterLoadDocument',
      )(afterLoadPayload(vaultDocument, preAuthContext(s.clock)));
      expect(s.budget.stateBytes).toBe(0);
    });
  });

  describe('beforeHandleMessage', () => {
    it('counts every frame by type and leaves awareness to the pre-dispatch cap', async () => {
      const s = scene({ maxLoadedDocs: 8, maxStateBytesTotal: 1 });
      const { connection, name } = connected(s);
      const send = (frame: Uint8Array): Promise<unknown> =>
        hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame));
      await send(updateFrame(name, new Uint8Array(3)));
      await send(step1Frame(name, new Uint8Array(1)));
      await send(awarenessFrameOf(name, new Uint8Array(2)));
      await send(statelessFrameOf(name, '{"v":1,"t":"flush"}'));
      await send(pingFrame(name));
      await expect(messagesTotal(s, 'sync')).resolves.toBe(2);
      await expect(messagesTotal(s, 'awareness')).resolves.toBe(1);
      await expect(messagesTotal(s, 'stateless')).resolves.toBe(1);
      await expect(messagesTotal(s, 'other')).resolves.toBe(1);
    });

    it('closes rate-limited on the message past the window, and the window slides', async () => {
      const s = scene({ maxLoadedDocs: 8, maxStateBytesTotal: 1 });
      const { connection, name } = connected(s);
      const send = (): Promise<unknown> =>
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(messagePayload(connection, updateFrame(name, new Uint8Array(1))));
      for (let count = 0; count < LIMITS.YJS_MESSAGES_PER_WINDOW; count += 1) {
        // eslint-disable-next-line no-await-in-loop -- the budget is filled one message at a time
        await send();
      }
      await expect(send()).rejects.toMatchObject({
        reason: 'rate-limited',
        auditReason: 'message_rate',
      });
      expect(s.logger.events()).toContain('collab.limit.exceeded');
      // Awareness is never counted against it.
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(messagePayload(connection, awarenessFrameOf(name, new Uint8Array(1)))),
      ).resolves.toBeUndefined();
      await s.clock.advance(LIMITS.YJS_MESSAGE_WINDOW_MS);
      await expect(send()).resolves.toBeUndefined();
    });

    it('closes too-large on a single update above the cap', async () => {
      const s = scene({ maxLoadedDocs: 8, maxStateBytesTotal: 1 });
      const { connection, name } = connected(s);
      const frame = updateFrame(name, new Uint8Array(LIMITS.YJS_UPDATE_MAX_BYTES));
      await expect(
        hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame)),
      ).rejects.toMatchObject({ reason: 'too-large' });
    });

    it('audits a read-only connection’s first write once, and never refuses it here', async () => {
      const s = scene({ maxLoadedDocs: 8, maxStateBytesTotal: 1 });
      const { connection, name } = connected(s, true);
      const send = (frame: Uint8Array): Promise<unknown> =>
        hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame));
      await expect(send(step1Frame(name, new Uint8Array(1)))).resolves.toBeUndefined();
      expect(s.audit.events).toEqual([]);
      await expect(send(updateFrame(name, new Uint8Array(2)))).resolves.toBeUndefined();
      await expect(send(step2Frame(name, new Uint8Array(2)))).resolves.toBeUndefined();
      expect(s.audit.events).toEqual([
        expect.objectContaining({ action: 'collab.write.rejected', reason: 'read_only' }),
      ]);
      expect(s.logger.events().filter((event) => event === 'collab.write.rejected')).toHaveLength(
        1,
      );
    });
  });
});
