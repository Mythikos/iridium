/**
 * Step 6 of `pnpm gen`: the desktop IPC typings,
 * `packages/contracts/src/generated/desktop-ipc.d.ts`
 * (12-milestones.md §4.3; 02-system-architecture.md, the `pnpm gen` artefact table; 09-api-reference.md
 * §5).
 *
 * These are the `window.iridium` typings. `desktop.preload-surface.guard` asserts from M5 that the
 * preload exposes exactly this surface, and `contracts.desktop-ipc.unit` asserts that the union of
 * channels here equals the union `apps/desktop/src/main/ipc/index.ts` registers.
 *
 * **At M0 exactly one channel exists: `iridium:app:info`** (09-api-reference.md §5.7). The typings are
 * *derived*, not restated: the channel list is read from the `ipcMain.handle` registrations in
 * `apps/desktop/src/main/ipc.ts` and the `AppInfo` shape from `apps/desktop/src/shared/bridge.ts`, so
 * the generated file cannot drift from the shell that ships. From M5 the source moves to
 * `packages/contracts/src/desktop-ipc.ts` — one zod schema per channel — and this step reads that
 * instead; `bridge.ts` stops being hand-written in the same commit.
 *
 * **Two conventions of §5.1 are enforced here rather than reviewed.** A request/response channel is
 * `iridium:<domain>:<verb>`; an event channel is `iridium:event:<name>`. A channel that matches
 * neither fails this step, because the preload's wrapper names are derived mechanically from the
 * channel name and a malformed name would silently produce a malformed surface.
 *
 * **The `AppInfo` member set is checked against 09-api-reference.md §5.7.** That list is carried below
 * as data with its citation, so a field added to the shell without being added to the reference — or
 * the reverse — fails the pipeline instead of shipping an undocumented member of the one surface the
 * About panel and the compatibility gate both read.
 */
import { readFileSync } from 'node:fs';

import { ARTEFACTS, SOURCES } from './lib/paths.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { generatedBanner, repoRelative, writeOrCompare } from './lib/write.ts';

/**
 * `AppInfo`'s members, exactly as 09-api-reference.md §5.7 declares them, in that order.
 *
 * The reference is the normative contract for every channel (bridge.ts's own header says so), so this
 * is the list the shell is checked against — not the other way round.
 */
const APP_INFO_MEMBERS: readonly string[] = [
  'appVersion',
  'electronVersion',
  'chromeVersion',
  'nodeVersion',
  'platform',
  'arch',
  'packaged',
  'bridgePath',
  'updatesEnabled',
  'secureStorage',
];

/** `iridium:<domain>:<verb>` — a request/response channel (`ipcRenderer.invoke`/`ipcMain.handle`). */
const INVOKE_CHANNEL = /^iridium:(?!event:)([a-z][a-zA-Z0-9]*):([a-z][a-zA-Z0-9]*)$/;
/** `iridium:event:<name>` — a main → renderer push. */
const EVENT_CHANNEL = /^iridium:event:[a-z][a-z0-9-]*$/;

/** A channel the shell registers, with the wrapper path its preload exposes. */
interface Channel {
  readonly name: string;
  readonly domain: string;
  readonly verb: string;
}

/**
 * Read the registered channels out of the main process's IPC registry.
 *
 * Registrations are `handle(<CONSTANT>, …)` over `export const <CONSTANT> = 'iridium:…'`, which is the
 * one registration form `ipc.origin.guard` permits, so matching that form is matching the guard's own
 * invariant rather than a convention this script invented.
 */
