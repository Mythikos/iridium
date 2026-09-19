/**
 * The collaboration limits (09-api-reference.md §3.10; 05-collaboration-and-durability.md, "Limits
 * relevant to collaboration" and "Admission control"; 04-auth-and-access-control.md §7.6).
 *
 * Three things live here and nowhere else:
 *
 *  1. **The effective values.** `config.collab` carries the operator's numbers (each defaulted from
 *     `LIMITS` in `config/env.ts`, the one place an environment key meets a limit); a boot may override
 *     a subset through `buildApp({ limits })`, which is how `collab.admission-budget.integration` drives
 *     the document budget to 8 instead of opening 2 001 documents. `resolveCollabLimits` freezes the
 *     result once per boot.
 *  2. **The socket caps** (`SocketCaps`): 50 sockets per IP and 5 000 per process, counted at the
 *     upgrade and released when the underlying socket closes — including sockets whose first
 *     `onAuthenticate` has not completed, because a pre-auth socket holds the same resources.
 *  3. **The admission budget** (`AdmissionBudget`): loaded documents and summed state bytes. A load
 *     *reserves* the estimate (`note_docs.snapshot_size`) at `onAuthenticate`, `afterLoadDocument`
 *     replaces it with the measured V2 size, and `afterUnloadDocument` releases it. Refusal, never
 *     eviction (A50).
 *
 * `COMPACTION_AWAIT_TIMEOUT_MS` is a `LIMITS` member (05, D05-20) with no environment key: a boot
 * overrides it only through `buildApp({ limits })`, which is how the integration project runs a
 * 1 000 ms wait while the chaos project keeps the production value.
 */
import { LIMITS } from '@iridium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { IridiumConfig } from '../config/env.ts';
import type { DocBudgetReading } from '../ops/readiness.ts';
import { sendProblem } from '../security/problem.ts';

/** `Retry-After` on a `429` socket-cap refusal at the upgrade (04 §7.6): one round trip later. */
export const SOCKET_REFUSAL_RETRY_AFTER_SECONDS = 1;

const MS_PER_SECOND = 1000;

/** What `buildApp({ limits })` accepts: a subset of the configured values, numbers only. */
export interface CollabLimitOverrides {
  readonly maxLoadedDocs?: number;
  readonly maxStateBytesTotal?: number;
  readonly maxConnectionsPerUser?: number;
  readonly maxConnectionsPerIp?: number;
  readonly maxConnections?: number;
  readonly compactionAwaitTimeoutMs?: number;
}

/** The effective values of one boot. */
export interface CollabLimits {
  readonly maxLoadedDocs: number;
  readonly maxStateBytesTotal: number;
  readonly maxConnectionsPerUser: number;
  readonly maxConnectionsPerIp: number;
  readonly maxConnections: number;
  readonly compactionAwaitTimeoutMs: number;
  readonly wsMaxPayloadBytes: number;
}

/** `config.collab` with the overrides applied, frozen. */
export function resolveCollabLimits(
  config: IridiumConfig,
  overrides: CollabLimitOverrides = {},
): CollabLimits {
  return Object.freeze({
    maxLoadedDocs: overrides.maxLoadedDocs ?? config.collab.maxLoadedDocs,
    maxStateBytesTotal: overrides.maxStateBytesTotal ?? config.collab.maxStateBytesTotal,
    maxConnectionsPerUser: overrides.maxConnectionsPerUser ?? config.collab.maxConnectionsPerUser,
    maxConnectionsPerIp: overrides.maxConnectionsPerIp ?? config.collab.maxConnectionsPerIp,
    maxConnections: overrides.maxConnections ?? config.collab.maxConnections,
    compactionAwaitTimeoutMs:
      overrides.compactionAwaitTimeoutMs ?? LIMITS.COMPACTION_AWAIT_TIMEOUT_MS,
    wsMaxPayloadBytes: config.collab.wsMaxPayloadBytes,
  });
}

// -----------------------------------------------------------------------------------------------
// Socket caps
// -----------------------------------------------------------------------------------------------

/** Why an upgrade was refused by the socket caps. */
export type SocketCapRefusal = 'ip' | 'process';

/** The outcome of `SocketCaps.admit`. */
export type SocketAdmission =
  | { readonly admitted: true; release(): void }
  | { readonly admitted: false; readonly refusal: SocketCapRefusal };

/** The per-IP and per-process socket counters of 04 §7.6. */
export class SocketCaps {
  readonly #perIp = new Map<string, number>();
  #total = 0;
  readonly #maxPerIp: number;
  readonly #maxTotal: number;

  constructor(limits: Pick<CollabLimits, 'maxConnectionsPerIp' | 'maxConnections'>) {
    this.#maxPerIp = limits.maxConnectionsPerIp;
    this.#maxTotal = limits.maxConnections;
  }

  /** Sockets currently counted, for the gauge and for assertions. */
  get total(): number {
    return this.#total;
  }

  /** Sockets currently counted for one address. */
  countFor(ip: string): number {
    return this.#perIp.get(ip) ?? 0;
  }

