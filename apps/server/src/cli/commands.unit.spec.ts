/**
 * `cli.commands.unit` — the command table's own invariants, and the usage text M0 fixed.
 *
 * The table is data that three other things read: the dispatcher, `--help`, and
 * `cli.audit-coverage.integration`, which enumerates it and fails on a mutating command nobody proved
 * writes an audit row. So the properties asserted here are the ones that would make those three
 * readers silently wrong — a mutation whose action is outside the closed vocabulary, a reserved name
 * that is also implemented, a `--help` entry for a command the table does not carry.
 *
 * The four M0 usage lines are pinned byte for byte. They are what an operator's runbook quotes and
 * what `cli.contract` will compare with the generated `docs/ops/runbooks/cli.md` from M8; moving a
 * column or rewording a summary is a change a reviewer should have to make deliberately.
 */
import { AUDIT_ACTIONS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import {
  CLI_COMMANDS,
  commandByName,
  commandPaths,
  RESERVED_COMMANDS,
  subcommandByName,
  USAGE,
} from './commands.ts';

/** Every subcommand, flattened, with the command it belongs to. */
const SUBCOMMANDS = CLI_COMMANDS.flatMap((command) =>
  command.subcommands.map((subcommand) => ({ command, subcommand })),
);

describe('cli.commands.unit [area:ops]', () => {
  describe('the table is internally consistent', () => {
    it('gives every command a unique name and every path a unique spelling', () => {
      const names = CLI_COMMANDS.map((command) => command.name);
      expect(new Set(names).size).toBe(names.length);
      const paths = commandPaths();
      expect(new Set(paths).size).toBe(paths.length);
    });

    it('resolves every command and subcommand it lists', () => {
      for (const { command, subcommand } of SUBCOMMANDS) {
        expect(commandByName(command.name)).toBe(command);
        expect(subcommandByName(command, subcommand.name)).toBe(subcommand);
      }
      expect(commandByName('no-such-command')).toBeUndefined();
    });

    it('never both implements and reserves a name', () => {
      for (const command of CLI_COMMANDS) {
        expect(RESERVED_COMMANDS).not.toContain(command.name);
        const implemented = command.subcommands.map((subcommand) => subcommand.name);
        for (const reserved of command.reserved) expect(implemented).not.toContain(reserved);
      }
    });

    it('gives a command with a bare subcommand no others, so resolution is unambiguous', () => {
      for (const command of CLI_COMMANDS) {
        const bare = command.subcommands.filter((subcommand) => subcommand.name === null);
        if (bare.length === 0) continue;
        expect(command.subcommands).toHaveLength(1);
        expect(command.defaultSubcommand).toBeNull();
      }
    });

    it('names a default subcommand only when the command has one by that name', () => {
      for (const command of CLI_COMMANDS) {
        if (command.defaultSubcommand === null) continue;
        expect(subcommandByName(command, command.defaultSubcommand)).toBeDefined();
      }
    });
  });

  describe('the audit contract', () => {
    it('declares only actions of the closed vocabulary', () => {
      for (const { subcommand } of SUBCOMMANDS) {
        for (const action of subcommand.mutations) expect(AUDIT_ACTIONS).toContain(action);
      }
    });

    it('gives every mutating subcommand the --actor flag of OPS-19, and no read-only one', () => {
      for (const { command, subcommand } of SUBCOMMANDS) {
        const where = `${command.name} ${subcommand.name ?? ''}`.trim();
        expect(
          { where, actor: 'actor' in subcommand.flags },
          `${where} declares ${String(subcommand.mutations.length)} mutation(s)`,
        ).toEqual({ where, actor: subcommand.mutations.length > 0 });
      }
    });

    it('declares at least one mutating command, so the coverage test is never vacuous', () => {
      expect(
        SUBCOMMANDS.filter(({ subcommand }) => subcommand.mutations.length > 0).length,
      ).toBeGreaterThan(0);
    });

    it('names every mutation carried through M2', () => {
      const actions = SUBCOMMANDS.flatMap(({ subcommand }) => subcommand.mutations).toSorted();
      expect(actions).toEqual([
        'admin.audit.exported',
        'admin.job.cancelled',
        'admin.job.triggered',
        'admin.job.triggered',
        'admin.job.triggered',
        'admin.job.triggered',
        'admin.user.created',
        'note.content.repaired',
        'session.revoked_all',
        'system.migration.applied',
        'system.migration.applied',
        'token.revoked_all',
      ]);
    });
  });

  describe('the usage text', () => {
    it('preserves the original commands and documents explicit long-running migration admission', () => {
      for (const line of [
        '  serve                     Run the server (the container CMD and the systemd ExecStart).',
        '  migrate status [--json]   Print applied, pending and unknown-newer migrations.',
        "  migrate up [--allow-long-running]\n                            Apply every pending migration under GET_LOCK('iridium_migrate', 60).",
        '  migrate to <name> [--allow-long-running]\n                            Migrate to a named migration; a target behind the current head is',
        '                            refused with exit 3 when NODE_ENV=production.',
        '  config check [--json]     Parse EnvSchema exactly as serve would and print the redacted summary.',
        '  version [--json]          Print the product version, commit, Node version and migration head.',
      ]) {
        expect(USAGE).toContain(line);
      }
    });

    it('keeps M0’s exit-code footer, which every wrapper script branches on', () => {
      expect(USAGE).toContain(
        'Exit codes: 0 success · 1 internal · 2 configuration or usage · 3 refused precondition\n' +
          '            4 pre-flight integrity · 5 verification · 6 diagnostic findings',
      );
    });

    it('lists every subcommand this build answers', () => {
      for (const { subcommand } of SUBCOMMANDS) expect(USAGE).toContain(subcommand.usage);
    });

    it('lists the reserved commands under the sentence that explains their exit code', () => {
      expect(USAGE).toContain('Reserved for later milestones (each exits 3 with not_implemented):');
      expect(USAGE).toContain(RESERVED_COMMANDS.join(', '));
    });
  });

  describe('the reserved command table shrank by what M2 implements', () => {
    it('no longer reserves doctor, admin, audit, tokens or sessions', () => {
      for (const implemented of [
        'doctor',
        'admin',
        'audit',
        'tokens',
        'sessions',
        'jobs',
        'trash',
        'reindex',
      ]) {
        expect(RESERVED_COMMANDS).not.toContain(implemented);
        expect(commandByName(implemented)).toBeDefined();
      }
    });

    it('still reserves the five commands no milestone before this one implements', () => {
      expect([...RESERVED_COMMANDS].toSorted()).toEqual([
        'backup',
        'desktop-updates',
        'keys',
        'mirror',
        'restore',
      ]);
    });
  });
});
