/**
 * Seeding through the product's own paths (10-testing-and-quality.md, "Seeding, tickets, sessions";
 * fixture policy rule 2: *"A test that needs state the product cannot create is a test that has found
 * a missing product capability"*).
 *
 * Every row enters through a real product capability:
 *
 * | What | How | Why not otherwise |
 * |---|---|---|
 * | the first server admin | `iridium admin create-user --server-admin` | `POST /admin/users` needs a server admin, so the first one has no REST path; there is deliberately no environment bootstrap of an admin password (A28) |
 * | every other user | `POST /admin/users` then `POST /auth/set-password` | the create returns a one-time `irid_spl_…` link and never a password, so no plaintext credential passes through an administrator |
 * | a vault | `POST /vaults` | one transaction: the vault row, its root category and the audit event |
 * | a membership | `PUT /vaults/:vaultId/members/:userId` | the route the console uses, so the seed exercises `201`-on-create |
 * | a note | `POST /vaults/:vaultId/nodes` | the only Markdown entry point at M1, and the one `NoteService.initialize` runs behind |
 * | M2's 20k structural fixture | server-injected `createNode` / `NoteService.initialize` | preserves owner fencing, locks, projections and audit while avoiding transport quotas during setup |
 *
 * The consequence the plan wants is that the seed is itself a smoke test: a regression in user
 * creation, membership or note creation fails every suite that seeds, at the seed, with the route's
 * own problem document in the message.
 */

import { signInWeb, stepUp, type WebSignIn } from '../auth/sessions.ts';
import type { RestClient } from '../clients/rest-client.ts';
import type { CliResult } from '../server/cli.ts';
import { seedKernel, type KernelSeed } from './kernel.ts';
import {
  seedStructureDataset,
  type StructureSeed,
  type StructureSeedRequest,
  type StructureNodeWriter,
} from './structure.ts';

/** A user the seed created, with the credential every fixture signs in with. */
export interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly isServerAdmin: boolean;
}

/** A vault the seed created. */
export interface SeededVault {
  readonly id: string;
  readonly name: string;
  /** The root category every created node hangs from (03-data-model.md §5). */
  readonly rootNodeId: string;
  readonly version: number;
}

/** A note the seed created. Its id is the node's: there is no separate note id (03 §8). */
export interface SeededNote {
  readonly id: string;
  readonly vaultId: string;
  readonly name: string;
  readonly markdown: string;
}

/** A role a membership grants (`@iridium/contracts`' `Role`, spelled here to keep the seam narrow). */
export type SeedRole = 'manager' | 'editor' | 'viewer';

/**
 * The fixed, obviously fake credential every seeded account carries (fixture policy rule 9).
 *
 * The `not-a-secret` marker is the same one `EnvSchema` refuses under `NODE_ENV=production`, so a
 * value copied out of a fixture into a deployment fails at boot rather than in the field. It is long
 * enough for the default `PASSWORD_MIN_LENGTH` of 15 and is not a blocklist entry.
 */
export const SEED_PASSWORD = 'fixture-example-not-a-secret';

/** The domain every seeded account uses (10-testing-and-quality.md, `kernel()`). */
export const SEED_EMAIL_DOMAIN = 'iridium.test';

/**
 * The seeding surface.
 *
 * Every method takes an optional `admin`; when it is absent the api's own bootstrap administrator is
 * used, created on first use and reused afterwards — there is exactly one first server admin per
 * deployment, and creating a second one through the CLI would be creating a row the product would
 * not have.
 */
export interface SeedApi {
  /** `iridium admin create-user --server-admin`, the link, then a signed-in web session. */
  admin(options?: { displayName?: string }): Promise<SeededAdmin>;
  /** `POST /admin/users` + `POST /auth/set-password`. */
  user(options: {
    email: string;
    displayName?: string;
    isServerAdmin?: boolean;
    admin?: SeededAdmin;
  }): Promise<SeededUser>;
  /** `POST /vaults`, then one `PUT …/members/:userId` per grant. */
  vault(options: {
    name: string;
    members?: readonly (readonly [SeededUser, SeedRole])[];
    admin?: SeededAdmin;
  }): Promise<SeededVault>;
  /** `POST /vaults/:vaultId/nodes` with `kind: 'note'`. */
  note(options: {
    vault: SeededVault;
    name: string;
    markdown?: string;
    parentId?: string;
    admin?: SeededAdmin;
  }): Promise<SeededNote>;
  /** Sign a seeded user in over the web (cookie) path. */
  signIn(user: SeededUser): Promise<WebSignIn>;
  /** `<localPart><suffix>@iridium.test` — the one place a seeded address is spelled. */
  email(localPart: string): string;
  /** The M1 cast, vault `V` and note `N` (10-testing-and-quality.md, `kernel()`). */
  kernel(): Promise<KernelSeed>;
  /** The populated M2 20k-node fixture, through an injected real structural service. */
  structure(options?: StructureSeedRequest): Promise<StructureSeed>;
}

