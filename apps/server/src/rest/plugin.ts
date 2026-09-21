/**
 * Boot step 7, the `rest` plugin: the `/api/v1` route tree, the two documentation operations, and
 * the static web surface.
 *
 * **`@fastify/swagger` is the first statement, and that is load-bearing.** It collects routes through
 * an `onRoute` hook, so it documents only what is registered after it; everything that registers a
 * route — `rest`, `collab`, `mcp`, `ops`, `jobs` — comes at or after this step, while steps 3 to 6
 * register none. Registering it anywhere else would silently produce a document missing whole route
 * families (`apps/server/src/ops/openapi.ts` records the same ordering from the other side).
 *
 * **Every route comes from `API_ROUTES`.** Each area exports `applyXRoutes(instance, deps)` and reads
 * its own rows through `routeSpec()`, so a route cannot be registered with a path, a policy or a
 * schema the OpenAPI document does not describe, and `rest.route-index.contract` holds the served
 * set, the documented set and 09-api-reference.md §2.18's table equal.
 *
 * **The `/api/v1` tree is one encapsulated child.** The zod validator and serializer compilers, the
 * `X-Iridium-Api-Version` header and the prefix belong to the API and not to `/healthz` or to the SPA;
 * encapsulating them is what keeps the operations surface free of a JSON serializer it never uses.
 *
 * Static serving is deliberately not `@fastify/static`'s own wildcard route. That route carries no
 * `config`, so the boot assertion would refuse to start; and the SPA entry document needs a
 * per-response CSP nonce substituted into it, which a plain file send cannot do. So the plugin is
 * registered with `serve: false` for `reply.sendFile` alone, and Iridium registers two routes of its
 * own that declare `config.auth = {public: true}` and choose their own `Cache-Control`:
 *
 *   `/app/assets/*` and every other hashed file  →  `public, max-age=31536000, immutable`
 *   the SPA entry document, including every fallback  →  `no-store`, nonce substituted
 *
 * `IRIDIUM_WEB_DIR` unset means the server serves no UI (API-only, 11-operations-and-deployment.md),
 * which is also the state before `apps/web` has been built: nothing is registered, `GET /` answers
 * the not-found handler's `ProblemDetails`, and no route promises a bundle that is not there.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

import fastifyStatic from '@fastify/static';
import { noteDocName, VaultId } from '@iridium/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { FsStorageDriver } from '../attachments/fs-storage.ts';
import { applyAttachmentRoutes } from '../attachments/routes.ts';
import { S3StorageDriver } from '../attachments/s3-storage.ts';
import { AttachmentService } from '../attachments/service.ts';
import type { StorageDriver } from '../attachments/storage.ts';
import { applyAuthRoutes } from '../auth/routes.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import { treeNotification } from '../collab/tree-notification.ts';
import type { IridiumConfig } from '../config/env.ts';
import { ContentReadCore } from '../content/read/index.ts';
import { applyJobRoutes } from '../jobs/routes.ts';
import { applyLinkRoutes } from '../links/routes.ts';
import { CursorCodec, readPromotedCursorKeyVersion } from '../mcp/cursor.ts';
import { applyMemberRoutes } from '../members/routes.ts';
import { applyNoteReadRoutes } from '../notes-rest/routes.ts';
import { checkpointTrash } from '../notes/trash-checkpoint.ts';
import { applyRestAccessLog } from '../ops/access-log.ts';
import type { ServerLogger } from '../ops/logging.ts';
import { applyOpenApiPlugin, hasOpenApi } from '../ops/openapi.ts';
import { applyRevisionRoutes } from '../revisions/routes.ts';
import { RevisionService } from '../revisions/service.ts';
import { MysqlFulltextSearch, type SearchIndex } from '../search/index.ts';
import { applySearchRoutes } from '../search/routes.ts';
import { SearchService } from '../search/service.ts';
import { SnippetBuilder } from '../search/snippets.ts';
import {
  CSP_NONCE_PLACEHOLDER,
  ENTRY_DOCUMENT_CACHE_CONTROL,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  STATIC_METADATA_CACHE_CONTROL,
} from '../security/csp.ts';
import { treeChanges } from '../tree/mutations.ts';
import { applyNodeRoutes, type NodeRouteDeps } from '../tree/routes.ts';
import { purgeExpiredTrash, type ExpiredTrashResult } from '../tree/trash.ts';
import { applyAdminUserRoutes } from '../users/routes.ts';
import { applyVaultRoutes } from '../vaults/routes.ts';
import { applyDocsUi } from './docs.ts';
import { appDb } from './handler-context.ts';
import { applyMetaRoutes } from './meta.ts';

/** What the rest plugin needs. */
export interface RestPluginOptions {
  readonly config: IridiumConfig;
  readonly logger: ServerLogger;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared storage lifetime for REST and maintenance reports. */
    attachmentStorage: StorageDriver;
    attachmentService: AttachmentService;
    contentRead: ContentReadCore;
    searchIndex: SearchIndex;
    purgeExpiredTrash(
      input: Parameters<typeof purgeExpiredTrash>[1] & { readonly ownerFence: OwnerFence },
    ): Promise<ExpiredTrashResult>;
  }
}

