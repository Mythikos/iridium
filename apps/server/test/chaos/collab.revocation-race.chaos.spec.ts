/** CH-14: real auth races and 200 live document connections behind 400 ms MySQL latency. */
import { NoteId, UserId, VaultId } from '@iridium/contracts';
import {
  assertSchemaName,
  connectToxiproxy,
  createNoteClient,
  FAULT,
  MYSQL_PROXY_NAME,
  restTicketSource,
  TOXIC,
  waitFor,
  workerSchemaName,
  type NoteClient,
  type SeededUser,
  type ToxicHandle,
} from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

import { NIGHTLY_CHAOS, waitFault } from '../support/collab-chaos.ts';
import { startCollab, type CollabHarness } from '../support/collab-harness.ts';

const ITERATIONS = NIGHTLY_CHAOS ? 50 : 10;
const LOAD_NOTES = 20;
const LOAD_USERS = 10;
const SOURCE_ADDRESSES = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5'] as const;
const MYSQL_LATENCY_MS = 400;
const CLOSE_DEADLINE_MS = 1_000;
const cases = Array.from({ length: ITERATIONS }, (_, index) => ({
  iteration: index + 1,
  total: ITERATIONS,
}));
const authCases = cases.flatMap((iteration) =>
  (['auth-first', 'revoke-first'] as const).map((order) => ({
    iteration: iteration.iteration,
    total: iteration.total,
    order,
  })),
);

interface CloseObservation {
  readonly at: number;
  readonly reason: string;
}

/** Timestamp the real provider callback, without adding waiter polling time to the observed event. */
function observeCloses(clients: readonly NoteClient[]): Map<NoteClient, CloseObservation> {
  const observed = new Map<NoteClient, CloseObservation>();
  for (const client of clients) {
    const provider = client.provider;
    if (provider === null) throw new Error('A revocation subject must have a live provider.');
    provider.on('close', ({ event }: { event: { reason: string } }) => {
      if (!observed.has(client)) observed.set(client, { at: Date.now(), reason: event.reason });
    });
  }
  return observed;
}

function removalQuery(harness: CollabHarness, vaultId: string, userId: string): string {
  assertSchemaName(harness.server.schema);
  const vault = VaultId.parse(vaultId).replaceAll('-', '');
  const user = UserId.parse(userId).replaceAll('-', '');
  return `SELECT id, TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', occurred_at) / 1000
    FROM ${harness.server.schema}.audit_events
    WHERE action='vault.member.removed' AND vault_id=UNHEX('${vault}')
      AND target_id=UNHEX('${user}') ORDER BY id;`;
}

interface CommitObservation {
  readonly auditId: number;
  readonly occurredAt: number;
  /** START of the last read that found no committed audit row: a conservative lower COMMIT bound. */
  readonly lastAbsentStarted: number;
  /** END of the first read that could see the committed row: an upper COMMIT bound. */
  readonly firstVisibleEnded: number;
}

/** Independent, unproxied MySQL observations; the HTTP response and product logs are not a clock. */
async function observeCommit(
  harness: CollabHarness,
  query: string,
  initialAbsentStarted: number,
  signal: AbortSignal,
): Promise<CommitObservation> {
  let lastAbsentStarted = initialAbsentStarted;
  return waitFor(
    async () => {
      const started = Date.now();
      const rows = await harness.sql.rows(query);
      const ended = Date.now();
      if (rows.length === 0) {
        lastAbsentStarted = started;
        return undefined;
      }
      expect(rows).toHaveLength(1);
      const auditId = Number(rows[0]?.[0]);
      const occurredAt = Number(rows[0]?.[1]);
      expect(auditId).toBeGreaterThan(0);
      expect(Number.isFinite(occurredAt)).toBe(true);
      return { auditId, occurredAt, lastAbsentStarted, firstVisibleEnded: ended };
    },
    {
      timeoutMs: 120_000,
      intervalMs: 5,
      signal,
      description: 'the committed membership audit row',
    },
  );
}

/** The actor/timestamp oracle is separate from the socket deadline and from the content replay. */
async function assertNoPostRevocationRows(
  harness: CollabHarness,
  auditId: number,
  userId: string,
  noteIds: readonly string[],
): Promise<void> {
  const user = UserId.parse(userId).replaceAll('-', '');
  const notes = noteIds.map((note) => `UNHEX('${NoteId.parse(note).replaceAll('-', '')}')`);
  const rows = await harness.sql.rows(`SELECT u.seq, HEX(u.note_id), u.created_at, a.occurred_at
    FROM ${harness.server.schema}.note_updates u
    JOIN ${harness.server.schema}.audit_events a ON a.id=${String(auditId)}
    WHERE u.actor_id=UNHEX('${user}') AND u.note_id IN (${notes.join(',')})
      AND u.created_at > a.occurred_at;`);
  expect(rows, 'No revoked-actor update may be created after the membership audit event.').toEqual(
    [],
  );
}

