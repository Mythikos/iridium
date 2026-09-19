/**
 * `POST /vaults/:vaultId/nodes` (09-api-reference.md section 2.7), the one structural write M1 has.
 *
 * This request describes the kinds this operation can create. The shared `NodeKind` and `Node`
 * response schemas still describe both categories and notes; category creation is added to this
 * request only when the operation implements it.
 *
 * `markdown` is capped at `NOTE_HARD_MAX_UTF16` and is the only Markdown any route accepts: it feeds
 * `NoteService.initialize`, the single Markdown-to-`Y.Doc` path in the system.
 */

import { z } from 'zod';

import { NodeId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { NodeName } from './common.ts';

/** `POST /vaults/:vaultId/nodes` — create a note. */
export interface CreateNodeBody {
  readonly kind: 'note';
  /** Must be a live category in this vault. */
  readonly parentId: string;
  /** For a note, the filename without `.md`; a supplied `.md` suffix is stripped. */
  readonly name: string;
  /** Notes only; defaults to `''`. Normalised to LF, BOM stripped, `U+0000` to `U+FFFD`. */
  readonly markdown?: string | undefined;
}

/** `POST /vaults/:vaultId/nodes`. */
export const CreateNodeBody: z.ZodType<CreateNodeBody> = z
  .strictObject({
    kind: z.literal('note'),
    parentId: NodeId,
    name: NodeName,
    markdown: z
      .string()
      // JSON Schema's maxLength counts code points; the refinement enforces the stricter note
      // policy in UTF-16 code units, including astral characters represented by surrogate pairs.
      .max(LIMITS.NOTE_HARD_MAX_UTF16)
      .refine((value) => value.length <= LIMITS.NOTE_HARD_MAX_UTF16, {
        error: 'markdown exceeds the hard note limit in UTF-16 code units',
      })
      .meta({ description: 'At most 2,097,152 UTF-16 code units.' })
      .optional(),
  })
  .meta({ id: 'CreateNodeBody' });
