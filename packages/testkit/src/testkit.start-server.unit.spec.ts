import { afterEach, describe, expect, it } from 'vitest';

import { createDeferred } from './harness/deadline.ts';
import { buildServerEnv } from './server/env.ts';
import type { BuildApp, TestAppInstance } from './server/in-process.ts';
import { startServer } from './server/start-server.ts';

/**
 * `startServer`'s configuration isolation and shutdown order through the injected `buildApp` seam.
 *
 * The order is the whole point: `child` mode sends `SIGTERM` and the product's own handler drains
 * before it closes, so `in-process` must do the same two steps in the same order. Without the drain,
 * `close()` destroys the pools while the collaboration owner lease still holds its dedicated
 * `dbPersist` connection.
 *
 * A double rather than a real server, because what is under test is the harness's sequencing and not
 * the product's drain; the real thing is exercised by every in-process integration suite.
 */

/** A `buildApp` whose instance records the order its lifecycle methods were called in. */
function doubleApp(
  options: {
    build?: (bootOptions: Parameters<BuildApp>[0]) => void | Promise<void>;
    listen?: () => Promise<void>;
    drain?: () => Promise<void>;
  } = {},
): {
  calls: string[];
  boots: Parameters<BuildApp>[0][];
  buildApp: BuildApp;
} {
  const calls: string[] = [];
  const boots: Parameters<BuildApp>[0][] = [];
  const app: TestAppInstance = {
    listen: async (): Promise<string> => {
      calls.push('listen');
      await options.listen?.();
      return 'http://127.0.0.1:0';
    },
    close: (): Promise<void> => {
      calls.push('close');
      return Promise.resolve();
    },
    drain: async (): Promise<void> => {
      calls.push('drain');
      await (options.drain?.() ?? Promise.resolve());
    },
    server: { address: (): { port: number } => ({ port: 1234 }) },
  };
  return {
    calls,
    boots,
    buildApp: async (bootOptions): Promise<TestAppInstance> => {
      boots.push(bootOptions);
      await options.build?.(bootOptions);
      return app;
    },
  };
}

const DB = { host: '127.0.0.1', port: 3306, schema: 'iridium_w0' };

/**
 * Adversarial ambient values belong to these tests, never to the harness. The worker is handed back
 * exactly what it had so this file cannot colour another one's run.
 */