/** The prefix the SPA is served under. */
export const APP_PREFIX = '/app';
/** The entry document, and the SPA fallback target. */
export const ENTRY_DOCUMENT = 'index.html';
/** Content-hashed assets live here and are safe to cache immutably. */
export const HASHED_ASSET_PREFIX = 'assets/';

const HTTP_FOUND = 302;

/** Thrown when the built bundle cannot carry a per-response nonce. */
export class MissingNoncePlaceholderError extends Error {
  readonly exitCode = 2;

  constructor(path: string) {
    super(
      `${path} does not contain ${CSP_NONCE_PLACEHOLDER}. The nonce is substituted into the entry ` +
        'document per response (D07-10), so a build that emits no placeholder would ship a page ' +
        'whose styles are blocked by its own Content-Security-Policy. Fix the Vite HTML transform ' +
        'rather than relaxing the policy.',
    );
    this.name = 'MissingNoncePlaceholderError';
  }
}

/** Rejects any path that escapes the served root, whatever separators or `..` it uses. */
function resolveWithin(root: string, requested: string): string | null {
  const normalized = normalize(requested).replace(/^([/\\]|\.\.[/\\]?)+/, '');
  if (normalized === '' || normalized === '.') return null;
  const full = join(root, normalized);
  return full === root || full.startsWith(root + sep) ? full : null;
}

function cacheControlFor(relativePath: string): string {
  if (relativePath.startsWith(HASHED_ASSET_PREFIX)) return IMMUTABLE_ASSET_CACHE_CONTROL;
  return STATIC_METADATA_CACHE_CONTROL;
}

/**
 * The shared keyset cursor codec, built on first use.
 *
 * It cannot be built at boot: the signing version is `schema_meta.cursor_key_version`, a row, and
 * `buildApp({ database: 'none' })` opens no pool. A failed build is not cached, so a listing made
 * while the database was down does not poison every later one.
 */