function readRegisteredChannels(): Channel[] {
  const source = readFileSync(SOURCES.desktopIpcRegistry, 'utf8');
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/export const (\w+_CHANNEL)\s*=\s*'([^']+)'/g)) {
    const [, identifier, value] = match;
    if (identifier !== undefined && value !== undefined) constants.set(identifier, value);
  }
  const registered: string[] = [];
  for (const match of source.matchAll(/\bhandle\(\s*([A-Z][A-Z0-9_]*)\s*,/g)) {
    const identifier = match[1];
    if (identifier === undefined) continue;
    const value = constants.get(identifier);
    if (value === undefined) {
      throw new Error(
        `${repoRelative(SOURCES.desktopIpcRegistry)} registers ${identifier}, which is declared ` +
          'nowhere in that file as an exported channel constant.',
      );
    }
    registered.push(value);
  }
  if (registered.length === 0) {
    throw new Error(
      `${repoRelative(SOURCES.desktopIpcRegistry)} registers no channel. The generated typings ` +
        'are derived from the registrations, so an empty registry is a parse failure, not an empty ' +
        'surface.',
    );
  }

  return [...new Set(registered)]
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => {
      if (EVENT_CHANNEL.test(name)) {
        throw new Error(
          `${name} is an event channel (\`iridium:event:<name>\`) and cannot be registered with ` +
            '`ipcMain.handle` (09-api-reference.md §5.1).',
        );
      }
      const parts = INVOKE_CHANNEL.exec(name);
      if (parts === null) {
        throw new Error(
          `${name} is not \`iridium:<domain>:<verb>\` (09-api-reference.md §5.1, "Channel names").`,
        );
      }
      return { name, domain: parts[1] ?? '', verb: parts[2] ?? '' };
    });
}

/** Read one interface body out of a TypeScript source file, as `name: type` pairs in order. */
function readInterface(file: string, interfaceName: string): { name: string; type: string }[] {
  const source = readFileSync(file, 'utf8');
  const body = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`).exec(
    source,
  )?.[1];
  if (body === undefined) {
    throw new Error(`${repoRelative(file)} declares no \`export interface ${interfaceName}\`.`);
  }
  const members: { name: string; type: string }[] = [];
  for (const line of body.split('\n')) {
    const member = /^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:\s*(.+?);\s*$/.exec(line);
    if (member?.[1] !== undefined && member[2] !== undefined) {
      members.push({ name: member[1], type: member[2] });
    }
  }
  if (members.length === 0) {
    throw new Error(`${repoRelative(file)}: \`${interfaceName}\` parsed to zero members.`);
  }
  return members;
}

function assertAppInfoMatchesReference(members: readonly { name: string }[]): void {
  const found = members.map((member) => member.name);
  const expected = [...APP_INFO_MEMBERS];
  const missing = expected.filter((name) => !found.includes(name));
  const extra = found.filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `AppInfo in ${repoRelative(SOURCES.desktopBridge)} does not match 09-api-reference.md §5.7.\n` +
        (missing.length > 0 ? `  missing from the shell: ${missing.join(', ')}\n` : '') +
        (extra.length > 0 ? `  not in the reference: ${extra.join(', ')}\n` : '') +
        '  Change both, in one commit: the reference is normative, and `contracts.desktop-ipc.unit` ' +
        'asserts the same equality from M5.',
    );
  }
}

/** Build the nested `window.iridium` surface from the flat channel list. */
function bridgeInterface(
  channels: readonly Channel[],
  responseType: (c: Channel) => string,
): string {
  const byDomain = new Map<string, Channel[]>();
  for (const channel of channels) {
    const existing = byDomain.get(channel.domain) ?? [];
    existing.push(channel);
    byDomain.set(channel.domain, existing);
  }
  const domains = [...byDomain.entries()].map(([domain, members]) => {
    const methods = members.map(
      (channel) =>
        `    /** \`${channel.name}\` */\n    ${channel.verb}(): Promise<${responseType(channel)}>;`,
    );
    return `  readonly ${domain}: {\n${methods.join('\n')}\n  };`;
  });
  return `export interface IridiumBridge {\n${domains.join('\n')}\n}`;
}

/** The response type name for a channel. At M0 the one channel answers `AppInfo`. */
const RESPONSE_TYPES: Readonly<Record<string, string>> = {
  'iridium:app:info': 'AppInfo',
};

