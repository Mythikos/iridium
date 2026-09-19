/**
 * `safeHook` — the wrapper every Hocuspocus hook body runs inside
 * (05-collaboration-and-durability.md, "Instance configuration"; 09-api-reference.md §3.8; D14-09).
 *
 * Hocuspocus 4.7.0 runs a hook chain as one promise chain and, for most events, lets a rejection
 * become an unhandled promise rejection — which terminates Node 24 (issue #754). A hook body may
 * therefore reject with exactly one class of value: the typed markers of `rejection.ts`, from the
 * seven hooks whose contract Hocuspocus defines as "throw to reject". Every other error, from every
 * hook, is logged as `collab.hook.error`, counted in `iridium_collab_hook_errors_total{hook}` and
 * swallowed. `collab.hooks-never-reject.unit` enumerates every registered hook and asserts exactly
 * that.
 *
 * `onStateless` is deliberately outside the rethrow list: its handlers close the connection
 * themselves (`connection.close({ code: 4403, reason: 'protocol-error' })`) and never signal by
 * throwing, because Hocuspocus swallows a message-less rejection from that hook.
 */
import { COLLAB_HOOK_NAMES, type CollabHookName } from '../ops/metrics.ts';
import { isHookSignal } from './rejection.ts';

/**
 * The hook names, and the list a suite enumerates: the label values of
 * `iridium_collab_hook_errors_total`, so the registry and the wrapper cannot disagree.
 */
/** @internal The unit suite enumerates every hook contract through this list. */
export { COLLAB_HOOK_NAMES };
export type { CollabHookName };

/** The seven hooks a typed marker may escape from (09 §3.8). */
export const RETHROWING_HOOKS: readonly CollabHookName[] = Object.freeze([
  'onAuthenticate',
  'onLoadDocument',
  'onTokenSync',
  'beforeHandleMessage',
  'beforeHandleAwareness',
  'beforeUnloadDocument',
  'onStoreDocument',
]);

/** The logging method and counter the wrapper uses — a slice, so a unit test needs no pino instance. */
export interface SafeHookDeps {
  readonly logger: {
    error(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  /** Resolved at call time: the process registry exists only after boot step 10. */
  readonly hookErrors: () => { inc(labels: { hook: string }): void } | null;
}

/** A hook body: sync or async, any payload, any return. */
export type HookBody<TPayload, TResult> = (payload: TPayload) => TResult | Promise<TResult>;

/**
 * Wraps `body` so it can only ever reject with a typed marker, and only from a rethrowing hook.
 *
 * `documentName` is read off the payload when it carries one, so the log line names the document
 * without the wrapper knowing the payload's shape.
 */
export function safeHook<TPayload, TResult>(
  name: CollabHookName,
  body: HookBody<TPayload, TResult>,
  deps: SafeHookDeps,
): (payload: TPayload) => Promise<TResult | undefined> {
  const rethrows = RETHROWING_HOOKS.includes(name);
  return async (payload: TPayload): Promise<TResult | undefined> => {
    try {
      return await body(payload);
    } catch (error) {
      if (rethrows && isHookSignal(error)) throw error;
      deps.logger.error(
        {
          err: error,
          event: 'collab.hook.error',
          hook: name,
          documentName: documentNameOf(payload),
        },
        'a collaboration hook failed and was contained',
      );
      deps.hookErrors()?.inc({ hook: name });
      return undefined;
    }
  };
}

function documentNameOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value: unknown = Reflect.get(payload, 'documentName');
  return typeof value === 'string' ? value : undefined;
}
