/**
 * `collab.vault-channel.unit` — `IridiumVaultChannel`: a `vault:<id>` document carries presence and
 * server messages and nothing else (05-collaboration-and-durability.md, "The vault channel";
 * 09-api-reference.md §3.7; 12-milestones.md §5.2).
 */
import { SkipFurtherHooksError } from '@hocuspocus/common';
import { noteDocName, vaultDocName } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { closeReasons, fakeConnection, fakeDocumentOf } from './testing/fake-hocuspocus.ts';
import { step1Frame, step2Frame, updateFrame } from './testing/frames.ts';
import {
  authenticatedContext,
  awarenessPayload,
  hookHarness,
  hookOf,
  loadPayload,
  messagePayload,
  statelessPayload,
  storePayload,
} from './testing/hook-deps.ts';
import { createVaultChannelExtension } from './vault-channel.ts';

function scene(channel: 'vault' | 'note') {
  const harness = hookHarness();
  const extension = createVaultChannelExtension({
    logger: harness.logger,
    metrics: () => harness.metrics,
  });
  const vaultId = harness.world.vault();
  const noteId = harness.world.note(vaultId);
  const userId = harness.world.user();
  const document = fakeDocumentOf(
    channel === 'vault' ? vaultDocName(vaultId) : noteDocName(noteId),
  );
  const { connection, socket } = fakeConnection(
    document,
    authenticatedContext(harness.clock, {
      userId,
      sessionId: harness.world.session(userId),
      vaultId,
      noteId: channel === 'vault' ? null : noteId,
    }),
    { readOnly: channel === 'vault' },
  );
  return { ...harness, extension, connection, socket, document, userId };
}

describe('collab.vault-channel.unit [area:collab]', () => {
  it('loads a vault document empty and ends its store chain with the library marker', async () => {
    const s = scene('vault');
    await expect(
      hookOf(s.extension, 'onLoadDocument')(loadPayload(s.document, s.connection.context)),
    ).resolves.toBeUndefined();
    await expect(
      hookOf(s.extension, 'onStoreDocument')(storePayload(s.document, s.connection.context)),
    ).rejects.toBeInstanceOf(SkipFurtherHooksError);
  });

  it('refuses content on the vault channel and lets a sync step 1 through', async () => {
    const s = scene('vault');
    const name = s.document.name;
    const send = (frame: Uint8Array): Promise<unknown> =>
      hookOf(s.extension, 'beforeHandleMessage')(messagePayload(s.connection, frame));
    await expect(send(step1Frame(name, new Uint8Array(1)))).resolves.toBeUndefined();
    await expect(send(step2Frame(name, Uint8Array.of(0, 0)))).resolves.toBeUndefined();
    await expect(send(step2Frame(name, Uint8Array.of(0, 0, 0)))).rejects.toMatchObject({
      reason: 'protocol-error',
    });
    await expect(send(step2Frame(name, Uint8Array.of(0, 1, 1, 1, 0, 1)))).rejects.toMatchObject({
      reason: 'protocol-error',
    });
    await expect(send(updateFrame(name, Uint8Array.of(0, 0)))).rejects.toMatchObject({
      reason: 'protocol-error',
    });
    await expect(send(updateFrame(name, new Uint8Array(1)))).rejects.toMatchObject({
      reason: 'protocol-error',
      auditReason: 'vault_channel_write',
    });
    await expect(send(step2Frame(name, new Uint8Array(1)))).rejects.toMatchObject({
      reason: 'protocol-error',
    });
    expect(s.logger.events()).toContain('collab.write.rejected');
  });

  it('accepts the vault awareness shape and closes on any other', async () => {
    const s = scene('vault');
    await expect(
      hookOf(
        s.extension,
        'beforeHandleAwareness',
      )(
        awarenessPayload(
          s.connection,
          new Map([[1, { user: { id: s.userId }, activeNoteId: s.world.note(s.world.vault()) }]]),
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      hookOf(
        s.extension,
        'beforeHandleAwareness',
      )(awarenessPayload(s.connection, new Map([[1, { user: { id: s.userId }, cursor: null }]]))),
    ).rejects.toMatchObject({ reason: 'awareness-spoof', auditReason: 'vault_awareness_shape' });
    expect(closeReasons(s.socket)).toEqual(['awareness-spoof']);
  });

  it('closes a client stateless message on the vault channel as a protocol error', async () => {
    const s = scene('vault');
    await expect(
      hookOf(s.extension, 'onStateless')(statelessPayload(s.connection, '{"v":1,"t":"baseline"}')),
    ).resolves.toBeUndefined();
    expect(closeReasons(s.socket)).toEqual(['protocol-error']);
    expect(s.logger.events()).toContain('collab.write.rejected');
  });

  it('leaves a note document entirely alone', async () => {
    const s = scene('note');
    const name = s.document.name;
    await expect(
      hookOf(s.extension, 'onStoreDocument')(storePayload(s.document, s.connection.context)),
    ).resolves.toBeUndefined();
    await expect(
      hookOf(
        s.extension,
        'beforeHandleMessage',
      )(messagePayload(s.connection, updateFrame(name, new Uint8Array(1)))),
    ).resolves.toBeUndefined();
    await expect(
      hookOf(
        s.extension,
        'beforeHandleAwareness',
      )(awarenessPayload(s.connection, new Map([[1, { not: 'a vault state' }]]))),
    ).resolves.toBeUndefined();
    await expect(
      hookOf(s.extension, 'onStateless')(statelessPayload(s.connection, '{"v":1,"t":"flush"}')),
    ).resolves.toBeUndefined();
    expect(closeReasons(s.socket)).toEqual([]);
  });
});