function responseTypeFor(channel: Channel): string {
  const type = RESPONSE_TYPES[channel.name];
  if (type === undefined) {
    throw new Error(
      `No response type is recorded for ${channel.name}. Add it to RESPONSE_TYPES in ` +
        'scripts/generate-desktop-ipc.ts, or move the source to ' +
        '`packages/contracts/src/desktop-ipc.ts` (M5), which carries one zod schema per channel.',
    );
  }
  return type;
}

export function renderDesktopIpcTypings(): { text: string; channels: readonly Channel[] } {
  const channels = readRegisteredChannels();
  const appInfo = readInterface(SOURCES.desktopBridge, 'AppInfo');
  assertAppInfoMatchesReference(appInfo);

  const appInfoMembers = appInfo
    .map((member) => `  readonly ${member.name}: ${member.type.replace(/^readonly\s+/, '')};`)
    .join('\n');

  const channelEntries = channels
    .map(
      (channel) =>
        `  readonly '${channel.name}': {\n` +
        `    readonly request: EmptyRequest;\n` +
        `    readonly response: ${responseTypeFor(channel)};\n` +
        `  };`,
    )
    .join('\n');

  const text = [
    generatedBanner(
      'scripts/generate-desktop-ipc.ts',
      'the `ipcMain.handle` registrations in apps/desktop/src/main/ipc.ts and the `AppInfo` ' +
        'interface in apps/desktop/src/shared/bridge.ts, checked against 09-api-reference.md §5',
    ),
    '',
    '/**',
    ' * `iridium:app:info` (09-api-reference.md §5.7). Drives the About panel and the compatibility',
    ' * gate.',
    ' */',
    'export interface AppInfo {',
    appInfoMembers,
    '}',
    '',
    '/** The request payload of a channel that takes no arguments (`parseEmptyPayload`). */',
    'export type EmptyRequest = Record<string, never>;',
    '',
    '/**',
    ' * Every request/response channel, with its request and response types.',
    ' *',
    ' * `contracts.desktop-ipc.unit` asserts from M5 that this key set equals the set',
    ' * `apps/desktop/src/main/ipc/index.ts` registers with `ipcMain.handle`.',
    ' */',
    'export interface IridiumIpcInvokeChannels {',
    channelEntries,
    '}',
    '',
    '/** Main → renderer pushes, `iridium:event:<name>` (09-api-reference.md §5.8). None at M0. */',
    'export type IridiumIpcEventChannels = Record<never, never>;',
    '',
    '/** Every channel name the renderer may reach, as a closed union. */',
    'export type IridiumIpcInvokeChannel = keyof IridiumIpcInvokeChannels;',
    '',
    '/** Every event name the renderer may subscribe to, as a closed union. */',
    'export type IridiumIpcEventChannel = keyof IridiumIpcEventChannels;',
    '',
    '/**',
    ' * The whole surface the renderer sees on `window.iridium`.',
    ' *',
    ' * Fixed wrappers only: no `ipcRenderer` pass-through and no channel parameter reaching `invoke`',
    ' * (07-client-applications.md, hardening row H15), which is why this is a nested object of',
    ' * zero-argument functions rather than a generic `invoke`.',
    ' */',
    bridgeInterface(channels, responseTypeFor),
    '',
  ].join('\n');

  return { text, channels };
}

export const step: Step = {
  name: 'desktop ipc typings',
  produces: 'packages/contracts/src/generated/desktop-ipc.d.ts',
  run(context: StepContext): Promise<StepResult> {
    const { text, channels } = renderDesktopIpcTypings();
    const outcome = writeOrCompare(ARTEFACTS.desktopIpc, text, context.check);
    return Promise.resolve({
      summary: `${String(channels.length)} channel(s), ${String(outcome.bytes)} bytes`,
      writes: [outcome],
      details: channels.map((channel) => channel.name),
    });
  },
};

if (import.meta.main) await runAsMain(step);
