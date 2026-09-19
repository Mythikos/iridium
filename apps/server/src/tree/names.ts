/**
 * The server's enforcement of the name rules (03-data-model.md §6.5; 09-api-reference.md §2.7).
 *
 * The *rules* live in `@iridium/contracts/paths.ts`, shared by the UI, the REST schemas and the
 * import scanner, so this module never restates one. What it owns is the three things that only the
 * server can do:
 *
 *  - **Normalisation before storage.** A name is stored NFC-normalised, and a note's name is stored
 *    without its `.md` suffix, because the suffix is a rendering of the node rather than part of it
 *    (`noteFileName()` puts it back on export). Both happen once, here, before any SQL runs —
 *    otherwise two spellings of the same name would be two rows that `uq_sibling` cannot see as one.
 *  - **Re-checking after normalisation.** The request schema checked what the client sent; stripping
 *    a suffix can leave something the rules refuse (`'.md'` alone becomes the empty name), so the
 *    result is checked again rather than assumed.
 *  - **The depth ceiling.** `TREE_MAX_DEPTH` is a property of the tree, not of one name, so it is
 *    enforced where the parent's depth is known.
 *
 * The three numbers are read from `@iridium/contracts/limits.ts` and never written here: this module
 * is one of the two enforcement sites `limits.policy.unit` pairs with `TREE_MAX_DEPTH`,
 * `NODE_NAME_MAX_BYTES` and `VAULT_NAME_MAX_CHARS`, and `limits.single-source.guard` fails on the
 * literals.
 */
import {
  checkNodeName,
  LIMITS,
  nodeNameFromFileName,
  type NameRejection,
  type NodeKind,
} from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';

/** What a refused name answers: the policy code `errors[0].code` carries (09 §1.4). */
export const INVALID_NAME_CODE = 'invalid_name';

/** The rejection the caller sees, as one `422 validation_failed`. */
export function invalidName(reason: NameRejection, where: string): ProblemError {
  return new ProblemError('validation_failed', {
    detail: `The name breaks a node-name rule (${reason}).`,
    errors: [{ path: where, message: `name: ${reason}`, code: INVALID_NAME_CODE }],
  });
}

/**
 * The name a node is stored under: NFC, and without the `.md` suffix for a note.
 *
 * @throws ProblemError `422 validation_failed` with `errors[0].code = 'invalid_name'` when the
 * normalised name breaks a rule of §6.5, including the one the client's own spelling did not.
 */
export function storedNodeName(raw: string, kind: NodeKind, where: string = 'body.name'): string {
  const normalized = raw.normalize('NFC');
  const stored = kind === 'note' ? nodeNameFromFileName(normalized) : normalized;
  // `checkNodeName` applies the `NODE_NAME_MAX_BYTES` cut itself, so there is no second byte check
  // here: two copies of one bound is how the two come to disagree.
  const check = checkNodeName(stored);
  if (!check.ok) throw invalidName(check.reason, where);
  return stored;
}

/**
 * The name a vault is stored under. A vault name is not a path segment, so it is bounded in
 * characters rather than in UTF-8 bytes (`vaults.name VARCHAR(120)`), and the character rules are
 * the node-name rules because an export writes the vault name as a folder.
 *
 * @throws ProblemError `422 validation_failed` with `errors[0].code = 'invalid_name'`.
 */
export function storedVaultName(raw: string, where: string = 'body.name'): string {
  const stored = raw.normalize('NFC');
  const check = checkNodeName(stored);
  if (!check.ok) throw invalidName(check.reason, where);
  // UTF-16 units, the unit `VaultName`'s own `.max()` counts in: two spellings of "120 characters"
  // would refuse different names on either side of the schema.
  if (stored.length > LIMITS.VAULT_NAME_MAX_CHARS) throw invalidName('too_long', where);
  return stored;
}

/** Thrown when a write would put a node deeper than the tree allows (§6.4 step 3). */
export function tooDeep(depth: number): ProblemError {
  return new ProblemError('invalid_move', {
    detail:
      `This would place the node ${String(depth)} levels below the vault root, and the tree is ` +
      `limited to ${String(LIMITS.TREE_MAX_DEPTH)}.`,
    errors: [{ path: 'body.parentId', message: 'depth', code: 'depth' }],
  });
}

/**
 * Refuses a parent whose depth leaves no room for a child.
 *
 * `parentDepth` is the number of levels the parent itself sits below the root (`0` for the root
 * row), so a child sits at `parentDepth + 1` and the ceiling is `TREE_MAX_DEPTH`.
 *
 * @throws ProblemError `409 invalid_move` with `reason: 'depth'`.
 */
export function assertChildDepth(parentDepth: number): void {
  const childDepth = parentDepth + 1;
  if (childDepth > LIMITS.TREE_MAX_DEPTH) throw tooDeep(childDepth);
}
