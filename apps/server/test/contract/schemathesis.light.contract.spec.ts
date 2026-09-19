/** M1 light gate over its shipped routes; later milestones extend the same route coverage. */
import { runSchemathesis } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

describe('schemathesis.light.contract [area:contracts]', () => {
  it('passes every Schemathesis check as a non-admin editor at fifty examples per operation', async () => {
    const result = await runSchemathesis({ profile: 'light' });
    expect(result.exitCode, result.output).toBe(0);
  }, 1_200_000);
});
