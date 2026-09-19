/**
 * A Hocuspocus `Document` stand-in for the persistence suites: a real `Y.Doc` (through
 * `@iridium/crdt`, the only package that may construct one) carrying the three members the writer
 * touches — `broadcastStateless`, `getConnectionsCount`, `getConnections` — plus fake connections
 * whose `readOnly` flag and per-connection messages a test can read back.
 *
 * Nothing here reimplements Hocuspocus behaviour: the writer is exercised as it is, the document is
 * a real CRDT, and the only difference from production is that a broadcast lands in an array
 * instead of on a socket.
 */
import type { Role, SessionId, UserId } from '@iridium/contracts';
import { createNoteDoc, type NoteDoc } from '@iridium/crdt';

import type { WriterConnection, WriterDocument } from '../writer.ts';

/** A connection the writer can flip read-only and message; what it received is recorded. */
export interface FakeConnection extends WriterConnection {
  readonly context: { role: Role; userId: UserId; sessionId: SessionId };
  readonly sent: string[];
}

/** The fake document: a `NoteDoc` with the writer's surface and recorded broadcasts. */
export type FakeDocument = NoteDoc &
  WriterDocument & {
    readonly broadcasts: string[];
    readonly connections: FakeConnection[];
    addConnection(context: { role: Role; userId: UserId; sessionId: SessionId }): FakeConnection;
    removeConnection(connection: FakeConnection): void;
  };

/** Builds one. */
export function fakeDocument(): FakeDocument {
  const doc = createNoteDoc({ gc: true });
  const broadcasts: string[] = [];
  const connections: FakeConnection[] = [];
  return Object.assign(doc, {
    broadcasts,
    connections,
    broadcastStateless(payload: string): void {
      broadcasts.push(payload);
    },
    getConnectionsCount(): number {
      return connections.length;
    },
    getConnections(): readonly FakeConnection[] {
      return connections;
    },
    addConnection(context: { role: Role; userId: UserId; sessionId: SessionId }): FakeConnection {
      const sent: string[] = [];
      const connection: FakeConnection = {
        readOnly: context.role === 'viewer',
        context,
        sent,
        sendStateless(payload: string): void {
          sent.push(payload);
        },
      };
      connections.push(connection);
      return connection;
    },
    removeConnection(connection: FakeConnection): void {
      const index = connections.indexOf(connection);
      if (index !== -1) connections.splice(index, 1);
    },
  });
}

/** The transaction origin a client update carries: `{source:'connection', connection}`. */
export function connectionOrigin(connection: FakeConnection): {
  readonly source: 'connection';
  readonly connection: FakeConnection;
} {
  return { source: 'connection', connection };
}

/** The transaction origin of a server-originated edit (04 §6.9). */
export function localOrigin(
  reason: 'restore' | 'repair',
  userId: UserId | null = null,
): { readonly source: 'local'; readonly context: { reason: string; userId?: UserId } } {
  return { source: 'local', context: { reason, ...(userId === null ? {} : { userId }) } };
}
