/**
 * Vitest `globalSetup` for the `chaos` project only (root `vitest.config.ts` lists it after
 * `mysql.global.ts`, and the order matters: this one attaches to the network and the MySQL container
 * that one created).
 *
 * It creates the `mysql` proxy in front of `mysql:3306`. The `collab` proxy is created per test, after
 * a child-process server has a port to proxy (10-testing-and-quality.md, "Environment: `startTestEnv`").
 */
import type { TestProject } from 'vitest/node';

import { MYSQL_NETWORK_ALIAS } from '../env/mysql.ts';
import { MYSQL_PROXY_NAME, startToxiproxy } from '../env/toxiproxy.ts';
import { requireSharedTestEnv } from './shared-env.ts';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = requireSharedTestEnv();
  if (env.network === undefined) {
    throw new Error(
      '@iridium/testkit: the chaos fixture needs a shared Docker network; mysql.global.ts creates one.',
    );
  }

  const toxiproxy = await startToxiproxy({ network: env.network });
  const mysqlProxy = await toxiproxy.createProxy(MYSQL_PROXY_NAME, `${MYSQL_NETWORK_ALIAS}:3306`);

  project.provide('iridiumToxiproxy', {
    controlUrl: toxiproxy.controlUrl,
    mysqlProxy: { host: mysqlProxy.host, port: mysqlProxy.port },
  });
  console.info(
    `[testkit] toxiproxy mysql proxy on ${mysqlProxy.host}:${String(mysqlProxy.port)} -> ${MYSQL_NETWORK_ALIAS}:3306`,
  );

  return async (): Promise<void> => {
    await toxiproxy.stop();
  };
}
