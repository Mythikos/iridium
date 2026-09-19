/**
 * `cli.args.unit` — the flag parser and `argv_shape`.
 *
 * The parser is what makes exit `2` mean "nothing was started": every refusal here happens before a
 * command has opened a connection, and every one of them names the accepted flags. The cases are the
 * mistakes an operator actually makes at a terminal — a typo'd flag, a flag whose value went missing,
 * a flag given twice — plus the two spellings a value may arrive in.
 *
 * `argvShape` is tested against the rule OPS-19 states rather than against a format: *the command path
 * with all values elided*. So the assertions are "no value survives" and "every flag name survives",
 * which is what an auditor reading the row is promised.
 */
import { describe, expect, it } from 'vitest';

import { argvShape, parseArgs, type FlagSpec } from './args.ts';

const CREATE_USER: FlagSpec = {
  email: 'value',
  'display-name': 'value',
  'server-admin': 'switch',
  actor: 'value',
};

/** The parsed args, or a failure the test can read as a message. */
function parse(argv: readonly string[], spec: FlagSpec = CREATE_USER) {
  return parseArgs(argv, spec);
}

describe('cli.args.unit [area:ops]', () => {
  describe('the two value spellings and the switch', () => {
    it('reads `--flag value`, `--flag=value` and a bare switch', () => {
      const result = parse([
        '--email',
        'ops@example.test',
        '--display-name=Ops Team',
        '--server-admin',
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.args.value('email')).toBe('ops@example.test');
      expect(result.args.value('display-name')).toBe('Ops Team');
      expect(result.args.has('server-admin')).toBe(true);
      expect(result.args.positionals).toEqual([]);
    });

    it('keeps a value that looks like a sentence, and one that contains an equals sign', () => {
      const result = parse(['--display-name=a=b', '--email', 'a+tag@example.test']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.args.value('display-name')).toBe('a=b');
      expect(result.args.value('email')).toBe('a+tag@example.test');
    });

    it('collects the words that carry no flag as positionals, in order', () => {
      const result = parse(['0034_grants'], {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.args.positionals).toEqual(['0034_grants']);
    });
  });

  describe('every refusal names the remedy', () => {
    it('refuses an unknown flag and lists the accepted ones', () => {
      const result = parse(['--emial', 'ops@example.test']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('--emial');
      expect(result.message).toContain('--email <value>');
      expect(result.message).toContain('--server-admin');
    });

    it('says so when a command takes no flags at all', () => {
      const result = parse(['--json'], {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('this command takes no flags');
    });

    it('refuses a value flag whose value is missing, rather than eating the next flag', () => {
      const result = parse(['--email', '--server-admin']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('--email needs a value');
    });

    it('refuses a value flag at the end of the line', () => {
      const result = parse(['--server-admin', '--email']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('--email needs a value');
    });

    it('refuses a switch given a value', () => {
      const result = parse(['--server-admin=true']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('--server-admin takes no value');
    });

    it('refuses a repeated flag rather than choosing one of the two values', () => {
      const result = parse(['--email', 'one@example.test', '--email', 'two@example.test']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('--email was given more than once');
    });

    it('refuses a repeated switch too, for the same reason', () => {
      const result = parse(['--server-admin', '--server-admin']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('given more than once');
    });
  });

  describe('argv_shape elides every value (OPS-19)', () => {
    it('keeps the command path and the flag names, and nothing else', () => {
      const rest = ['--email', 'ops@example.test', '--display-name=Ops Team', '--server-admin'];
      const shape = argvShape(['admin', 'create-user'], rest, CREATE_USER);
      expect(shape).toBe('admin create-user --email <value> --display-name <value> --server-admin');
      expect(shape).not.toContain('ops@example.test');
      expect(shape).not.toContain('Ops Team');
    });

    it('elides a positional argument, such as a migration name or a note id', () => {
      expect(argvShape(['migrate', 'to'], ['0034_grants'], {})).toBe('migrate to <value>');
      expect(
        argvShape(['doctor'], ['--repair-content', '018f2b1e-0000-7000-8000-0000000000aa'], {
          'repair-content': 'value',
        }),
      ).toBe('doctor --repair-content <value>');
    });

    it('elides the value of a flag the command does not declare, rather than printing it', () => {
      // An unknown flag never reaches a command — the parser refused it first — but the shape is
      // built from the same argv, so a value that follows one must not survive into an audit row.
      const shape = argvShape(['sessions', 'revoke-all'], ['--user', 'someone@example.test'], {
        user: 'value',
      });
      expect(shape).not.toContain('someone@example.test');
    });

    it('is the bare path when a command carries no arguments', () => {
      expect(argvShape(['version'], [], {})).toBe('version');
    });
  });
});
