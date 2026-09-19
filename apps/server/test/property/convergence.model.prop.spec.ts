/** N real-codec peers over the actual MySQL writer, loader, compactor and retention operation. */
import { it } from '@fast-check/vitest';
import { keepSchema, PROP_DB } from '@iridium/testkit';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe } from 'vitest';

import {
  convergenceCommands,
  convergenceSoakCommands,
  MAX_PEERS,
  runConvergenceModel,
} from '../../src/collab/persistence/testing/convergence-model.ts';
import { startDatabaseModel, type DatabaseModelFixture } from '../support/persistence-model.ts';

// Each example creates a new note; retain the route-created cast for this model property.
keepSchema();
let fixture: DatabaseModelFixture;
beforeAll(async () => {
  fixture = await startDatabaseModel();
});
afterAll(async () => {
  await fixture?.stop();
});

describe('convergence.model.prop [area:collab] [spec:concurrent-editing] [spec:initialization-reconnection] [hp:HP-1] [hp:HP-2]', () => {
  it.prop(
    [
      fc.integer({ min: 2, max: MAX_PEERS }),
      fc.commands(convergenceCommands, { maxCommands: PROP_DB.maxCommands }),
    ],
    PROP_DB,
  )(
    'converges through real persistence, compaction, prune, restart and protocol re-sync',
    (peers, sequence) =>
      runConvergenceModel(peers, sequence, (markdown) => fixture.create(markdown)),
  );
  // Plan 10 adds exactly one long soak to the unchanged regular PROP_DB budget on nightly runs.
  if (process.env['IRIDIUM_PROP_SOAK'] === '1') {
    it.prop([convergenceSoakCommands], { ...PROP_DB, numRuns: 1 })(
      'soaks ten peers through 2000 commands with a restart every hundred commands',
      (commands) => runConvergenceModel(10, commands, (markdown) => fixture.create(markdown)),
    );
  }
});
