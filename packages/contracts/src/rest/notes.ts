/**
 * `/notes/:noteId` (09-api-reference.md section 2.8), the three read routes M1 serves.
 *
 * Every one of them reads the **committed projection**, never the live `Y.Doc` (A37): `revision` is
 * the projected `note_updates.seq` and `headRevision` is `note_docs.head_seq`, so a client that sees
 * `revision < headRevision` knows the text is up to `COMPACTION_MAX_DEBOUNCE_MS` behind the editors
 * and says so rather than pretending otherwise.
 *
 * `GET /notes/:noteId/markdown` answers `text/markdown`, so its contract is a query plus a header set
 * rather than a response schema: `MARKDOWN_RESPONSE_HEADERS` is what the route sets and what the
 * OpenAPI document declares.
 */

import { z } from 'zod';

import { Role } from '../authz.ts';
import { PresenceMode } from '../collab.ts';
import { UserId } from '../ids.ts';
import { Timestamp } from '../time.ts';
import { QueryBoolean, RESPONSE_HEADERS } from './common.ts';

/**
 * `GET /notes/:noteId/markdown` — the query. `revision` and `fresh` both need `history:read`: one
 * reads a retained checkpoint, the other forces work on the live document.
 */
export interface GetMarkdownQuery {
  /** A retained `note_revisions.seq`. */
  readonly revision?: number | undefined;
  /** A 1-based inclusive line range over the LF-normalised source, e.g. `120-260`. */
  readonly lines?: string | undefined;
  /** Force compaction first; a no-op when `projected_seq == head_seq`. */
  readonly fresh: boolean;
}

/**
 * A positive, ordered line range with safe-integer endpoints. Whether its start exists in the
 * selected note remains the read handler's request-state check (09-api-reference.md section 2.8).
 */
export const MarkdownLineRange: z.ZodType<string> = z
  .string()
  .regex(/^0*[1-9][0-9]*-0*[1-9][0-9]*$/, 'expected a 1-based inclusive line range such as 120-260')
  .refine((value) => {
    const [rawStart, rawEnd] = value.split('-');
    const start = Number(rawStart);
    const end = Number(rawEnd);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start;
  }, 'expected an ordered range of positive safe integers')
  .meta({ format: 'iridium-line-range' });

/** `GET /notes/:noteId/markdown` — the query. */
export const GetMarkdownQuery: z.ZodType<GetMarkdownQuery> = z
  .strictObject({
    revision: z.coerce.number().int().positive().optional(),
    lines: MarkdownLineRange.optional(),
    fresh: QueryBoolean.default(false),
  })
  .meta({ id: 'GetMarkdownQuery' });

/**
 * The headers `GET /notes/:noteId/markdown` sets beyond `ETag` and `Content-Disposition`. The `ETag`
 * is `"<revision>:<contentHash>"` over the **whole** note even when `lines` returned a slice, so a
 * cache stays correct; `x-iridium-returned-lines` is present only with `lines`.
 */
export const MARKDOWN_RESPONSE_HEADERS: readonly string[] = [
  RESPONSE_HEADERS.revision,
  RESPONSE_HEADERS.headRevision,
  RESPONSE_HEADERS.contentHash,
  RESPONSE_HEADERS.lineCount,
  RESPONSE_HEADERS.returnedLines,
  RESPONSE_HEADERS.projectionStatus,
];

/** The `ETag` of a Markdown read: the revision and the whole note's content hash. */
export function markdownEtag(revision: number, contentHash: string): string {
  return `"${String(revision)}:${contentHash}"`;
}

/** The weak validator `GET /notes/:noteId` emits — cache validation only, never an `If-Match` value. */
export function noteMetaEtag(version: number, revision: number): string {
  return `W/"${String(version)}:${String(revision)}"`;
}

/** One participant of `GET /notes/:noteId/participants`, taken from authenticated connections. */
export interface NoteParticipant {
  readonly userId: string;
  readonly displayName: string;
  readonly colorHue: number;
  readonly role: Role;
  /** `null` when the connection has published no presence mode. */
  readonly mode: 'source' | 'reading' | 'split' | null;
  readonly connections: number;
  readonly since: string;
}

/** One participant. */
export const NoteParticipant: z.ZodType<NoteParticipant> = z
  .strictObject({
    userId: UserId,
    displayName: z.string(),
    colorHue: z.int(),
    role: Role,
    mode: PresenceMode.nullable(),
    connections: z.int().positive(),
    since: Timestamp,
  })
  .meta({ id: 'NoteParticipant' });

/**
 * `GET /notes/:noteId/participants` — presence without opening a collaboration connection. Derived
 * from each connection's authenticated context, never from awareness (A25/F6), which is why a client
 * cannot present a name it chose itself.
 */
export interface NoteParticipants {
  readonly items: readonly NoteParticipant[];
  /** `false` when the document is not in memory, in which case `items` is empty. */
  readonly loaded: boolean;
}

/** `GET /notes/:noteId/participants`. */
export const NoteParticipants: z.ZodType<NoteParticipants> = z
  .strictObject({ items: z.array(NoteParticipant), loaded: z.boolean() })
  .meta({ id: 'NoteParticipants' });
