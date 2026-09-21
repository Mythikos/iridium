/** Product-service adapter for testkit's large fixture; all node writes retain structural invariants. */
import { SessionId, UserId, VaultId } from '@iridium/contracts';
import type { StructureNodeWriter } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';

import { createNode } from '../../src/tree/service.ts';

/** Bind after the normal application factory has composed the real services and owner lease. */
export function createStructureWriter(app: FastifyInstance): StructureNodeWriter {
  return async (input) => {
    const db = app.database.dbApp;
    if (db === null) throw new Error('The structure fixture needs a ready database.');
    const created = await createNode(
      {
        db,
        clock: app.clock,
        notes: app.notes,
        audit: app.audit,
        searchIndex: app.searchIndex,
        ownerFence: app.collab.ownerLease.captureFence(),
      },
      {
        vaultId: VaultId.parse(input.vaultId),
        parentId: input.parentId,
        name: input.name,
        kind: input.kind,
        ...(input.markdown === undefined ? {} : { markdown: input.markdown }),
        actor: {
          userId: UserId.parse(input.actor.userId),
          sessionId: SessionId.parse(input.actor.sessionId),
          displayName: input.actor.displayName,
        },
        context: { client: 'structure-fixture' },
      },
    );
    return { id: created.node.id };
  };
}
