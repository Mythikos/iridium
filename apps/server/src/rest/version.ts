/**
 * The client-compatibility gate, the effective client floor, and the mounted features (A54). The
 * API counter `API_VERSION` and the release floor `RELEASE_MIN_CLIENT_VERSION` are wire contract and
 * live in `@iridium/contracts`; the floor this module serves and enforces is the SemVer maximum of
 * that release floor and the operator floor `schema_meta.min_client_version`
 * (09-api-reference.md section 7.1; A54 as amended 2026-09-25).
 */
import {
  API_VERSION,
  RELEASE_MIN_CLIENT_VERSION,
  RESPONSE_HEADERS,
  type Feature,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

import type { DatabaseHandle } from '../boot/db.ts';
import type { IridiumConfig } from '../config/env.ts';
import { isOpsPath } from '../ops/paths.ts';
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_MAX_LENGTH } from '../security/client-header.ts';
import { ProblemError } from '../security/problem.ts';

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

/** A release floor that is not SemVer 2.0.0; a build carrying one refuses to load this module. */
class InvalidReleaseFloorError extends Error {
  constructor(value: string) {
    super(
      `RELEASE_MIN_CLIENT_VERSION ${JSON.stringify(value)} in @iridium/contracts rest/meta.ts is ` +
        'not a SemVer 2.0.0 version; set it to one (09-api-reference.md section 7.1).',
    );
    this.name = 'InvalidReleaseFloorError';
  }
}

function releaseFloor(): SemanticVersion {
  const parsed = semanticVersion(RELEASE_MIN_CLIENT_VERSION);
  if (parsed === null) throw new InvalidReleaseFloorError(RELEASE_MIN_CLIENT_VERSION);
  return parsed;
}

/** The floor this release carries, parsed once: a build constant, never re-read per request. */
const RELEASE_FLOOR = releaseFloor();

/**
 * Reads the operator floor on every request, so an operator change cannot sit in a process cache,
 * and returns the SemVer maximum of it and the release floor: the operator can raise the release's
 * floor and never lower it (09-api-reference.md section 7.1; A54 as amended).
 */
export async function minimumClientVersion(
  database: Pick<DatabaseHandle, 'mode' | 'dbApp'>,
): Promise<string> {
  // Database-free schema export has no operator floor and uses the release floor alone (09 §7.1).
  if (database.mode === 'none') return RELEASE_MIN_CLIENT_VERSION;
  const db = database.dbApp;
  if (db === null) throw new ProblemError('not_ready');
  const row = await db
    .selectFrom('schema_meta')
    .select('value')
    .where('key', '=', 'min_client_version')
    .executeTakeFirst();
  const operatorFloor = row === undefined ? null : semanticVersion(row.value);
  if (row === undefined || operatorFloor === null) {
    throw new ProblemError('unavailable', {
      detail: 'The server client compatibility policy is unavailable.',
    });
  }
  return compareVersions(operatorFloor, RELEASE_FLOOR) < 0 ? RELEASE_MIN_CLIENT_VERSION : row.value;
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
