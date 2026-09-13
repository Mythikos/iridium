/**
 * `packages/ui/src/host.ts` — the single platform seam.
 *
 * `IridiumHost` is reproduced here exactly as 02-system-architecture.md, "The `IridiumHost` seam"
 * gives it (07-client-applications.md §2.2 repeats the same block). The application receives one
 * `IridiumHost` at mount time and never branches on `kind` outside the host implementations and the
 * feature flags derived from it (`updates !== null`, `collab.webSocketFactory !== undefined`).
 *
 * The supporting types below are declared in this module on purpose (07-client-applications.md §3.6
 * lists `host.ts` as the home of `KeyValueStorage`, `ServerProfile`, `ImportSource`,
 * `ExportOutcome`, `UpdateState` and `MenuManifest`). At M0 the wire packages that will own the DTO
 * half — `@iridium/contracts` (`Me`, `ServerProfile`, `DeepLink`, `UpdateState`, `CommandId`,
 * `MenuManifest`) and `@iridium/api-client` (`ApiTransport`, `TicketSource`) — are still
 * placeholders, so the shapes are written here from 09-api-reference.md §2.3 and §5 and are
 * replaced by imports at M4/M5 without changing this file's public names.
 *
 * The renderer host has no `secrets` member and never will (13-decision-log.md A26).
 */

/** Cancels a subscription created by an `on*` member. Calling it twice is a no-op. */
export type Unsubscribe = () => void;

/** Any JSON body that crosses `ApiTransport` (values only — no `undefined`, no cycles). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/** The operating systems the desktop client is built for (09-api-reference.md §2.16 `Platform`). */
export type Platform = 'win32' | 'darwin' | 'linux';

export interface ApiRequest {
  readonly method: HttpMethod;
  readonly path: `/api/v1/${string}`;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue | FormData;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue | string | null;
}

/**
 * The one method every transport implements (07-client-applications.md §3.4, D07-02): plain JSON
 * in, `{status, headers, body}` out, because `contextBridge` copies values and cannot pass
 * `Request`/`Response`, streams or `AbortSignal`.
 */
export interface ApiTransport {
  request(req: ApiRequest): Promise<ApiResponse>;
}

/** Per-profile, per-user UI preferences. `localStorage` in both hosts (D07-06). */
export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** 09-api-reference.md §5.2. `id` is `'web'` for the browser host's single implicit profile. */
export interface ServerProfile {
  readonly id: string;
  readonly origin: string;
  readonly displayName: string;
  readonly pinnedCertSha256?: string | null;
  readonly lastUsedAt?: string | null;
  readonly userEmail?: string | null;
}

/** What `auth.signIn` takes. The password never leaves the sign-in call in either host. */
export interface Credentials {
  readonly email: string;
  readonly password: string;
  readonly deviceName?: string;
}

/**
 * The signed-in principal as `GET /auth/me` reports it (09-api-reference.md §2.3). Narrowed to the
 * members the shell needs at M0; `@iridium/contracts` owns the full schema from M1.
 */
export interface Me {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
  };
  readonly isServerAdmin: boolean;
  readonly principalKind: 'user' | 'token';
}

/** The payload of `iridium:event:session-changed` (09-api-reference.md §5.8). */
export interface SessionChangedEvent {
  readonly state: 'signed-in' | 'signed-out' | 'expired';
  readonly me: Me | null;
  readonly origin: string;
}

/** Collaboration tickets, batched by `@iridium/collab-client` and host-agnostic (A24). */
export interface TicketSource {
  acquire(count: number): Promise<string[]>;
}

/**
 * The subset of `WebSocket` `@iridium/collab-client` needs, so the Electron `IpcWebSocket` fallback
 * (07-client-applications.md §7.10) can stand in for the platform class.
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: ArrayBufferLike | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** 09-api-reference.md §5.6. Carries an opaque `sourceId` — never a filesystem path. */
export type ImportSource =
  | {
      readonly kind: 'directory';
      readonly sourceId: string;
      readonly name: string;
      readonly files: number;
      readonly bytes: number;
    }
  | {
      readonly kind: 'zip';
      readonly sourceId: string;
      readonly name: string;
      readonly bytes: number;
    };

/** `iridium:event:transfer-progress` (09-api-reference.md §5.8). */
export interface TransferProgress {
  readonly jobId: string;
  readonly direction: 'upload' | 'download';
  readonly bytesDone: number;
  readonly bytesTotal: number | null;
  readonly filesDone: number | null;
  readonly filesTotal: number | null;
  readonly done: boolean;
  readonly error: string | null;
}

