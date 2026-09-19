/** Nightly contract profiles, each on a separately seeded disposable production deployment. */
import { runSchemathesis } from '../packages/testkit/dist/index.js';

for (const principal of ['admin', 'outsider'] as const) {
  // eslint-disable-next-line no-await-in-loop -- each profile owns a full deployment and its cleanup
  const result = await runSchemathesis({ profile: 'full', principal });
  console.info(`${principal}: ${result.reportPath}`);
  if (result.exitCode !== 0) {
    console.error(result.output);
    process.exitCode = 1;
  }
}