function cursorCodecFactory(
  app: FastifyInstance,
  config: IridiumConfig,
): () => Promise<CursorCodec> {
  let pending: Promise<CursorCodec> | null = null;
  return () => {
    pending ??= (async () => {
      const signingVersion = await readPromotedCursorKeyVersion(appDb(app));
      return new CursorCodec({
        keyring: config.keys.mcpCursor,
        signingVersion,
        now: () => app.clock.now(),
      });
    })().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/** Applies boot step 7. */
export async function applyRestPlugin(
  app: FastifyInstance,
  options: RestPluginOptions,
): Promise<void> {
  const { config } = options;

  // First, so the `onRoute` hook sees every route registered from here on (ARCH-27).
  if (!hasOpenApi(app)) await applyOpenApiPlugin(app);

  const cursors = cursorCodecFactory(app, config);
  const storage: StorageDriver =
    config.storage.driver === 'fs'
      ? new FsStorageDriver(config.storage.dir)
      : new S3StorageDriver(config.storage);
  const attachments = new AttachmentService({
    database: () => appDb(app),
    clock: app.clock,
    audit: app.audit,
    authorize: (...args) => app.authz.authorize(...args),
    storage,
  });
  app.decorate('attachmentStorage', storage);
  app.decorate('attachmentService', attachments);
  app.addHook('onClose', () => storage.close());
  const snippets = new SnippetBuilder({
    clock: app.clock,
    pool: {
      run: <T>(task: unknown, runOptions?: { readonly filename?: string }) =>
        app.projectionPool.run<T>(task, runOptions),
    },
  });
  const searchIndex = new MysqlFulltextSearch({
    database: () => appDb(app),
    snippets,
    rebuild: (selection, context) => app.reindexService.run(selection, context),
  });
  app.decorate('searchIndex', searchIndex);
  const contentRead = new ContentReadCore({
    database: () => appDb(app),
    authorize: (...args) => app.authz.authorize(...args),
    accessibleVaultIds: (...args) => app.authz.accessibleVaultIds(...args),
    cursors,
    attachments,
    search: new SearchService(searchIndex),
    outline: async (markdown) => (await app.notes.prepare(markdown)).headings,
  });
  app.decorate('contentRead', contentRead);
  const lifecycle: NodeRouteDeps['lifecycle'] = {
    afterTrashCommit: async () => {
      app.faults.crash('tree.crash-after-commit-before-notify');
      await app.faults.hold('tree.hold-after-commit-before-notify');
    },
    markClosing: (noteId) => app.notes.markClosing(noteId),
    clearClosing: (noteId) => app.notes.clearClosing(noteId),
    checkpointTrash: (trx, noteIds, actor, now) =>
      checkpointTrash(
        trx,
        noteIds,
        {
          userId: actor.userId,
          sessionId: actor.sessionId,
          actorType: actor.userId === null ? 'system' : 'user',
        },
        now,
      ),
    afterTrash: async (vaultId, noteIds) => {
      await Promise.all(
        noteIds.map((noteId) =>
          app.authz.bus.publishAndWait({ type: 'note.trashed', vaultId, noteId }),
        ),
      );
    },
    beginPurge: (noteIds) => app.collab.persistence.beginFenceNotes(noteIds),
    beforePurge: async (noteIds) => {
      const hp = app.collab.server.hocuspocus;
      await Promise.allSettled(
        noteIds
          .map((noteId) => hp.loadingDocuments.get(noteDocName(noteId)))
          .filter((loading) => loading !== undefined),
      );
      await Promise.all(noteIds.map((noteId) => app.notes.closeNote(noteId, 'note-closing')));
      await app.collab.persistence.fenceNotes(noteIds);
      await Promise.all(
        noteIds.map(async (noteId) => {
          const document = hp.documents.get(noteDocName(noteId));
          if (document !== undefined) await hp.unloadDocument(document);
        }),
      );
    },
    afterPurge: async (vaultId, noteIds) => {
      await Promise.all(
        noteIds.map((noteId) =>
          app.authz.bus.publishAndWait({ type: 'note.trashed', vaultId, noteId }),
        ),
      );
    },
  };
  app.decorate(
    'purgeExpiredTrash',
    async (
      input: Parameters<typeof purgeExpiredTrash>[1] & { readonly ownerFence: OwnerFence },
    ) => {
      const result = await purgeExpiredTrash(
        {
          db: appDb(app),
          clock: app.clock,
          audit: app.audit,
          notes: app.notes,
          searchIndex,
          ownerFence: input.ownerFence,
          ...lifecycle,
        },
        input,
      );
      if (result.status === 'purged')
        app.collab.gateway.broadcastVault(
          input.vaultId,
          treeNotification(result.treeVersion, treeChanges(result.nodes, 'purged')),
        );
      return result;
    },
  );

  await app.register(
    async (api: FastifyInstance) => {
      applyRestAccessLog(api);
      applyMetaRoutes(api, config);
      applyAuthRoutes(api, { audit: app.audit });
      applyAdminUserRoutes(api, { audit: app.audit, cursors });
      applyVaultRoutes(api, {
        audit: app.audit,
        core: () => contentRead,
        broadcastVaultUpdated: (vaultId, version, changed) =>
          app.collab.gateway.broadcastVault(VaultId.parse(vaultId), {
            v: 1,
            t: 'vault-updated',
            version,
            changed: [...changed],
          }),
      });
      applyMemberRoutes(api, { audit: app.audit });
      applyNodeRoutes(api, {
        searchIndex: () => searchIndex,
        audit: app.audit,
        notes: () => app.notes,
        core: () => contentRead,
        lifecycle,
        broadcastTreeChanged: (vaultId, treeVersion, changes) => {
          app.collab.gateway.broadcastVault(
            VaultId.parse(vaultId),
            treeNotification(treeVersion, changes),
          );
        },
      });
      applySearchRoutes(api, contentRead);
      applyLinkRoutes(api, contentRead);
      applyJobRoutes(api, { jobs: () => app.jobs.scheduler, cursors });
      applyRevisionRoutes(api, {
        core: () => contentRead,
        service: () =>
          new RevisionService({
            db: () => appDb(app),
            gateway: app.collab.gateway,
            persistence: app.collab.persistence,
            captureOwner: () => app.collab.ownerLease.captureFence(),
            audit: app.audit,
            clock: app.clock,
            logger: options.logger,
          }),
      });
      await applyAttachmentRoutes(api, {
        service: attachments,
        core: contentRead,
        cursors,
        tempDirectory: join(
          config.storage.driver === 'fs' ? config.storage.dir : config.transfer.stagingDir,
          '.tmp',
        ),
        maxUploadBytes: config.transfer.maxUploadBytes,
        metrics: {
          uploaded: (status) => app.metrics.attachmentUploadsTotal.inc({ status }),
          served: (bytes) => app.metrics.attachmentServedBytesTotal.inc(bytes),
          missing: () => app.metrics.attachmentMissingTotal.inc(),
        },
      });
      applyNoteReadRoutes(api, {
        core: contentRead,
        markdownOf: (noteId, o) => app.notes.markdownOf(noteId, o),
        participants: (noteId) => app.collab.gateway.participants(noteId),
        isLoaded: (noteId) =>
          app.collab.server
            .loadedDocuments()
            .some((document) => document.name === noteDocName(noteId)),
      });
    },
    { prefix: API_PREFIX },
  );

  await applyDocsUi(app, config);
  await applyStaticSurface(app, options);
}

/** The SPA and the root redirect of ARCH-07; nothing is registered without a built bundle. */
async function applyStaticSurface(app: FastifyInstance, options: RestPluginOptions): Promise<void> {
  const { config, logger } = options;
  const root = config.web.dir;
  if (root === null) {
    logger.info(
      { webDir: null },
      'IRIDIUM_WEB_DIR is unset: this server is API-only and serves no web bundle',
    );
    return;
  }

  let entryTemplate: string;
  try {
    entryTemplate = await readFile(join(root, ENTRY_DOCUMENT), 'utf8');
  } catch {
    logger.warn(
      { webDir: root },
      `IRIDIUM_WEB_DIR is set but ${join(root, ENTRY_DOCUMENT)} does not exist; no web bundle is served`,
    );
    return;
  }
  if (!entryTemplate.includes(CSP_NONCE_PLACEHOLDER)) {
    throw new MissingNoncePlaceholderError(join(root, ENTRY_DOCUMENT));
  }
  // Split once at boot rather than replacing per request: the entry document is served on every SPA
  // navigation and a global regex replace per response is measurable at that rate.
  const entryPieces = entryTemplate.split(CSP_NONCE_PLACEHOLDER);

  // Iridium owns per-route caching below. The file adapter's default max-age=0 would otherwise
  // overwrite those headers while piping an asset or metadata file to the response.
  await app.register(fastifyStatic, {
    root,
    serve: false,
    decorateReply: true,
    cacheControl: false,
  });

  const sendEntryDocument = (reply: FastifyReply): FastifyReply =>
    reply
      .header('cache-control', ENTRY_DOCUMENT_CACHE_CONTROL)
      .type('text/html; charset=utf-8')
      .send(entryPieces.join(reply.cspNonce.style));

  // The static surfaces of §2.17 are not API operations, so they carry no `operationId` and are
  // hidden from the document: `openapi.coverage.contract` walks documented operations, and a bundle
  // path there would be an operation no test could ever "exercise".
  app.get(
    `${APP_PREFIX}/*`,
    { config: { auth: { public: true } }, schema: { hide: true } },
    async (request: FastifyRequest<{ Params: { '*': string } }>, reply) => {
      const requested = request.params['*'];
      if (requested === '' || requested === ENTRY_DOCUMENT) return sendEntryDocument(reply);

      const resolved = resolveWithin(root, requested);
      if (resolved === null) return sendEntryDocument(reply);
      try {
        const stats = await stat(resolved);
        if (!stats.isFile()) return sendEntryDocument(reply);
      } catch {
        // The SPA fallback: an unknown path under /app/ is a client route, not a missing file.
        return sendEntryDocument(reply);
      }
      return reply.header('cache-control', cacheControlFor(requested)).sendFile(requested);
    },
  );

  app.get(
    APP_PREFIX,
    { config: { auth: { public: true } }, schema: { hide: true } },
    // The shared router ignores trailing slashes, so this route also wins over the wildcard for
    // /app/. Redirect only the bare prefix; the canonical URL must actually serve its entry.
    async (request, reply) =>
      request.url.split('?', 1)[0] === APP_PREFIX
        ? reply.redirect(`${APP_PREFIX}/`, HTTP_FOUND)
        : sendEntryDocument(reply),
  );

  // ARCH-07: the SPA is the only human entry point on the origin, and a 404 at the root is a
  // support ticket.
  app.get(
    '/',
    { config: { auth: { public: true } }, schema: { hide: true } },
    async (_request, reply) => reply.redirect(`${APP_PREFIX}/`, HTTP_FOUND),
  );

  logger.info({ webDir: root }, `serving the web bundle at ${APP_PREFIX}/*`);
}
