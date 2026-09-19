/**
 * `/me` (09-api-reference.md section 2.3): the caller's own sessions, display name and password.
 *
 * Every route here is `self`, which means the id in the path must belong to the caller and a foreign
 * one is `404 not_found` rather than `403` — knowing an identifier grants nothing, and telling a
 * caller that someone else's session exists would be a leak.
 */

import { z } from 'zod';

import { DisplayName, Password, Session } from './common.ts';

/** `GET /me/sessions` — the caller's live sessions, current first, capped at 1 000 rows. */
export interface SessionList {
  readonly items: readonly Session[];
}

/** `GET /me/sessions`. */
export const SessionList: z.ZodType<SessionList> = z
  .strictObject({ items: z.array(Session).max(1000) })
  .meta({ id: 'SessionList' });

/** `PATCH /me` — the one field a user may change about themselves. */
export interface UpdateMeBody {
  readonly displayName: string;
}

/** `PATCH /me`. */
export const UpdateMeBody: z.ZodType<UpdateMeBody> = z
  .strictObject({ displayName: DisplayName })
  .meta({ id: 'UpdateMeBody' });

/**
 * `POST /me/password` — a change, never a reset: the current password is required in addition to the
 * step-up window, because step-up proves a recent authentication and this proves the present one.
 */
export interface ChangePasswordBody {
  readonly currentPassword: string;
  readonly newPassword: string;
}

/** `POST /me/password`. */
export const ChangePasswordBody: z.ZodType<ChangePasswordBody> = z
  .strictObject({ currentPassword: z.string().min(1).max(128), newPassword: Password })
  .meta({ id: 'ChangePasswordBody' });
