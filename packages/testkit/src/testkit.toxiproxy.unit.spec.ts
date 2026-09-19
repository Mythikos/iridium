/** Control-plane refusals must fail a chaos test rather than pretend its fault was armed. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectToxiproxy, TOXIC, type ToxiproxyApi } from './env/toxiproxy.ts';

const fetchIo = vi.fn<typeof fetch>();
afterEach(() => {
  vi.unstubAllGlobals();
  fetchIo.mockReset();
});
function api(): ToxiproxyApi {
  vi.stubGlobal('fetch', fetchIo);
  return connectToxiproxy('http://127.0.0.1:8474///');
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
const PROXY = {
  name: 'db / replica',
  listen: '0.0.0.0:8666',
  upstream: 'mysql:3306',
  enabled: true,
};

describe('testkit.toxiproxy.unit [area:testkit]', () => {
  it('keeps proxy coordinates and toggles only enabled through the real control protocol', async () => {
    const control = api();
    const proxy = control.proxy(PROXY.name, '127.0.0.1', 18666);
    expect(proxy.uri('mysql', '/iridium_w1')).toBe('mysql://127.0.0.1:18666/iridium_w1');
    expect(proxy.uri('tcp')).toBe('tcp://127.0.0.1:18666');
    fetchIo
      .mockResolvedValueOnce(json(PROXY))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await proxy.setEnabled(false);
    expect(fetchIo.mock.calls).toEqual([
      ['http://127.0.0.1:8474/proxies/db%20%2F%20replica', undefined],
      [
        'http://127.0.0.1:8474/proxies/db%20%2F%20replica',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...PROXY, enabled: false }),
        },
      ],
    ]);
  });
  it('arms named, directional faults and returns an idempotent removal handle', async () => {
    const proxy = api().proxy('collab/test', '127.0.0.1', 18667);
    fetchIo
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const toxic = await proxy.addToxic({
      ...TOXIC.latency(250, 30),
      name: 'slow / wire',
      stream: 'upstream',
      toxicity: 0.5,
    });
    expect(toxic.name).toBe('slow / wire');
    expect(fetchIo.mock.calls[0]).toEqual([
      'http://127.0.0.1:8474/proxies/collab%2Ftest/toxics',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'slow / wire',
          type: 'latency',
          stream: 'upstream',
          toxicity: 0.5,
          attributes: { latency: 250, jitter: 30 },
        }),
      },
    ]);
    await toxic.remove();
    expect(fetchIo.mock.calls[1]).toEqual([
      'http://127.0.0.1:8474/proxies/collab%2Ftest/toxics/slow%20%2F%20wire',
      { method: 'DELETE' },
    ]);
  });
  it.each([TOXIC.timeout(500), TOXIC.resetPeer(), TOXIC.bandwidth(32), TOXIC.latency(10)])(
    'arms default downstream faults on every connection: $type',
    async (toxic) => {
      const control = api();
      fetchIo.mockResolvedValueOnce(json({}));
      expect(await control.addToxic('mysql', toxic)).toBe(toxic.type);
      expect(fetchIo.mock.calls[0]?.[1]?.body).toBe(
        JSON.stringify({
          name: toxic.type,
          type: toxic.type,
          stream: 'downstream',
          toxicity: 1,
          attributes: toxic.attributes,
        }),
      );
    },
  );
  it('removes only named toxics in response order, tolerating already removed entries', async () => {
    const proxy = api().proxy('mysql', '127.0.0.1', 8666);
    fetchIo
      .mockResolvedValueOnce(
        json([{ name: 'latency' }, null, 1, {}, { name: 1 }, { name: 'reset_peer' }]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await proxy.removeAllToxics();
    expect(fetchIo.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8474/proxies/mysql/toxics',
      'http://127.0.0.1:8474/proxies/mysql/toxics/latency',
      'http://127.0.0.1:8474/proxies/mysql/toxics/reset_peer',
    ]);
  });
  it.each([
    null,
    7,
    {},
    { name: 'mysql' },
    { ...PROXY, listen: false },
    { ...PROXY, upstream: null },
    { ...PROXY, enabled: 'yes' },
  ])('rejects a malformed proxy response: %j', async (body) => {
    const control = api();
    fetchIo.mockResolvedValueOnce(json(body));
    await expect(control.getProxy('mysql')).rejects.toThrow('no usable proxy document');
  });
  it('refuses an invalid toxic-list response instead of claiming cleanup completed', async () => {
    const control = api();
    fetchIo.mockResolvedValueOnce(json({ error: 'unusable' }));
    await expect(control.proxy('mysql', '127.0.0.1', 8666).removeAllToxics()).rejects.toThrow(
      'no usable toxic list',
    );
  });
  it('reports method, path, status and response when a fault cannot be armed', async () => {
    const control = api();
    fetchIo.mockResolvedValueOnce(new Response('upstream missing', { status: 503 }));
    await expect(control.addToxic('mysql', TOXIC.timeout(0))).rejects.toThrow(
      'POST /proxies/mysql/toxics answered 503: upstream missing',
    );
    fetchIo.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(control.getProxy('mysql')).rejects.toThrow(
      'GET /proxies/mysql answered 404: missing',
    );
  });
  it('fails cleanup on a refused deletion so toxics cannot leak into the next case', async () => {
    const control = api();
    fetchIo.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(control.removeToxic('mysql', 'latency')).rejects.toThrow(
      'could not remove toxic latency: 503',
    );
  });
  it('reads the health version and rejects a failed health probe', async () => {
    const control = api();
    fetchIo.mockResolvedValueOnce(new Response('2.12.0'));
    expect(await control.version()).toBe('2.12.0');
    fetchIo.mockResolvedValueOnce(new Response('unhealthy', { status: 503 }));
    await expect(control.version()).rejects.toThrow('GET /version answered 503');
  });
});
