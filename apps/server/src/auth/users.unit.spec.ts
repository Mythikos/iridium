/**
 * `auth.users.unit` (03-data-model.md section 3; 09-api-reference.md section 2.0): the two user
 * reads issue one statement joining the credential row, answer `null` for an unknown user, the
 * required form throws the typed error that names the missing row, and the `User` DTO renders the
 * columns as the wire spells them, with `hasCredentials` from the join.
 */
import { UserId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { fakeDatabase, type ScriptedAnswer } from '../../test/support/fake-driver.ts';
import { idBytes } from './ids.ts';
import {
  emailKeyOf,
  loadUserByEmail,
  loadUserById,
  PrincipalUserMissingError,
  requireUserRow,
  toUserDto,
  type UserWithCredential,
} from './users.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const NOW = new Date('2026-09-13T12:00:00.000Z');

const ROW: UserWithCredential = {
  id: idBytes(USER),
  email: 'Ada@Example.test',
  email_key: 'ada@example.test',
  display_name: 'Ada',
  is_server_admin: true,
  status: 'active',
  color_hue: 137,
  authz_version: 2,
  version: 3,
  created_at: NOW,
  updated_at: NOW,
  last_login_at: null,
  password_hash: null,
  pepper_version: null,
};

function database(answer: ScriptedAnswer) {
  return fakeDatabase({ script: () => answer });
}

describe('auth.users.unit [area:auth]', () => {
  it('reads a user by email key and by id with the credential columns joined', async () => {
    const byEmail = database({ rows: [ROW] });
    await expect(loadUserByEmail(byEmail.db, 'Ada@Example.test')).resolves.toStrictEqual(ROW);
    expect(byEmail.executed[0]?.sql).toContain('left join `user_credentials`');
    expect(byEmail.executed[0]?.parameters).toStrictEqual([emailKeyOf('Ada@Example.test')]);

    const byId = database({ rows: [ROW] });
    await expect(loadUserById(byId.db, USER)).resolves.toStrictEqual(ROW);
    expect(byId.executed[0]?.parameters).toStrictEqual([idBytes(USER)]);
  });

  it('answers null for an unknown user on both reads', async () => {
    await expect(loadUserByEmail(database({ rows: [] }).db, 'nobody@example.test')).resolves.toBe(
      null,
    );
    await expect(loadUserById(database({ rows: [] }).db, USER)).resolves.toBeNull();
  });

  it('requires the row a principal names, throwing the typed error when it is gone', async () => {
    await expect(requireUserRow(database({ rows: [ROW] }).db, USER)).resolves.toStrictEqual(ROW);
    const thrown = await requireUserRow(database({ rows: [] }).db, USER).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(PrincipalUserMissingError);
    expect(thrown).toMatchObject({ userId: USER, message: expect.stringContaining(USER) });
  });

  it('renders the DTO with wire spellings and hasCredentials from the join', () => {
    expect(toUserDto(ROW)).toStrictEqual({
      id: USER,
      email: 'Ada@Example.test',
      displayName: 'Ada',
      isServerAdmin: true,
      status: 'active',
      colorHue: 137,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      lastLoginAt: null,
      hasCredentials: false,
      version: 3,
    });
    expect(
      toUserDto({ ...ROW, password_hash: '$argon2id$…', pepper_version: 1, last_login_at: NOW }),
    ).toMatchObject({ hasCredentials: true, lastLoginAt: NOW.toISOString() });
  });
});
