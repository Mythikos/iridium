/** Long-running source markers must survive bundling as explicit admission metadata. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LONG_RUNNING_MIGRATIONS, MIGRATION_NAMES } from '../../src/db/migrations.ts';

describe('migrations.admission.guard [area:ops]', () => {
  it('registers every migration and exactly the marked long-running files', () => {
    const directory = join(import.meta.dirname, '../../migrations');
    const files = readdirSync(directory)
      .filter((name) => /^\d{4}_.*\.ts$/.test(name))
      .toSorted();
    expect(files.map((name) => name.slice(0, -3))).toEqual(MIGRATION_NAMES);
    const marked = files
      .filter((file) =>
        readFileSync(join(directory, file), 'utf8').startsWith('// -- iridium: long-running'),
      )
      .map((file) => file.slice(0, -3));
    expect([...LONG_RUNNING_MIGRATIONS].toSorted()).toEqual(marked);
  });
});
