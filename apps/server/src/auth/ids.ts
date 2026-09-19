/**
 * Branded ids at the database boundary (02-system-architecture.md, "Identifiers"; ARCH-13).
 *
 * A `BINARY(16)` column arrives as a `Buffer` and leaves as one; every principal, session and
 * token carries the canonical lowercase string with its brand. The brand is applied by the id
 * schema's `parse`, which is one regex and also the assertion that the bytes rendered canonically —
 * a cast would claim the same thing with nothing checking it.
 */
import { idFromBytes, idToBytes, SessionId, TokenId, UserId, VaultId } from '@iridium/contracts';

/** A `users.id` buffer as a branded id. */
export function userIdFromBytes(bytes: Uint8Array): UserId {
  return UserId.parse(idFromBytes(bytes));
}

/** A `sessions.id` buffer as a branded id. */
export function sessionIdFromBytes(bytes: Uint8Array): SessionId {
  return SessionId.parse(idFromBytes(bytes));
}

/** An `access_tokens.id` buffer as a branded id. */
export function tokenIdFromBytes(bytes: Uint8Array): TokenId {
  return TokenId.parse(idFromBytes(bytes));
}

/** A `vaults.id` buffer as a branded id. */
export function vaultIdFromBytes(bytes: Uint8Array): VaultId {
  return VaultId.parse(idFromBytes(bytes));
}

/** The 16 bytes of any branded id, for a `WHERE id = ?` parameter. */
export function idBytes(id: string): Buffer {
  return Buffer.from(idToBytes(id));
}
