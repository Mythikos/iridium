/**
 * `applyNoteReadRoutes(app)` — the three note reads of M1 (09-api-reference.md §2.8).
 *
 * All three answer from committed rows. `GET /notes/:noteId` and `GET /notes/:noteId/markdown` read
 * the projection; `GET /notes/:noteId/participants` reads the gateway's connection contexts and
 * never awareness (A25/F6), which is what stops a client presenting a name it chose itself.
 *
 * **Two query parameters need more than `note:read`.** `?revision=` reads a retained checkpoint and
 * `?fresh=true` forces work on the live document, and §2.8 gates both on `history:read`. The route
 * policy cannot express "this permission, but only with that parameter", so the handler asks
 * `authorize()` itself — the one place in this area that calls it directly, and for exactly the
 * reason 04-auth-and-access-control.md §5.4 names: a check the route did not make.
 *
 * **`?fresh=true` carries its own budget** (§1.8: 6/min per principal and note). It is a second
 * counter rather than a `@fastify/rate-limit` route configuration because the limit applies to a
 * *parameter* and not to the route: a plain read of the same note must not consume it, and the
 * plugin runs at most one limiter per request.
 */
import {
  GetMarkdownQuery,
  LIMITS,
  markdownEtag,
  NoteId,
  NoteIdParams,
  NoteMeta,
  NoteParticipants,
  noteMetaEtag,
  RESPONSE_HEADERS,
  type RouteSpec,
  type VaultId,
} from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { WindowedBudget } from '../auth/tickets/ip-budget.ts';
import type { ContentReadCore } from '../content/read/index.ts';
import {
  EMPTY_RESPONSE,
  requirePrincipal,
  routeSpec as manifestRow,
} from '../rest/handler-context.ts';
import { ProblemError } from '../security/problem.ts';

/**
 * A body this route can serve: the committed projection, or one retained checkpoint.
 *
 * `status` and `headSeq` are present only for a read of the current text. A retained revision *is*
 * the state it names, so it trails nothing and its projection status is `ok` by construction.
 */
export interface MarkdownRead {
  readonly markdown: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly status?: string | undefined;
  readonly headSeq?: number | undefined;
}

/** What the composer passes. */
export interface NoteReadRouteDeps {
  readonly core: ContentReadCore;
  /** `app.notes.markdownOf` — the one committed-Markdown accessor, shared with the M3 tools. */
  readonly markdownOf: (
    noteId: NoteId,
    options?: { readonly fresh?: boolean },
  ) => Promise<MarkdownRead | null>;
  /** `app.collab.gateway.participants`. */
  readonly participants: (noteId: NoteId) => readonly NoteParticipantSource[];
  /** Whether the note's document is in memory; `false` makes `items` empty rather than wrong. */
  readonly isLoaded: (noteId: NoteId) => boolean;
}

/** What a participant entry must carry for `NoteParticipant` to be rendered from it. */
export interface NoteParticipantSource {
  readonly id: string;
  readonly name: string;
  readonly colorHue: number;
  readonly role: 'viewer' | 'editor' | 'manager';
  readonly mode?: 'source' | 'reading' | 'split' | undefined;
  readonly connections: number;
  /** Epoch milliseconds of the participant's first connection to this document. */
  readonly since: number;
}

/** The operation ids this module registers, in registration order. */
export const NOTE_READ_OPERATION_IDS = [
  'notes.get',
  'notes.getMarkdown',
  'notes.participants',
] as const;

/** An operation id of this module. */
type NoteReadOperationId = (typeof NOTE_READ_OPERATION_IDS)[number];

/**
 * The manifest row for one of this module's operations: the shared lookup, narrowed to the ids
 * above, so a registration cannot name a row this module does not claim.
 */
function routeSpec(operationId: NoteReadOperationId): RouteSpec {
  return manifestRow(operationId);
}

const HTTP_OK = 200;
const HTTP_NOT_MODIFIED = 304;
const MS_PER_MINUTE = 60_000;

/**
 * The `?fresh=true` budget of §1.8: six reads per minute per principal and note.
 *
 * The number is a rate limit and belongs in `@iridium/contracts/limits.ts` beside
 * `FLUSH_PER_MINUTE`, which is the same budget on the collaboration channel; it is declared here
 * until that package carries it, and the M1 report asks for the member.
 */
const FRESH_READS_PER_MINUTE = LIMITS.FLUSH_PER_MINUTE;

