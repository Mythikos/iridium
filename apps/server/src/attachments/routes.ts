/** Streaming attachment routes and read-only administrative reporting (09 §2.11 and §2.15). */
import fastifyMultipart from '@fastify/multipart';
import {
  ATTACHMENT_TYPES,
  Attachment,
  AttachmentPage,
  AttachmentParams,
  AttachmentUploadBody,
  AttachmentUploaded,
  AttachmentUploadFields,
  DeleteAttachmentQuery,
  LIMITS,
  ListAttachmentsQuery,
  parseStrongEtag,
  strongEtag,
  UnreferencedAttachmentPage,
  UnreferencedAttachmentsQuery,
  VaultIdParams,
  VaultId,
} from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireUserRow } from '../auth/users.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import type { ContentReadCore } from '../content/read/index.ts';
import type { CursorCodec } from '../mcp/cursor.ts';
import {
  appDb,
  auditContext,
  EMPTY_RESPONSE,
  requirePrincipal,
  requireUserPrincipal,
  routeSpec,
} from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import { ProblemError } from '../security/problem.ts';
import { AttachmentUploadAdmission } from './admission.ts';
import { attachmentEtagMatches, parseAttachmentRange } from './range.ts';
import { readAttachmentReport } from './report.ts';
import type { AttachmentService, AttachmentWriteContext } from './service.ts';
import { stageAttachment, type StagedAttachment } from './staging.ts';
import { AttachmentBytesMissingError } from './storage.ts';

/** Metrics remain in the process registry; this module names only observations it produces. */
export interface AttachmentRouteMetrics {
  uploaded(status: 'created' | 'deduplicated' | 'rejected'): void;
  served(bytes: number): void;
  missing(): void;
}
/** Composition supplies one service and one temporary directory for the process. */
export interface AttachmentRouteDeps {
  readonly service: AttachmentService;
  readonly core: ContentReadCore;
  readonly tempDirectory: string;
  readonly maxUploadBytes: number;
  readonly cursors: () => Promise<CursorCodec>;
  readonly metrics: AttachmentRouteMetrics;
}

const BINARY_CONTENT = Object.fromEntries(
  Object.keys(ATTACHMENT_TYPES).map((mime) => [mime, { schema: z.unknown() }]),
);
const MULTIPART_FIELDS = 2;
const MULTIPART_PARTS = 3;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_PARTIAL = 206;
const HTTP_NOT_MODIFIED = 304;

class AttachmentRouteSchemaError extends Error {
  constructor(part: string | undefined) {
    super(
      `Attachment upload ${part ?? 'unknown'} schema is not zod; register the contracts schema.`,
    );
    this.name = 'AttachmentRouteSchemaError';
  }
}

function invalidMultipart(code: string): ProblemError {
  return new ProblemError('validation_failed', { errors: [{ path: 'body', message: code, code }] });
}

async function actorContext(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<AttachmentWriteContext> {
  const principal = requireUserPrincipal(request.principal);
  const actor = await requireUserRow(appDb(app), principal.userId);
  return {
    principal,
    actor: {
      userId: principal.userId,
      sessionId: principal.sessionId,
      displayName: actor.display_name,
    },
    context: auditContext(request),
    ownerFence: requestOwnerFence(request),
  };
}

async function receiveUpload(
  request: FastifyRequest,
  deps: AttachmentRouteDeps,
  commit: (staged: StagedAttachment, fields: AttachmentUploadFields) => Promise<AttachmentUploaded>,
): Promise<AttachmentUploaded> {
  if (!request.isMultipart())
    throw new ProblemError('unsupported_media', {
      detail: 'Use multipart/form-data with one file part.',
    });
  let staged: StagedAttachment | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of request.parts({
      limits: {
        files: 2,
        fields: MULTIPART_FIELDS,
        parts: MULTIPART_PARTS,
        fileSize: deps.maxUploadBytes + 1,
        fieldSize: LIMITS.ATTACHMENT_PATH_MAX_CHARS * 4,
      },
    })) {
      if (part.type === 'file') {
        if (staged !== null) {
          part.file.resume();
          throw invalidMultipart('multiple_files');
        }
        if (part.fieldname !== 'file') {
          part.file.resume();
          throw invalidMultipart('no_file');
        }
        // eslint-disable-next-line no-await-in-loop -- multipart fields are sequential and the body is never buffered
        staged = await stageAttachment(
          part.file,
          part.filename,
          deps.tempDirectory,
          deps.maxUploadBytes,
        );
        if (part.file.truncated) throw new ProblemError('payload_too_large');
      } else {
        if (
          !['pathHint', 'noteId'].includes(part.fieldname) ||
          Object.hasOwn(fields, part.fieldname) ||
          typeof part.value !== 'string' ||
          part.valueTruncated
        )
          throw invalidMultipart('invalid_path');
        fields[part.fieldname] = part.value;
      }
    }
    if (staged === null) throw invalidMultipart('no_file');
    const parsed = AttachmentUploadFields.safeParse(fields);
    if (!parsed.success)
      throw invalidMultipart(fields['pathHint'] === undefined ? 'invalid_note' : 'invalid_path');
    return await commit(staged, parsed.data);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw new ProblemError('payload_too_large');
      if (error.code === 'FST_FILES_LIMIT') throw invalidMultipart('multiple_files');
      if (error.code === 'FST_FIELDS_LIMIT' || error.code === 'FST_PARTS_LIMIT')
        throw invalidMultipart('too_many_parts');
    }
    throw error;
  } finally {
    await staged?.dispose();
  }
}

