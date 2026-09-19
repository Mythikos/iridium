/**
 * Real Hocuspocus documents and connections over fake sockets, for the hook and gateway unit suites.
 *
 * `Document` and `Connection` are the library's own classes: a `Connection` built here sends its
 * frames through a `WebSocketLike` that records bytes, so a test reads back exactly what a provider
 * would have received — a `CLOSE(7)` with its reason, a stateless payload — through the same header
 * peek the product uses. Nothing here constructs a `Hocuspocus` instance: `guards.one-boot-path.guard`
 * allows one construction site in the tree, and the gateway and the hooks are written against the
 * narrower `GatewayServer` / `documents()` surfaces precisely so a suite can hand them a map.
 */
import { Connection, Document } from '@hocuspocus/server';
import { FRAME_TYPE, peekFrame, peekStatelessPayload } from '@iridium/crdt';

import type { CollabHookContext } from '../context.ts';
import type { GatewayServer } from '../gateway.ts';

/** A recorded outbound frame, decoded as far as the header peek goes. */
export interface SentFrame {
  readonly type: number;
  readonly documentName: string;
  /** The stateless payload for a `Stateless` frame, or the reason of a `CLOSE` frame. */
  readonly text: string | null;
}

/** The socket a fake connection writes to. */
export interface FakeSocket {
  readonly frames: SentFrame[];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }>;
  readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

function decode(bytes: Uint8Array): SentFrame {
  const header = peekFrame(bytes);
  if (header === null) return { type: -1, documentName: '', text: null };
  const text =
    header.type === FRAME_TYPE.stateless || header.type === FRAME_TYPE.close
      ? peekStatelessPayload(bytes, header)
      : null;
  return { type: header.type, documentName: header.documentName, text };
}

/** A socket that records. */
export function fakeSocket(): FakeSocket {
  const frames: SentFrame[] = [];
  const closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  return {
    frames,
    closes,
    readyState: WS_OPEN,
    send(data): void {
      if (typeof data === 'string' || data instanceof Blob) return;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      frames.push(decode(bytes));
    },
    close(code, reason): void {
      closes.push({ code, reason });
    },
  };
}

/** A real `Document`, as `Hocuspocus.loadDocument` would construct it. */
export function fakeDocumentOf(name: string): Document {
  return new Document(name, { gc: true }, { flushDelay: false, flushMaxBytes: 0 });
}

/** A real `Connection` on `document` — the constructor registers it — over a recording socket. */
export function fakeConnection(
  document: Document,
  context: CollabHookContext,
  options: {
    readonly readOnly?: boolean;
    readonly socketId?: string;
    readonly socket?: FakeSocket;
  } = {},
): { readonly connection: Connection<CollabHookContext>; readonly socket: FakeSocket } {
  const socket = options.socket ?? fakeSocket();
  const request = new Request('http://127.0.0.1/collab');
  const connection = new Connection<CollabHookContext>(
    socket,
    request,
    document,
    options.socketId ?? `socket-${String(Math.random()).slice(2, 8)}`,
    context,
    options.readOnly ?? false,
  );
  return { connection, socket };
}

/** The stateless payloads a socket received, in order. */
export function statelessPayloads(socket: FakeSocket): string[] {
  return socket.frames.flatMap((frame) =>
    frame.type === FRAME_TYPE.stateless && frame.text !== null ? [frame.text] : [],
  );
}

/** The `CLOSE(7)` reasons a socket received, in order. */
export function closeReasons(socket: FakeSocket): string[] {
  return socket.frames.flatMap((frame) =>
    frame.type === FRAME_TYPE.close && frame.text !== null ? [frame.text] : [],
  );
}

/** A `GatewayServer` over a plain map, with an `openDirectConnection` a test may stub. */
export function fakeGatewayServer(
  documents: Map<string, Document> = new Map(),
): GatewayServer & { readonly documents: Map<string, Document> } {
  return {
    documents,
    openDirectConnection: () =>
      Promise.reject(new Error('fake gateway server: openDirectConnection is not stubbed')),
  };
}
