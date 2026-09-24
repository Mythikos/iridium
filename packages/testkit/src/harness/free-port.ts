/**
 * Reserving a loopback port before boot.
 *
 * `PUBLIC_ORIGIN` is not a cosmetic setting: the `/collab` Origin allowlist, the CSRF host guard, the
 * cookie flags and the MCP `resource` are all derived from it, and ARCH-09 is the rule that nothing
 * may disagree with it. A server that listened on an ephemeral port and *then* learned its own origin
 * would have to be told its origin twice, so the harness picks the port first and hands the same
 * number to `PORT` and to `PUBLIC_ORIGIN`. That is the one place this differs from the plan's
 * `listen({ port: 0 })` shorthand, and the reason is the guard it keeps exercised.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';

/**
 * Ask the kernel for a free ephemeral port on `127.0.0.1` and release it.
 *
 * The window between release and the server's own `listen` is why this is not used for a long-lived
 * fixture: a chaos restart re-uses the *same* number deliberately, so the process that just died is
 * the only plausible competitor for it.
 */
export async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('@iridium/testkit: could not reserve a loopback port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Where IANA's dynamic range starts; Windows and macOS allocate ephemeral ports from it. */
const IANA_DYNAMIC_FIRST_PORT = 49_152;

/** The lowest port a long-lived fixture takes, clear of the services a developer commonly runs. */
const FIXTURE_PORT_FLOOR = 20_000;

/** How many candidate ports a fixture reservation tries before it reports the host as exhausted. */
const FIXTURE_PORT_ATTEMPTS = 64;

/**
 * The first port the kernel hands out on its own: to `listen(0)`, to every outbound socket and, on
 * Linux, to Docker's published host ports.
 *
 * @internal Exported for the reservation's own unit test.
 */
export async function ephemeralPortFloor(): Promise<number> {
  let raw: string;
  try {
    raw = await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');
  } catch (error) {
    // Only Linux publishes its range here; every other host uses IANA's dynamic range.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return IANA_DYNAMIC_FIRST_PORT;
    }
    throw error;
  }
  const first = Number(raw.trim().split(/\s+/)[0]);
  if (!Number.isInteger(first) || first <= FIXTURE_PORT_FLOOR) {
    throw new Error(
      `@iridium/testkit: /proc/sys/net/ipv4/ip_local_port_range starts at "${raw.trim()}", which ` +
        `leaves no room above ${String(FIXTURE_PORT_FLOOR)} for a fixture port; widen the range's start.`,
    );
  }
  return first;
}

async function bindable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * A free loopback port for a fixture that is chosen once and bound much later, such as the chaos
 * collaboration port every chaos file binds its child server to.
 *
 * {@link reserveLoopbackPort} releases an ephemeral port, and in that window the kernel may hand the
 * same number to any outbound socket or to a container's published port: on a CI runner the chaos
 * child then failed with `EADDRINUSE`. A port below the ephemeral range is never assigned
 * implicitly, so only an explicit bind can take it, and each candidate is bound once to prove it
 * free, which also skips the ranges Windows reserves for Hyper-V.
 */
export async function reserveFixturePort(): Promise<number> {
  const ceiling = await ephemeralPortFloor();
  for (let attempt = 0; attempt < FIXTURE_PORT_ATTEMPTS; attempt += 1) {
    const candidate =
      FIXTURE_PORT_FLOOR + Math.floor(Math.random() * (ceiling - FIXTURE_PORT_FLOOR));
    // eslint-disable-next-line no-await-in-loop -- candidates are tried one at a time until one binds
    if (await bindable(candidate)) return candidate;
  }
  throw new Error(
    `@iridium/testkit: no free loopback port between ${String(FIXTURE_PORT_FLOOR)} and ` +
      `${String(ceiling)} after ${String(FIXTURE_PORT_ATTEMPTS)} attempts; free ports in that range.`,
  );
}
