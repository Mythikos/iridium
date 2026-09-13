/**
 * `HocuspocusProvider` 4.7.0 over the testkit's `Origin`-injecting `ws` subclass — the shape the
 * M1 `NoteClient` takes (12-milestones.md §4.3; `packages/testkit/src/clients/note-client.ts`).
 *
 * `@hocuspocus/provider` is a dependency of `@iridium/collab-client`, not of `apps/server`, so a bare
 * specifier does not resolve from here. The module is loaded from the workspace copy by path — its
 * ESM build, so that it shares the single `yjs` instance with `@hocuspocus/server` and
 * `@iridium/crdt` (A14; a CJS build would load a second copy). The surface used is declared below
 * rather than typed from the package, for the same reason the testkit declares `TestWebSocket`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createNoteDoc } from '@iridium/crdt';
import { createDeferred, createOriginWebSocket, REPO_ROOT, waitFor } from '@iridium/testkit';

export type NoteDoc = ReturnType<typeof createNoteDoc>;

export interface CloseEventLike {
  readonly code: number;
  readonly reason: string;
}

export interface WebsocketProviderLike {
  readonly status: string;
  readonly webSocket: { readonly readyState: number } | null;
  connect(): Promise<void>;
  disconnect(): void;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface ProviderLike {
  readonly document: NoteDoc;
  readonly synced: boolean;
  readonly isAuthenticated: boolean;
  readonly unsyncedChanges: number;
  readonly configuration: { readonly websocketProvider: WebsocketProviderLike };
  attach(): void;
  detach(): void;
  destroy(): void;
  sendStateless(payload: string): void;
  setAwarenessField(key: string, value: unknown): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface ProviderModule {
  readonly HocuspocusProvider: new (configuration: Record<string, unknown>) => ProviderLike;
  readonly HocuspocusProviderWebsocket: new (
    configuration: Record<string, unknown>,
  ) => WebsocketProviderLike;
}

const PROVIDER_ENTRY = join(
  REPO_ROOT,
  'packages',
  'collab-client',
  'node_modules',
  '@hocuspocus',
  'provider',
  'dist',
  'hocuspocus-provider.esm.js',
);

let loaded: Promise<ProviderModule> | undefined;

function isProviderModule(value: unknown): value is ProviderModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'HocuspocusProvider' in value &&
    typeof value.HocuspocusProvider === 'function' &&
    'HocuspocusProviderWebsocket' in value &&
    typeof value.HocuspocusProviderWebsocket === 'function'
  );
}

export function loadProviderModule(): Promise<ProviderModule> {
  loaded ??= (async () => {
    const module: unknown = await import(pathToFileURL(PROVIDER_ENTRY).href);
    if (!isProviderModule(module)) {
      throw new Error(
        `${PROVIDER_ENTRY} does not export HocuspocusProvider and HocuspocusProviderWebsocket`,
      );
    }
    return module;
  })();
  return loaded;
}

export interface SpikeClientOptions {
  readonly wsUrl: string;
  readonly name: string;
  /** `null` omits the header — the case the server must refuse. */
  readonly origin: string | null;
  readonly token?: string;
  readonly document?: NoteDoc;
  /** Share one socket between two providers (a note and a vault channel on one connection). */
  readonly websocketProvider?: WebsocketProviderLike;
}

export interface SpikeClient {
  readonly provider: ProviderLike;
  readonly doc: NoteDoc;
  /** Every `onClose` the provider reported, in order (document-level CLOSE frames and socket closes). */
  readonly closes: CloseEventLike[];
  readonly statuses: string[];
  readonly authFailures: string[];
  readonly stateless: string[];
  waitSynced(timeoutMs?: number): Promise<void>;
  waitClose(
    predicate: (event: CloseEventLike) => boolean,
    timeoutMs?: number,
  ): Promise<CloseEventLike>;
  destroy(): void;
}

export async function createSpikeClient(options: SpikeClientOptions): Promise<SpikeClient> {
  const { HocuspocusProvider } = await loadProviderModule();
  const doc = options.document ?? createNoteDoc();
  const closes: CloseEventLike[] = [];
  const statuses: string[] = [];
  const authFailures: string[] = [];
  const stateless: string[] = [];
  const synced = createDeferred<void>();

  const configuration: Record<string, unknown> = {
    url: options.wsUrl,
    name: options.name,
    document: doc,
    token: options.token ?? 'spike-ticket',
    WebSocketPolyfill: createOriginWebSocket({ origin: options.origin }),
    onSynced: ({ state }: { state: boolean }) => {
      if (state) synced.resolve();
    },
    onClose: ({ event }: { event: CloseEventLike }) => {
      closes.push({ code: event.code, reason: event.reason });
    },
    onStatus: ({ status }: { status: string }) => {
      statuses.push(status);
    },
    onAuthenticationFailed: ({ reason }: { reason: string }) => {
      authFailures.push(reason);
    },
    onStateless: ({ payload }: { payload: string }) => {
      stateless.push(payload);
    },
  };
  if (options.websocketProvider !== undefined) {
    configuration['websocketProvider'] = options.websocketProvider;
  }
  const provider = new HocuspocusProvider(configuration);
  if (options.websocketProvider !== undefined) provider.attach();

  return {
    provider,
    doc,
    closes,
    statuses,
    authFailures,
    stateless,
    async waitSynced(timeoutMs = 10_000): Promise<void> {
      if (provider.synced) return;
      await waitFor(() => provider.synced, { timeoutMs, intervalMs: 5 });
    },
    async waitClose(predicate, timeoutMs = 10_000): Promise<CloseEventLike> {
      await waitFor(() => closes.some(predicate), { timeoutMs, intervalMs: 5 });
      const found = closes.find(predicate);
      if (found === undefined) throw new Error('close event vanished');
      return found;
    },
    destroy(): void {
      provider.destroy();
    },
  };
}
