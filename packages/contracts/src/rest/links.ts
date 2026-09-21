/** Link reads expose the immutable projected references, never rewritten Markdown (09 section 2.8). */
import { z } from 'zod';

import { LIMITS } from '../limits.ts';
import { Link } from './tree.ts';

/** The bounded outgoing list shares one committed projection revision. */
export interface NoteLinks {
  readonly items: readonly Link[];
  readonly revision: number;
}
/** One note cannot project more than the parser's accepted link cap. */
export const NoteLinks: z.ZodType<NoteLinks> = z
  .strictObject({
    items: z.array(Link).max(LIMITS.MARKDOWN_LINKS_MAX),
    revision: z.int().nonnegative(),
  })
  .meta({ id: 'NoteLinks' });
