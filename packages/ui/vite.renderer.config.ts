/**
 * The shared renderer build configuration (07-client-applications.md §6.1).
 *
 * `apps/web/vite.config.ts` and `apps/desktop/vite.renderer.config.ts` both build this module's
 * object and add their own plugin list, so the settings that must not drift between the two hosts —
 * above all `resolve.dedupe`, which is the bundle half of `deps.single-instance.guard` (A14) — have
 * exactly one home. The only intended differences between the hosts are `base` and `build.target`,
 * and both are parameters of `rendererConfig`.
 *
 * This file deliberately imports nothing: `@iridium/ui` is `browser`-tagged, so it may not depend on
 * `vite` (a Node package) and may not import `node:*`. The returned object is a plain `UserConfig`
 * fragment that each host passes through its own `defineConfig` / `mergeConfig`, which is what keeps
 * the three build configs of §7.1 plain and independent.
 */

/** One module instance each (13-decision-log.md A14). The web and desktop bundles are scanned. */
export const DEDUPED_MODULES = [
  'yjs',
  'lib0',
  'y-protocols',
  '@codemirror/state',
  '@codemirror/view',
] as const;

/** Build targets (07-client-applications.md D07-18): current Chrome/Edge, and Electron 44's Chromium. */
export const WEB_BUILD_TARGET = 'chrome150';
export const DESKTOP_BUILD_TARGET = 'chrome152';

/**
 * The literal the server substitutes per request and the desktop scheme handler substitutes per
 * load (D07-10). A boot assertion fails when it is absent from the built HTML.
 */
export const CSP_NONCE_PLACEHOLDER = '__IRIDIUM_CSP_NONCE__';

export interface RendererConfigOptions {
  /** `'/app/'` for the web host, `'./'` for the desktop renderer loaded from `app://iridium/`. */
  readonly base: string;
  /** Defaults to `WEB_BUILD_TARGET`; the desktop config narrows it to `DESKTOP_BUILD_TARGET`. */
  readonly target?: string;
  /** The single Changesets product version, injected as `__IRIDIUM_VERSION__`. */
  readonly productVersion: string;
}

export interface RendererSharedConfig {
  base: string;
  resolve: { dedupe: string[] };
  worker: { format: 'es' };
  build: {
    target: string;
    sourcemap: 'hidden';
    cssCodeSplit: true;
    manifest: true;
  };
  define: Record<string, string>;
}

export function rendererConfig(options: RendererConfigOptions): RendererSharedConfig {
  return {
    base: options.base,
    resolve: { dedupe: [...DEDUPED_MODULES] },
    worker: { format: 'es' },
    build: {
      target: options.target ?? WEB_BUILD_TARGET,
      // Maps are built and archived by CI, never served (§6.1).
      sourcemap: 'hidden',
      cssCodeSplit: true,
      // `scripts/check-bundle-budget.ts` reads this manifest for both hosts (§6.1, A40).
      manifest: true,
    },
    define: { __IRIDIUM_VERSION__: JSON.stringify(options.productVersion) },
  };
}