/** A server admin plus the signed-in client the seed makes its privileged calls with. */
export interface SeededAdmin extends SeededUser {
  /** A web client carrying the `__Host-iridium_session` cookie and a live step-up window. */
  readonly client: RestClient;
  readonly sessionId: string;
}

export interface SeedApiOptions {
  /** A fresh, unauthenticated REST client on the server's origin. */
  readonly client: () => RestClient;
  /** Runs `iridium <args…>` against the same schema as the server under test. */
  readonly cli: (args: readonly string[]) => Promise<CliResult>;
  /** Overrides `SEED_PASSWORD` for a suite that needs a different one. */
  readonly password?: string;
  /** Appended to every local part, for a suite that seeds two casts on one schema. */
  readonly suffix?: string;
  /** Server-owned in-process fixture adapter; no product imports or direct SQL enter testkit. */
  readonly structureWriter?: StructureNodeWriter;
}

function refused(where: string, status: number, body: unknown): Error {
  return new Error(
    `@iridium/testkit: ${where} answered ${String(status)}: ${JSON.stringify(body)}`,
  );
}

/** The `irid_spl_…` secret inside a `<PUBLIC_ORIGIN>/set-password#irid_spl_…` link. */
export function setPasswordTokenFrom(link: string): string {
  const hash = link.indexOf('#');
  const token = hash === -1 ? '' : link.slice(hash + 1);
  if (!token.startsWith('irid_spl_')) {
    throw new Error(
      `@iridium/testkit: "${link}" is not a set-password link; the fragment must be an irid_spl_ credential (09-api-reference.md §2.15.1).`,
    );
  }
  return token;
}

/** The first `irid_spl_…` token the CLI printed, wherever in its output it landed. */
function setPasswordTokenFromCli(result: CliResult): string {
  const match = /irid_spl_[A-Za-z0-9_-]+/.exec(`${result.stdout}\n${result.stderr}`);
  if (match === null) {
    throw new Error(
      `@iridium/testkit: \`iridium admin create-user\` printed no set-password link.\n${result.stdout}\n${result.stderr}`,
    );
  }
  return match[0];
}

interface CreatedUserBody {
  readonly user?: { readonly id?: unknown; readonly displayName?: unknown };
  readonly setPasswordLink?: unknown;
}

interface CreatedVaultBody {
  readonly id?: unknown;
  readonly rootNodeId?: unknown;
  readonly version?: unknown;
}

interface CreatedNodeBody {
  readonly id?: unknown;
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? { ...body } : {};
}