/** The content type a Markdown read answers with (§2.8). */
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

/** The media type the document names for that body; the charset is a response parameter, not a key. */
const MARKDOWN_MEDIA_TYPE = 'text/markdown';

/**
 * The body of a Markdown read, for the document.
 *
 * It is a zod schema because the `/api/v1` child builds every serializer with the zod compiler.
 * Fastify never runs it: a string payload sent with a non-JSON `Content-Type` bypasses
 * serialization, which is what keeps the Markdown byte-for-byte what the projection committed.
 */
const MARKDOWN_BODY_SCHEMA = z.string().meta({ id: 'NoteMarkdown' });

/** Whether an `If-None-Match` header matches the ETag a read would answer with (§1.2). */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === etag || candidate === `W/${etag}`);
}

/**
 * The note the route policy resolved.
 *
 * `vaultFrom: 'note:params.noteId'` has already read the row, refused a node that is not a note
 * and authorised `note:read`, so an absent attachment is a policy defect rather than an unknown
 * id. The id itself comes from the validated params, not from a second parse of the URL.
 */
function resolvedNote(
  request: FastifyRequest,
  noteId: string,
): { readonly id: NoteId; readonly vaultId: VaultId } {
  const node = request.resolvedNode;
  if (node === null) throw new ProblemError('not_found');
  return { id: NoteId.parse(noteId), vaultId: node.vaultId };
}

