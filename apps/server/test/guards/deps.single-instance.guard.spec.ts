/**
 * `deps.single-instance.guard` (12-milestones.md section 4.6; 10-testing-and-quality.md, "Guard
 * tests"; invariant 8 of 02-system-architecture.md; A14).
 *
 * Two copies of `yjs` in one process break `instanceof` checks and stop documents converging **with
 * no error at the call site** — which makes this the highest-consequence, lowest-visibility failure
 * in the product. The plan defends it in four layers, and this file owns two of them:
 *
 *  1. **the lockfile** — exactly one resolved version of `yjs`, `lib0`, `y-protocols`,
 *     `@codemirror/state` and `@codemirror/view`, read from `pnpm-lock.yaml` directly (one parse, no
 *     child process, so it fits the `guard` project's timeout and the `static` job's pre-flight);
 *  2. **the server startup guard** — the process fails rather than serving when a second copy
 *     announces itself with `Yjs was already imported`.
 *
 * The other two layers are elsewhere by construction: the `pnpm why` shell step is `ci.yml › static`'s
 * (12-milestones.md section 3 names that form), and the bundle-analysis assertion needs a built web
 * and desktop bundle, so it belongs to the lane that builds them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSingleYjsInstance,
  capturedYjsWarnings,
  resetYjsGuardForTest,
  YJS_DOUBLE_IMPORT_MESSAGE,
  YJS_GLOBAL_KEY,
  YjsMultipleInstancesError,
  yjsIsLoaded,
} from '../../src/ops/yjs-single-instance.ts';

/** The five packages that must resolve to exactly one version each (A14). */
const SINGLE_INSTANCE_PACKAGES: readonly string[] = Object.freeze([
  'yjs',
  'lib0',
  'y-protocols',
  '@codemirror/state',
  '@codemirror/view',
]);

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const LOCKFILE = join(REPO_ROOT, 'pnpm-lock.yaml');

/**
 * Every version of `name` the lockfile resolves.
 *
 * A lockfile entry key is `<name>@<version>` at two-space indentation, optionally followed by a peer
 * suffix in parentheses (`y-protocols@1.0.7(yjs@13.6.32)`), and a scoped name is quoted. Reading the
 * keys with a line matcher rather than a YAML parser is deliberate: this guard runs as the first step
 * of the `static` job, and adding a parser dependency to the server package to read one file would be
 * a production dependency added for a test.
 */
function resolvedVersions(lockfile: string, name: string): readonly string[] {
  const escaped = name.replace(/[/@]/g, (character) => `\\${character}`);
  const pattern = new RegExp(`^ {2}'?${escaped}@([^'():\\s]+)`, 'gm');
  const versions = new Set<string>();
  for (const match of lockfile.matchAll(pattern)) {
    const version = match[1];
    if (version !== undefined) versions.add(version);
  }
  return [...versions].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Why a second copy is fatal rather than merely wasteful, kept out of the assertion so the line that
 * reports the failure stays readable. `vitest/valid-expect` accepts a literal or a template as the
 * message argument but not a bare identifier, so this is interpolated rather than passed directly.
 */
const WHY_ONE_VERSION =
  'Two copies break instanceof checks and stop synchronisation silently (A14). ' +
  'Add or correct the pnpm-workspace.yaml `overrides` entry rather than deduping by hand.';

describe('deps.single-instance.guard [area:deps]', () => {
  describe('the lockfile resolves one version per single-instance package', () => {
    const lockfile = readFileSync(LOCKFILE, 'utf8');

    it('finds the lockfile where the guard expects it', () => {
      expect(lockfile.length).toBeGreaterThan(0);
      expect(lockfile).toContain('lockfileVersion');
    });

    for (const name of SINGLE_INSTANCE_PACKAGES) {
      it(`resolves exactly one version of ${name}`, () => {
        const versions = resolvedVersions(lockfile, name);
        expect(
          versions,
          `${name} resolves ${String(versions.length)} versions (${versions.join(', ')}). ${WHY_ONE_VERSION}`,
        ).toHaveLength(1);
      });
    }
  });

  describe('the server startup guard', () => {
    it('intercepts the exact line Yjs writes when a second copy loads', () => {
      resetYjsGuardForTest();
      // The real producer is the second copy's module body; console.error is the only signal it emits.
      // eslint-disable-next-line no-console -- reproducing the exact producer is the point of the test
      console.error(
        `${YJS_DOUBLE_IMPORT_MESSAGE}. This breaks constructor checks and will lead to issues!`,
      );
      expect(capturedYjsWarnings()).toHaveLength(1);
      expect(capturedYjsWarnings()[0]).toContain(YJS_DOUBLE_IMPORT_MESSAGE);
      resetYjsGuardForTest();
    });

    it('fails the boot with a remedy once the line has been captured', () => {
      resetYjsGuardForTest();
      // eslint-disable-next-line no-console -- as above
      console.warn(`${YJS_DOUBLE_IMPORT_MESSAGE}.`);
      let thrown: unknown;
      try {
        assertSingleYjsInstance();
      } catch (error) {
        thrown = error;
      }
      if (!(thrown instanceof YjsMultipleInstancesError)) {
        throw new Error(`expected the guard to refuse the boot; it threw: ${String(thrown)}`);
      }
      expect(thrown.exitCode).not.toBe(0);
      expect(thrown.message).toContain('pnpm why yjs');
      expect(thrown.message).toContain('@iridium/crdt');
      resetYjsGuardForTest();
    });

    it('passes when nothing announced a second copy', () => {
      resetYjsGuardForTest();
      expect(() => {
        assertSingleYjsInstance();
      }).not.toThrow();
      expect(capturedYjsWarnings()).toHaveLength(0);
    });

    it('leaves every other console line alone', () => {
      resetYjsGuardForTest();
      const seen: string[] = [];
      const original = console.error;
      // eslint-disable-next-line no-console -- restoring the spy is the whole assertion
      console.error = (...args: unknown[]): void => {
        seen.push(args.join(' '));
      };
      try {
        // eslint-disable-next-line no-console -- as above
        console.error('an ordinary error line');
      } finally {
        // eslint-disable-next-line no-console -- as above
        console.error = original;
      }
      expect(seen).toEqual(['an ordinary error line']);
      expect(capturedYjsWarnings()).toHaveLength(0);
    });

    it('reports whether a Yjs copy is loaded at all, for `iridium doctor --yjs-instances`', () => {
      // The server itself never imports yjs — only @iridium/crdt may — so in this process the global
      // is absent. The assertion is on the reporter agreeing with the global, not on either value.
      expect(yjsIsLoaded()).toBe(YJS_GLOBAL_KEY in globalThis);
    });
  });
});
