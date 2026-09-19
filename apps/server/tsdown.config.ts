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
  // `@hocuspocus/*` is bundled for the same reason `@iridium/*` is, and it is invariant 8 rather than
  // a preference. `@iridium/crdt` is inlined, so the one copy of `yjs` it imports is inlined with it;
  // leaving `@hocuspocus/server` external would make it resolve its own `yjs` from `node_modules` at
  // run time, and the process would hold **two** Yjs copies — which breaks `instanceof` and stops
  // documents converging with nothing thrown (A14). Yjs itself detects it and `iridium <any command>`
  // then refuses to start, which is how this was found. Bundling the collaboration server resolves its
  // `yjs`, `y-protocols` and `lib0` imports to the same inlined modules, so one instance serves both.
  deps: {
    alwaysBundle: [/^@iridium\//, /^@hocuspocus\//, 'y-protocols'],
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
    // The breached-password list is data, not code, and `auth/credentials/blocklist.ts` resolves it
    // as `new URL('blocklist.txt', import.meta.url)` — which is `dist/blocklist.txt` once bundled. A
    // bundler copies no data files on its own, so without this the built binary throws `ENOENT` in
    // boot step 4 and **nothing that boots works**: not `iridium serve`, not any CLI command that
    // reaches the application, and not `startServer({ mode: 'child' })`, which is how the chaos
    // project gets a process it can `SIGKILL`.
    // `to` names a *directory*, not a file: spelling it `dist/blocklist.txt` creates a directory of
    // that name and puts the list inside it, which fails the same way with `EISDIR` instead of `ENOENT`.
    copy: [{ from: 'src/auth/credentials/blocklist.txt', to: 'dist' }],
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
