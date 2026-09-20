/**
 * `/admin/users` (09-api-reference.md section 2.15.1), the five routes M1 serves: the listing, the
 * create that returns a one-time set-password link, disable/enable, and password reset.
 *
 * The row is created **without credentials** and the administrator delivers the link out of band
 * (A28), so no plaintext password ever passes through an administrator — which is why the create
 * response carries a link and an expiry rather than a password, and why `hasCredentials` on the user
 * row is `false` until the link is consumed.
 *
 * `PATCH`, `revoke-sessions` and `revoke-tokens` are outside the M1 route set; they
 * arrive with the admin console. A DTO for a route no milestone registers would fail
 * `openapi.coverage.contract` rather than sit harmlessly unused.
 */

import { z } from 'zod';

import { Role } from '../authz.ts';
import { VaultId } from '../ids.ts';
import { Timestamp } from '../time.ts';
import { AdminUserSummary, DisplayName, Email, QueryBoolean, User, UserStatus } from './common.ts';

/** `GET /admin/users` — the filters and the page bounds. */
export interface ListAdminUsersQuery {
  /** A prefix match on `email_key` or `display_name`. */
  readonly q?: string | undefined;
  readonly status?: readonly UserStatus[] | undefined;
  readonly isServerAdmin?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** `GET /admin/users` — the query. */
export const ListAdminUsersQuery: z.ZodType<ListAdminUsersQuery> = z
  .strictObject({
    q: z.string().max(200).optional(),
    // A single form-style query value arrives as a string; repeated values arrive as an array.
    status: z
      .codec(z.union([UserStatus, z.array(UserStatus)]), z.array(UserStatus), {
        decode: (value) => (typeof value === 'string' ? [value] : value),
        encode: (value) => value,
      })
      .optional(),
    isServerAdmin: QueryBoolean.optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .meta({ id: 'ListAdminUsersQuery' });

/** `GET /admin/users` — one cursor page. */
export interface AdminUserPage {
  readonly items: readonly AdminUserSummary[];
  /** Absent at the end of the list — never `null`, never `''` (section 1.6). */
  readonly nextCursor?: string | undefined;
}

/** `GET /admin/users` — one cursor page. */
export const AdminUserPage: z.ZodType<AdminUserPage> = z
  .strictObject({
    items: z.array(AdminUserSummary),
    nextCursor: z.string().optional(),
  })
  .meta({ id: 'AdminUserPage' });

/** One membership granted in the transaction that creates the user. */
export interface AdminUserMembership {
  readonly vaultId: string;
  readonly role: Role;
}

/** One membership granted with the user. */
export const AdminUserMembership: z.ZodType<AdminUserMembership> = z
  .strictObject({ vaultId: VaultId, role: Role })
  .meta({ id: 'AdminUserMembership' });

/** `POST /admin/users` — create a user without credentials. */
export interface CreateAdminUserBody {
  readonly email: string;
  readonly displayName: string;
  readonly isServerAdmin: boolean;
  readonly memberships?: readonly AdminUserMembership[] | undefined;
}

/** `POST /admin/users`. */
export const CreateAdminUserBody: z.ZodType<CreateAdminUserBody> = z
  .strictObject({
    email: Email,
    displayName: DisplayName,
    isServerAdmin: z.boolean().default(false),
    memberships: z.array(AdminUserMembership).max(500).optional(),
  })
  .meta({ id: 'CreateAdminUserBody' });

/** `POST /admin/users` — the user and the one-time link, which is shown exactly once. */
export interface AdminUserCreated {
  readonly user: User;
  /** `<PUBLIC_ORIGIN>/set-password#irid_spl_…`; never stored in plaintext. */
  readonly setPasswordLink: string;
  /** Issued at plus `password_policy.setupLinkHours` (24 h). */
  readonly expiresAt: string;
}

/** `POST /admin/users` — the user and the one-time link. */
export const AdminUserCreated: z.ZodType<AdminUserCreated> = z
  .strictObject({ user: User, setPasswordLink: z.url(), expiresAt: Timestamp })
  .meta({ id: 'AdminUserCreated' });

/** `POST /admin/users/:userId/disable` — the reason lands in the audit row's metadata. */
export interface DisableUserBody {
  readonly reason?: string | undefined;
}

/** `POST /admin/users/:userId/disable`. */
export const DisableUserBody: z.ZodType<DisableUserBody> = z
  .strictObject({ reason: z.string().max(200).optional() })
  .meta({ id: 'DisableUserBody' });

/** A replacement password link; reset revokes sessions while preserving PATs. */
export interface AdminUserPasswordReset {
  readonly setPasswordLink: string;
  readonly expiresAt: string;
}

/** `POST /admin/users/:userId/reset-password`, shown once to the administrator. */
export const AdminUserPasswordReset: z.ZodType<AdminUserPasswordReset> = z
  .strictObject({ setPasswordLink: z.url(), expiresAt: Timestamp })
  .meta({ id: 'AdminUserPasswordReset' });
