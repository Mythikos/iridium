/** Exercise the production error handler over HTTP for the complete current envelope vocabulary. */
import {
  ERROR_CODES,
  ERROR_CODE_STATUS,
  ERROR_CODE_TITLE,
  PROBLEM_VARIANTS,
  ProblemDetails,
  type ProblemVariant,
} from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProblemError } from '../../src/security/problem.ts';
import {
  buildWithoutDatabase,
  NO_DATABASE_HOST,
  type NoDatabaseApp,
} from '../support/no-database-app.ts';

const PRIVATE = 'SELECT password_hash FROM users /srv/iridium/private.ts Bearer fixture-secret';
let booted: NoDatabaseApp;

describe('problem-details.contract [area:contracts]', () => {
  beforeAll(async () => {
    booted = await buildWithoutDatabase();
    for (const code of ERROR_CODES) {
      booted.app.get(`/__test__/problem/${code}`, { config: { auth: 'test-only' } }, () => {
        const failure = new ProblemError(code);
        failure.message = PRIVATE;
        failure.stack = PRIVATE;
        throw failure;
      });
    }
    for (const variant of Object.keys(PROBLEM_VARIANTS).filter((key): key is ProblemVariant =>
      Object.hasOwn(PROBLEM_VARIANTS, key),
    )) {
      booted.app.get(
        `/__test__/problem/variant/${variant}`,
        { config: { auth: 'test-only' } },
        () => {
          throw new ProblemError(PROBLEM_VARIANTS[variant].code, {}, variant);
        },
      );
    }
    booted.app.get('/__test__/problem/unexpected', { config: { auth: 'test-only' } }, () => {
      throw new Error(PRIVATE);
    });
    booted.app.get('/__test__/problem/current', { config: { auth: 'test-only' } }, () => {
      throw new ProblemError('stale_version', {
        detail: 'The node changed after this edit began.',
        current: { version: 2 },
      });
    });
    await booted.app.ready();
  });
  afterAll(async () => {
    await booted.close();
  });

  it.each(ERROR_CODES)(
    '%s has the closed wire shape and never exposes the thrown message or stack',
    async (code) => {
      const response = await booted.app.inject({
        method: 'GET',
        url: `/__test__/problem/${code}`,
        headers: { host: NO_DATABASE_HOST },
      });
      const body = ProblemDetails.parse(response.json());
      expect(response.statusCode).toBe(ERROR_CODE_STATUS[code]);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(body).toMatchObject({
        code,
        title: ERROR_CODE_TITLE[code],
        type: `urn:iridium:problem:${code}`,
        status: response.statusCode,
        requestId: response.headers['x-request-id'],
      });
      expect(response.body).not.toMatch(
        /SELECT |password_hash|private\.ts|Bearer |fixture-secret|stack/i,
      );
      expect(body.detail).toBeUndefined();
    },
  );

  it.each(Object.entries(PROBLEM_VARIANTS))(
    '%s retains its explicit transport status',
    async (variant, expected) => {
      const response = await booted.app.inject({
        method: 'GET',
        url: `/__test__/problem/variant/${variant}`,
        headers: { host: NO_DATABASE_HOST },
      });
      expect(response.statusCode).toBe(expected.status);
      expect(ProblemDetails.parse(response.json())).toMatchObject(expected);
    },
  );

  it('conceals unexpected exceptions while preserving intentional current-state metadata', async () => {
    const unknown = await booted.app.inject({
      method: 'GET',
      url: '/__test__/problem/unexpected',
      headers: { host: NO_DATABASE_HOST },
    });
    expect(ProblemDetails.parse(unknown.json())).toMatchObject({
      code: 'server_error',
      status: 500,
    });
    expect(unknown.body).not.toMatch(
      /SELECT |password_hash|private\.ts|Bearer |fixture-secret|stack/i,
    );
    const stale = await booted.app.inject({
      method: 'GET',
      url: '/__test__/problem/current',
      headers: { host: NO_DATABASE_HOST },
    });
    expect(ProblemDetails.parse(stale.json())).toMatchObject({
      code: 'stale_version',
      detail: 'The node changed after this edit began.',
      current: { version: 2 },
    });
  });
});
