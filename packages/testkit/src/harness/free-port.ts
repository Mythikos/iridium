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
