/**
 * Serve the S14 mount by hand, for the external tools of the register row:
 *
 *   node --experimental-strip-types apps/server/test/spikes/support/s14-serve.ts
 *   <tools>/node_modules/.bin/conformance server --url http://127.0.0.1:<port>/mcp --scenario server-initialize
 *   <tools>/node_modules/.bin/mcp-inspector --cli http://127.0.0.1:<port>/mcp --transport http --method tools/list
 *
 * The process prints one JSON line with the origin and stays up until it is killed. The spec runs
 * the same tools itself; this runner exists so a reader can watch one scenario at a time.
 */
import { buildSpikeApp } from './app.ts';
import { mountMcp } from './mcp-mount.ts';

const spike = await buildSpikeApp();
const state = mountMcp(spike);
await spike.listen();
console.info(JSON.stringify({ origin: spike.origin, mounts: ['/mcp', '/mcp-owned'] }));

const report = (): void => {
  console.info(
    JSON.stringify({
      factoryCalls: state.factoryCalls.length,
      eras: [...new Set(state.factoryCalls.map((call) => call.era))],
      handlerErrors: state.handlerErrors,
      adapterErrors: state.adapterErrors,
      routeCatches: state.routeCatches,
      requestsThroughChain: state.chain.length,
    }),
  );
};
setInterval(report, 15_000).unref();
process.on('SIGINT', () => {
  report();
  void spike.close().then(() => process.exit(0));
});
