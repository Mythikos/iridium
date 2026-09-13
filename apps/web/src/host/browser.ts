/**
 * `BrowserHost` — the browser binding of the `IridiumHost` seam (07-client-applications.md §2.3,
 * §6.3, §6.4).
 *
 * The browser host is cookie-only: no bearer credential ever exists in a tab (13-decision-log.md
 * A26), and the seam carries no `secrets` member to make that structural rather than a convention.
 *
 * M0 implements every member whose behaviour is pure browser platform — the single implicit
 * profile, the attachment URL shape, the WebSocket URL derivation, the validated `openExternal`,
 * the clipboard, the title, the `localStorage` namespace and the no-op deep-link/menu/update
 * members. The members that are the `@iridium/api-client` and `@iridium/collab-client` surface
 * (`api.request`, `auth.*`, `collab.ticketSource`, `files.*`) reject with `HostError('unsupported')`
 * until M4 lands `FetchTransport` and `RestTicketSource`: a typed refusal is the honest M0 state,
 * and re-implementing those transports inside `apps/web` would put them in the wrong package.
 */
import {
  HostError,
  type ApiResponse,
  type ExportOutcome,
  type ImportSource,
  type IridiumHost,
  type KeyValueStorage,
  type Me,
  type ServerProfile,
  type SessionChangedEvent,
  type Unsubscribe,
} from '@iridium/ui';

/** The single implicit profile of the web host: the origin that served the bundle (§2.2). */
const WEB_PROFILE_ID = 'web';

/** The `localStorage` key namespace before a session exists (§2.2, §6.4). */
const ANONYMOUS_USER_ID = 'anonymous';

/** Arrives with M4, together with `@iridium/api-client`'s transports. */
function notYetImplemented(member: string): HostError {
  return new HostError(
    'unsupported',
    `BrowserHost.${member} is not wired at M0; it lands with @iridium/api-client at M4.`,
  );
}

function oneProfileOnly(): HostError {
  return new HostError('unsupported', 'The web host has one implicit profile.');
}

/**
 * `shell.openExternal` accepts `https:` and `mailto:` and nothing else — the same validation the
 * desktop applies in main (§7.4 H11). Note content is untrusted, so `javascript:`, `data:`, `file:`
 * and `http:` are refusals rather than degraded opens.
 */
export function isOpenableExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
}

/** `wss://<host>/collab`, or `ws://` when the origin is `http:` (development only, §2.2). */
export function collabUrlFor(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/collab';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * `localStorage` namespaced by origin and user id (§2.2). The user id is `anonymous` until a session
 * exists; M4 re-keys it from `session-changed` so two accounts in one browser profile never share a
 * workspace layout.
 */
function createLocalStorage(origin: string, userId: () => string): KeyValueStorage {
  const prefixed = (key: string): string => `iridium:${origin}:${userId()}:${key}`;
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

export function createBrowserHost(): IridiumHost {
  const origin = globalThis.location.origin;
  const sessionListeners = new Set<(event: SessionChangedEvent) => void>();

  const profile: ServerProfile = {
    id: WEB_PROFILE_ID,
    origin,
    displayName: globalThis.location.host,
  };

  const host: IridiumHost = {
    kind: 'web',

    server: {
      origin: (): string => origin,
      listProfiles: (): Promise<ServerProfile[]> => Promise.resolve([profile]),
      select: (): Promise<void> => Promise.reject(oneProfileOnly()),
      add: (): Promise<void> => Promise.reject(oneProfileOnly()),
      remove: (): Promise<void> => Promise.reject(oneProfileOnly()),
    },

    api: {
      request: (): Promise<ApiResponse> => Promise.reject(notYetImplemented('api.request')),
    },

    auth: {
      signIn: (): Promise<Me> => Promise.reject(notYetImplemented('auth.signIn')),
      signOut: (): Promise<void> => Promise.reject(notYetImplemented('auth.signOut')),
      me: (): Promise<Me> => Promise.reject(notYetImplemented('auth.me')),
      reauthenticate: (): Promise<void> => Promise.reject(notYetImplemented('auth.reauthenticate')),
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
          Promise.reject(notYetImplemented('collab.ticketSource.acquire')),
      },
      websocketUrl: (): string => collabUrlFor(origin),
      // `webSocketFactory` stays undefined on the web: the tab opens its own socket (§2.2).
    },

    attachments: {
      urlFor: (vaultId: string, attachmentId: string): string =>
        `/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(attachmentId)}`,
    },

    files: {
      pickImportSource: (): Promise<ImportSource | null> =>
        Promise.reject(notYetImplemented('files.pickImportSource')),
      uploadImport: (): Promise<void> => Promise.reject(notYetImplemented('files.uploadImport')),
      exportVault: (): Promise<ExportOutcome> =>
        Promise.reject(notYetImplemented('files.exportVault')),
      saveText: (): Promise<void> => Promise.reject(notYetImplemented('files.saveText')),
    },

    shell: {
      openExternal: (url: string): Promise<void> => {
        if (!isOpenableExternalUrl(url)) {
          return Promise.reject(
            new HostError('rejected', 'Only https: and mailto: URLs may be opened externally.'),
          );
        }
        globalThis.open(url, '_blank', 'noopener,noreferrer');
        return Promise.resolve();
      },
      copyText: (text: string): Promise<void> => globalThis.navigator.clipboard.writeText(text),
      setTitle: (title: string): void => {
        globalThis.document.title = title;
      },
    },

    // The router handles `https://<origin>/app/v/...` directly, so the callback never fires (§6.4).
    links: {
      onDeepLink: (): Unsubscribe => (): void => {},
    },

    // The menu is the command palette on the web (§6.4).
    commands: {
      onNativeCommand: (): Unsubscribe => (): void => {},
      publishMenu: (): void => {},
    },

    // The browser gets new code by reloading (§6.5).
    updates: null,

    storage: createLocalStorage(origin, () => ANONYMOUS_USER_ID),
  };

  return host;
}
