/**
 * `collab.limits.unit` — the socket caps, the admission budget and the per-boot override resolution
 * (04-auth-and-access-control.md §7.6; 05-collaboration-and-durability.md, "Admission control";
 * skeleton A50).
 *
 * The budget's rule is refusal, never eviction: a reservation admitted for a document is replaced by
 * the measured size and released only by the unload. The socket caps count sockets, including those
 * whose first `onAuthenticate` has not completed, and release on the socket's close.
 */
import { EventEmitter } from 'node:events';

import { LIMITS } from '@iridium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config/env.ts';
import { docBudgetOutcome } from '../ops/readiness.ts';
import {
  AdmissionBudget,
  createConnectionCapsHook,
  resolveCollabLimits,
  SocketCaps,
  type SocketCapRefusal,
} from './limits.ts';

const TEST_ENV = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'http://127.0.0.1:4000',
  DATABASE_URL: 'mysql://iridium_app@127.0.0.1:3306/iridium',
  DATABASE_PASSWORD: 'test-app-not-a-secret',
  AUTH_PASSWORD_PEPPER: 'test-pepper-not-a-secret',
  AUDIT_HMAC_KEY: 'test-audit-not-a-secret',
  MCP_CURSOR_KEY: 'test-cursor-not-a-secret',
  COLLAB_MAX_LOADED_DOCS: '8',
};

interface FakeUpgrade {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly socket: EventEmitter;
  readonly sent: Array<{ status: number; body: unknown }>;
}

function upgrade(ip: string): FakeUpgrade {
  const socket = new EventEmitter();
  const sent: Array<{ status: number; body: unknown }> = [];
  let status = 200;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook calls the four members below; a FastifyReply cannot be constructed outside the framework
  const reply = {
    header: () => reply,
    getHeader: () => undefined,
    code: (value: number) => {
      status = value;
      return reply;
    },
    type: () => reply,
    send: (body: unknown) => {
      sent.push({ status, body });
      return reply;
    },
  } as unknown as FastifyReply;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads ip, raw.socket and log; a FastifyRequest cannot be constructed outside the framework
  const request = {
    ip,
    requestId: 'req-1',
    raw: { socket },
    log: { warn: () => undefined },
  } as unknown as FastifyRequest;
  return { request, reply, socket, sent };
}

describe('collab.limits.unit [area:collab]', () => {
  describe('resolveCollabLimits', () => {
    it('takes the configured values and lets a boot override a subset', () => {
      const config = loadConfig(TEST_ENV);
      const defaults = resolveCollabLimits(config);
      expect(defaults.maxLoadedDocs).toBe(8);
      expect(defaults.compactionAwaitTimeoutMs).toBe(LIMITS.COMPACTION_AWAIT_TIMEOUT_MS);
      expect(defaults.maxConnectionsPerUser).toBe(config.collab.maxConnectionsPerUser);
      const overridden = resolveCollabLimits(config, {
        maxLoadedDocs: 2,
        compactionAwaitTimeoutMs: 1_000,
      });
      expect(overridden.maxLoadedDocs).toBe(2);
      expect(overridden.compactionAwaitTimeoutMs).toBe(1_000);
      expect(overridden.maxStateBytesTotal).toBe(config.collab.maxStateBytesTotal);
      expect(Object.isFrozen(overridden)).toBe(true);
    });
  });

  describe('SocketCaps', () => {
    it('counts sockets per address and per process and releases idempotently', () => {
      const caps = new SocketCaps({ maxConnectionsPerIp: 2, maxConnections: 3 });
      const first = caps.admit('10.0.0.1');
      const second = caps.admit('10.0.0.1');
      expect(first.admitted && second.admitted).toBe(true);
      expect(caps.admit('10.0.0.1')).toEqual({ admitted: false, refusal: 'ip' });
      const third = caps.admit('10.0.0.2');
      expect(third.admitted).toBe(true);
      expect(caps.admit('10.0.0.3')).toEqual({ admitted: false, refusal: 'process' });
      expect(caps.total).toBe(3);
      if (first.admitted) {
        first.release();
        first.release();
      }
      expect(caps.total).toBe(2);
      expect(caps.countFor('10.0.0.1')).toBe(1);
      expect(caps.admit('10.0.0.3').admitted).toBe(true);
    });
  });

  describe('AdmissionBudget', () => {
    it('reserves an estimate, confirms the measured size and releases on unload', () => {
      const budget = new AdmissionBudget({ maxLoadedDocs: 2, maxStateBytesTotal: 1_000 });
      expect(budget.reserve('note:a', 400)).toEqual({ admitted: true });
      expect(budget.reserve('note:a', 400)).toEqual({ admitted: true });
      expect(budget.loadedDocs).toBe(1);
      expect(budget.stateBytes).toBe(400);
      expect(budget.reserve('note:b', 700)).toEqual({ admitted: false, refusal: 'bytes' });
      budget.confirm('note:a', 100);
      expect(budget.stateBytes).toBe(100);
      expect(budget.reserve('note:b', 700)).toEqual({ admitted: true });
      expect(budget.reserve('note:c', 1)).toEqual({ admitted: false, refusal: 'docs' });
      budget.release('note:a');
      budget.release('note:a');
      expect(budget.reading()).toEqual({
        loadedDocs: 1,
        maxLoadedDocs: 2,
        stateBytes: 700,
        maxStateBytes: 1_000,
      });
      expect(budget.reserve('note:c', 1)).toEqual({ admitted: true });
    });

    it('feeds the readiness policy: warn from 80 %, fail at 100 %', () => {
      const budget = new AdmissionBudget({ maxLoadedDocs: 10, maxStateBytesTotal: 1_000 });
      for (let index = 0; index < 8; index += 1) budget.reserve(`note:${String(index)}`, 0);
      expect(docBudgetOutcome(budget.reading()).status).toBe('warn');
      budget.reserve('note:8', 0);
      budget.reserve('note:9', 0);
      expect(docBudgetOutcome(budget.reading()).status).toBe('fail');
    });
  });

  describe('createConnectionCapsHook', () => {
    it('admits under the caps, releases on the socket close, and refuses 429 over them', async () => {
      const caps = new SocketCaps({ maxConnectionsPerIp: 1, maxConnections: 5 });
      const refusals: SocketCapRefusal[] = [];
      const hook = createConnectionCapsHook({
        caps,
        onRefused: (_request, refusal) => refusals.push(refusal),
      });

      const first = upgrade('10.0.0.9');
      expect(await hook(first.request, first.reply)).toBeUndefined();
      expect(caps.total).toBe(1);

      const second = upgrade('10.0.0.9');
      await hook(second.request, second.reply);
      expect(refusals).toEqual(['ip']);
      expect(second.sent).toHaveLength(1);
      expect(second.sent[0]?.status).toBe(429);
      expect(second.sent[0]?.body).toMatchObject({ code: 'rate_limited' });

      first.socket.emit('close');
      expect(caps.total).toBe(0);
      const third = upgrade('10.0.0.9');
      expect(await hook(third.request, third.reply)).toBeUndefined();
    });
  });
});
