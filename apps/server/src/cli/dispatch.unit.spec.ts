import { describe, expect, it } from 'vitest';

/**
 * `cli.dispatch.unit` — argv resolution and every refusal that happens before anything connects.
 *
 * This is the suite M0's header promised and could not have: `runCli` is driven directly, with a
 * buffered `CliIo` and a literal environment, so the seven-code contract of OPS-16 is asserted rather
 * than described. Nothing here boots an application or opens a connection — every case is one the
 * dispatcher answers on its own, which is the same thing as saying every case exits `2` or `3` with
 * nothing started, or exits `0` from a pure function of the build.
 *
 * The order of refusals is the property under test. A reserved name is refused before an unknown one
 * (`iridium backup` is "not in this build", not "unknown"), the flags are parsed before the
 * environment (a typo'd flag is not reported as a configuration failure), and `version` answers
 * before the environment is read at all — which is what makes it usable inside a deployment whose
 * `EnvSchema` parse is the thing that is broken.
 */
import type { RawEnv } from '../config/env.ts';
import { runCli } from './dispatch.ts';
import { EXIT } from './exit.ts';
import { BufferedIo } from './output.ts';

/** Enough environment for `EnvSchema` to parse; nothing in this suite connects to it. */
const MINIMAL: RawEnv = Object.freeze({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'http://127.0.0.1:4000',
  DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
});

/**
 * `JSON.parse` narrowed to `unknown` in one place, so no case asserts a type out of `any` — which is
 * what `typescript/no-unsafe-type-assertion` refuses, and rightly: an assertion from `any` checks
 * nothing at all.
 */
function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Runs one command line and returns its exit code with everything it printed. */
async function run(argv: readonly string[], env: RawEnv = MINIMAL) {
  const io = new BufferedIo();
  const code = await runCli(argv, { io, env });
  return { code, stdout: io.stdout, stderr: io.stderr };
}