/** Build the seeding surface. `TestServer.seed` is one of these bound to the running server. */
export function createSeedApi(options: SeedApiOptions): SeedApi {
  const password = options.password ?? SEED_PASSWORD;
  const suffix = options.suffix ?? '';
  const emailFor = (local: string): string => `${local}${suffix}@${SEED_EMAIL_DOMAIN}`;
  /** The one bootstrap administrator, created on first use. */
  let bootstrap: Promise<SeededAdmin> | null = null;

  /** `POST /auth/set-password`: a public route, so it runs on its own anonymous client. */
  const consumeLink = async (token: string): Promise<void> => {
    const response = await options.client().post('/auth/set-password', {
      json: { token, password },
    });
    if (response.status !== 204) {
      throw refused('/auth/set-password', response.status, response.body);
    }
  };

  const signIn = async (user: SeededUser): Promise<WebSignIn> =>
    signInWeb(options.client(), { email: user.email, password: user.password });

  const createAdmin = async (displayName: string): Promise<SeededAdmin> => {
    const email = emailFor('admin');
    // The flag spelling is 12-milestones.md §5.2's and 04-auth-and-access-control.md §2's; the CLI
    // table of 11-operations-and-deployment.md spells the same two flags `--name` and `--admin`.
    const result = await options.cli([
      'admin',
      'create-user',
      '--email',
      email,
      '--display-name',
      displayName,
      '--server-admin',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `@iridium/testkit: \`iridium admin create-user\` exited ${String(result.code ?? result.signal)}.\n${result.stderr || result.stdout}`,
      );
    }
    await consumeLink(setPasswordTokenFromCli(result));

    const session = await signIn({
      id: '',
      email,
      displayName,
      password,
      isServerAdmin: true,
    });
    // Every `/admin/*` mutation declares `stepUp: true`. A fresh sign-in already sets
    // `lastAuthenticatedAt`, so this is belt and braces for a suite that seeds after advancing a
    // clock past the step-up window.
    await stepUp(session.client, password);
    return {
      id: session.userId,
      email,
      displayName,
      password,
      isServerAdmin: true,
      client: session.client,
      sessionId: session.session.id,
    };
  };

  const admin = (o: { displayName?: string } = {}): Promise<SeededAdmin> => {
    bootstrap ??= createAdmin(o.displayName ?? 'Seed Admin');
    return bootstrap;
  };

  const user = async (o: {
    email: string;
    displayName?: string;
    isServerAdmin?: boolean;
    admin?: SeededAdmin;
  }): Promise<SeededUser> => {
    const as = o.admin ?? (await admin());
    const displayName = o.displayName ?? o.email.split('@')[0] ?? o.email;
    const response = await as.client.post('/admin/users', {
      json: {
        email: o.email,
        displayName,
        isServerAdmin: o.isServerAdmin ?? false,
      },
    });
    if (response.status !== 201) {
      throw refused('POST /admin/users', response.status, response.body);
    }
    const body: CreatedUserBody = asObject(response.body);
    const id = body.user?.id;
    const link = body.setPasswordLink;
    if (typeof id !== 'string' || typeof link !== 'string') {
      throw new Error(
        `@iridium/testkit: POST /admin/users answered 201 without a user and a link: ${JSON.stringify(response.body)}`,
      );
    }
    await consumeLink(setPasswordTokenFrom(link));
    return {
      id,
      email: o.email,
      displayName,
      password,
      isServerAdmin: o.isServerAdmin ?? false,
    };
  };

  const vault = async (o: {
    name: string;
    members?: readonly (readonly [SeededUser, SeedRole])[];
    admin?: SeededAdmin;
  }): Promise<SeededVault> => {
    const as = o.admin ?? (await admin());
    const response = await as.client.post('/vaults', { json: { name: o.name } });
    if (response.status !== 201) {
      throw refused('POST /vaults', response.status, response.body);
    }
    const body: CreatedVaultBody = asObject(response.body);
    const { id, rootNodeId, version } = body;
    if (typeof id !== 'string' || typeof rootNodeId !== 'string' || typeof version !== 'number') {
      throw new Error(
        `@iridium/testkit: POST /vaults answered 201 without id, rootNodeId and version: ${JSON.stringify(response.body)}`,
      );
    }

    for (const [member, role] of o.members ?? []) {
      const path = `/vaults/${id}/members/${member.id}`;
      // Memberships are granted one at a time and in the order given: a grant is a versioned row and
      // `PUT` answers `201` only for the first one, which is the case worth exercising here.
      // eslint-disable-next-line no-await-in-loop -- grants are ordered and each is one route call
      const granted = await as.client.put(path, { json: { role } });
      if (granted.status !== 201 && granted.status !== 200) {
        throw refused(`PUT ${path}`, granted.status, granted.body);
      }
    }
    return { id, name: o.name, rootNodeId, version };
  };

  const note = async (o: {
    vault: SeededVault;
    name: string;
    markdown?: string;
    parentId?: string;
    admin?: SeededAdmin;
  }): Promise<SeededNote> => {
    const as = o.admin ?? (await admin());
    const markdown = o.markdown ?? '';
    const path = `/vaults/${o.vault.id}/nodes`;
    const response = await as.client.post(path, {
      json: {
        kind: 'note',
        parentId: o.parentId ?? o.vault.rootNodeId,
        name: o.name,
        markdown,
      },
    });
    if (response.status !== 201) {
      throw refused(`POST ${path}`, response.status, response.body);
    }
    const body: CreatedNodeBody = asObject(response.body);
    if (typeof body.id !== 'string') {
      throw new Error(
        `@iridium/testkit: POST ${path} answered 201 without a node id: ${JSON.stringify(response.body)}`,
      );
    }
    return { id: body.id, vaultId: o.vault.id, name: o.name, markdown };
  };

  const api: SeedApi = {
    admin,
    user,
    vault,
    note,
    signIn,
    email: emailFor,
    kernel: () => seedKernel(api),
    structure: (request) => seedStructureDataset(api, options.structureWriter, request),
  };
  return api;
}
