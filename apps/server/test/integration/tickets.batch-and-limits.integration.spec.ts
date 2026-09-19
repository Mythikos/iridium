/**
 * `tickets.batch-and-limits` (04-auth-and-access-control.md section 7; 09-api-reference.md section
 * 2.3; A24): `POST /auth/collab-tickets` mints a batch of single-use `/collab` tickets bound to the
 * caller's session, the batch size is bounded to 1..50, and each ticket lives `TICKET_TTL_S` and is
 * consumed exactly once. The real provider retries a rate-limited ticket request while a sibling document remains connected. The store's consume is also exercised here
 * as the seam the collaboration server will call, so the binding and single-use are proven end to end.
 */
import { LIMITS, SessionId } from '@iridium/contracts';
import {
  CollabTicketError,
  createCollabSocket,
  createNoteClient,
  noteClientWebSocket,
  restTicketSource,
  type NoteClient,
} from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { seedUser, signInDesktop } from '../support/seed.ts';

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

describe('tickets.batch-and-limits.integration [area:auth]', () => {
  it('retries a real 429 in the provider ticket getter while another document keeps its healthy socket', async () => {
    const admin = await context.server.seed.admin();
    const user = await context.server.seed.user({ email: 'ticket-retry@iridium.test', admin });
    const vault = await context.server.seed.vault({
      name: 'Ticket retry',
      members: [[user, 'editor']],
      admin,
    });
    const first = await context.server.seed.note({
      vault,
      name: 'Healthy document',
      markdown: 'healthy\n',
      admin,
    });
    const second = await context.server.seed.note({
      vault,
      name: 'Attaching document',
      markdown: 'retry\n',
      admin,
    });
    const sessions = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        context.server.sessions.signInDesktop(user, `ticket-budget-${index}`),
      ),
    );
    const ip = '198.51.100.77';
    const rest = sessions.map((session) => desktopClient(context, session.token, ip));
    const client = rest[0];
    const signed = sessions[0];
    if (client === undefined || signed === undefined)
      throw new Error('The ticket fixture requires a session.');
    const socket = createCollabSocket({
      url: context.server.wsUrl,
      webSocketPolyfill: noteClientWebSocket({ defaultOrigin: context.origin }),
    });
    const connected: NoteClient[] = [];
    try {
      const healthy = createNoteClient({
        socket,
        noteId: first.id,
        userId: user.id,
        sessionId: signed.session.id,
        tickets: restTicketSource(client, { batch: 1 }),
      });
      connected.push(healthy);
      await healthy.waitFor('saved');
      // Spend the actual 1,000/IP budget through HTTP, spread across four sessions so the
      // separate 300/session limit remains below its ceiling. The healthy attachment spent one.
      const perSession = LIMITS.TICKETS_PER_MINUTE_PER_IP / sessions.length;
      await Promise.all(
        rest.map(async (source, index) => {
          const remaining = perSession - (index === 0 ? 1 : 0);
          for (let request = 0; request < remaining; request += 1) {
            // eslint-disable-next-line no-await-in-loop -- consume one real request from the budget
            const response = await source.post('/auth/collab-tickets', { json: { count: 1 } });
            expect(response.status).toBe(201);
          }
        }),
      );
      const source = restTicketSource(client, { batch: 1 });
      const retryClock = new ManualClock(context.clock.now());
      let failures = 0;
      let attempts = 0;
      const attaching = createNoteClient({
        socket,
        noteId: second.id,
        userId: user.id,
        sessionId: signed.session.id,
        clock: retryClock,
        tickets: {
          invalidate(rejectedTicket: string): void {
            source.invalidate(rejectedTicket);
          },
          async next(): Promise<string> {
            attempts += 1;
            try {
              return await source.next();
            } catch (error) {
              if (error instanceof CollabTicketError && error.status === 429) failures += 1;
              throw error;
            }
          },
        },
      });
      connected.push(attaching);
      await expect.poll(() => failures).toBe(1);
      expect(healthy.closes).toEqual([]);
      expect(healthy.session.input.socket).toBe('connected');
      expect(healthy.saveState).toBe('saved');
      // Advance the server's real IP budget and the product getter's injected retry clock.
      // Neither HTTP nor the WebSocket transport is mocked or replaced.
      context.clock.jump(context.clock.now() + 60_001);
      await retryClock.advance(1_000);
      await attaching.waitFor('saved');
      expect(attempts).toBe(2);
      expect(failures).toBe(1);
      expect(attaching.closes).toEqual([]);
      expect(healthy.closes).toEqual([]);
      expect(healthy.session.input.socket).toBe('connected');
    } finally {
      await Promise.all(connected.map((note) => note.close()));
      socket.destroy();
    }
  });

  it('mints a batch bound to the session, each ticket single-use with the published TTL', async () => {
    const user = await seedUser(context, { email: 'tickets@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    const response = await desktopClient(context, token).post<{
      tickets: string[];
      expiresIn: number;
    }>('/auth/collab-tickets', { json: { count: 3 } });
    expect(response.status).toBe(201);
    expect(response.body.expiresIn).toBe(LIMITS.TICKET_TTL_S);
    expect(response.body.tickets).toHaveLength(3);
    for (const ticket of response.body.tickets) expect(ticket.startsWith('irid_tkt_')).toBe(true);

    // Each ticket consumes once, to this session and user (the seam `/collab` will call).
    const first = response.body.tickets[0] ?? '';
    const binding = context.app.auth.tickets.consume(first);
    expect(binding).toMatchObject({ sessionId, userId: user.id });
    expect(context.app.auth.tickets.consume(first)).toBeNull();
  });

  it('bounds the batch size to 1..50', async () => {
    const user = await seedUser(context, { email: 'ticket-bounds@example.test' });
    const { token } = await signInDesktop(context, user);
    expect(
      (await desktopClient(context, token).post('/auth/collab-tickets', { json: { count: 0 } }))
        .status,
    ).toBe(422);
    expect(
      (
        await desktopClient(context, token).post('/auth/collab-tickets', {
          json: { count: LIMITS.TICKET_BATCH_MAX + 1 },
        })
      ).status,
    ).toBe(422);
    const max = await desktopClient(context, token).post<{ tickets: string[] }>(
      '/auth/collab-tickets',
      {
        json: { count: LIMITS.TICKET_BATCH_MAX },
      },
    );
    expect(max.status).toBe(201);
    expect(max.body.tickets).toHaveLength(LIMITS.TICKET_BATCH_MAX);
  });

  it('expires the batch at the TTL, so the seam refuses it afterward', async () => {
    const user = await seedUser(context, { email: 'ticket-ttl@example.test' });
    const { token } = await signInDesktop(context, user);
    const response = await desktopClient(context, token).post<{ tickets: string[] }>(
      '/auth/collab-tickets',
      {
        json: { count: 1 },
      },
    );
    const ticket = response.body.tickets[0] ?? '';
    await context.clock.advance(LIMITS.TICKET_TTL_S * 1000 + 1);
    expect(context.app.auth.tickets.consume(ticket)).toBeNull();
  });

  it('refuses to mint a ticket for a caller without a session', async () => {
    const anonymous = await desktopClient(context).post('/auth/collab-tickets', {
      json: { count: 1 },
    });
    expect(anonymous.status).toBe(401);
  });

  it('loads the live session a consumed ticket names, and reports it dead once revoked (section 7.3)', async () => {
    const user = await seedUser(context, { email: 'tickets-live@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    const client = desktopClient(context, token);
    const minted = await client.post<{ tickets: string[] }>('/auth/collab-tickets', {
      json: { count: 1 },
    });
    const binding = context.app.auth.tickets.consume(minted.body.tickets[0] ?? '');
    expect(binding).toMatchObject({ sessionId, userId: user.id });
    // The seam `/collab`'s `onAuthenticate` calls after `consume`: by primary key, no secret.
    const live = await context.app.auth.sessions.loadLiveSession(SessionId.parse(sessionId));
    expect(live).toMatchObject({
      kind: 'user',
      sessionId,
      userId: user.id,
      sessionKind: 'desktop',
    });
    expect((await client.del('/auth/sessions/current')).status).toBe(204);
    await expect(
      context.app.auth.sessions.loadLiveSession(SessionId.parse(sessionId)),
    ).resolves.toStrictEqual({ dead: 'revoked' });
    await expect(
      context.app.auth.sessions.loadLiveSession(
        SessionId.parse('019948c4-0000-7000-8000-0000000000ff'),
      ),
    ).resolves.toBeNull();
  });
});