/** One outcome type for both hosts; the browser owns the path, so it reports `null` (§6.4). */
export interface ExportOutcome {
  readonly saved: boolean;
  readonly path: string | null;
  readonly bytes: number | null;
  readonly cancelled: boolean;
}

/** `iridium://open?server=&note=&rev=` after main's zod parse (09-api-reference.md §5.8). */
export interface DeepLink {
  readonly kind: 'open';
  readonly origin: string | null;
  readonly noteId: string | null;
  readonly rev: number | null;
}

/**
 * An id from the static command manifest. At M4 this narrows to the `CommandId` union of
 * `@iridium/contracts/commands.ts`; the registry, the palette, the CodeMirror keymaps and the
 * native menu all key on it (07-client-applications.md §3.5).
 */
export type CommandId = string;

/** Runtime state only — labels and accelerators stay in main's copy of the manifest (D07-05). */
export interface MenuItemState {
  readonly commandId: CommandId;
  readonly enabled: boolean;
  readonly checked?: boolean;
  readonly visible?: boolean;
}

export type MenuManifest = readonly MenuItemState[];

export interface UpdateArtifact {
  readonly platform: Platform;
  readonly arch: 'x64' | 'arm64';
  readonly name: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Exactly the five members of the 1.0 union (09-api-reference.md §5.7, D07-44). The post-1.0
 * desktop distribution epic adds `available`, `downloading`, `downloaded` and `installing`; nothing
 * is ever removed, which is what keeps that epic additive.
 */
export type UpdateState =
  | { readonly status: 'disabled'; readonly reason: 'policy' | 'insecure-server' | 'unpackaged' }
  | { readonly status: 'idle'; readonly currentVersion: string; readonly checkedAt: string | null }
  | { readonly status: 'checking' }
  | {
      readonly status: 'manual-download';
      readonly version: string;
      readonly notes: string | null;
      readonly mandatory: boolean;
      readonly artifacts: readonly UpdateArtifact[];
    }
  | { readonly status: 'error'; readonly message: string; readonly retryInMs: number };

export interface IridiumHost {
  kind: 'web' | 'electron';
  server: {
    origin(): string;
    listProfiles(): Promise<ServerProfile[]>;
    select(id: string): Promise<void>;
    add(p: ServerProfile): Promise<void>;
    remove(id: string): Promise<void>;
  };
  /** `FetchTransport` | `IpcTransport` */
  api: ApiTransport;
  auth: {
    signIn(c: Credentials): Promise<Me>;
    signOut(): Promise<void>;
    me(): Promise<Me>;
    reauthenticate(password: string): Promise<void>;
    onSessionChanged(cb: (event: SessionChangedEvent) => void): Unsubscribe;
  };
  collab: {
    ticketSource: TicketSource;
    websocketUrl(): string;
    /** factory only in the Electron IPC fallback */
    webSocketFactory?: () => WebSocketLike;
  };
  attachments: { urlFor(vaultId: string, attachmentId: string): string };
  files: {
    pickImportSource(mode?: 'directory' | 'zip'): Promise<ImportSource | null>;
    uploadImport(
      jobId: string,
      source: ImportSource,
      onProgress: (progress: TransferProgress) => void,
    ): Promise<void>;
    exportVault(vaultId: string, jobId: string): Promise<ExportOutcome>;
    saveText(name: string, text: string): Promise<void>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
    copyText(t: string): Promise<void>;
    setTitle(t: string): void;
  };
  links: { onDeepLink(cb: (l: DeepLink) => void): Unsubscribe };
  commands: {
    onNativeCommand(cb: (id: CommandId) => void): Unsubscribe;
    publishMenu(m: MenuManifest): void;
  };
  /** at 1.0 `install()` is registered and always rejects with `updates_manual_only` */
  updates: {
    check(): Promise<UpdateState>;
    onState(cb: (state: UpdateState) => void): Unsubscribe;
    install(): Promise<void>;
  } | null;
  /** per-profile UI prefs; `localStorage` in both hosts (D07-06), never a userData JSON file */
  storage: KeyValueStorage;
}

/**
 * The error every host raises for a member the environment cannot support — `server.select` on the
 * web, for instance (07-client-applications.md §2.2).
 */
export class HostError extends Error {
  readonly code: 'unsupported' | 'rejected';

  constructor(code: 'unsupported' | 'rejected', message?: string) {
    super(message ?? code);
    this.name = 'HostError';
    this.code = code;
  }
}
