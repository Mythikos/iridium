/** Live compatibility policy, SemVer precedence, and refusal ordering without replacing product rules. */
import { RELEASE_MIN_CLIENT_VERSION } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { fakeDatabase } from '../../test/support/fake-driver.ts';
import { applyClientVersionGate, clientVersionProblem, minimumClientVersion } from './version.ts';

type Request = {
  method: string;
  url: string;
  routeOptions: { url: string | undefined };
  headers: Record<string, string | string[] | undefined>;
  iridiumClientVersion: string | null;
};
type Hook = (
  request: Request,
  reply?: { header(name: string, value: string): void },
  payload?: unknown,
) => Promise<unknown>;

function request(
  version: string | undefined,
  url = '/api/v1/auth/sessions',
  method = 'POST',
): Request {
  return {
    method,
    url,
    routeOptions: { url: url.split('?')[0] },
    headers: { 'x-iridium-client-version': version },
    iridiumClientVersion: version ?? null,
  };
}

function fixture(initial: string | null = '1.0.0') {
  let value = initial;
  const fake = fakeDatabase({ script: () => ({ rows: value === null ? [] : [{ value }] }) });
  const hooks = new Map<string, Hook>();
  const host = {
    database: { mode: 'connect', dbApp: fake.db },
    addHook: (name: string, hook: Hook): void => {
      hooks.set(name, hook);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the unit scripts only the hook-registration I/O boundary, never constructs a second server
  applyClientVersionGate(host as unknown as FastifyInstance);
  const check = hooks.get('onRequest');
  const send = hooks.get('onSend');
  if (check === undefined || send === undefined)
    throw new Error('The compatibility hooks must both be mounted.');
  return {
    fake,
    check,
    send,
    change: (next: string | null): void => {
      value = next;
    },
  };
}

describe('rest.client-version.unit [area:ops]', () => {
  it.each([
    ['0.0.0', '0.0.1'],
    ['1.9.0', '1.10.0'],
    ['9.9.9', '10.0.0'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
    ['1.0.0-alpha.beta', '1.0.0-beta'],
    ['1.0.0-beta.2', '1.0.0-beta.11'],
    ['1.0.0-rc.1', '1.0.0'],
    ['1.0.0-A', '1.0.0-a'],
    ['9007199254740992.0.0', '9007199254740993.0.0'],
    ['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
  ])('orders %s below %s without numeric rounding', (older, newer) => {
    expect(clientVersionProblem(older, newer)).toMatchObject({
      code: 'client_outdated',
      status: 426,
      extensions: { detail: newer },
    });
    expect(clientVersionProblem(newer, older)).toBeNull();
    expect(clientVersionProblem(newer, newer)).toBeNull();
  });

  it.each(['0.0.0', '1.2.3', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x-y-z.--'])(
    'ignores build metadata for %s',
    (version) => {
      expect(clientVersionProblem(version + '+first.001', version + '+second.002')).toBeNull();
    },
  );

  it.each([
    '',
    '1',
    '1.2',
    'v1.2.3',
    '1.2.3.4',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.0.0-01',
    '1.0.0-rc..1',
    '1.0.0+',
    '1.0.0+build..tag',
    '1.0.0-ä',
    ' 1.0.0',
    '1.0.0 ',
    '1.0.0-' + 'x'.repeat(64),
  ])('refuses malformed explicit version %j', (version) => {
    expect(clientVersionProblem(version, '0.0.0')).toMatchObject({
      code: 'validation_failed',
      status: 422,
    });
  });

  it('refuses an invalid floor even through the pure comparison boundary', () => {
    expect(() => clientVersionProblem('1.0.0', 'broken')).toThrow(/validate the durable floor/);
  });

  it('reads each committed floor independently and fails closed when missing or corrupt', async () => {
    const target = fixture('1.0.0');
    try {
      expect(await minimumClientVersion({ mode: 'connect', dbApp: target.fake.db })).toBe('1.0.0');
      target.change('2.0.0');
      expect(await minimumClientVersion({ mode: 'connect', dbApp: target.fake.db })).toBe('2.0.0');
      expect(target.fake.executed.map((query) => query.parameters)).toEqual([
        ['min_client_version'],
        ['min_client_version'],
      ]);
      target.change(null);
      await expect(
        minimumClientVersion({ mode: 'connect', dbApp: target.fake.db }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      target.change('broken');
      await expect(
        minimumClientVersion({ mode: 'connect', dbApp: target.fake.db }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(minimumClientVersion({ mode: 'connect', dbApp: null })).rejects.toMatchObject({
        code: 'not_ready',
      });
      expect(await minimumClientVersion({ mode: 'none', dbApp: null })).toBe(
        RELEASE_MIN_CLIENT_VERSION,
      );
    } finally {
      await target.fake.db.destroy();
    }
  });

  it('serves the SemVer maximum of the release floor and the operator floor', async () => {
    // A54 as amended: the operator can raise the release's floor and never lower it. `0.0.0-0` is the
    // lowest SemVer precedence there is, so it is below the floor whatever value a release carries.
    expect(clientVersionProblem(RELEASE_MIN_CLIENT_VERSION, RELEASE_MIN_CLIENT_VERSION)).toBeNull();
    const below = '0.0.0-0';
    const target = fixture(below);
    try {
      expect(clientVersionProblem(below, RELEASE_MIN_CLIENT_VERSION)).toMatchObject({
        code: 'client_outdated',
      });
      expect(await minimumClientVersion({ mode: 'connect', dbApp: target.fake.db })).toBe(
        RELEASE_MIN_CLIENT_VERSION,
      );
      target.change('999.0.0');
      expect(await minimumClientVersion({ mode: 'connect', dbApp: target.fake.db })).toBe(
        '999.0.0',
      );
      target.change(RELEASE_MIN_CLIENT_VERSION);
      expect(await minimumClientVersion({ mode: 'connect', dbApp: target.fake.db })).toBe(
        RELEASE_MIN_CLIENT_VERSION,
      );
    } finally {
      await target.fake.db.destroy();
    }
  });

  it('bypasses absent versions, operational paths and GET metadata without a SQL read', async () => {
    const target = fixture();
    try {
      await target.check(request(undefined));
      await target.check(request('not-a-version', '/healthz?probe=1', 'GET'));
      await target.check(request('0.0.0', '/readyz', 'GET'));
      await target.check(request('0.0.0', '/metrics', 'GET'));
      await target.check(request('broken', '/api/v1/meta?probe=1', 'GET'));
      expect(target.fake.executed).toHaveLength(0);
      await expect(target.check(request('0.0.0', '/api/v1/meta', 'HEAD'))).rejects.toMatchObject({
        code: 'client_outdated',
      });
    } finally {
      await target.fake.db.destroy();
    }
  });

  it('validates the original header before SQL and reads the live floor for valid explicit versions', async () => {
    const target = fixture();
    try {
      const malformed = request('malformed');
      await expect(target.check(malformed)).rejects.toMatchObject({ code: 'validation_failed' });
      const duplicate = request('1.0.0');
      duplicate.headers['x-iridium-client-version'] = ['1.0.0', '2.0.0'];
      await expect(target.check(duplicate)).rejects.toMatchObject({ code: 'validation_failed' });
      const truncated = request('1.0.0+tag');
      truncated.iridiumClientVersion = '1.0.0';
      await expect(target.check(truncated)).rejects.toMatchObject({ code: 'validation_failed' });
      expect(target.fake.executed).toHaveLength(0);
      await expect(target.check(request('0.0.0'))).rejects.toMatchObject({
        code: 'client_outdated',
        extensions: { detail: '1.0.0' },
      });
      await expect(target.check(request('1.0.0'))).resolves.toBeUndefined();
      expect(target.fake.executed).toHaveLength(2);
    } finally {
      await target.fake.db.destroy();
    }
  });

  it('adds the API counter to success and early failure bodies without rewriting the payload', async () => {
    const target = fixture();
    try {
      const header = vi.fn<(name: string, value: string) => void>();
      const body = '{"code":"unauthenticated"}';
      expect(
        await target.send(request(undefined, '/api/v1/auth/me?probe=1', 'GET'), { header }, body),
      ).toBe(body);
      expect(header).toHaveBeenCalledExactlyOnceWith('x-iridium-api-version', '1');
      header.mockClear();
      await target.send(request(undefined, '/api/v1'), { header }, body);
      expect(header).toHaveBeenCalledOnce();
      header.mockClear();
      await target.send(request(undefined, '/api/v11/meta'), { header }, body);
      expect(header).not.toHaveBeenCalled();
    } finally {
      await target.fake.db.destroy();
    }
  });
});
