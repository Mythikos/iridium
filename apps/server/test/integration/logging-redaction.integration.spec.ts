import { TEST_SECRETS } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `logging-redaction.integration` (12-milestones.md §5.4; 11-operations-and-deployment.md, "What is never
 * logged, and how that is enforced"; skeleton A49).
 *
 * The contract is absolute and it is worth restating because "absolute" is the part an implementation
 * erodes: **every** line this process writes to stdout and stderr is one pino JSON object, and none of them
 * carries a credential, a key, a cookie, a note body or Yjs update bytes. A single `console.warn` from a
 * dependency, or one `log.info({ token })` in a hurry, breaks it.
 *
 * So the suite captures the logger the process is built with — `buildApp({ logger })` is what makes that
 * possible for the *boot* lines too, which is where `config.loaded` prints every configured secret — drives
 * the surfaces that exist at M1, and then scans every captured line.
 *
 * **What is pending.** The row's full exercise ("login, token use, a collab session, an import and an error
 * path") needs the `auth`, `collab-server` and `transfer` streams. What is asserted here is everything that
 * does not: the JSON-per-line contract over boot and request lines, the `config.loaded` rendering of every
 * keyring, the credential-shaped scanner over the whole stream, an error path, and — directly, rather than
 * by hoping a code path exists that would trip it — that pino's configured `redact` list censors the fields
 * a note body, a Yjs update, a password, a token and a secret would arrive in. The later streams' surfaces
 * are then scanned by the same assertions with no edit here.
 */
import { REDACT_PATHS, createLogger, newInstanceId } from '../../src/ops/logging.ts';
import { startPlatformApp, TEST_PUBLIC_ORIGIN, type PlatformApp } from './platform-app.ts';

/** The published scanner regex of 11's "never logged" table. */
const CREDENTIAL_PATTERN = /irid_(pat|ses|tkt|spl|oat|ort|oac)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}/;

/** A marker that stands in for a note body, so the redaction paths are exercised rather than assumed. */
const BODY_MARKER = 'IRIDIUM_SECRET_BODY_MARKER';

/** A base64 prefix of a plausible Yjs update, which `*.update` must censor. */
const UPDATE_MARKER = 'AQEBAQEBAQEBAQEBAQEB';

const HOST = new URL(TEST_PUBLIC_ORIGIN).host;

const captured: string[] = [];
let booted: PlatformApp;

/** Every captured line, parsed. A line that is not JSON fails the parse and therefore the suite. */
function parsedLines(): readonly Readonly<Record<string, unknown>>[] {
  return captured.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(
        `a line on the log stream is not one JSON object, which A49 requires of every line: ${line}`,
        { cause: error },
      );
    }
  });
}

function stream(): string {
  return captured.join('\n');
}

beforeAll(async () => {
  const logger = createLogger({
    level: 'trace',
    format: 'json',
    instanceId: newInstanceId('01a09c3c-0000-7000-8000-000000000000'),
    destination: {
      write(line: string): void {
        captured.push(line.trimEnd());
      },
    },
  });
  booted = await startPlatformApp({ logger });

  // Exercise the surfaces that exist: a served request, a refused request that logs an `err`, and the
  // credential-bearing headers the `redact` paths name.
  await booted.app.inject({ method: 'GET', url: '/healthz', headers: { host: HOST } });
  await booted.app.inject({
    method: 'POST',
    url: '/__test__/faults',
    headers: {
      host: HOST,
      'x-iridium-client': 'web',
      origin: TEST_PUBLIC_ORIGIN,
      authorization: 'Bearer irid_pat_0123456789abcdef_0123456789012345678901234567890123456789012',
      cookie:
        '__Host-iridium_session=irid_ses_0123456789abcdef_0123456789012345678901234567890123456789012',
    },
    payload: { point: 'store.explode' },
  });
  // A clean request that fails validation, so the error path has a line of its own to assert.
  await booted.app.inject({
    method: 'POST',
    url: '/__test__/faults',
    headers: { host: HOST, 'x-iridium-client': 'web', origin: TEST_PUBLIC_ORIGIN },
    payload: { point: 'store.explode' },
  });

  // The redaction paths, driven directly: these are the shapes a note body, an update, a password, a token
  // and a secret arrive in, and the only way to assert the list is configured is to log one of each — at
  // the top level, which is the shape a mistake takes, and one level down, which is what `*.x` covers.
  const sensitive = {
    markdown: BODY_MARKER,
    update: UPDATE_MARKER,
    password: 'hunter2',
    token: 'irid_pat_0123456789abcdef_0123456789012345678901234567890123456789012',
    secret: TEST_SECRETS['AUDIT_HMAC_KEY'],
  };
  booted.app.log.info({ ...sensitive }, 'the redaction paths, at the top level');
  booted.app.log.info({ note: { ...sensitive } }, 'the redaction paths, one level down');
});

afterAll(async () => {
  await booted.close();
});

