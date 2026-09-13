/**
 * Toxiproxy: the only way the suite degrades a network (10-testing-and-quality.md, flake policy —
 * *"the fix is `expect.poll` with an explicit deadline, an injected clock, a Toxiproxy toxic, or a test
 * lock"*, never a sleep).
 *
 * Two proxies exist by name: `mysql`, in front of `mysql:3306` on the shared Docker network, and
 * `collab`, created after a child-process server starts and pointed at `server:<port>`.
 *
 * The container is started with `@testcontainers/toxiproxy` (which owns the exposed proxy-port range
 * and picks a free one), but every *operation* on a proxy goes through `ToxiproxyApi`, a small client
 * over Toxiproxy's HTTP control API. That split is deliberate: `globalSetup` runs in the Vitest node
 * process and the chaos tests run in workers, which hold no container object, so a proxy has to be
 * drivable from a URL alone. One implementation serves both, and the harness needs no dependency on
 * `toxiproxy-node-client` — which `@testcontainers/toxiproxy` re-exports only from a build-internal
 * path, not from its package root.
 */
import { ToxiProxyContainer } from '@testcontainers/toxiproxy';
import type { StartedToxiProxyContainer } from '@testcontainers/toxiproxy';
import type { StartedNetwork } from 'testcontainers';

/** Pinned by 12-milestones.md §4.3 and pre-pulled by the developer setup. */
export const TOXIPROXY_IMAGE = 'ghcr.io/shopify/toxiproxy:2.12.0';

/** The proxy in front of MySQL, used by CH-6 (database outage) and CH-7 (degradation). */
export const MYSQL_PROXY_NAME = 'mysql';

/** The proxy in front of a child-process server's `/collab` port. */
export const COLLAB_PROXY_NAME = 'collab';

/** Toxiproxy's control API port inside the container. */
export const TOXIPROXY_CONTROL_PORT = 8474;

/** The toxic kinds Toxiproxy 2.12 implements; 12-milestones.md §7.3 names the first four. */
export type ToxicKind =
  | 'latency'
  | 'bandwidth'
  | 'slow_close'
  | 'timeout'
  | 'slicer'
  | 'limit_data'
  | 'reset_peer';

export type ToxicDirection = 'upstream' | 'downstream';

export interface ToxicSpec {
  readonly type: ToxicKind;
  /** Toxiproxy's own attribute object for that kind. */
  readonly attributes: Readonly<Record<string, number>>;
  /** `downstream` (server → client) by default, as Toxiproxy does. */
  readonly stream?: ToxicDirection;
  /** Fraction of connections affected; 1 by default. */
  readonly toxicity?: number;
  /** Defaults to the type, which is unique per proxy in every suite that arms one toxic of a kind. */
  readonly name?: string;
}

export interface ToxicHandle {
  readonly name: string;
  remove(): Promise<void>;
}

export interface ProxyHandle {
  readonly name: string;
  /** The listener on the developer machine — what a connection string is built from. */
  readonly host: string;
  readonly port: number;
  /** `uri('mysql', '/iridium_w1')` → `mysql://127.0.0.1:8666/iridium_w1`. */
  uri(scheme: string, suffix?: string): string;
  /** `false` is an outage: existing connections are dropped and new ones refused. */
  setEnabled(enabled: boolean): Promise<void>;
  addToxic(toxic: ToxicSpec): Promise<ToxicHandle>;
  removeAllToxics(): Promise<void>;
}

interface ProxyBody {
  readonly name: string;
  readonly listen: string;
  readonly upstream: string;
  readonly enabled: boolean;
}

function isProxyBody(value: unknown): value is ProxyBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'listen' in value &&
    'upstream' in value &&
    typeof value.name === 'string' &&
    typeof value.listen === 'string' &&
    typeof value.upstream === 'string'
  );
}

/** A client over Toxiproxy's HTTP control API, usable from `globalSetup` and from a worker alike. */
export class ToxiproxyApi {
  readonly controlUrl: string;

  constructor(controlUrl: string) {
    this.controlUrl = controlUrl.replace(/\/+$/, '');
  }