  /** Counts one socket, or refuses. `release` is idempotent. */
  admit(ip: string): SocketAdmission {
    if (this.#total >= this.#maxTotal) return { admitted: false, refusal: 'process' };
    const forIp = this.countFor(ip);
    if (forIp >= this.#maxPerIp) return { admitted: false, refusal: 'ip' };
    this.#perIp.set(ip, forIp + 1);
    this.#total += 1;
    let released = false;
    return {
      admitted: true,
      release: (): void => {
        if (released) return;
        released = true;
        this.#total -= 1;
        const remaining = this.countFor(ip) - 1;
        if (remaining <= 0) this.#perIp.delete(ip);
        else this.#perIp.set(ip, remaining);
      },
    };
  }
}

/** What the `connectionCaps` hook needs beside the counters. */
export interface ConnectionCapsHookDeps {
  readonly caps: SocketCaps;
  /** Invoked with the refusal so the plugin can count and log `collab.connection.rejected`. */
  readonly onRefused: (request: FastifyRequest, refusal: SocketCapRefusal) => void;
}

/**
 * The `connectionCaps` `preValidation` hook of the `/collab` route (04 §7.6).
 *
 * It runs on the HTTP upgrade request, before any WebSocket exists, and answers `429 rate_limited`
 * with `Retry-After` when a cap is full. An admitted socket is released when the underlying TCP socket
 * closes — the same socket `ws` takes over for the WebSocket, so no handler cooperation is needed and a
 * handshake that fails after this hook releases its count too.
 */
export function createConnectionCapsHook(
  deps: ConnectionCapsHookDeps,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined> {
  return async (request, reply) => {
    const admission = deps.caps.admit(request.ip);
    if (admission.admitted) {
      request.raw.socket.once('close', () => {
        admission.release();
      });
      return undefined;
    }
    deps.onRefused(request, admission.refusal);
    await sendProblem(request, reply, 'rate_limited', {
      detail:
        admission.refusal === 'ip'
          ? 'Too many collaboration sockets from this address.'
          : 'This server has reached its collaboration socket cap.',
      retryAfterMs: SOCKET_REFUSAL_RETRY_AFTER_SECONDS * MS_PER_SECOND,
      headers: { 'retry-after': String(SOCKET_REFUSAL_RETRY_AFTER_SECONDS) },
    });
    return reply;
  };
}

// -----------------------------------------------------------------------------------------------
// The admission budget
// -----------------------------------------------------------------------------------------------

/** Which budget refused a load. The `iridium_collab_admission_refused_total{reason}` label. */
export type AdmissionRefusal = 'docs' | 'bytes';

/** The outcome of `AdmissionBudget.reserve`. */
export type Admission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal };

/** The loaded-document and state-byte accounting of A50. */
export class AdmissionBudget {
  readonly #entries = new Map<string, number>();
  #bytes = 0;
  readonly #maxDocs: number;
  readonly #maxBytes: number;

  constructor(limits: Pick<CollabLimits, 'maxLoadedDocs' | 'maxStateBytesTotal'>) {
    this.#maxDocs = limits.maxLoadedDocs;
    this.#maxBytes = limits.maxStateBytesTotal;
  }

  /** Whether a document already holds an entry (loaded, or reserved and loading). */
  has(documentName: string): boolean {
    return this.#entries.has(documentName);
  }

  /** Documents with an entry. */
  get loadedDocs(): number {
    return this.#entries.size;
  }

  /** Summed reserved-or-measured bytes. */
  get stateBytes(): number {
    return this.#bytes;
  }

  /** The `doc_budget` readiness input. */
  reading(): DocBudgetReading {
    return {
      loadedDocs: this.#entries.size,
      maxLoadedDocs: this.#maxDocs,
      stateBytes: this.#bytes,
      maxStateBytes: this.#maxBytes,
    };
  }

  /**
   * Reserves `estimateBytes` for a document that is not loaded yet. A document that already holds an
   * entry is admitted without a second reservation: a second connection to a loaded document costs
   * no budget.
   */
  reserve(documentName: string, estimateBytes: number): Admission {
    if (this.#entries.has(documentName)) return { admitted: true };
    if (this.#entries.size + 1 > this.#maxDocs) return { admitted: false, refusal: 'docs' };
    if (this.#bytes + estimateBytes > this.#maxBytes) return { admitted: false, refusal: 'bytes' };
    this.#entries.set(documentName, estimateBytes);
    this.#bytes += estimateBytes;
    return { admitted: true };
  }

  /** Replaces the reservation with the measured size (`afterLoadDocument`). */
  confirm(documentName: string, measuredBytes: number): void {
    const previous = this.#entries.get(documentName) ?? 0;
    this.#entries.set(documentName, measuredBytes);
    this.#bytes += measuredBytes - previous;
  }

  /** Drops the entry (`afterUnloadDocument`, or a load that failed after reserving). Idempotent. */
  release(documentName: string): void {
    const previous = this.#entries.get(documentName);
    if (previous === undefined) return;
    this.#entries.delete(documentName);
    this.#bytes -= previous;
  }
}
