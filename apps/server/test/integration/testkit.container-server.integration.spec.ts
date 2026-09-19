/** The production image, with a real database and only operator/API seeding paths. */
import {
  startServer,
  startTestEnv,
  type NoteClient,
  type TestEnv,
  type TestServer,
} from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let env: TestEnv;
let server: TestServer;
const clients: NoteClient[] = [];
beforeAll(async () => {
  env = await startTestEnv({ productionCredentials: true });
  server = await startServer({
    mode: 'container',
    db: { ...env.mysql, schema: env.mysql.templateSchema },
    extraEnv: env.serverEnv,
  });
  await server.waitReady();
}, 180_000);
afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  try {
    await server?.stop();
  } finally {
    await env?.stop();
  }
});

describe('testkit.container-server.integration [area:testkit]', () => {
  it('seeds through the shipped CLI and REST, survives SIGKILL, then exits cleanly on Linux SIGTERM', async () => {
    const seed = await server.seed.kernel();
    const editor = await server.client(seed.editorA, seed.note.id);
    clients.push(editor);
    await editor.waitFor('saved');
    const marker = '[production-container-recovery]';
    editor.text.insert(editor.text.length, marker);
    await editor.waitFor('saved');
    const expected = editor.text.toJSON();
    expect(
      (await server.rest().request('POST', '/__test__/faults', { json: { point: 'store.throw' } }))
        .status,
    ).toBe(404);
    await server.kill();
    await editor.close();
    await server.restart();
    const fresh = await server.client(seed.editorA, seed.note.id);
    clients.push(fresh);
    await fresh.waitFor('saved');
    expect(fresh.text.toJSON()).toBe(expected);
    expect(fresh.text.toJSON().split(marker)).toHaveLength(2);
    const audit = await server.cli(['audit', 'verify-chain']);
    expect(audit.code, audit.stderr).toBe(0);
    await fresh.close();
    await expect(server.kill('SIGTERM')).resolves.toBeUndefined();
  }, 120_000);
});