describe('cli.dispatch.unit [area:ops]', () => {
  describe('the usage text', () => {
    it('exits 2 with the usage text when no command is given', async () => {
      const result = await run([]);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stdout).toContain('iridium <command> [args]');
    });

    it('exits 0 for --help, -h and the word help', async () => {
      const results = await Promise.all(
        ['--help', '-h', 'help'].map((spelling) => run([spelling])),
      );
      expect(results.map((result) => result.code)).toEqual([
        EXIT.success,
        EXIT.success,
        EXIT.success,
      ]);
      for (const result of results) {
        expect(result.stdout).toContain('Commands available in this build:');
      }
    });

    it('answers --help after a command word too', async () => {
      const result = await run(['admin', '--help']);
      expect(result.code).toBe(EXIT.success);
      expect(result.stdout).toContain('Commands available in this build:');
    });

    it('does not read `help` as a flag value', async () => {
      // `--display-name help` is a display name. Treating the word as a help request anywhere in the
      // line would make it impossible to create a user called "help", and would do it silently.
      const result = await run(['admin', 'create-user', '--display-name', 'help', '--email']);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('--email needs a value');
    });
  });

  describe('reserved names are refused, unknown ones are usage errors', () => {
    it('exits 3 with not_implemented for a reserved command', async () => {
      const reserved = ['backup', 'restore', 'keys', 'mirror'];
      const results = await Promise.all(reserved.map((name) => run([name])));
      expect(results.map((result) => result.code)).toEqual(reserved.map(() => EXIT.refused));
      for (const result of results) {
        expect(result.stderr).toContain('not_implemented in this build');
      }
    });

    it('exits 3 with not_implemented for a reserved subcommand', async () => {
      const result = await run(['admin', 'reset-password', '--email', 'a@example.test']);
      expect(result.code).toBe(EXIT.refused);
      expect(result.stderr).toContain('iridium admin reset-password: not_implemented');
    });

    it('exits 2 and prints the usage text for an unknown command', async () => {
      const result = await run(['frobnicate']);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('unknown command "frobnicate"');
      expect(result.stderr).toContain('iridium <command> [args]');
    });

    it('exits 2 naming the answerable subcommands for an unknown one', async () => {
      const result = await run(['audit', 'frobnicate']);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('unknown subcommand "frobnicate"');
      expect(result.stderr).toContain('verify-chain');
    });

    it('exits 2 when a command needs a subcommand and none was given', async () => {
      const result = await run(['admin']);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('expected a subcommand (create-user)');
    });
  });

  describe('flags are parsed before the environment', () => {
    it('reports a typo’d flag as a usage error, not as a configuration failure', async () => {
      const result = await run(['audit', 'verify-chain', '--chian', 'server'], {});
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('unknown flag "--chian"');
      expect(result.stderr).not.toContain('configuration error');
    });

    it('refuses a stray word rather than dropping it', async () => {
      const result = await run(['sessions', 'revoke-all', 'everyone']);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('unexpected argument "everyone"');
      expect(result.stderr).toContain('no positional arguments');
    });

    it('says where a subcommand written after the flags belongs', async () => {
      // `migrate --actor a@example.test up` resolves to `migrate status` — only the first word is
      // read as a subcommand, or `--actor`'s value would become one — so the refusal points at `up`.
      const result = await run(['migrate', '--actor', 'a@example.test', 'up']);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('iridium migrate up');
      expect(result.stderr).toContain('The subcommand comes before the flags.');
    });

    it('accepts the one positional `migrate to` takes', async () => {
      // It gets as far as the migrator credential check, which is where a parse failure would not.
      const result = await run(['migrate', 'to', '0034_grants']);
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('DATABASE_MIGRATE_URL');
    });
  });

  describe('the configuration boundary', () => {
    it('exits 2 with the parse failure when the environment is wrong', async () => {
      const result = await run(['config', 'check'], {});
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('configuration error (config.invalid)');
    });

    it('exits 2 for an unknown IRIDIUM_ key, which EnvSchema refuses by name', async () => {
      const result = await run(['config', 'check'], { ...MINIMAL, IRIDIUM_NOT_A_KEY: '1' });
      expect(result.code).toBe(EXIT.usage);
      expect(result.stderr).toContain('config.unknown_key');
    });

    it('prints the redacted summary and exits 0 on a valid environment', async () => {
      const result = await run(['config', 'check']);
      expect(result.code).toBe(EXIT.success);
      expect(result.stdout).toContain('configuration');
      expect(result.stdout).toContain('resolved ceiling');
    });

    it('answers `config check --json` as one JSON document on stdout', async () => {
      const result = await run(['config', 'check', '--json']);
      expect(result.code).toBe(EXIT.success);
      const parsed = parseJson(result.stdout);
      expect(parsed).toHaveProperty('config');
      expect(parsed).toHaveProperty('warnings');
      expect(result.stderr).toBe('');
    });

    it('defaults `config` to `check`, as M0 did', async () => {
      expect((await run(['config'])).code).toBe(EXIT.success);
      expect((await run(['config', '--json'])).code).toBe(EXIT.success);
    });
  });

  describe('version answers without an environment', () => {
    it('prints the build identity with no configuration at all', async () => {
      const result = await run(['version'], {});
      expect(result.code).toBe(EXIT.success);
      expect(result.stdout).toContain('version');
      expect(result.stdout).toContain('schemaHead');
      expect(result.stderr).toBe('');
    });

    it('answers --version and -v the same way M0 did', async () => {
      const results = await Promise.all(['--version', '-v'].map((spelling) => run([spelling], {})));
      expect(results.map((result) => result.code)).toEqual([EXIT.success, EXIT.success]);
      for (const result of results) expect(result.stdout).toContain('commit');
    });

    it('answers --json as one parseable document naming the binary’s schema head', async () => {
      const result = await run(['version', '--json'], {});
      expect(parseJson(result.stdout)).toMatchObject({
        schemaHead: expect.stringMatching(/^\d{4}_/),
      });
    });
  });

  describe('doctor runs the checks this build carries', () => {
    it('refuses a reserved check with exit 3 rather than calling it unknown', async () => {
      const result = await run(['doctor', '--triggers']);
      expect(result.code).toBe(EXIT.refused);
      expect(result.stderr).toContain('iridium doctor --triggers: not_implemented');
    });

    it('runs only --yjs-instances when that is the check asked for', async () => {
      const result = await run(['doctor', '--yjs-instances', '--json']);
      expect(result.code).toBe(EXIT.success);
      // Exactly one check ran, and it is the one the flag named.
      expect(parseJson(result.stdout)).toEqual({
        checks: [expect.objectContaining({ name: 'yjs_instances', status: 'ok' })],
      });
    });

    it('refuses --repair-content without --yes, and boots nothing to say so', async () => {
      // 11's "Repair" section: every repair subcommand requires `--yes`, and `doctor --repair-content`
      // is a documented alias for one. The refusal is the dispatcher's, so no pool is opened for it —
      // which is why this case can live in the unit lane at all.
      const result = await run([
        'doctor',
        '--repair-content',
        '018f2b1e-0000-7000-8000-0000000000aa',
      ]);
      expect(result.code).toBe(EXIT.refused);
      expect(result.stderr).toContain('add --yes to confirm');
    });
  });
});
