/**
 * Vitest `globalSetup` for the `chaos` project only (root `vitest.config.ts` lists it after
 * `mysql.global.ts`, and the order matters: this one attaches to the network and the MySQL container
 * that one created).
 *
 * It creates the `mysql` proxy in front of `mysql:3306`. The `collab` proxy is created per test, after
 * a child-process server has a port to proxy (10-testing-and-quality.md, "Environment: `startTestEnv`").
 */
import { TestContainers } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { MYSQL_NETWORK_ALIAS } from '../env/mysql.ts';
import { COLLAB_PROXY_NAME, MYSQL_PROXY_NAME, startToxiproxy } from '../env/toxiproxy.ts';
import { withDeadline } from '../harness/deadline.ts';
import { reserveFixturePort } from '../harness/free-port.ts';
import { requireSharedTestEnv } from './shared-env.ts';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = requireSharedTestEnv();
  if (env.network === undefined) {
    throw new Error(
      '@iridium/testkit: the chaos fixture needs a shared Docker network; mysql.global.ts creates one.',
    );
  }

  // Create the portable SSH host-port forwarder before Toxiproxy joins its network.
  // The sequential chaos files bind their child to this port when exercising WS toxics, long after
  // it is chosen, so it comes from below the ephemeral range (`reserveFixturePort`).
  const collabServerPort = await reserveFixturePort();
  // Testcontainers unrefs its SSH socket before requesting the forwarding rule. This referenced
  // deadline keeps global setup alive until that rule is acknowledged and fails a stuck setup.
  await withDeadline(TestContainers.exposeHostPorts(collabServerPort), {
    timeoutMs: 60_000,
    description: 'the chaos host-port forwarding rule',
  });
  const toxiproxy = await startToxiproxy({ network: env.network });
  const mysqlProxy = await toxiproxy.createProxy(MYSQL_PROXY_NAME, `${MYSQL_NETWORK_ALIAS}:3306`);

  const collabProxy = await toxiproxy.createProxy(
    COLLAB_PROXY_NAME,
    `host.testcontainers.internal:${String(collabServerPort)}`,
  );

  project.provide('iridiumToxiproxy', {
    controlUrl: toxiproxy.controlUrl,
    collabServerPort,
    collabProxy: { host: collabProxy.host, port: collabProxy.port },
    mysqlProxy: { host: mysqlProxy.host, port: mysqlProxy.port },
  });
  console.info(
    `[testkit] toxiproxy mysql proxy on ${mysqlProxy.host}:${String(mysqlProxy.port)} -> ${MYSQL_NETWORK_ALIAS}:3306`,
  );

  return async (): Promise<void> => {
    await toxiproxy.stop();
  };
}
