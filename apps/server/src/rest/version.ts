/** The API compatibility counter, live release-controlled client floor, and mounted features (A54). */
import { RESPONSE_HEADERS, type Feature } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

import type { DatabaseHandle } from '../boot/db.ts';
import type { IridiumConfig } from '../config/env.ts';
import { isOpsPath } from '../ops/paths.ts';
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_MAX_LENGTH } from '../security/client-header.ts';
import { ProblemError } from '../security/problem.ts';

/**
 * The integer `GET /meta.apiVersion` and the `X-Iridium-Api-Version` response header carry.
 *
 * It increments only for a breaking change as §7.2 defines one: removing or renaming a field, an
 * endpoint, an `operationId`, a `ProblemDetails` code, a stateless message type or an IPC channel;
 * changing semantics; tightening validation. Adding any of those is additive and leaves it alone.
 */
export const API_VERSION = 1;

/** The initial release floor, seeded by migration 0055; database-free schema export uses it too. */
const INITIAL_CLIENT_VERSION = '0.0.0';

interface SemanticVersion {
  readonly core: readonly string[];
  readonly prerelease: readonly string[];
}

// SemVer 2.0.0: numeric identifiers have no leading zero; build metadata never affects precedence.
const SEMANTIC_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^[0-9]+$/;

function semanticVersion(value: string): SemanticVersion | null {
  const match = value.length <= CLIENT_VERSION_MAX_LENGTH ? SEMANTIC_VERSION.exec(value) : null;
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  const prerelease = match?.[4]?.split('.') ?? [];
  if (
    prerelease.some(
      (part) => NUMERIC_IDENTIFIER.test(part) && part.length > 1 && part.startsWith('0'),
    )
  )
    return null;
  return { core: [major, minor, patch], prerelease };
}

function compareNumeric(left: string, right: string): number {
  return left.length === right.length
    ? left < right
      ? -1
      : left === right
        ? 0
        : 1
    : left.length - right.length;
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (const [index, part] of left.core.entries()) {
    const other = right.core[index];
    if (other === undefined)
      throw new Error('A parsed semantic version must have three core identifiers.');
    const order = compareNumeric(part, other);
    if (order !== 0) return order;
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  for (const [index, part] of left.prerelease.entries()) {
    const other = right.prerelease[index];
    if (other === undefined) return 1;
    if (part === other) continue;
    const numeric = NUMERIC_IDENTIFIER.test(part);
    const otherNumeric = NUMERIC_IDENTIFIER.test(other);
    if (numeric && otherNumeric) return compareNumeric(part, other);
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    return part < other ? -1 : 1;
  }
  return left.prerelease.length - right.prerelease.length;
}

/** Reads the committed floor on every request, so an operator change cannot sit in a process cache. */
export async function minimumClientVersion(
  database: Pick<DatabaseHandle, 'mode' | 'dbApp'>,
): Promise<string> {
  if (database.mode === 'none') return INITIAL_CLIENT_VERSION;
  const db = database.dbApp;
  if (db === null) throw new ProblemError('not_ready');
  const row = await db
    .selectFrom('schema_meta')
    .select('value')
    .where('key', '=', 'min_client_version')
    .executeTakeFirst();
  if (row === undefined || semanticVersion(row.value) === null) {
    throw new ProblemError('unavailable', {
      detail: 'The server client compatibility policy is unavailable.',
    });
  }
  return row.value;
}

/** A presented version is explicit input; absent versions are handled before this policy. @internal */
export function clientVersionProblem(client: string, minimum: string): ProblemError | null {
  const candidate = semanticVersion(client);
  if (candidate === null)
    return new ProblemError('validation_failed', {
      detail: 'X-Iridium-Client-Version must be a valid semantic version.',
    });
  const floor = semanticVersion(minimum);
  if (floor === null)
    throw new Error('minimumClientVersion must validate the durable floor before comparison.');
  return compareVersions(candidate, floor) < 0
    ? new ProblemError('client_outdated', { detail: minimum })
    : null;
}

/** Authentication and CSRF precede compatibility; authorization and route work follow it. */
export function applyClientVersionGate(app: FastifyInstance): void {
  // onSend also covers authentication/readiness refusals that precede the compatibility hook.
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0];
    if (path === '/api/v1' || path?.startsWith('/api/v1/') === true) {
      reply.header(RESPONSE_HEADERS.apiVersion, String(API_VERSION));
    }
    return payload;
  });
  app.addHook('onRequest', async (request) => {
    if (
      isOpsPath(request.url) ||
      (request.method === 'GET' && request.routeOptions.url === '/api/v1/meta')
    )
      return;
    const client = request.headers[CLIENT_VERSION_HEADER];
    if (client === undefined) return;
    // The parser caps the public/logged header. A truncated or multiple header is not a version.
    if (
      typeof client !== 'string' ||
      client !== request.iridiumClientVersion ||
      semanticVersion(client) === null
    ) {
      throw new ProblemError('validation_failed', {
        detail: 'X-Iridium-Client-Version must be a valid semantic version.',
      });
    }
    const problem = clientVersionProblem(client, await minimumClientVersion(app.database));
    if (problem !== null) throw problem;
  });
}

/**
 * The optional capabilities this build mounts, before the configuration switches are applied.
 *
 * Empty at M1 and populated by the milestone that mounts each surface: `mcp` and `oauth` at M3,
 * `attachments`, `import` and `export` at M6, `search` at M2, `desktop-updates` at M5.
 * `obsidian-compat-rendering` and `smtp` are reserved names that no milestone turns on (§2.2).
 */
export const SERVED_FEATURES: readonly Feature[] = Object.freeze([]);

/**
 * The `features` array for one configuration: what the build serves, minus anything the deployment
 * switched off. `mcp` needs `MCP_ENABLED`; `oauth` needs `MCP_OAUTH_ENABLED`, which is the switch
 * that mounts `/mcp/connect` and the whole `/oauth/*` surface.
 */
export function featuresFor(config: IridiumConfig): readonly Feature[] {
  return SERVED_FEATURES.filter((feature) => {
    if (feature === 'mcp') return config.mcp.enabled;
    if (feature === 'oauth') return config.mcp.oauthEnabled;
    return true;
  });
}
