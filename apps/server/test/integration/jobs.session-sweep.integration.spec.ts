/** Expired credentials enter through public routes; maintenance owns physical removal. */
import { LIMITS } from '@iridium/contracts';
import { issueTickets } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { appDb } from '../../src/rest/handler-context.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('jobs.session-sweep.integration [area:jobs]', () => {
  it('sweeps ticket entries and expired session/setup rows while preserving live credentials', async () => {
    const clock = new ManualClock(Date.now());
    const cleanupTime = clock.now();
    const harness = await startCollab({ clock, extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.server.loginAs(cast.editorA);
      await issueTickets(client, 2);
      const app = harness.application();
      const db = appDb(app);
      const sessions = await db.selectFrom('sessions').select('id').execute();
      const links = await db.selectFrom('password_setup_tokens').select('id').execute();
      expect(sessions.length).toBeGreaterThan(0);
      expect(links.length).toBeGreaterThan(0);
      expect(app.auth.tickets.size).toBeGreaterThanOrEqual(2);
      const sweep = async () => {
        const queued = await app.jobs.scheduler.enqueue(
          'session_ticket_sweep',
          {},
          { ownerFence: app.collab.ownerLease.captureFence() },
        );
        const done = await app.jobs.scheduler.runUntilSettled(queued.id);
        expect(done.status).toBe('succeeded');
        return done.result;
      };
      expect(await sweep()).toMatchObject({ sessions: 0, links: 0 });
      expect(app.auth.tickets.size).toBeGreaterThanOrEqual(2);
      clock.jump(clock.now() + LIMITS.TICKET_TTL_S * 1000);
      expect(await sweep()).toMatchObject({ sessions: 0, links: 0 });
      expect(app.auth.tickets.size).toBe(0);
      clock.jump(clock.now() + 366 * 86_400_000);
      expect(await sweep()).toMatchObject({ sessions: sessions.length, links: links.length });
      expect(await db.selectFrom('sessions').select('id').execute()).toEqual([]);
      expect(await db.selectFrom('password_setup_tokens').select('id').execute()).toEqual([]);
      expect(await sweep()).toMatchObject({ sessions: 0, links: 0 });
    } finally {
      clock.jump(cleanupTime);
      await harness.close();
    }
  });
});
