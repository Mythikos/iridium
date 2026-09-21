/** Structural and vault metadata use the same required strong-version validator (09 §1.2). */
import { parseStrongEtag } from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';

/** Refuses missing, weak, wildcard, list and malformed validators with 428. */
export function requiredVersion(header: string | readonly string[] | undefined): number {
  const version = typeof header === 'string' ? parseStrongEtag(header) : null;
  if (version === null) throw new ProblemError('precondition_required');
  return version;
}