describe('collab.revocation-race.chaos [spec:live-revocation] [hp:HP-3]', () => {
  it.for(authCases)(
    'refuses a pre-issued ticket and pending update with $order — iteration $iteration/$total',
    async ({ order }) => {
      const harness = await startCollab({ mode: 'child' });
      const pendingClients: NoteClient[] = [];
      try {
        await harness.server.waitReady();
        const seeded = await harness.server.seed.kernel();
        const [victim, observer] = await Promise.all([
          harness.open(seeded.editorA, seeded.note.id),
          harness.open(seeded.editorB, seeded.note.id),
        ]);
        await Promise.all([victim.waitFor('saved'), observer.waitFor('saved')]);
        const guaranteed = victim.marker('before-revocation-committed');
        await victim.waitFor('saved');
        const [oldTicket] = await harness.server.tickets.issue(seeded.editorA, 1);
        if (oldTicket === undefined) throw new Error('A pre-revocation ticket is required.');
        const faults = await harness.server.faults.arm(FAULT.authSlow, { arg: 3_000 });
        let pendingMarker = '';
        const startPending = async (): Promise<NoteClient> => {
          const logStart = harness.logs.length;
          const client = createNoteClient({
            wsUrl: harness.server.wsUrl,
            noteId: seeded.note.id,
            userId: seeded.editorA.id,
            tickets: {
              next: async () => oldTicket,
              // Reuse this pre-revocation ticket, never mint a replacement that changes the race.
              invalidate(): void {},
            },
          });
          pendingClients.push(client);
          pendingMarker = client.marker('must-not-apply-after-revocation');
          await waitFault(harness, FAULT.authSlow, logStart);
          return client;
        };
        const pending = order === 'auth-first' ? await startPending() : null;
        const revoked = victim.waitClosed({ timeoutMs: CLOSE_DEADLINE_MS });
        const [removed, closed] = await Promise.all([
          seeded.admin.client.del(`/vaults/${seeded.vault.id}/members/${seeded.editorA.id}`, {
            headers: { 'if-match': '"1"' },
          }),
          revoked,
          Promise.resolve().then(() => victim.marker('racing-before-removal')),
        ]);
        expect(removed.status).toBe(204);
        expect(closed.collabReason).toBe('revoked');
        const refused = order === 'revoke-first' ? await startPending() : pending;
        if (refused === null) throw new Error('The pending authentication was not started.');
        expect(refused.closes).toEqual([]);
        expect((await refused.waitClosed({ timeoutMs: 5_000 })).collabReason).toBe(
          'note-not-found',
        );
        await faults.disarm();
        const finalMarker = observer.marker('still-authorized-after-race');
        await observer.waitFor('saved');
        const durable = await harness.committed(seeded.note.id);
        expect(durable.text).toContain(guaranteed);
        expect(durable.text).toContain(finalMarker);
        expect(durable.text).not.toContain(pendingMarker);
        expect(refused.text.toJSON()).toContain(pendingMarker);
        expect(refused.states).not.toContain('saved');
        expect(durable.updates.map((update) => update.seq)).toEqual(
          Array.from({ length: durable.head }, (_, index) => index + 1),
        );
        const audit = await harness.sql.rows(
          removalQuery(harness, seeded.vault.id, seeded.editorA.id),
        );
        expect(audit).toHaveLength(1);
        await assertNoPostRevocationRows(harness, Number(audit[0]?.[0]), seeded.editorA.id, [
          seeded.note.id,
        ]);
      } finally {
        try {
          await Promise.all(pendingClients.map((client) => client.close()));
        } finally {
          await harness.close();
        }
      }
    },
  );

  it.for(cases)(
    'closes victims among 200 connections across 20 notes within 1 s of COMMIT — load iteration $iteration/$total',
    { timeout: 600_000 },
    async ({ iteration, total }) => {
      const provided = inject('iridiumToxiproxy');
      const proxy = connectToxiproxy(provided.controlUrl).proxy(
        MYSQL_PROXY_NAME,
        provided.mysqlProxy.host,
        provided.mysqlProxy.port,
      );
      const harness = await startCollab({
        mode: 'child',
        db: {
          ...provided.mysqlProxy,
          schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1'),
        },
      });
      const clients: NoteClient[] = [];
      const observations = new AbortController();
      let toxic: ToxicHandle | undefined;
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        // Reuse the real cast and its administrator's existing session: exactly ten account setup
        // and sign-in operations fit the unchanged per-IP credential route budgets.
        const existingUsers: readonly SeededUser[] = [
          cast.editorA,
          cast.editorB,
          cast.editorC,
          cast.viewer,
          cast.outsider,
          cast.admin,
        ];
        const promoted = await cast.admin.client.put(
          `/vaults/${cast.vault.id}/members/${cast.viewer.id}`,
          {
            json: { role: 'editor' },
            headers: { 'if-match': '"1"' },
          },
        );
        expect(promoted.status).toBe(200);
        const additional = await Promise.all(
          Array.from({ length: LOAD_USERS - existingUsers.length }, (_, index) =>
            harness.server.seed.user({
              admin: cast.admin,
              email: harness.server.seed.email(`revocation-load-${String(index)}`),
            }),
          ),
        );
        await Promise.all(
          [cast.outsider, ...additional].map(async (user) => {
            const response = await cast.admin.client.put(
              `/vaults/${cast.vault.id}/members/${user.id}`,
              { json: { role: 'editor' } },
            );
            expect(response.status).toBe(201);
          }),
        );
        const users: readonly SeededUser[] = [...existingUsers, ...additional];
        const notes = [
          cast.note,
          ...(await Promise.all(
            Array.from({ length: LOAD_NOTES - 1 }, (_, index) =>
              harness.server.seed.note({
                admin: cast.admin,
                vault: cast.vault,
                name: `Revocation load ${String(index + 1)}`,
                markdown: `load note ${String(index + 1)}\n`,
              }),
            ),
          )),
        ];
        const sessions = await Promise.all(
          users.map((user) =>
            user.id === cast.admin.id
              ? Promise.resolve({
                  client: cast.admin.client,
                  session: { id: cast.admin.sessionId },
                })
              : harness.server.sessions.current(user),
          ),
        );
        toxic = await proxy.addToxic(TOXIC.latency(MYSQL_LATENCY_MS));
        const ticketSources = sessions.map((session) =>
          restTicketSource(session.client, { batch: LOAD_NOTES }),
        );
        // Establish the prescribed steady load one note at a time under the same toxic. A burst
        // of 200 authentication/load operations would measure pool-acquisition overload instead
        // of revocation at 200 connected peers. All earlier sockets stay connected throughout.
        // Four real source IPs retain the unchanged 20/user and 50/IP caps.
        for (const note of notes) {
          const noteClients: NoteClient[] = [];
          for (const [userIndex, user] of users.entries()) {
            const session = sessions[userIndex];
            const tickets = ticketSources[userIndex];
            if (session === undefined || tickets === undefined)
              throw new Error('Every load user needs a real session and ticket source.');
            const localAddress = SOURCE_ADDRESSES[clients.length % SOURCE_ADDRESSES.length];
            if (localAddress === undefined) throw new Error('Missing load-peer source address.');
            const client = createNoteClient({
              wsUrl: harness.server.wsUrl,
              localAddress,
              noteId: note.id,
              userId: user.id,
              sessionId: session.session.id,
              tickets,
              flushDelayMs: false,
            });
            clients.push(client);
            noteClients.push(client);
          }
          try {
            // eslint-disable-next-line no-await-in-loop -- retain each connected cohort before adding another note to the prescribed steady load
            await Promise.all(
              noteClients.map((client) => client.waitFor('saved', { timeoutMs: 120_000 })),
            );
          } catch (error) {
            console.error(
              'CH14 initial load diagnostic',
              JSON.stringify({
                states: Object.fromEntries(
                  [...new Set(clients.map((client) => client.saveState))].map((state) => [
                    state,
                    clients.filter((client) => client.saveState === state).length,
                  ]),
                ),
                unsaved: clients
                  .filter((client) => client.saveState !== 'saved')
                  .slice(0, 12)
                  .map((client) => ({
                    userId: client.userId,
                    documentName: client.documentName,
                    states: client.states,
                    closes: client.closes.slice(-3),
                    stateless: client.stateless.slice(-3),
                  })),
                logTail: harness.logs.slice(-80),
              }),
            );
            throw error;
          }
        }
        expect(clients).toHaveLength(200);
        expect(notes).toHaveLength(20);
        expect(clients.every((client) => client.closes.length === 0)).toBe(true);
        const metrics = await harness.server.metrics();
        expect(metrics['iridium_ws_connections{doc_kind="note"}']).toBe(200);
        expect(metrics['iridium_docs_loaded']).toBe(20);
        const victims = clients.filter((client) => client.userId === cast.editorA.id);
        const unaffected = clients.filter((client) => client.userId !== cast.editorA.id);
        expect(victims).toHaveLength(20);
        const selected = (iteration - 1) % notes.length;
        const victim = victims[selected];
        const selectedNote = notes[selected];
        if (victim === undefined || selectedNote === undefined)
          throw new Error('Missing race note.');
        const guaranteed = victim.marker(`load-before-${String(iteration)}`);
        await victim.waitFor('saved', { timeoutMs: 60_000 });

        const closeEvents = observeCloses(victims);
        const query = removalQuery(harness, cast.vault.id, cast.editorA.id);
        const initialAbsentStarted = Date.now();
        expect(await harness.sql.rows(query)).toEqual([]);
        const commit = observeCommit(harness, query, initialAbsentStarted, observations.signal);
        const closed = waitFor(
          () => (closeEvents.size === victims.length ? [...closeEvents.values()] : undefined),
          {
            timeoutMs: 120_000,
            intervalMs: 5,
            signal: observations.signal,
            description: 'every victim close',
          },
        );
        const [removed, bracket, closes] = await Promise.all([
          cast.admin.client.del(`/vaults/${cast.vault.id}/members/${cast.editorA.id}`, {
            headers: { 'if-match': '"1"' },
          }),
          commit,
          closed,
          Promise.resolve().then(() => victim.marker(`load-racing-${String(iteration)}`)),
        ]);
        expect(removed.status).toBe(204);
        expect(closes.every((close) => close.reason === 'revoked')).toBe(true);
        const conservativeElapsed = Math.max(
          ...closes.map((close) => close.at - bracket.lastAbsentStarted),
        );
        const auditElapsed = Math.max(...closes.map((close) => close.at - bracket.occurredAt));
        console.info(
          'CH14 revocation observation',
          JSON.stringify({
            iteration,
            total,
            connections: clients.length,
            notes: notes.length,
            mysqlLatencyMs: MYSQL_LATENCY_MS,
            ...bracket,
            lastCloseAt: Math.max(...closes.map((close) => close.at)),
            conservativeElapsed,
            auditElapsed,
          }),
        );

        expect(conservativeElapsed).toBeGreaterThanOrEqual(0);
        expect(conservativeElapsed).toBeLessThanOrEqual(CLOSE_DEADLINE_MS);
        expect(bracket.firstVisibleEnded).toBeGreaterThanOrEqual(bracket.lastAbsentStarted);
        expect(unaffected.every((client) => client.closes.length === 0)).toBe(true);
        const blockedMarkers = victims.map((client, index) => {
          const note = notes[index];
          if (note === undefined) throw new Error('Missing revoked client note.');
          const marker = client.marker(`load-revoked-local-${String(iteration)}-${String(index)}`);
          expect(client.saveState).toBe('revoked');
          expect(client.text.toJSON()).toContain(marker);
          return { noteId: note.id, marker };
        });
        await toxic.remove();
        toxic = undefined;

        const finalObservers = unaffected.filter((client) => client.userId === cast.editorB.id);
        expect(finalObservers).toHaveLength(LOAD_NOTES);
        const finalMarkers = finalObservers.map((client, index) => ({
          note: notes[index],
          marker: client.marker(`load-after-${String(iteration)}-${String(index)}`),
        }));
        await Promise.all(
          finalObservers.map((client) => client.waitFor('saved', { timeoutMs: 60_000 })),
        );
        for (const { note, marker } of finalMarkers) {
          if (note === undefined) throw new Error('Missing final observer note.');
          // eslint-disable-next-line no-await-in-loop -- each independent persisted note is checked after the final authorized write
          const durable = await harness.committed(note.id);
          const blocked = blockedMarkers.find((entry) => entry.noteId === note.id);
          if (blocked === undefined) throw new Error('Missing post-revocation local marker.');
          expect(durable.text).toContain(marker);
          expect(durable.text).not.toContain(blocked.marker);
        }
        const selectedDurable = await harness.committed(selectedNote.id);
        expect(selectedDurable.text).toContain(guaranteed);
        await assertNoPostRevocationRows(
          harness,
          bracket.auditId,
          cast.editorA.id,
          notes.map((note) => note.id),
        );
        const refused = await harness.open(cast.editorA, selectedNote.id);
        expect((await refused.waitClosed({ timeoutMs: 10_000 })).collabReason).toBe(
          'note-not-found',
        );
        const victimSession = sessions[0];
        if (victimSession === undefined) throw new Error('The revoked user needs a real session.');
        expect((await victimSession.client.get(`/notes/${selectedNote.id}`)).status).toBe(404);
      } finally {
        observations.abort();
        try {
          await toxic?.remove();
        } finally {
          try {
            await Promise.all(clients.map((client) => client.close()));
          } finally {
            await harness.close();
          }
        }
      }
    },
  );
});
