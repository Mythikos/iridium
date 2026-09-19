/**
 * The bundled breached-password list (04-auth-and-access-control.md section 3.4, D04-04).
 *
 * `blocklist.txt` beside this module is the SecLists top-100 000 entries of the xato.net
 * ten-million-password corpus (MIT), the file the plan names `10-million-password-list-top-100000`
 * — SecLists renamed it `xato-net-10-million-passwords-100000.txt` — pinned by the SHA-256 below
 * and bundled in the image. The list is loaded once at boot into a `Set` of NFC-lowercased
 * entries and consulted offline; a candidate never leaves the process and is never logged.
 *
 * The pin is checked every time the file is loaded, so a modified or truncated copy refuses to boot
 * rather than silently weakening the policy: the artefact is auditable because the number is here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** SHA-256 of `blocklist.txt` as shipped (SecLists commit `810736be`). */
export const BLOCKLIST_SHA256 = '1472aafa2561df5e3293aee252aee3ca660c12b399a283cf808bb01b39be388b';

/**
 * Lines the shipped file carries. The upstream list has one blank line, so 99 999 of them are
 * passwords, and case-folding collapses those to `BLOCKLIST_ENTRY_COUNT` distinct keys. The pin is
 * the SHA-256; these two numbers are what `auth.policy.blocklist-hash.unit` asserts the pinned
 * bytes yield.
 *
 * @internal
 */
export const BLOCKLIST_LINE_COUNT = 100_000;

/** Distinct NFC-lowercased keys the shipped file yields. @internal */
export const BLOCKLIST_ENTRY_COUNT = 96_517;

/** Where the bundled list lives, resolved from this module so `dist/` and `src/` both work. */
export const BLOCKLIST_PATH: string = fileURLToPath(new URL('blocklist.txt', import.meta.url));

/** Thrown when the bundled list does not match its pin; the remedy is to restore the file. */
export class BlocklistIntegrityError extends Error {
  readonly exitCode = 2;

  constructor(path: string, expected: string, observed: string) {
    super(
      `${path} does not match its pinned SHA-256 (expected ${expected}, observed ${observed}). ` +
        'The breached-password list is bundled and pinned (04-auth-and-access-control.md section 3.4); ' +
        'restore the shipped file rather than editing the pin.',
    );
    this.name = 'BlocklistIntegrityError';
  }
}

/** The lowercased, NFC-normalised form every candidate is compared in. */
export function blocklistKey(candidate: string): string {
  return candidate.normalize('NFC').toLowerCase();
}

/**
 * Loads the list, verifying the pin first. Synchronous by design: it runs once inside boot step 4
 * and the policy cannot exist without it.
 */
export function loadBlocklist(path: string = BLOCKLIST_PATH): ReadonlySet<string> {
  const bytes = readFileSync(path);
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== BLOCKLIST_SHA256) {
    throw new BlocklistIntegrityError(path, BLOCKLIST_SHA256, observed);
  }
  const entries = new Set<string>();
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line !== '') entries.add(blocklistKey(line));
  }
  return entries;
}