  async #request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.controlUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(
        `@iridium/testkit: toxiproxy ${init?.method ?? 'GET'} ${path} answered ${String(response.status)}: ${await response.text()}`,
      );
    }
    if (response.status === 204) {
      return undefined;
    }
    return response.json();
  }

  async version(): Promise<string> {
    const response = await fetch(`${this.controlUrl}/version`);
    return response.text();
  }

  async getProxy(name: string): Promise<ProxyBody> {
    const body = await this.#request(`/proxies/${encodeURIComponent(name)}`);
    if (!isProxyBody(body)) {
      throw new Error(
        `@iridium/testkit: toxiproxy returned no usable proxy document for "${name}"`,
      );
    }
    return body;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const current = await this.getProxy(name);
    await this.#request(`/proxies/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...current, enabled }),
    });
  }

  async addToxic(proxy: string, toxic: ToxicSpec): Promise<string> {
    const name = toxic.name ?? toxic.type;
    await this.#request(`/proxies/${encodeURIComponent(proxy)}/toxics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        type: toxic.type,
        stream: toxic.stream ?? 'downstream',
        toxicity: toxic.toxicity ?? 1,
        attributes: { ...toxic.attributes },
      }),
    });
    return name;
  }

  async removeToxic(proxy: string, toxic: string): Promise<void> {
    const response = await fetch(
      `${this.controlUrl}/proxies/${encodeURIComponent(proxy)}/toxics/${encodeURIComponent(toxic)}`,
      { method: 'DELETE' },
    );
    // 404 means the toxic is already gone, which is the state the caller asked for.
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `@iridium/testkit: toxiproxy could not remove toxic ${toxic}: ${String(response.status)}`,
      );
    }
  }

  async listToxicNames(proxy: string): Promise<readonly string[]> {
    const body = await this.#request(`/proxies/${encodeURIComponent(proxy)}/toxics`);
    if (!Array.isArray(body)) {
      return [];
    }
    return body.flatMap((entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'name' in entry &&
      typeof entry.name === 'string'
        ? [entry.name]
        : [],
    );
  }

  /** Drive an already-created proxy whose listener maps to `host:port` on this machine. */
  proxy(name: string, host: string, port: number): ProxyHandle {
    return {
      name,
      host,
      port,
      uri: (scheme: string, suffix = ''): string => `${scheme}://${host}:${String(port)}${suffix}`,
      setEnabled: async (enabled: boolean): Promise<void> => {
        await this.setEnabled(name, enabled);
      },
      addToxic: async (toxic: ToxicSpec): Promise<ToxicHandle> => {
        const toxicName = await this.addToxic(name, toxic);
        return {
          name: toxicName,
          remove: async (): Promise<void> => {
            await this.removeToxic(name, toxicName);
          },
        };
      },
      removeAllToxics: async (): Promise<void> => {
        for (const toxicName of await this.listToxicNames(name)) {
          // Toxiproxy applies toxic changes per request; removing them in order keeps the proxy's
          // observable state monotonic, which is what a chaos step asserts against.
          // eslint-disable-next-line no-await-in-loop -- toxics are removed in order; see above
          await this.removeToxic(name, toxicName);
        }
      },
    };
  }
}

export interface ToxiproxyFixture {
  readonly container: StartedToxiProxyContainer;
  readonly api: ToxiproxyApi;
  /** The control API URL a worker reconnects with. */
  readonly controlUrl: string;
  /** Create a named proxy; `upstream` is `<alias>:<port>` on the shared Docker network. */
  createProxy(name: string, upstream: string): Promise<ProxyHandle>;
  stop(): Promise<void>;
}

export interface StartToxiproxyOptions {
  /** The shared network MySQL is on; the proxy must reach `mysql:3306` by alias. */
  readonly network: StartedNetwork;
  readonly image?: string;
}

export async function startToxiproxy(options: StartToxiproxyOptions): Promise<ToxiproxyFixture> {
  const container = await new ToxiProxyContainer(options.image ?? TOXIPROXY_IMAGE)
    .withNetwork(options.network)
    .withNetworkAliases('toxiproxy')
    .start();

  const controlUrl = `http://${container.getHost()}:${String(container.getMappedPort(TOXIPROXY_CONTROL_PORT))}`;
  const api = new ToxiproxyApi(controlUrl);

  return {
    container,
    api,
    controlUrl,
    async createProxy(name: string, upstream: string): Promise<ProxyHandle> {
      // The container module owns the exposed proxy-port range and picks a free one.
      const created = await container.createProxy({ name, upstream });
      return api.proxy(name, created.host, created.port);
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}

/** Reconnect to a running Toxiproxy from a Vitest worker, given the coordinates `inject()` provides. */
export function connectToxiproxy(controlUrl: string): ToxiproxyApi {
  return new ToxiproxyApi(controlUrl);
}

/** The four toxics 12-milestones.md §7.3 names, as spec builders so a suite never hand-rolls one. */
export const TOXIC = {
  latency(latencyMs: number, jitterMs = 0): ToxicSpec {
    return { type: 'latency', attributes: { latency: latencyMs, jitter: jitterMs } };
  },
  timeout(timeoutMs: number): ToxicSpec {
    return { type: 'timeout', attributes: { timeout: timeoutMs } };
  },
  resetPeer(timeoutMs = 0): ToxicSpec {
    return { type: 'reset_peer', attributes: { timeout: timeoutMs } };
  },
  bandwidth(rateKbps: number): ToxicSpec {
    return { type: 'bandwidth', attributes: { rate: rateKbps } };
  },
} as const;
