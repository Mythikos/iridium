/** First successor's additive contract, anchored to the immutable v0.1.0 release tag (A54). */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AwarenessState,
  ClientNoteMessage,
  Meta,
  ServerNoteMessage,
  ServerVaultMessage,
  VaultAwarenessState,
} from '@iridium/contracts';
import type { IridiumIpcInvokeChannels as CurrentChannels } from '@iridium/contracts/desktop-ipc';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { IridiumIpcInvokeChannels as PreviousChannels } from '../contract/baselines/1/desktop-ipc.d.ts';
import { startCollab } from '../support/collab-harness.ts';
import { object, openApiChanges, schemaChanges } from '../support/wire-compatibility.ts';

const directory = join(import.meta.dirname, '../contract/baselines/1');
const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown;

// The compiler proves each previous IPC request is accepted and every response remains assignable.
// Removing a channel or changing a promised type makes this object fail the normal type gate.
const ipcCompatible: {
  [
    Channel in keyof PreviousChannels
  ]: PreviousChannels[Channel]['request'] extends CurrentChannels[Channel]['request']
    ? CurrentChannels[Channel]['response'] extends PreviousChannels[Channel]['response']
      ? true
      : never
    : never;
} = { 'iridium:app:info': true };

describe('compat.n-minus-1.integration [area:ops]', () => {
  it('preserves previous operations, validation, stateless envelopes and IPC at the reported apiVersion', async () => {
    const manifest = object(read('manifest.json'));
    expect(manifest['tag']).toBe('v0.1.0');
    expect(manifest['commit']).toMatch(/^[0-9a-f]{40}$/);
    for (const [file, hash] of Object.entries(object(manifest['files']))) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(directory, file)))
          .digest('hex'),
        file,
      ).toBe(hash);
    }
    const harness = await startCollab();
    try {
      const response = await harness.server
        .rest()
        .get('/meta', { headers: { 'x-iridium-client-version': '0.1.0' } });
      expect(response.status).toBe(200);
      const meta = Meta.parse(response.body);
      expect(meta.apiVersion).toBe(manifest['apiVersion']);
      const changes = openApiChanges(read('openapi.json'), harness.application().swagger());
      const baseline = object(read('stateless.json'));
      const current = {
        ServerNoteMessage,
        ServerVaultMessage,
        ClientNoteMessage,
        AwarenessState,
        VaultAwarenessState,
      };
      for (const [name, schema] of Object.entries(current)) {
        const emitted = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
        changes.push(
          ...schemaChanges(
            baseline[name],
            emitted,
            name === 'ClientNoteMessage' ? 'request' : 'response',
            baseline[name],
            emitted,
            name,
          ),
        );
      }
      expect(
        changes,
        'Breaking wire changes require an apiVersion/minClientVersion migration, not rewriting the previous baseline.',
      ).toEqual([]);
      expect(Object.values(ipcCompatible).every(Boolean)).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
