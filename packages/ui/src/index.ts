/**
 * `@iridium/ui` — the whole React application plus the `IridiumHost` seam, the command registry and
 * `i18n/en.ts` (02-system-architecture.md, "Package responsibilities").
 *
 * The package is `browser`-tagged and has zero Electron and zero Node imports: the only
 * platform-specific object it ever sees is the `IridiumHost` passed to `mountIridium` at mount
 * time. This barrel is the package's `.` export; a module that is not re-exported here does not
 * exist for consumers, and the two hosts import nothing else.
 *
 * At M0 the application is an empty shell (12-milestones.md §4.3); M4 fills it in behind the same
 * entry point.
 */

export {
  commandRegistry,
  type CommandBinding,
  type CommandContext,
  type CommandRegistry,
} from './commands/registry.ts';
export { HostError } from './host.ts';
export type {
  ApiRequest,
  ApiResponse,
  ApiTransport,
  CommandId,
  Credentials,
  DeepLink,
  ExportOutcome,
  HttpMethod,
  ImportSource,
  IridiumHost,
  JsonValue,
  KeyValueStorage,
  Me,
  MenuItemState,
  MenuManifest,
  Platform,
  ServerProfile,
  SessionChangedEvent,
  TicketSource,
  TransferProgress,
  Unsubscribe,
  UpdateArtifact,
  UpdateState,
  WebSocketLike,
} from './host.ts';
export { en, type MessageKey } from './i18n/en.ts';
export { t, type MessageValues } from './i18n/t.ts';
export { mountIridium, type IridiumApp } from './mount.tsx';
