/**
 * `POST /vaults/:vaultId/nodes` (09-api-reference.md section 2.7), for categories and notes.
 *
 * `markdown` is capped at `NOTE_HARD_MAX_UTF16` and is the only Markdown any route accepts: it feeds
 * `NoteService.initialize`, the single Markdown-to-`Y.Doc` path in the system.
 */

import { z } from 'zod';

import { NodeId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { NodeName } from './common.ts';

/** `POST /vaults/:vaultId/nodes` — create a category. */
export interface CreateCategoryBody {
  readonly kind: 'category';
  /** Must be a live category in this vault. */
  readonly parentId: string;
  readonly name: string;
}

/** `POST /vaults/:vaultId/nodes` — create an initialized note. */
export interface CreateNoteBody {
  readonly kind: 'note';
  /** Must be a live category in this vault. */
  readonly parentId: string;
  /** The filename without `.md`; a supplied `.md` suffix is stripped. */
  readonly name: string;
  /** Defaults to `''`. Normalised to LF, BOM stripped, `U+0000` to `U+FFFD`. */
  readonly markdown?: string | undefined;
}

/**
 * `POST /vaults/:vaultId/nodes` — create a category or initialized note.
 *
 * The two kinds are a discriminated union rather than one object with a cross-field refusal,
 * because a refusal that only exists in the refinement cannot reach the published schema: the
 * document would advertise `markdown` on a category and the server would answer 422 to a request
 * the contract called valid. As a union the constraint is in the document, so the fuzzer never
 * generates the combination and a client learns the rule from the specification.
 */
export type CreateNodeBody = CreateCategoryBody | CreateNoteBody;

/** `POST /vaults/:vaultId/nodes`. */
export const CreateNodeBody: z.ZodType<CreateNodeBody> = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('category'),
      parentId: NodeId,
      name: NodeName,
    }),
    z.strictObject({
      kind: z.literal('note'),
      parentId: NodeId,
      name: NodeName,
      markdown: z
        .string()
        // JSON Schema's maxLength counts code points; the refinement enforces the stricter note
        // policy in UTF-16 code units, including astral characters as surrogate pairs.
        .max(LIMITS.NOTE_HARD_MAX_UTF16)
        .refine((value) => value.length <= LIMITS.NOTE_HARD_MAX_UTF16, {
          error: 'markdown exceeds the hard note limit in UTF-16 code units',
        })
        .meta({ description: 'At most 2,097,152 UTF-16 code units.' })
        .optional(),
    }),
  ])
  .meta({ id: 'CreateNodeBody' });