/** Applies the note read routes to an instance already mounted under `/api/v1`. */
export function applyNoteReadRoutes(app: FastifyInstance, deps: NoteReadRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();

  const freshBudget = new WindowedBudget({
    clock: app.clock,
    max: FRESH_READS_PER_MINUTE,
    windowMs: MS_PER_MINUTE,
  });
  app.addHook('onClose', async () => {
    freshBudget.close();
  });

  /** §2.8: `?revision=` and `?fresh=true` need `history:read` in addition to `note:read`. */
  const requireHistoryRead = async (request: FastifyRequest, vaultId: VaultId): Promise<void> => {
    const principal = requirePrincipal(request.principal);
    const decision = await app.authz.authorize(principal, 'history:read', {
      vaultId,
      surface: 'rest',
    });
    if (decision === 'allow') return;
    request.log.warn(
      { event: 'authz.denied', reason: 'history', route: request.routeOptions.url },
      'denied',
    );
    throw new ProblemError('forbidden', {
      detail: 'Reading a named revision or forcing a fresh projection needs history access.',
    });
  };

  // ---- GET /notes/:noteId ------------------------------------------------------------------------
  const get = routeSpec('notes.get');
  api.get(
    get.path,
    {
      config: { auth: get.auth },
      schema: {
        operationId: get.operationId,
        tags: [get.tag],
        summary: get.summary,
        params: NoteIdParams,
        response: { [HTTP_OK]: NoteMeta },
      },
    },
    async (request, reply) => {
      const note = resolvedNote(request, request.params.noteId);
      const meta = await deps.core.readNoteMeta(requirePrincipal(request.principal), note.id);
      reply
        .header('etag', noteMetaEtag(meta.version, meta.revision))
        .header(RESPONSE_HEADERS.revision, String(meta.revision))
        .header(RESPONSE_HEADERS.headRevision, String(meta.headRevision))
        .header(RESPONSE_HEADERS.projectionStatus, meta.projectionStatus);
      if (meta.contentHash !== null) reply.header(RESPONSE_HEADERS.contentHash, meta.contentHash);
      return reply.code(HTTP_OK).send(meta);
    },
  );

  // ---- GET /notes/:noteId/markdown ---------------------------------------------------------------
  const markdown = routeSpec('notes.getMarkdown');
  api.get(
    markdown.path,
    {
      config: { auth: markdown.auth },
      schema: {
        operationId: markdown.operationId,
        tags: [markdown.tag],
        summary: markdown.summary,
        params: NoteIdParams,
        querystring: GetMarkdownQuery,
        response: {
          [HTTP_OK]: { content: { [MARKDOWN_MEDIA_TYPE]: { schema: MARKDOWN_BODY_SCHEMA } } },
          // A `304` carries no body at all, and `EMPTY_RESPONSE` is what says so in the document.
          [HTTP_NOT_MODIFIED]: EMPTY_RESPONSE,
        },
      },
    },
    async (request, reply) => {
      const note = resolvedNote(request, request.params.noteId);
      const { revision, lines, fresh } = request.query;
      if (revision !== undefined || fresh) await requireHistoryRead(request, note.vaultId);

      if (fresh && revision === undefined)
        await readCurrent(deps, freshBudget, request, note.id, true);
      const lineRange = lines?.split('-').map(Number);
      if (
        lineRange !== undefined &&
        (!Number.isSafeInteger(lineRange[0]) ||
          !Number.isSafeInteger(lineRange[1]) ||
          (lineRange[0] ?? 0) < 1 ||
          (lineRange[1] ?? 0) < (lineRange[0] ?? 0))
      ) {
        throw new ProblemError('validation_failed', {
          detail: 'lines must be a 1-based inclusive range such as 120-260.',
          errors: [{ path: 'query.lines', message: 'lines_invalid', code: 'lines_invalid' }],
        });
      }
      const content = await deps.core.readNoteMarkdown(
        requirePrincipal(request.principal),
        note.id,
        {
          ...(revision === undefined ? {} : { revision }),
          ...(lineRange === undefined
            ? {}
            : { lines: { start: lineRange[0] ?? 1, end: lineRange[1] ?? 1 } }),
        },
      );

      const etag = markdownEtag(content.revision, content.contentHash);
      reply
        .header('etag', etag)
        .header(RESPONSE_HEADERS.revision, String(content.revision))
        .header(RESPONSE_HEADERS.headRevision, String(content.headRevision))
        .header(RESPONSE_HEADERS.contentHash, content.contentHash)
        .header(RESPONSE_HEADERS.lineCount, String(content.lineCount))
        .header(RESPONSE_HEADERS.projectionStatus, content.projectionStatus);
      if (matchesEtag(request.headers['if-none-match'], etag)) {
        return reply.code(HTTP_NOT_MODIFIED).send();
      }

      // The shared read core clamps source selections for bounded excerpts (A37). The REST
      // query retains its published M1 refusal when the first requested line does not exist.
      if (lineRange !== undefined && (lineRange[0] ?? 1) > content.lineCount) {
        throw new ProblemError('validation_failed', {
          detail: `lines starts at ${String(lineRange[0])} and the note has ${String(content.lineCount)} line(s).`,
          errors: [
            { path: 'query.lines', message: 'lines_out_of_range', code: 'lines_out_of_range' },
          ],
        });
      }

      reply.header(
        'content-disposition',
        `inline; filename="${encodeURIComponent(content.meta.name)}.md"`,
      );
      if (lines !== undefined) {
        reply.header(
          RESPONSE_HEADERS.returnedLines,
          `${String(content.returnedRange[0])}-${String(content.returnedRange[1])}`,
        );
      }
      return reply.code(HTTP_OK).type(MARKDOWN_CONTENT_TYPE).send(content.markdown);
    },
  );

  // ---- GET /notes/:noteId/participants -----------------------------------------------------------
  const participants = routeSpec('notes.participants');
  api.get(
    participants.path,
    {
      config: { auth: participants.auth },
      schema: {
        operationId: participants.operationId,
        tags: [participants.tag],
        summary: participants.summary,
        params: NoteIdParams,
        response: { [HTTP_OK]: NoteParticipants },
      },
    },
    async (request, reply) => {
      const note = resolvedNote(request, request.params.noteId);
      const loaded = deps.isLoaded(note.id);
      const items = loaded
        ? deps.participants(note.id).map((entry) => ({
            userId: entry.id,
            displayName: entry.name,
            colorHue: entry.colorHue,
            role: entry.role,
            mode: entry.mode ?? null,
            connections: entry.connections,
            since: new Date(entry.since).toISOString(),
          }))
        : [];
      return reply.code(HTTP_OK).send({ items, loaded });
    },
  );
}

/** The committed text of a note right now, with the `?fresh=true` budget applied when it is asked for. */
async function readCurrent(
  deps: NoteReadRouteDeps,
  budget: WindowedBudget,
  request: FastifyRequest,
  noteId: NoteId,
  fresh: boolean,
): Promise<MarkdownRead | null> {
  if (!fresh) return deps.markdownOf(noteId);
  const verdict = budget.hit(`${request.principalKey ?? request.ip}|${noteId}`);
  if (!verdict.allowed) {
    throw new ProblemError('rate_limited', {
      detail: 'Too many forced projections of this note; try again shortly.',
      retryAfterMs: verdict.retryAfterMs,
    });
  }
  return deps.markdownOf(noteId, { fresh: true });
}
