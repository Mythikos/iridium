import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assertDbaGrantScript } from './dba-grants.ts';

describe('testkit.dba-grants.unit [area:testkit]', () => {
  it('admits the exact generated artifact without replacing its deployment grammar', () => {
    const artifact = readFileSync(
      new URL('../../../../docs/ops/db-grants.sql', import.meta.url),
      'utf8',
    );
    expect(() => assertDbaGrantScript(artifact)).not.toThrow();
  });

  it.each([
    '',
    '-- No grants\n',
    "GRANT SELECT ON `iridium`.`users` TO 'outsider'@'%';",
    "GRANT SELECT ON `another_database`.`users` TO 'iridium_app'@'%';",
    "GRANT SELECT ON `iridium`.`users` TO 'iridium_app'@'%'; DROP TABLE users;",
    '/*!50000 DROP TABLE users */;',
  ])('refuses unrelated SQL or accounts before privileged execution: %s', (script) => {
    expect(() => assertDbaGrantScript(script)).toThrow(
      'unmodified generated Iridium DBA grant artifact',
    );
  });
});