/** Registers multipart only for the composing API instance, without buffering fields onto body. */
export async function applyAttachmentRoutes(
  app: FastifyInstance,
  deps: AttachmentRouteDeps,
): Promise<void> {
  await app.register(fastifyMultipart);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();
  const admission = new AttachmentUploadAdmission(app.clock);

  const list = routeSpec('attachments.list');
  api.get(
    list.path,
    {
      config: { auth: list.auth },
      schema: {
        operationId: list.operationId,
        tags: [list.tag],
        summary: list.summary,
        params: VaultIdParams,
        querystring: ListAttachmentsQuery,
        response: { [HTTP_OK]: AttachmentPage },
      },
    },
    async (request, reply) => {
      const page = await deps.core.listAttachments(
        requirePrincipal(request.principal),
        VaultId.parse(request.params.vaultId),
        request.query,
      );
      return reply.code(HTTP_OK).send(page);
    },
  );

  const upload = routeSpec('attachments.upload');
  api.post(
    upload.path,
    {
      config: { auth: upload.auth },
      // Multipart owns validation of its streaming file; a JSON validator must not require buffering.
      validatorCompiler: (context) => {
        if (context.httpPart === 'body') return () => ({ value: undefined });
        if (!(context.schema instanceof z.ZodType))
          throw new AttachmentRouteSchemaError(context.httpPart);
        return validatorCompiler({ ...context, schema: context.schema });
      },
      schema: {
        operationId: upload.operationId,
        tags: [upload.tag],
        summary: upload.summary,
        consumes: ['multipart/form-data'],
        params: VaultIdParams,
        body: AttachmentUploadBody,
        response: { [HTTP_CREATED]: AttachmentUploaded },
      },
    },
    async (request, reply) => {
      const release = admission.enter(request.principalKey ?? request.ip, request.params.vaultId);
      try {
        const write = await actorContext(app, request);
        const result = await receiveUpload(request, deps, (staged, fields) =>
          deps.service.upload(request.params.vaultId, staged, fields, write),
        );
        deps.metrics.uploaded(result.deduplicated ? 'deduplicated' : 'created');
        return reply
          .code(HTTP_CREATED)
          .header(
            'location',
            `${API_PREFIX}/vaults/${result.attachment.vaultId}/attachments/${result.attachment.id}/meta`,
          )
          .send(result);
      } catch (error) {
        deps.metrics.uploaded('rejected');
        throw error;
      } finally {
        release();
      }
    },
  );

  const download = routeSpec('attachments.download');
  app.get(
    download.path,
    {
      config: { auth: download.auth },
      schema: {
        operationId: download.operationId,
        tags: [download.tag],
        summary: download.summary,
        params: AttachmentParams,
        response: {
          [HTTP_OK]: { content: BINARY_CONTENT },
          [HTTP_PARTIAL]: { content: BINARY_CONTENT },
          [HTTP_NOT_MODIFIED]: EMPTY_RESPONSE,
        },
      },
    },
    async (request, reply) => {
      const params = AttachmentParams.parse(request.params);
      const content = await deps.core.readAttachmentContent(
        requirePrincipal(request.principal),
        VaultId.parse(params.vaultId),
        params.attachmentId,
      );
      const attachment = content.attachment;
      const etag = `"${attachment.sha256}"`;
      reply
        .header('etag', etag)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', 'sandbox')
        .header(
          'content-disposition',
          `${attachment.inlineable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.originalName).replaceAll(/[()'*]/g, (part) => `%${part.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        )
        .header('cache-control', 'private, max-age=3600')
        .header('accept-ranges', 'bytes')
        .header('cross-origin-resource-policy', 'same-origin')
        .header('x-permitted-cross-domain-policies', 'none')
        .header('referrer-policy', 'no-referrer')
        .header('vary', 'Authorization');
      if (attachmentEtagMatches(request.headers['if-none-match'], etag))
        return reply.code(HTTP_NOT_MODIFIED).send();
      const requestedRange =
        request.headers['if-range'] !== undefined && request.headers['if-range'] !== etag
          ? undefined
          : request.headers.range;
      const parsed = parseAttachmentRange(requestedRange, attachment.sizeBytes);
      if (parsed.kind === 'invalid') {
        reply.header('content-range', `bytes */${attachment.sizeBytes}`);
        throw new ProblemError(
          'validation_failed',
          { detail: 'Supply one satisfiable bytes range.' },
          'attachment-range',
        );
      }
      const range = parsed.kind === 'range' ? parsed.range : undefined;
      try {
        const stream = await content.open(range);
        const length = range === undefined ? attachment.sizeBytes : range.end - range.start + 1;
        if (range !== undefined)
          reply.header(
            'content-range',
            `bytes ${range.start}-${range.end}/${attachment.sizeBytes}`,
          );
        if (request.method !== 'HEAD') reply.raw.once('finish', () => deps.metrics.served(length));
        return reply
          .code(range === undefined ? HTTP_OK : HTTP_PARTIAL)
          .header('content-length', String(length))
          .type(attachment.mime)
          .send(stream);
      } catch (error) {
        if (!(error instanceof AttachmentBytesMissingError)) throw error;
        app.log.error(
          { event: 'attachment.bytes_missing', storageKey: error.storageKey },
          error.message,
        );
        deps.metrics.missing();
        throw new ProblemError(
          'server_error',
          { detail: 'Attachment bytes are unavailable. Restore the matching attachment volume.' },
          'attachment-missing',
        );
      }
    },
  );

  const metadata = routeSpec('attachments.getMeta');
  api.get(
    metadata.path,
    {
      config: { auth: metadata.auth },
      schema: {
        operationId: metadata.operationId,
        tags: [metadata.tag],
        summary: metadata.summary,
        params: AttachmentParams,
        response: { [HTTP_OK]: Attachment },
      },
    },
    async (request, reply) => {
      const attachment = await deps.core.readAttachmentMeta(
        requirePrincipal(request.principal),
        VaultId.parse(request.params.vaultId),
        request.params.attachmentId,
      );
      return reply.code(HTTP_OK).header('etag', strongEtag(attachment.version)).send(attachment);
    },
  );

  const remove = routeSpec('attachments.delete');
  api.delete(
    remove.path,
    {
      config: { auth: remove.auth },
      schema: {
        operationId: remove.operationId,
        tags: [remove.tag],
        summary: remove.summary,
        params: AttachmentParams,
        querystring: DeleteAttachmentQuery,
        response: { [HTTP_NO_CONTENT]: EMPTY_RESPONSE },
      },
    },
    async (request, reply) => {
      const version =
        request.headers['if-match'] === undefined
          ? undefined
          : (parseStrongEtag(request.headers['if-match']) ?? undefined);
      await deps.service.delete(
        request.params.vaultId,
        request.params.attachmentId,
        version,
        request.query.force,
        await actorContext(app, request),
      );
      return reply.code(HTTP_NO_CONTENT).send();
    },
  );

  const report = routeSpec('admin.attachments.unreferenced');
  api.get(
    report.path,
    {
      config: { auth: report.auth },
      schema: {
        operationId: report.operationId,
        tags: [report.tag],
        summary: report.summary,
        querystring: UnreferencedAttachmentsQuery,
        response: { [HTTP_OK]: UnreferencedAttachmentPage },
      },
    },
    async (request, reply) =>
      reply
        .code(HTTP_OK)
        .send(
          await readAttachmentReport(
            appDb(app),
            request.query,
            await deps.cursors(),
            request.principalKey ?? request.ip,
          ),
        ),
  );
}
