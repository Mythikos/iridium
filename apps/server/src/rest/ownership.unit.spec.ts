/** Requests waiting for auth must never borrow a successor's ownership generation. */
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { CollabOwnershipLost, type OwnerFence } from '../collab/owner-lease.ts';
import { ProblemError } from '../security/problem.ts';
import { applyRequestOwnership, requestOwnerFence } from './ownership.ts';

type Request = { method: string; url: string; ownerFence: OwnerFence | null };

function fixture() {
  const hooks: ((request: Request) => Promise<void>)[] = [];
  const active = vi.fn<OwnerFence['assertActive']>();
  const fence: OwnerFence = {
    assertActive: active,
    assertCurrent: vi.fn<OwnerFence['assertCurrent']>(),
  };
  const capture = vi.fn<() => OwnerFence>().mockReturnValue(fence);
  const decorate = vi.fn<(name: string, value: null) => void>();
  const host = {
    decorateRequest: decorate,
    collab: { ownerLease: { captureFence: capture } },
    addHook: (_name: string, hook: (request: Request) => Promise<void>) => hooks.push(hook),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the hook registration boundary is scripted in this unit test
  applyRequestOwnership(host as unknown as FastifyInstance);
  const admit = hooks[0];
  if (admit === undefined) throw new Error('Ownership hooks were not registered.');
  return { admit, decorate, capture, fence, active };
}

describe('rest.ownership.unit [area:rest]', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'captures %s admission before asynchronous auth begins',
    async (method) => {
      const { admit, capture, fence, decorate, active } = fixture();
      const request: Request = { method, url: '/api/v1/vaults', ownerFence: null };
      await admit(request);
      expect(decorate).toHaveBeenCalledExactlyOnceWith('ownerFence', null);
      expect(capture).toHaveBeenCalledOnce();
      expect(requestOwnerFence(request)).toBe(fence);
      expect(active).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['GET', '/api/v1/vaults'],
    ['HEAD', '/api/v1/vaults'],
    ['OPTIONS', '/api/v1/vaults'],
    ['GET', '/collab'],
    ['POST', '/healthz'],
    ['POST', '/readyz?verbose=1'],
    ['POST', '/metrics'],
  ])('leaves %s %s to its existing readiness or upgrade policy', async (method, url) => {
    const { admit, capture } = fixture();
    const request: Request = { method, url, ownerFence: null };
    await admit(request);
    expect(request.ownerFence).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it('retains the old fence across a suspended auth read and a successor claim', async () => {
    const { admit, capture, fence, active } = fixture();
    const request: Request = { method: 'POST', url: '/api/v1/vaults/v/nodes', ownerFence: null };
    await admit(request);
    const successorActive = vi.fn<OwnerFence['assertActive']>();
    const successor: OwnerFence = {
      assertActive: successorActive,
      assertCurrent: vi.fn<OwnerFence['assertCurrent']>(),
    };
    capture.mockReturnValue(successor);
    active.mockImplementation(() => {
      throw new CollabOwnershipLost();
    });
    await Promise.resolve();
    expect(() => requestOwnerFence(request)).toThrow(CollabOwnershipLost);
    expect(request.ownerFence).toBe(fence);
    expect(capture).toHaveBeenCalledOnce();
    expect(successorActive).not.toHaveBeenCalled();
  });

  it('fails closed when no request generation was captured', () => {
    expect(() => requestOwnerFence({ ownerFence: null })).toThrow(ProblemError);
  });

  it('refuses ownership loss at capture before any authentication work', async () => {
    const { admit, capture } = fixture();
    const failure = new CollabOwnershipLost();
    capture.mockImplementation(() => {
      throw failure;
    });
    await expect(admit({ method: 'POST', url: '/api/v1/vaults', ownerFence: null })).rejects.toBe(
      failure,
    );
  });
});
