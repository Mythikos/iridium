/**
 * `/auth` (09-api-reference.md section 2.1): the six routes that turn a credential into a session and
 * a session into collaboration tickets.
 *
 * Two rules from section 2.1 are visible in the schemas. `POST /auth/sessions` answers a different
 * body per `client`, because a web login's credential goes into a `__Host-` cookie the response never
 * repeats while a desktop login's goes into the response for the main process to store — so the
 * response is a union of the two, not one shape with optional members. And every credential a body
 * carries is validated with `credentialSchema(kind)`, so the `irid_` format lives in `tokens.ts`
 * alone and a body cannot accept a ticket where a set-password link belongs.
 */

import { z } from 'zod';

import { LIMITS } from '../limits.ts';
import { Timestamp } from '../time.ts';
import { credentialSchema } from '../tokens.ts';
import { ClientKind, Email, Password, Session, User } from './common.ts';

/** `POST /auth/sessions` — the login body. The header and this `client` must agree (section 2.1). */
export interface CreateSessionBody {
  readonly email: string;
  readonly password: string;
  readonly client: ClientKind;
  /** Desktop only: what the session row shows in the user's own session list. */
  readonly deviceName?: string | undefined;
}

/** `POST /auth/sessions` — the login body. */
export const CreateSessionBody: z.ZodType<CreateSessionBody> = z
  .strictObject({
    email: Email,
    password: z.string().min(1).max(128),
    client: ClientKind,
    deviceName: z.string().max(120).optional(),
  })
  .meta({ id: 'CreateSessionBody' });

/** `201` for `client: 'web'`: the credential is in the cookie and never in the body. */
export interface WebSessionCreated {
  readonly user: User;
  readonly session: Session;
}

/** `201` for `client: 'web'`. */
export const WebSessionCreated: z.ZodType<WebSessionCreated> = z
  .strictObject({ user: User, session: Session })
  .meta({ id: 'WebSessionCreated' });

/** `201` for `client: 'desktop'`: the bearer the Electron main process stores (A26). */
export interface DesktopSessionCreated {
  /** `irid_ses_…`. Held by the main process only; the renderer never sees it. */
  readonly token: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly user: User;
  readonly session: Session;
}

/** `201` for `client: 'desktop'`. */
export const DesktopSessionCreated: z.ZodType<DesktopSessionCreated> = z
  .strictObject({
    token: credentialSchema('ses'),
    expiresAt: Timestamp,
    idleExpiresAt: Timestamp,
    user: User,
    session: Session,
  })
  .meta({ id: 'DesktopSessionCreated' });

/** `POST /auth/sessions` — `201`, one shape per `client`. */
export const SessionCreated: z.ZodType<WebSessionCreated | DesktopSessionCreated> = z
  .union([WebSessionCreated, DesktopSessionCreated])
  .meta({ id: 'SessionCreated' });

/** `POST /auth/reauthenticate` — the step-up body. */
export interface ReauthenticateBody {
  readonly password: string;
}

/** `POST /auth/reauthenticate` — the step-up body. */
export const ReauthenticateBody: z.ZodType<ReauthenticateBody> = z
  .strictObject({ password: z.string().min(1).max(128) })
  .meta({ id: 'ReauthenticateBody' });

/** `POST /auth/reauthenticate` — the new step-up window. */
export interface Reauthenticated {
  readonly lastAuthenticatedAt: string;
  /** `lastAuthenticatedAt` plus `session_policy.stepUpMinutes`. */
  readonly stepUpExpiresAt: string;
}

/** `POST /auth/reauthenticate` — the new step-up window. */
export const Reauthenticated: z.ZodType<Reauthenticated> = z
  .strictObject({ lastAuthenticatedAt: Timestamp, stepUpExpiresAt: Timestamp })
  .meta({ id: 'Reauthenticated' });

/** `POST /auth/set-password` — consuming a one-time `irid_spl_…` link. */
export interface SetPasswordBody {
  readonly token: string;
  readonly password: string;
}

/** `POST /auth/set-password` — consuming a one-time link. */
export const SetPasswordBody: z.ZodType<SetPasswordBody> = z
  .strictObject({
    token: credentialSchema('spl').meta({ format: 'iridium-credential-spl' }),
    password: Password,
  })
  .meta({ id: 'SetPasswordBody' });

/** `POST /auth/collab-tickets` — how many single-use tickets to mint. */
export interface CreateCollabTicketsBody {
  readonly count: number;
}

/** `POST /auth/collab-tickets` — how many tickets to mint. */
export const CreateCollabTicketsBody: z.ZodType<CreateCollabTicketsBody> = z
  .strictObject({ count: z.int().min(1).max(LIMITS.TICKET_BATCH_MAX) })
  .meta({ id: 'CreateCollabTicketsBody' });

/** `POST /auth/collab-tickets` — the batch. Each ticket is single use and lives `TICKET_TTL_S`. */
export interface CollabTicketsCreated {
  readonly tickets: readonly string[];
  readonly expiresIn: typeof LIMITS.TICKET_TTL_S;
}

/** `POST /auth/collab-tickets` — the batch. */
export const CollabTicketsCreated: z.ZodType<CollabTicketsCreated> = z
  .strictObject({
    tickets: z.array(credentialSchema('tkt')).min(1).max(LIMITS.TICKET_BATCH_MAX),
    expiresIn: z.literal(LIMITS.TICKET_TTL_S),
  })
  .meta({ id: 'CollabTicketsCreated' });
