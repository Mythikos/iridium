/** Bootstrap the M1 cast through the shipped CLI and public account/password endpoints. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createSeedApi, restClient, runIridiumCli } from '@iridium/testkit';
import { expect, test as setup } from '@playwright/test';

const ROLES = ['admin', 'editorA', 'editorB', 'editorC', 'viewer', 'outsider'] as const;
const AUTH_DIRECTORY = fileURLToPath(new URL('../.auth/', import.meta.url));

setup(
  'bootstrap real accounts and save their authenticated browser states',
  async ({ baseURL }) => {
    if (baseURL === undefined) throw new Error('The setup project requires a server baseURL');
    const seed = createSeedApi({
      client: () => restClient({ origin: baseURL }),
      cli: (args) => runIridiumCli(args, { env: { NODE_ENV: 'test', PUBLIC_ORIGIN: baseURL } }),
      suffix: `-${randomUUID()}`,
    });
    const kernel = await seed.kernel();
    await mkdir(AUTH_DIRECTORY, { recursive: true });
    await Promise.all(
      ROLES.map(async (role) => {
        // Each state is produced by an actual web login, with the real Secure/HttpOnly cookie.
        const session = await seed.signIn(kernel[role]);
        const me = await session.client.get('/auth/me');
        expect(me.status).toBe(200);
        const cookies = session.jar.cookies().map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: new URL(baseURL).hostname,
          path: cookie.path,
          expires: cookie.expiresAt === undefined ? -1 : cookie.expiresAt / 1000,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite:
            cookie.sameSite?.toLowerCase() === 'strict'
              ? 'Strict'
              : cookie.sameSite?.toLowerCase() === 'none'
                ? 'None'
                : 'Lax',
        }));
        expect(cookies.some((cookie) => cookie.name === '__Host-iridium_session')).toBe(true);
        await writeFile(
          new URL(`${role}.json`, new URL('../.auth/', import.meta.url)),
          JSON.stringify({ cookies, origins: [] }),
          { mode: 0o600 },
        );
      }),
    );
    // Identifiers only; no password, session credential or one-time link belongs in the fixture map.
    await writeFile(
      new URL('kernel.json', new URL('../.auth/', import.meta.url)),
      JSON.stringify({
        vaultId: kernel.vault.id,
        rootNodeId: kernel.vault.rootNodeId,
        noteId: kernel.note.id,
        users: Object.fromEntries(ROLES.map((role) => [role, kernel[role].id])),
      }),
    );
  },
);
