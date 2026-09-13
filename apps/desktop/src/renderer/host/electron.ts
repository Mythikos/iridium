/**
 * `ElectronHost` — the desktop binding of the `IridiumHost` seam (07-client-applications.md §2.3).
 *
 * The renderer reaches the platform only through `window.iridium`, the fixed preload surface, and it
 * never holds a credential: there is no `secrets` member on the seam and no token getter on the
 * bridge (13-decision-log.md A26, hardening row H17). Everything that needs the bearer — the REST
 * proxy, attachment streaming, transfers — happens in main.
 *
 * M0 implements the members that are pure renderer platform (`storage` in the `persist:iridium`
 * partition, the attachment URL shape) and the ones that are no-ops on this host. The members whose
 * IPC channels land with M5 reject with `HostError('unsupported')`, so a caller gets a typed refusal
 * rather than an undefined property.
 */
import {
  HostError,
  type ApiResponse,
  type DeepLink,
  type ExportOutcome,
  type ImportSource,
  type IridiumHost,
  type KeyValueStorage,
  type Me,
  type ServerProfile,
  type SessionChangedEvent,
  type Unsubscribe,
} from '@iridium/ui';

import type { IridiumBridge } from '../../shared/bridge.ts';

/** The `localStorage` key namespace before a session exists (§2.2, D07-06). */
const ANONYMOUS_USER_ID = 'anonymous';

/** The origin the renderer runs at; also the `Origin` the server's allowlist contains (A24). */
const RENDERER_ORIGIN = 'app://iridium';

function arrivesAtM5(member: string): HostError {
  return new HostError(
    'unsupported',
    `ElectronHost.${member} is not wired at M0; its IPC channel lands with M5.`,
  );
}

/**
 * The renderer's own `localStorage` inside the `persist:iridium` partition, with the same key prefix
 * as the web host. There is deliberately no `storage:*` IPC channel (D07-06).
 */
function createPartitionStorage(
  profileOrigin: () => string,
  userId: () => string,
): KeyValueStorage {
  const prefixed = (key: string): string => `iridium:${profileOrigin()}:${userId()}:${key}`;
  return {
    get(key: string): Promise<string | null> {
      return Promise.resolve(globalThis.localStorage.getItem(prefixed(key)));
    },
    set(key: string, value: string): Promise<void> {
      globalThis.localStorage.setItem(prefixed(key), value);
      return Promise.resolve();
    },
    remove(key: string): Promise<void> {
      globalThis.localStorage.removeItem(prefixed(key));
      return Promise.resolve();
    },
  };
}

export function createElectronHost(bridge: IridiumBridge): IridiumHost {
  // A renderer whose preload did not run has no way to reach main, and must fail loudly rather than
  // degrade: every credential-bearing operation in this host is an IPC call.
  if (typeof bridge.app.info !== 'function') {
    throw new HostError(
      'unsupported',
      'The preload bridge is missing: window.iridium is not exposed.',
    );
  }

  const sessionListeners = new Set<(event: SessionChangedEvent) => void>();

  const host: IridiumHost = {
    kind: 'electron',

    server: {
      // Profiles live in main from M5; until then the shell has no server to talk to.
      origin: (): string => {
        throw arrivesAtM5('server.origin');
      },
      listProfiles: (): Promise<ServerProfile[]> =>
        Promise.reject(arrivesAtM5('server.listProfiles')),
      select: (): Promise<void> => Promise.reject(arrivesAtM5('server.select')),
      add: (): Promise<void> => Promise.reject(arrivesAtM5('server.add')),
      remove: (): Promise<void> => Promise.reject(arrivesAtM5('server.remove')),
    },

    api: {
      request: (): Promise<ApiResponse> => Promise.reject(arrivesAtM5('api.request')),
    },

    auth: {
      signIn: (): Promise<Me> => Promise.reject(arrivesAtM5('auth.signIn')),
      signOut: (): Promise<void> => Promise.reject(arrivesAtM5('auth.signOut')),
      me: (): Promise<Me> => Promise.reject(arrivesAtM5('auth.me')),
      reauthenticate: (): Promise<void> => Promise.reject(arrivesAtM5('auth.reauthenticate')),
      onSessionChanged: (cb: (event: SessionChangedEvent) => void): Unsubscribe => {
        sessionListeners.add(cb);
        return (): void => {
          sessionListeners.delete(cb);
        };
      },
    },

    collab: {
      ticketSource: {
        acquire: (): Promise<string[]> =>
          Promise.reject(arrivesAtM5('collab.ticketSource.acquire')),
      },
      websocketUrl: (): string => {
        throw arrivesAtM5('collab.websocketUrl');
      },
      // `webSocketFactory` is defined only when spike S3 recorded the `IpcWebSocket` fallback (§7.10).
    },

    attachments: {
      // Main fetches with the bearer and streams with the hardening headers (§7.7, D07-37).
      urlFor: (vaultId: string, attachmentId: string): string =>
        `iridium-attachment://${encodeURIComponent(vaultId)}/${encodeURIComponent(attachmentId)}`,
    },

    files: {
      pickImportSource: (): Promise<ImportSource | null> =>
        Promise.reject(arrivesAtM5('files.pickImportSource')),
      uploadImport: (): Promise<void> => Promise.reject(arrivesAtM5('files.uploadImport')),
      exportVault: (): Promise<ExportOutcome> => Promise.reject(arrivesAtM5('files.exportVault')),
      saveText: (): Promise<void> => Promise.reject(arrivesAtM5('files.saveText')),
    },

    shell: {
      openExternal: (): Promise<void> => Promise.reject(arrivesAtM5('shell.openExternal')),
      copyText: (): Promise<void> => Promise.reject(arrivesAtM5('shell.copyText')),
      // Main owns the window title (`iridium:window:setTitle`, M5); the renderer must not set it.
      setTitle: (): void => {},
    },

    links: {
      onDeepLink:
        (_cb: (l: DeepLink) => void): Unsubscribe =>
        (): void => {},
    },

    commands: {
      onNativeCommand: (): Unsubscribe => (): void => {},
      publishMenu: (): void => {},
    },

    // `null` until the update channels land; also `null` under `IRIDIUM_E2E=1` (§2.2).
    updates: null,

    storage: createPartitionStorage(
      () => RENDERER_ORIGIN,
      () => ANONYMOUS_USER_ID,
    ),
  };

  return host;
}
