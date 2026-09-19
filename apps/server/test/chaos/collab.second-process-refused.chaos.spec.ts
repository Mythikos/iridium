import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  connectToxiproxy,
  createOriginWebSocket,
  MYSQL_PROXY_NAME,
  withDeadline,
  workerSchemaName,
} from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

import { NIGHTLY_CHAOS } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

async function upgrade(url: string, origin: string): Promise<{ code: number; reason: string }> {
  const OriginSocket = createOriginWebSocket({ origin });
  const socket = new OriginSocket(url);
  try {
    return await withDeadline(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('close', (code: number, reason: Buffer) =>
          resolve({ code, reason: reason.toString() }),
        );
      }),
      { timeoutMs: 10_000, description: 'a real second process to refuse document ownership' },
    );
  } finally {
    socket.terminate();
  }
}

describe('collab.second-process-refused.chaos [hp:HP-2]', () => {
  it.each(Array.from({ length: NIGHTLY_CHAOS ? 20 : 1 }, (_, index) => index))(
    'refuses a second process and hands over acknowledged content after killing owner %i',
    async (iteration) => {
      const provided = inject('iridiumToxiproxy');
      const proxy = connectToxiproxy(provided.controlUrl).proxy(
        MYSQL_PROXY_NAME,
        provided.mysqlProxy.host,
        provided.mysqlProxy.port,
      );
      const scratch = mkdtempSync(join(tmpdir(), 'iridium-second-owner-'));
      const db = {
        ...provided.mysqlProxy,
        schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1'),
      };
      const owner = await startCollab({ mode: 'child', db, attachmentsDir: scratch });
      let standby: Awaited<ReturnType<typeof startCollab>> | undefined;
      try {
        await owner.server.waitReady();
        const cast = await owner.server.seed.kernel();
        const ownerSession = await owner.server.loginAsDesktop(cast.editorA);
        if (ownerSession.bearer === undefined)
          throw new Error('The real desktop session must have a bearer.');
        const clients = await Promise.all(
          [cast.editorA, cast.editorB].map((user) => owner.open(user, cast.note.id)),
        );
        await expectConverged(owner, cast.note.id, clients);
        const marker = clients[0]?.marker(`owner-${String(iteration)}`);
        const saved = await expectConverged(owner, cast.note.id, clients);
        const lock =
          'iridium_collab_owner:' +
          createHash('sha256').update(owner.server.schema).digest('base64url');
        const beforeOwner = await owner.sql.rows(`SELECT IS_USED_LOCK('${lock}');`);
        expect(Number(beforeOwner[0]?.[0])).toBeGreaterThan(0);
        if (NIGHTLY_CHAOS)
          await proxy.addToxic({
            type: 'latency',
            stream: 'upstream',
            attributes: { latency: (iteration * 149) % 501, jitter: 50 },
          });
        standby = await startCollab({ mode: 'child', db, attachmentsDir: scratch });
        const readiness = await standby.server
          .rest()
          .request<{ checks: { name: string; status: string }[] }>('GET', '/readyz');
        expect(readiness.status).toBe(503);
        expect(readiness.body.checks).toContainEqual(
          expect.objectContaining({ name: 'collab_owner_lease', status: 'fail' }),
        );
        expect(await upgrade(standby.server.wsUrl, standby.server.origin)).toEqual({
          code: 4503,
          reason: 'no-owner-lease',
        });
        expect(await upgrade(standby.server.wsUrl, standby.server.origin)).toEqual({
          code: 4503,
          reason: 'no-owner-lease',
        });
        expect(
          standby.logs.filter((line) => line.includes('"event":"collab.owner_lease.denied"')),
        ).toHaveLength(1);
        expect((await standby.server.rest().request('GET', '/healthz')).status).toBe(200);
        const reader = standby.server.rest({ bearer: ownerSession.bearer, client: 'desktop' });
        const refusedRead = await reader.api('GET', `/notes/${cast.note.id}/markdown`);
        expect(refusedRead.status).toBe(503);
        expect(refusedRead.body).toMatchObject({ code: 'not_ready' });
        expect(
          (
            await standby.server.rest().post('/auth/sessions', {
              json: {
                email: cast.editorA.email,
                password: cast.editorA.password,
                client: 'desktop',
                deviceName: 'standby-refused',
              },
            })
          ).status,
        ).toBe(503);
        expect((await standby.committed(cast.note.id)).head).toBe(saved.head);
        expect(await owner.sql.rows(`SELECT IS_USED_LOCK('${lock}');`)).toEqual(beforeOwner);
        expect(
          [...owner.logs, ...standby.logs].some((line) => line.includes('persist.cas_mismatch')),
        ).toBe(false);
        await owner.server.kill('SIGKILL');
        await Promise.all(clients.map((client) => client.close()));
        await standby.server.waitReady({ timeoutMs: 30_000 });
        const afterOwner = await owner.sql.rows(`SELECT IS_USED_LOCK('${lock}');`);
        expect(Number(afterOwner[0]?.[0])).toBeGreaterThan(0);
        expect(afterOwner).not.toEqual(beforeOwner);
        const admittedRead = await reader.api<string>(
          'GET',
          `/notes/${cast.note.id}/markdown?fresh=true`,
        );
        expect(admittedRead.status).toBe(200);
        expect(admittedRead.body).toBe(saved.text);
        const fresh = await standby.open(cast.editorC, cast.note.id);
        const recovered = await expectConverged(standby, cast.note.id, [fresh]);
        expect(recovered.text).toBe(saved.text);
        expect(recovered.text.split(marker ?? 'missing-marker')).toHaveLength(2);
        expect(recovered.head).toBe(saved.head);
      } finally {
        await proxy.removeAllToxics();
        await standby?.close();
        await owner.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
