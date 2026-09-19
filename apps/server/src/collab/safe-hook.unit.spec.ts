/**
 * `collab.safe-hook.unit` — the wrapper that lets a hook body reject with a typed marker only, and
 * only from the seven hooks whose contract is "throw to reject" (09-api-reference.md §3.8; D14-09).
 */
import { describe, expect, it } from 'vitest';

import { CollabRejection, StoreRejected, UnloadVeto } from './rejection.ts';
import { RETHROWING_HOOKS, safeHook, type CollabHookName } from './safe-hook.ts';

interface Counted {
  readonly hook: string;
}

function deps(): {
  readonly errors: Array<Readonly<Record<string, unknown>>>;
  readonly counted: Counted[];
  readonly hookDeps: Parameters<typeof safeHook>[2];
} {
  const errors: Array<Readonly<Record<string, unknown>>> = [];
  const counted: Counted[] = [];
  return {
    errors,
    counted,
    hookDeps: {
      logger: { error: (fields) => void errors.push(fields) },
      hookErrors: () => ({ inc: (labels) => void counted.push(labels) }),
    },
  };
}

const EVERY_HOOK: readonly CollabHookName[] = [
  'onAuthenticate',
  'onTokenSync',
  'onLoadDocument',
  'afterLoadDocument',
  'beforeHandleMessage',
  'beforeHandleAwareness',
  'onStateless',
  'onStoreDocument',
  'beforeUnloadDocument',
  'afterUnloadDocument',
  'connected',
  'onDisconnect',
];

describe('collab.safe-hook.unit [area:collab]', () => {
  it('names exactly the seven rethrowing hooks of 09 §3.8', () => {
    expect([...RETHROWING_HOOKS].toSorted()).toEqual(
      [
        'onAuthenticate',
        'onLoadDocument',
        'onTokenSync',
        'beforeHandleMessage',
        'beforeHandleAwareness',
        'beforeUnloadDocument',
        'onStoreDocument',
      ].toSorted(),
    );
  });

  it('passes a resolved value through untouched', async () => {
    const { hookDeps } = deps();
    const wrapped = safeHook('onAuthenticate', (payload: { n: number }) => payload.n + 1, hookDeps);
    await expect(wrapped({ n: 1 })).resolves.toBe(2);
  });

  it('swallows, logs and counts a plain error from every hook', async () => {
    for (const hook of EVERY_HOOK) {
      const { hookDeps, errors, counted } = deps();
      const wrapped = safeHook(
        hook,
        () => {
          throw new Error('boom');
        },
        hookDeps,
      );
      // eslint-disable-next-line no-await-in-loop -- one hook per iteration, sequential by design
      await expect(wrapped({ documentName: 'note:x' })).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ event: 'collab.hook.error', hook, documentName: 'note:x' });
      expect(counted).toEqual([{ hook }]);
    }
  });

  it('rethrows each typed marker from a rethrowing hook and swallows it elsewhere', async () => {
    const markers = [
      new CollabRejection('revoked'),
      new UnloadVeto('the queue is not empty'),
      new StoreRejected(new Error('io')),
    ];
    for (const hook of EVERY_HOOK) {
      for (const marker of markers) {
        const { hookDeps, counted } = deps();
        const wrapped = safeHook(
          hook,
          () => {
            throw marker;
          },
          hookDeps,
        );
        const rethrows = RETHROWING_HOOKS.includes(hook);
        // eslint-disable-next-line no-await-in-loop -- one case per iteration, sequential by design
        const settled = await wrapped({}).then(
          (value) => ({ outcome: 'resolved', value }),
          (error: unknown) => ({ outcome: 'rejected', value: error }),
        );
        expect({ hook, settled, counted }).toEqual({
          hook,
          settled: rethrows
            ? { outcome: 'rejected', value: marker }
            : { outcome: 'resolved', value: undefined },
          counted: rethrows ? [] : [{ hook }],
        });
      }
    }
  });

  it('keeps working when no registry exists yet', async () => {
    const wrapped = safeHook(
      'afterLoadDocument',
      () => {
        throw new Error('early');
      },
      { logger: { error: () => undefined }, hookErrors: () => null },
    );
    await expect(wrapped({})).resolves.toBeUndefined();
  });

  it('carries the close code of a rejection reason', () => {
    expect(new CollabRejection('too-large').code).toBe(1009);
    expect(new CollabRejection('no-owner-lease').code).toBe(4503);
    expect(
      new CollabRejection('note-trashed', { auditReason: 'trashed_under_lock' }).auditReason,
    ).toBe('trashed_under_lock');
  });
});
