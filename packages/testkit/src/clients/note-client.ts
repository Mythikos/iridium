/**
 * `NoteClient` — the real-wire collaboration client
 * (10-testing-and-quality.md, "Multi-client collaboration harness").
 *
 * The plan is explicit about what it is built on and why: *"Built on `@iridium/collab-client`'s
 * `NoteSession`, so integration and chaos tests exercise the exact provider, codec and
 * `SaveStateMachine` that ship in the UI"* and *"`saveState` is the product's `SaveStateMachine`, not a
 * reimplementation, so a bug in the indicator is a test failure rather than a divergence between
 * harness and UI."* The harness therefore owns exactly two things here — the `Origin`-injecting
 * WebSocket constructor (`origin-ws.ts`) and the ticket it was issued through the real
 * `POST /api/v1/auth/collab-tickets` — and takes everything else from the product.
 *
 * At M0 `@iridium/collab-client` is still a placeholder (12-milestones.md §4.3 lists it under
 * *"Placeholders with correct tags, exports and dependency declarations"*), and its `NoteSession`
 * arrives with the M1 package row. `loadCollabClient()` is the seam: it names the missing export and
 * the milestone that adds it, so a suite written against `createNoteClient` fails with one readable
 * sentence instead of `TypeError: undefined is not a constructor` inside a provider.
 */
import * as collabClient from '@iridium/collab-client';

import type { OriginWebSocketOptions, TestWebSocketConstructor } from './origin-ws.ts';
import { createOriginWebSocket } from './origin-ws.ts';

/** Options `createNoteClient` takes. Stable across M0 → M1; only the implementation fills in. */
export interface NoteClientOptions {
  /** `ws://127.0.0.1:<port>/collab`, from `TestServer.wsUrl`. */
  readonly wsUrl: string;
  /** The document name: `note:<uuid>` (05-collaboration-and-durability.md §"Documents"). */
  readonly documentName: string;
  /** A single-use ticket from the real `POST /api/v1/auth/collab-tickets`. */
  readonly ticket: string;
  /**
   * The `Origin` header value. Defaults to the server's `PUBLIC_ORIGIN`; `null` omits the header and
   * is used only by `security.ws-origin.integration`, which asserts that the server refuses it.
   */
  readonly origin?: string | null;
  /** `provider.configuration.flushDelay` — update batching, set through options, never monkey-patched. */
  readonly flushDelayMs?: number;
  /** Mirrors `WS_MAX_PAYLOAD_BYTES` so an oversize frame is refused on both ends. */
  readonly maxPayload?: number;
  /** Extra handshake headers, for the hostile-client cases. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The WebSocket constructor a `NoteClient` hands to `@iridium/collab-client`'s injection point
 * (12-milestones.md §7.3: *"Node support through the injected `ws` (`NoteClient` in the testkit is
 * built on it)"*). Exported because `startServer` and the `vaultChannel` harness need the same one.
 */
export function noteClientWebSocket(
  options: Pick<NoteClientOptions, 'origin' | 'headers' | 'maxPayload'> & { defaultOrigin: string },
): TestWebSocketConstructor {
  const origin = options.origin === undefined ? options.defaultOrigin : options.origin;
  const wsOptions: OriginWebSocketOptions = {
    origin,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.maxPayload === undefined ? {} : { maxPayload: options.maxPayload }),
  };
  return createOriginWebSocket(wsOptions);
}

/**
 * The `@iridium/collab-client` surface the harness drives. Declared here rather than imported so the
 * seam is one named contract: when the package ships `NoteSession`, this shape is what it must satisfy
 * and the loader below stops throwing.
 */
export interface CollabClientSurface {
  /** The product's session factory, `NoteSession` in 12-milestones.md §7.3. */
  readonly NoteSession: unknown;
}

/**
 * Resolve `@iridium/collab-client`'s session surface, or throw a sentence that names the missing
 * export, the package that owns it and the milestone that adds it.
 *
 * The module namespace is inspected at runtime rather than asserted into a shape, so the check is a
 * real check: when `NoteSession` appears, this function starts succeeding with no type change here.
 */
export function loadCollabClient(): CollabClientSurface {
  const module: unknown = collabClient;
  const surface: Record<string, unknown> =
    typeof module === 'object' && module !== null ? { ...module } : {};
  if (surface['NoteSession'] === undefined) {
    throw new Error(
      '@iridium/testkit: @iridium/collab-client exports no NoteSession. ' +
        'NoteClient is built on the product session so that the harness and the UI cannot diverge ' +
        '(10-testing-and-quality.md, "Multi-client collaboration harness"); the session arrives with ' +
        'the @iridium/collab-client row of 12-milestones.md §7.3 (M1). Until then use ' +
        'createOriginWebSocket() for raw-socket assertions.',
    );
  }
  return { NoteSession: surface['NoteSession'] };
}

/*
 * `createNoteClient(options): Promise<NoteClient>` is deliberately **not** exported at M0.
 *
 * Every member of the plan's `NoteClient` interface — `ydoc`, `text`, `undo`, `saveState`, `states`,
 * `stateless`, `closes`, `typeAt`, `waitFor`, `waitForAck`, `waitForStateless`, `waitSynced`,
 * `waitClosed`, `sv`, `disconnectSocket`, `reconnectSocket`, `sendRaw`, `sendStateless`,
 * `setAwareness` — is a view onto the product's `NoteSession`, `HocuspocusProvider` and
 * `SaveStateMachine`. Exporting a factory that throws, or an interface whose Yjs-typed members are
 * `unknown`, would let a suite be written against a shape the product has not agreed to, and the
 * plan's whole reason for building the harness on the product session is that the two cannot diverge.
 * The factory and the interface land together with `@iridium/collab-client`'s `NoteSession`
 * (12-milestones.md §7.3), against `loadCollabClient()` and `noteClientWebSocket()` above.
 */
