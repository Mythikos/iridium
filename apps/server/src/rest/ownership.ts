/** Preserve the serving generation from request admission through every mutation COMMIT. */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerFence } from '../collab/owner-lease.ts';
import { isOpsPath } from '../ops/paths.ts';
import { ProblemError } from '../security/problem.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Captured before asynchronous authentication; a later lease claim cannot replace it. */
    ownerFence: OwnerFence | null;
  }
}

/** Install after readiness admission and before authentication, using the final collab decorator. */
export function applyRequestOwnership(app: FastifyInstance): void {
  app.decorateRequest('ownerFence', null);
  app.addHook('onRequest', async (request) => {
    if (
      isOpsPath(request.url) ||
      request.method === 'GET' ||
      request.method === 'HEAD' ||
      request.method === 'OPTIONS'
    )
      return;
    request.ownerFence = app.collab.ownerLease.captureFence();
  });
}

/** Mutating route dependencies require the admission fence, never a newly captured generation. */
export function requestOwnerFence(request: Pick<FastifyRequest, 'ownerFence'>): OwnerFence {
  const fence = request.ownerFence;
  if (fence === null) {
    throw new ProblemError('unavailable', { detail: 'This request has no serving owner.' });
  }
  fence.assertActive();
  return fence;
}