describe('logging-redaction.integration [area:ops]', () => {
  describe('the stream itself', () => {
    it('captured the boot lines, so what follows is not scanning an empty stream', () => {
      expect(captured.length).toBeGreaterThan(2);
      const events = parsedLines().map((line) => line['event']);
      expect(events).toContain('config.loaded');
      expect(events).toContain('http.request');
      expect(events).toContain('readyz.recovered');
    });

    it('writes one JSON object per line, boot lines included', () => {
      for (const line of parsedLines()) {
        // pino's base: every line carries the service, the version and the instance id.
        expect(line['service']).toBe('iridium-server');
        expect(typeof line['level']).toBe('string');
        expect(typeof line['time']).toBe('string');
        expect(typeof line['instanceId']).toBe('string');
      }
    });

    it('logs the route template on a request line, never the concrete path with its ids', () => {
      const request = parsedLines().find((line) => line['event'] === 'http.request');
      expect(request?.['route']).toBe('/healthz');
      expect(request?.['status']).toBe(200);
    });
  });

  describe('credentials and keys', () => {
    it('contains no irid_ credential anywhere, in any of the seven kinds', () => {
      expect(stream()).not.toMatch(CREDENTIAL_PATTERN);
    });

    it('contains no Bearer prefix and no cookie header value', () => {
      expect(stream()).not.toContain('Bearer ');
      expect(stream()).not.toContain('__Host-iridium_session=');
    });

    it('contains no key material, in either its configured form or its base64 form', () => {
      const leaked = Object.entries(TEST_SECRETS).filter(
        ([, material]) =>
          stream().includes(material) ||
          stream().includes(Buffer.from(material, 'utf8').toString('base64')),
      );
      expect(leaked.map(([name]) => name)).toEqual([]);
    });

    it('contains no database role password, though the summary names the role and the schema', () => {
      // `redactConfig` strips the password component and keeps the rest: an operator needs to see which
      // role and which schema this process is using, and never the credential.
      const loaded = parsedLines().find((line) => line['event'] === 'config.loaded');
      const rendered = JSON.stringify(loaded);
      expect(rendered).not.toContain('test-app-not-a-secret');
      expect(rendered).toContain('iridium_app');
    });
  });

  describe('the config.loaded rendering (ARCH-28)', () => {
    it('prints a fingerprint per keyring and never a bare ***', () => {
      const loaded = parsedLines().find((line) => line['event'] === 'config.loaded');
      const rendered = JSON.stringify(loaded);
      const keyrings = ['AUTH_PASSWORD_PEPPER', 'AUDIT_HMAC_KEY', 'MCP_CURSOR_KEY'];
      expect(
        keyrings.filter((name) => !rendered.includes(`"${name}":"<set: versions v1; sha256:`)),
      ).toEqual([]);
      // A bare `***` is not an accepted rendering: the fingerprint is the operator control that answers
      // "do these two hosts carry the same key?" after a restore or a rotation.
      expect(rendered).not.toContain('***');
    });
  });

  describe('content and update bytes', () => {
    it('censors every field the A49 redact list names, at the top level and one level down', () => {
      const fields = ['markdown', 'update', 'password', 'token', 'secret'];

      const censored = fields.map((field) => [field, '[redacted]']);

      const top = parsedLines().find(
        (entry) => entry['msg'] === 'the redaction paths, at the top level',
      );
      expect(top).toBeDefined();
      expect(fields.map((field) => [field, top?.[field]])).toEqual(censored);

      const nested = parsedLines().find(
        (entry) => entry['msg'] === 'the redaction paths, one level down',
      );
      const note = nested?.['note'];
      const nestedFields: Readonly<Record<string, unknown>> =
        typeof note === 'object' && note !== null ? { ...note } : {};
      expect(fields.map((field) => [field, nestedFields[field]])).toEqual(censored);

      expect(stream()).not.toContain(BODY_MARKER);
      expect(stream()).not.toContain(UPDATE_MARKER);
    });

    it('configures every path 11 lists, plus the bare twin of each, so the list cannot quietly shrink', () => {
      // pino's `*` matches one level, so each `*.x` needs a bare `x` beside it or the likeliest shape of a
      // mistake — `log.info({ markdown }, …)` — is not covered at all.
      for (const field of ['password', 'token', 'secret', 'markdown', 'update']) {
        expect(REDACT_PATHS).toContain(field);
        expect(REDACT_PATHS).toContain(`*.${field}`);
      }
      expect(REDACT_PATHS).toContain('req.headers.authorization');
      expect(REDACT_PATHS).toContain('req.headers.cookie');
      expect(REDACT_PATHS).toContain('res.headers["set-cookie"]');
    });
  });

  describe('the error path', () => {
    it('logs a failure with its code and route, and the body carries only the request id', () => {
      const failures = parsedLines().filter((line) => line['msg'] === 'request failed');
      const codes = failures.map((line) => line['code']);
      // Two failures were driven: a bearer that does not verify, and a body the registry refuses.
      expect(codes).toContain('unauthenticated');
      expect(codes).toContain('validation_failed');
      const failure = failures.find((line) => line['code'] === 'validation_failed');
      expect(failure?.['route']).toBe('/__test__/faults');
      // The stack is on the log line; it must still carry no credential, which the scanner above covers.
      expect(JSON.stringify(failure)).not.toMatch(CREDENTIAL_PATTERN);
    });
  });
});
