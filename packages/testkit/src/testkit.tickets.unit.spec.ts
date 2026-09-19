import { describe, expect, it } from 'vitest';

import { fixedTicketSource, restTicketSource } from './auth/tickets.ts';
import { restClient } from './clients/rest-client.ts';

function harness(
  batch = 3,
  clock?: { now(): number },
): {
  source: ReturnType<typeof restTicketSource>;
  requests: string[][];
} {
  const requests: string[][] = [];
  const rest = restClient({
    origin: 'http://127.0.0.1:4000',
    fetch: () => {
      const tickets = Array.from({ length: batch }, (_, i) => `batch${requests.length}:${i}`);
      requests.push(tickets);
      return Promise.resolve(Response.json({ tickets, expiresIn: 60 }, { status: 201 }));
    },
  });
  return {
    source: restTicketSource(rest, clock === undefined ? { batch } : { batch, clock }),
    requests,
  };
}

describe('testkit.tickets.unit [area:testkit]', () => {
  it('shares refills across concurrent attachments, including more callers than a batch', async () => {
    const { source, requests } = harness(3);
    const tickets = await Promise.all(Array.from({ length: 8 }, () => source.next()));
    expect(new Set(tickets).size).toBe(8);
    expect(requests).toHaveLength(3);
  });

  it('discards the rejected batch and keeps the replacement after a late old refusal', async () => {
    const { source, requests } = harness();
    const first = await source.next();
    const sibling = await source.next();
    source.invalidate(first);
    expect(await source.next()).toBe('batch1:0');
    source.invalidate(sibling);
    expect(await source.next()).toBe('batch1:1');
    expect(requests).toHaveLength(2);
  });

  it('keeps an in-flight replacement when another old ticket is refused', async () => {
    const { source, requests } = harness();
    const first = await source.next();
    const sibling = await source.next();
    source.invalidate(first);
    const replacement = source.next();
    source.invalidate(sibling);
    expect(await replacement).toBe('batch1:0');
    expect(await source.next()).toBe('batch1:1');
    expect(requests).toHaveLength(2);
  });

  it('reuses a live batch but refreshes at expiry, including concurrent callers', async () => {
    let now = 0;
    const { source, requests } = harness(5, { now: () => now });
    const first = await source.next();
    now = 59_999;
    expect(await source.next()).toBe('batch0:1');
    now = 60_000;
    expect(await Promise.all([source.next(), source.next()])).toEqual(['batch1:0', 'batch1:1']);
    source.invalidate(first);
    expect(await source.next()).toBe('batch1:2');
    expect(requests).toHaveLength(2);
  });

  it('charges request latency against the ticket lifetime', async () => {
    let now = 0;
    let requests = 0;
    const rest = restClient({
      origin: 'http://127.0.0.1:4000',
      fetch: () => {
        requests += 1;
        now += 50_000;
        return Promise.resolve(
          Response.json(
            { tickets: [`first${requests}`, `unused${requests}`], expiresIn: 60 },
            { status: 201 },
          ),
        );
      },
    });
    const source = restTicketSource(rest, { batch: 2, clock: { now: () => now } });
    expect(await source.next()).toBe('first1');
    now = 60_000;
    expect(await source.next()).toBe('first2');
    expect(requests).toBe(2);
  });

  it('rejects a batch already expired in transit as a retryable network failure', async () => {
    let now = 0;
    const rest = restClient({
      origin: 'http://127.0.0.1:4000',
      fetch: () => {
        now += 60_000;
        return Promise.resolve(
          Response.json({ tickets: ['expired'], expiresIn: 60 }, { status: 201 }),
        );
      },
    });
    const source = restTicketSource(rest, { clock: { now: () => now } });
    await expect(source.next()).rejects.toMatchObject({ status: null });
  });

  it.each([undefined, 0, -1, 59, '60'])(
    'refuses an invalid advertised ticket lifetime %s',
    async (expiresIn) => {
      const rest = restClient({
        origin: 'http://127.0.0.1:4000',
        fetch: () =>
          Promise.resolve(Response.json({ tickets: ['invalid'], expiresIn }, { status: 201 })),
      });
      await expect(restTicketSource(rest).next()).rejects.toMatchObject({ status: 201 });
    },
  );

  it('preserves an explicitly scripted replay and refuses exhaustion', async () => {
    const source = fixedTicketSource('replayed', 'replayed');
    expect(await source.next()).toBe('replayed');
    source.invalidate('replayed');
    expect(await source.next()).toBe('replayed');
    await expect(source.next()).rejects.toMatchObject({ status: 401 });
  });
});
