// The server bundle: `dist/main.mjs` with every `@iridium/*` workspace package inlined, and the
// native and worker-hosting modules left external (02-system-architecture.md, "Build outputs and
// artifacts").
//
// `src/main.ts` is the entry because it is the CLI dispatcher *and* the server: one binary, different
// sub-commands, so `iridium serve` and `iridium migrate up` can never see a different configuration
// or a different schema than each other. `package.json`'s `bin` points at the same file, and
// `@iridium/testkit` drives it for the `child` harness mode and for every migration a fixture runs.
//
// Three externals, each for a reason that is not "it was awkward to bundle": `@node-rs/argon2` is a
// native addon, `mysql2` resolves its own auth plugins at runtime, and `piscina` spawns worker
// entry points that must stay separate files.
//
// There are **two** outputs, and they are declared as two configurations rather than as two keys of
// one `entry` map. The image's `HEALTHCHECK` runs `node /app/dist/healthcheck.mjs`
// (11-operations-and-deployment.md, "Container image"; OPS-03), and the probe shares three leaf
// modules with the server — `ops/paths.ts`, `config/defaults.ts`, `config/process-env.ts` — so that
// the path it requests and the port it addresses have one definition, not two. A single build with
// two entries hoists exactly those shared modules into a third, content-hashed chunk that both
// outputs then import. That chunk works, but it makes the probe a two-file program whose second file
// is renamed on every build, and the thing being probed is a container whose health check must be the
// most boring code in the image. Two configurations give two self-contained files from one `tsdown`
// invocation, which is what both the Dockerfile and the plan's "20-line script" describe.
import { defineConfig, type UserConfig } from 'tsdown';

/** Everything the two outputs agree on. Neither may differ in target, format or externals. */
const shared = {
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  deps: {
    alwaysBundle: [/^@iridium\//],
    neverBundle: ['@node-rs/argon2', 'mysql2', 'piscina'],
  },
  sourcemap: true,
  dts: false,
} as const satisfies UserConfig;

export default defineConfig([
  {
    ...shared,
    name: 'main',
    entry: { main: 'src/main.ts' },
    // Exactly one configuration asks for a clean, and it asks for the whole directory. tsdown
    // collects the clean across every configuration and performs it once, before any build starts —
    // verified by leaving a stale file in `dist` and watching one "Cleaning" pass remove it while
    // both outputs survived. So this is a full clean that cannot race the sibling build, and a stale
    // chunk from an earlier layout cannot survive into an image.
    clean: true,
  },
  {
    ...shared,
    name: 'healthcheck',
    entry: { healthcheck: 'src/ops/healthcheck.ts' },
    clean: false,
  },
]);
