/**
 * `auth.pepper-rotation.integration` (04-auth-and-access-control.md sections 3.5 and 3.6; D04-05;
 * ARCH-09): a credential hashed under pepper version 1 still verifies after the promoted version is
 * rotated to 2, and the successful login transparently re-hashes it under version 2 — the stored
 * `pepper_version` moves from 1 to 2 with the password unchanged, and no login is interrupted by the
 * rotation. The rotation is observed by the very next login with no restart and no cache refresh,
 * because `schema_meta.pepper_version` is read per password operation. A promoted version the
 * keyring lacks makes every password operation answer `503`, never a wrong hash.
 *
 * `iridium keys rotate pepper` (the CLI that writes the row) is the wave-2 `cli` stream's; the
 * "downgrade refuses to boot" half of the inventory row belongs to that command's own
 * `keys-rotate.integration`, and this suite drives the row it writes.
 */
import type { UserId } from '@iridium/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PEPPER_VERSION_KEY } from '../../src/auth/credentials/pepper-version.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser } from '../support/seed.ts';

let context: AuthTestServer;

beforeAll(async () => {
  // A second pepper version is configured; version 1 is the harness's unversioned `AUTH_PASSWORD_PEPPER`.
  context = await startAuthServer({
    extraEnv: { AUTH_PASSWORD_PEPPER_V2: 'rotation-pepper-two-not-a-secret' },
  });
});

afterAll(async () => {
  // `schema_meta` survives the per-test truncation and the worker schema is shared across files, so
  // the active pepper version is restored to 1 before this server stops — a later suite has no v2 key.
  await context.db
    .updateTable('schema_meta')
    .set({ value: '1' })
    .where('key', '=', PEPPER_VERSION_KEY)
    .execute();
  await context.stop();
});

async function credential(userId: UserId) {
  return context.db
    .selectFrom('user_credentials')
    .select(['password_hash', 'pepper_version'])
    .where('user_id', '=', idBytes(userId))
    .executeTakeFirstOrThrow();
}

async function promotePepper(version: string): Promise<void> {
  await context.db
    .updateTable('schema_meta')
    .set({ value: version })
    .where('key', '=', PEPPER_VERSION_KEY)
    .execute();
}

beforeEach(async () => {
  // schema_meta intentionally survives the table reset between cases.
  await promotePepper('1');
});

describe('auth.pepper-rotation.integration [area:auth]', () => {
  it('re-hashes a v1 credential under v2 on the first login after the promoted version is rotated', async () => {
    const user = await seedUser(context, { email: 'rotate@example.test' });
    const before = await credential(user.id);
    expect(before.pepper_version).toBe(1);

    // The rotation is one row write; nothing in the process caches the promoted version.
    await promotePepper('2');
    await expect(context.app.auth.pepperVersion.current()).resolves.toBe(2);

    // The v1 credential still verifies, and the login re-hashes it under v2.
    const login = await desktopClient(context).post('/auth/sessions', {
      json: { email: user.email, password: user.password, client: 'desktop' },
    });
    expect(login.status).toBe(201);

    const after = await credential(user.id);
    expect(after.pepper_version).toBe(2);
    expect(after.password_hash).not.toBe(before.password_hash);
    // The password is unchanged: it still signs in, now against the v2 hash, and a second login
    // finds nothing left to re-hash.
    expect(
      (
        await desktopClient(context).post('/auth/sessions', {
          json: { email: user.email, password: user.password, client: 'desktop' },
        })
      ).status,
    ).toBe(201);
    expect((await credential(user.id)).password_hash).toBe(after.password_hash);
  });

  it('answers 503, never a wrong hash, while the promoted version has no configured pepper', async () => {
    const user = await seedUser(context, { email: 'rotate-missing@example.test' });
    const before = await credential(user.id);
    await promotePepper('9');
    try {
      // The credential still verifies under its own version, but the re-hash and every new hash
      // need the promoted key: a login is refused as unavailable rather than hashed under a stale one.
      const login = await desktopClient(context).post('/auth/sessions', {
        json: { email: user.email, password: user.password, client: 'desktop' },
      });
      expect(login.status).toBe(503);
      expect(login.body).toMatchObject({ code: 'unavailable' });
      expect(await credential(user.id)).toStrictEqual(before);
      // Refused before anything was written: no session row exists for the attempt.
      const sessions = await context.db
        .selectFrom('sessions')
        .select(context.db.fn.countAll<number>().as('n'))
        .where('user_id', '=', idBytes(user.id))
        .executeTakeFirstOrThrow();
      expect(sessions.n).toBe(0);
    } finally {
      await promotePepper('1');
    }
  });

  it('boots against a promoted version the keyring lacks, logs it, and answers 503 until it is fixed', async () => {
    const user = await seedUser(context, { email: 'rotate-boot@example.test' });
    await promotePepper('9');
    let degraded: AuthTestServer | null = null;
    try {
      // Hand the schema to this process: a standby correctly refuses all product requests, which
      // would hide the password-specific failure and recovery this case needs to exercise.
      await context.app.collab.ownerLease.relinquish();
      degraded = await startAuthServer({ waitForReady: false });
      expect(degraded.app.collab.ownerLease.held).toBe(true);
      const readiness = await degraded.app.inject('/readyz');
      expect(readiness.statusCode).toBe(503);
      expect(
        readiness.json<{ checks: { name: string; status: string }[] }>().checks,
      ).toContainEqual(expect.objectContaining({ name: 'key_versions', status: 'fail' }));
      const login = await desktopClient(degraded).post('/auth/sessions', {
        json: { email: user.email, password: user.password, client: 'desktop' },
      });
      expect(login.status).toBe(503);
      expect(login.body).toMatchObject({ code: 'unavailable' });
      await promotePepper('1');
      expect(
        (
          await desktopClient(degraded).post('/auth/sessions', {
            json: { email: user.email, password: user.password, client: 'desktop' },
          })
        ).status,
      ).toBe(201);
    } finally {
      await promotePepper('1');
      await degraded?.stop();
      await expect(context.app.collab.ownerLease.tryAcquire()).resolves.toBe(true);
      await context.app.readiness.evaluate();
    }
  });
});
