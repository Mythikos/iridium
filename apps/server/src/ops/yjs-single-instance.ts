/**
 * The Yjs single-instance startup guard (invariant 8 of 02-system-architecture.md; A14;
 * 05-collaboration-and-durability.md; the server half of `deps.single-instance.guard`).
 *
 * Two copies of `yjs` in one process break `instanceof` checks and silently stop synchronising —
 * the worst failure mode in the product, because nothing throws and documents simply stop
 * converging. Yjs itself detects the condition: it sets `globalThis['__ $YJS$ __']` on first import
 * and, when a second copy loads, writes
 *
 *     Yjs was already imported. This breaks constructor checks and will lead to issues!
 *
 * to `console.error`. That line is the only signal available in-process, so this module captures it.
 *
 * **Import order is load-bearing.** The message is written while the second copy's module body
 * evaluates, which under ESM happens *before* the body of the module that imported it. So this file
 * must be the **first** import of `main.ts` (and of any test that asserts the guard), it must import
 * nothing itself, and the interception happens at module evaluation rather than in a function a
 * later boot step calls. A guard installed after the import graph has been evaluated would observe
 * nothing and pass on a broken process — which is exactly the shape of bug it exists to catch.
 */

/** The exact string Yjs writes when a second copy loads. */
export const YJS_DOUBLE_IMPORT_MESSAGE = 'Yjs was already imported';

/** The global Yjs sets on first import; its presence means a Yjs copy is loaded. */
export const YJS_GLOBAL_KEY = '__ $YJS$ __';

/** Thrown by `assertSingleYjsInstance`; `main.ts` maps it to a non-zero exit. */
export class YjsMultipleInstancesError extends Error {
  readonly code = 'deps.yjs_multiple_instances';
  readonly exitCode = 1;
  readonly captured: readonly string[];

  constructor(captured: readonly string[]) {
    super(
      'more than one copy of yjs is loaded in this process, which breaks constructor checks and ' +
        'stops documents converging with no error at the call site (A14). Resolve the duplicate: ' +
        '`pnpm why yjs lib0 y-protocols` must report exactly one version, and only @iridium/crdt may ' +
        `import yjs. Captured: ${captured.join(' | ')}`,
    );
    this.name = 'YjsMultipleInstancesError';
    this.captured = captured;
  }
}

const captured: string[] = [];

function textOf(args: readonly unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
}

function intercept<A extends unknown[]>(original: (...args: A) => void): (...args: A) => void {
  return (...args: A): void => {
    const text = textOf(args);
    if (text.includes(YJS_DOUBLE_IMPORT_MESSAGE)) {
      captured.push(text);
      return;
    }
    original(...args);
  };
}

// Installed at module evaluation, which is why this module is imported first and imports nothing.
/* eslint-disable no-console -- the point of this module is to intercept Yjs's own console output */
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
console.error = intercept(originalError);
console.warn = intercept(originalWarn);
/* eslint-enable no-console */

/**
 * Whatever the interception captured, for a diagnostic that wants to print it.
 *
 * `deps.single-instance.guard` is the reader today: the captured text is the only evidence that the
 * interception fired on the real Yjs message rather than on some other console line, so the guard
 * asserts the content and not merely that a refusal happened. `iridium doctor --yjs-instances`
 * prints the same list from M1.
 *
 */
export function capturedYjsWarnings(): readonly string[] {
  return [...captured];
}

/**
 * Whether a Yjs copy has been loaded at all — reported by `iridium doctor --yjs-instances` from M1.
 *
 * `deps.single-instance.guard` reads it to pin the meaning of the global: the guard is worthless if
 * the key Yjs sets ever stops being the thing this module watches for.
 *
 */
export function yjsIsLoaded(): boolean {
  return YJS_GLOBAL_KEY in globalThis;
}

/**
 * Fails the boot when a second Yjs copy announced itself. Called by the `db` plugin, which is where
 * 02-system-architecture.md's boot sequence places this guard.
 */
export function assertSingleYjsInstance(): void {
  if (captured.length > 0) throw new YjsMultipleInstancesError(captured);
}

/**
 * Test seam: clears the captured list so one process can exercise the guard more than once.
 *
 * The capture is module state installed at evaluation and a Vitest worker evaluates this module once,
 * so without a reset the second case in `deps.single-instance.guard` would inherit the first case's
 * capture and pass for the wrong reason. Nothing in the serving path may call it: a boot that clears
 * the list is a boot that has just hidden the condition the module exists to catch.
 *
 * @internal
 */
export function resetYjsGuardForTest(): void {
  captured.length = 0;
}