const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe('testkit.start-server.unit [area:testkit]', () => {
  it.each(['8', '4', undefined])(
    'reports the observed in-process threadpool setting %s without pretending extraEnv resizes it',
    async (threadpoolSize) => {
      if (threadpoolSize === undefined) delete process.env['UV_THREADPOOL_SIZE'];
      else process.env['UV_THREADPOOL_SIZE'] = threadpoolSize;
      const before = { ...process.env };
      const { buildApp, boots } = doubleApp();
      const server = await startServer({
        mode: 'in-process',
        db: DB,
        buildApp,
        extraEnv: { UV_THREADPOOL_SIZE: '32' },
      });
      try {
        expect(boots[0]?.env?.['UV_THREADPOOL_SIZE']).toBe(threadpoolSize);
        expect(Object.keys(boots[0]?.env ?? {}).includes('UV_THREADPOOL_SIZE')).toBe(
          threadpoolSize !== undefined,
        );
        expect(Object.isFrozen(boots[0]?.env)).toBe(true);
        expect({ ...process.env }).toStrictEqual(before);
      } finally {
        await server.stop();
      }
    },
  );

  it('leaves container and child fixture environments independent of the host pool', () => {
    process.env['UV_THREADPOOL_SIZE'] = '16';
    const options = { ...DB, publicOrigin: 'http://127.0.0.1:1234' };

    // The child merges this with its inherited environment at spawn. Docker merges it with the
    // image's ENV instead, so copying the host value here would silently replace the image default.
    expect(buildServerEnv(options)).not.toHaveProperty('UV_THREADPOOL_SIZE');
    expect(buildServerEnv({ ...options, extraEnv: { UV_THREADPOOL_SIZE: '12' } })).toHaveProperty(
      'UV_THREADPOOL_SIZE',
      '12',
    );
    expect(process.env['UV_THREADPOOL_SIZE']).toBe('16');
  });
  it('drains before it closes, the way SIGTERM does in child mode', async () => {
    const { calls, buildApp } = doubleApp();
    const server = await startServer({ mode: 'in-process', db: DB, buildApp });

    await server.stop();

    expect(calls).toStrictEqual(['listen', 'drain', 'close']);
  });

  it('closes anyway when the drain overruns, and says how long it waited', async () => {
    // A drain that never settles must not become a harness that never returns: production answers an
    // overrun by exiting the process, and a test run cannot.
    const { calls, buildApp } = doubleApp({ drain: () => new Promise<void>(() => undefined) });
    const server = await startServer({ mode: 'in-process', db: DB, buildApp });

    const warnings: string[] = [];
    const warn = console.warn;
    // eslint-disable-next-line no-console -- the harness's one log line is the subject of this case
    console.warn = (message: unknown): void => {
      warnings.push(String(message));
    };
    try {
      await server.stop({ drainTimeoutMs: 25 });
    } finally {
      // eslint-disable-next-line no-console -- restored immediately; see above
      console.warn = warn;
    }

    expect(calls).toStrictEqual(['listen', 'drain', 'close']);
    expect(warnings.join('\n')).toMatch(/shutdown drain did not finish in \d+ ms; closing anyway/);
  });

  it('closes anyway when the drain rejects, so a failure cannot strand a listening server', async () => {
    const { calls, buildApp } = doubleApp({
      drain: () => Promise.reject(new Error('a writer is parked in backpressure')),
    });
    const server = await startServer({ mode: 'in-process', db: DB, buildApp });

    const warnings: string[] = [];
    const warn = console.warn;
    // eslint-disable-next-line no-console -- the harness's one log line is the subject of this case
    console.warn = (message: unknown): void => {
      warnings.push(String(message));
    };
    try {
      await server.stop();
    } finally {
      // eslint-disable-next-line no-console -- restored immediately; see above
      console.warn = warn;
    }

    expect(calls).toStrictEqual(['listen', 'drain', 'close']);
    expect(warnings.join('\n')).toContain('a writer is parked in backpressure');
  });

  it('closes an instance that exposes no drain, so a double need not implement one', async () => {
    const calls: string[] = [];
    const app: TestAppInstance = {
      listen: (): Promise<string> => {
        calls.push('listen');
        return Promise.resolve('http://127.0.0.1:0');
      },
      close: (): Promise<void> => {
        calls.push('close');
        return Promise.resolve();
      },
      server: { address: (): { port: number } => ({ port: 1234 }) },
    };
    const server = await startServer({
      mode: 'in-process',
      db: DB,
      buildApp: () => Promise.resolve(app),
    });

    await server.stop();

    expect(calls).toStrictEqual(['listen', 'close']);
  });

  it('refuses to kill or restart an in-process server, naming what to do instead', async () => {
    const { buildApp } = doubleApp();
    const server = await startServer({ mode: 'in-process', db: DB, buildApp });
    try {
      await expect(server.kill()).rejects.toThrow(/cannot be SIGKILLed/);
      await expect(server.restart()).rejects.toThrow(/'child' and 'container' modes only/);
    } finally {
      await server.stop();
    }
  });

  it('carries the faults and collaboration knobs an in-process boot is given', async () => {
    const before = { ...process.env };
    const { buildApp, boots } = doubleApp();
    const server = await startServer({
      mode: 'in-process',
      db: DB,
      buildApp,
      faults: [{ point: 'store.throw', count: 1 }],
      collab: { debounceMs: 25, ticketTtlS: 5 },
    });
    try {
      expect(boots[0]?.env).toMatchObject({
        IRIDIUM_FAULT: 'store.throw:1',
        COLLAB_DEBOUNCE_MS: '25',
        COLLAB_TICKET_TTL_S: '5',
      });
      expect({ ...process.env }).toStrictEqual(before);
    } finally {
      await server.stop();
    }
  });

  it('omits optional settings from a later boot without changing the prior snapshot', async () => {
    const first = doubleApp();
    const withFaults = await startServer({
      mode: 'in-process',
      db: DB,
      buildApp: first.buildApp,
      limits: { maxLoadedDocs: 8 },
      collab: { debounceMs: 25 },
    });
    expect(first.boots[0]?.env).toMatchObject({
      COLLAB_MAX_LOADED_DOCS: '8',
      COLLAB_DEBOUNCE_MS: '25',
    });
    await withFaults.stop();

    // The stopped instance retains its own values; the next boot receives a separate configuration.
    const second = doubleApp();
    const plain = await startServer({ mode: 'in-process', db: DB, buildApp: second.buildApp });
    try {
      expect(second.boots[0]?.env?.['COLLAB_MAX_LOADED_DOCS']).toBeUndefined();
      expect(second.boots[0]?.env?.['COLLAB_DEBOUNCE_MS']).toBeUndefined();
      expect(first.boots[0]?.env).toMatchObject({
        COLLAB_MAX_LOADED_DOCS: '8',
        COLLAB_DEBOUNCE_MS: '25',
      });
    } finally {
      await plain.stop();
    }
  });

  it('isolates arbitrary extra environment keys from later boots and the ambient process', async () => {
    process.env['METRICS_TOKEN'] = 'ambient-metrics-not-a-secret';
    process.env['AUTH_PASSWORD_PEPPER_V73'] = 'ambient-pepper-not-a-secret';
    process.env['COLLAB_MAX_LOADED_DOCS'] = '999';
    const before = { ...process.env };
    const configured = doubleApp();
    const server = await startServer({
      mode: 'in-process',
      db: DB,
      buildApp: configured.buildApp,
      extraEnv: {
        METRICS_TOKEN: 'instance-metrics-not-a-secret',
        AUTH_PASSWORD_PEPPER_V73: 'instance-pepper-not-a-secret',
      },
    });
    try {
      expect(configured.boots[0]?.env).toMatchObject({
        METRICS_TOKEN: 'instance-metrics-not-a-secret',
        AUTH_PASSWORD_PEPPER_V73: 'instance-pepper-not-a-secret',
      });
      expect(configured.boots[0]?.env?.['COLLAB_MAX_LOADED_DOCS']).toBeUndefined();
      expect({ ...process.env }).toStrictEqual(before);
    } finally {
      await server.stop();
    }

    const unconfigured = doubleApp();
    const plain = await startServer({
      mode: 'in-process',
      db: DB,
      buildApp: unconfigured.buildApp,
    });
    try {
      expect(unconfigured.boots[0]?.env?.['METRICS_TOKEN']).toBeUndefined();
      expect(unconfigured.boots[0]?.env?.['AUTH_PASSWORD_PEPPER_V73']).toBeUndefined();
      expect({ ...process.env }).toStrictEqual(before);
    } finally {
      await plain.stop();
    }
    expect({ ...process.env }).toStrictEqual(before);
  });

  it('keeps overlapping asynchronous boots independent without restoring over ambient changes', async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const first = doubleApp({
      build: async () => {
        entered.resolve(undefined);
        await release.promise;
      },
    });
    const firstStart = startServer({
      mode: 'in-process',
      db: { ...DB, schema: 'iridium_first' },
      buildApp: first.buildApp,
      extraEnv: { METRICS_TOKEN: 'first-metrics-not-a-secret' },
    });
    await entered.promise;
    try {
      process.env['METRICS_TOKEN'] = 'ambient-changed-during-boot-not-a-secret';
      const during = { ...process.env };
      const second = doubleApp();
      const secondServer = await startServer({
        mode: 'in-process',
        db: { ...DB, schema: 'iridium_second' },
        buildApp: second.buildApp,
        extraEnv: { METRICS_TOKEN: 'second-metrics-not-a-secret' },
      });
      try {
        expect(first.boots[0]?.env).toMatchObject({
          METRICS_TOKEN: 'first-metrics-not-a-secret',
          DATABASE_URL: expect.stringContaining('/iridium_first'),
        });
        expect(second.boots[0]?.env).toMatchObject({
          METRICS_TOKEN: 'second-metrics-not-a-secret',
          DATABASE_URL: expect.stringContaining('/iridium_second'),
        });
        expect(first.boots[0]?.env).not.toBe(second.boots[0]?.env);
        expect({ ...process.env }).toStrictEqual(during);
      } finally {
        await secondServer.stop();
      }
    } finally {
      release.resolve(undefined);
      const firstServer = await firstStart;
      await firstServer.stop();
    }
    expect(first.boots[0]?.env?.['METRICS_TOKEN']).toBe('first-metrics-not-a-secret');
    expect(process.env['METRICS_TOKEN']).toBe('ambient-changed-during-boot-not-a-secret');
  });

  it.each(['build', 'listen'] as const)(
    'leaves environment untouched when %s fails',
    async (stage) => {
      const before = { ...process.env };
      const failure = new Error(`deliberate ${stage} failure`);
      const failed = doubleApp(
        stage === 'build'
          ? { build: () => Promise.reject(failure) }
          : { listen: () => Promise.reject(failure) },
      );
      await expect(
        startServer({
          mode: 'in-process',
          db: DB,
          buildApp: failed.buildApp,
          extraEnv: { METRICS_TOKEN: 'failed-boot-metrics-not-a-secret' },
        }),
      ).rejects.toBe(failure);
      expect(failed.boots[0]?.env?.['METRICS_TOKEN']).toBe('failed-boot-metrics-not-a-secret');
      expect({ ...process.env }).toStrictEqual(before);

      const following = doubleApp();
      const server = await startServer({
        mode: 'in-process',
        db: DB,
        buildApp: following.buildApp,
      });
      try {
        expect(following.boots[0]?.env?.['METRICS_TOKEN']).toBeUndefined();
        expect({ ...process.env }).toStrictEqual(before);
      } finally {
        await server.stop();
      }
    },
  );
});
