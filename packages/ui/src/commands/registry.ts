/**
 * The command registry (07-client-applications.md §3.5).
 *
 * `@iridium/contracts/commands.ts` holds the pure data manifest — the `CommandId` union, the i18n
 * title key, `defaultKeys`, scope and menu placement. This module binds each id to behaviour, and
 * the same manifest then drives the command palette, the CodeMirror keymaps, the Electron
 * application menu and the E2E selectors.
 *
 * M0 defines the registry type and registers no commands: every surface that would invoke one
 * arrives with M4.
 */
import type { CommandId, IridiumHost } from '../host.ts';

/** What a command receives when it runs. M4 widens this with the router and the stores. */
export interface CommandContext {
  readonly host: IridiumHost;
}

/**
 * `when()` takes no argument on purpose: availability is read from the stores the registry closes
 * over, so the palette can evaluate it without building a context.
 */
export interface CommandBinding {
  when(): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

/**
 * Once `CommandId` narrows to the manifest's union (M4), `satisfies CommandRegistry` makes a
 * manifest entry without a binding a compile error — which is what keeps the palette, the keymaps
 * and the native menu from offering a command that does nothing.
 */
export type CommandRegistry = Readonly<Record<CommandId, CommandBinding>>;

export const commandRegistry: CommandRegistry = Object.freeze({});
