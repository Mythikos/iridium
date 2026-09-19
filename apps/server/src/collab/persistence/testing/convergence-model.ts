// oxlint-disable vitest/no-standalone-expect -- shared assertions execute inside the two model properties.
/** The identical real-codec command set used by the memory mirror and MySQL convergence gate. */
import { projectMarkdown, type NoteDoc } from '@iridium/crdt';
import { createMarkerSequence, noteText, type MarkerSequence } from '@iridium/testkit';
import * as fc from 'fast-check';
import { expect } from 'vitest';

import { assertConverged } from './converge.ts';
import type { ModelReal } from './model.ts';
import { createSimNet, type SimNet } from './sim-net.ts';

export const INITIAL_MARKER = '⟦IMPORT-MARK⟧';
export const MAX_PEERS = 6;

interface NetModel {
  readonly peers: number;
  readonly markers: readonly MarkerSequence[];
  headSeen: number;
  /** Set once a compaction ran, which is what makes a prune meaningful. */
  compacted: boolean;
}

interface NetReal {
  readonly net: SimNet;
  readonly real: ModelReal;
}

type Command = fc.AsyncCommand<NetModel, NetReal>;

/** Stable identities of all currently visible characters authored outside this document. */
function foreignClocks(doc: NoteDoc): Set<string> {
  const visible = new Set<string>();
  for (const [client, structs] of doc.store.clients) {
    if (client === doc.clientID) continue;
    for (const struct of structs) {
      if (struct.deleted || !('content' in struct)) continue;
      for (let offset = 0; offset < struct.length; offset += 1) {
        visible.add(`${String(client)}:${String(struct.id.clock + offset)}`);
      }
    }
  }
  return visible;
}

/** Undo may reinsert one's deleted text inside a foreign marker, but cannot delete foreign items. */
export function assertUndoIsolation(net: SimNet, peer: number): void {
  const doc = net.peers[peer]?.doc;
  if (doc === undefined) throw new Error('undo peer does not exist');
  const before = foreignClocks(doc);
  net.undo(peer);
  const after = foreignClocks(doc);
  expect(
    [...before].filter((clock) => !after.has(clock)),
    `undo(${String(peer)}) preserves every visible foreign CRDT character`,
  ).toEqual([]);
}
export class Insert implements Command {
  readonly #peer: number;
  readonly #at: number;
  readonly #text: string;

  constructor(peer: number, at: number, text: string) {
    this.#peer = peer;
    this.#at = at;
    this.#text = text;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(model: NetModel, { net }: NetReal): Promise<void> {
    const marker = model.markers[this.#peer]?.next() ?? '';
    const length = net.peers[this.#peer]?.text.length ?? 0;
    net.insert(this.#peer, Math.floor(this.#at * (length + 1)), `${this.#text}${marker}`);
  }

  toString(): string {
    return `Insert(${String(this.#peer)}, ${this.#at.toFixed(2)}, ${JSON.stringify(this.#text)})`;
  }
}

class Delete implements Command {
  readonly #peer: number;
  readonly #at: number;
  readonly #length: number;

  constructor(peer: number, at: number, length: number) {
    this.#peer = peer;
    this.#at = at;
    this.#length = length;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    const length = net.peers[this.#peer]?.text.length ?? 0;
    net.delete(this.#peer, Math.floor(this.#at * length), this.#length);
  }

  toString(): string {
    return `Delete(${String(this.#peer)}, ${this.#at.toFixed(2)}, ${String(this.#length)})`;
  }
}

class Undo implements Command {
  readonly #peer: number;

  constructor(peer: number) {
    this.#peer = peer;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    assertUndoIsolation(net, this.#peer);
  }
  toString(): string {
    return `Undo(${String(this.#peer)})`;
  }
}

class Redo implements Command {
  readonly #peer: number;

  constructor(peer: number) {
    this.#peer = peer;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    net.redo(this.#peer);
  }

  toString(): string {
    return `Redo(${String(this.#peer)})`;
  }
}

class DeliverOne implements Command {
  readonly #peer: number;

  constructor(peer: number) {
    this.#peer = peer;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    net.deliverOne(this.#peer);
  }

  toString(): string {
    return `DeliverOne(${String(this.#peer)})`;
  }
}

class DeliverAll implements Command {
  check(): boolean {
    return true;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    net.deliverAll();
  }

  toString(): string {
    return 'DeliverAll';
  }
}

class Disconnect implements Command {
  readonly #peer: number;

  constructor(peer: number) {
    this.#peer = peer;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    net.disconnect(this.#peer);
  }

  toString(): string {
    return `Disconnect(${String(this.#peer)})`;
  }
}

class Reconnect implements Command {
  readonly #peer: number;

  constructor(peer: number) {
    this.#peer = peer;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    net.reconnect(this.#peer);
  }

  toString(): string {
    return `Reconnect(${String(this.#peer)})`;
  }
}

class ServerPersist implements Command {
  check(): boolean {
    return true;
  }

  async run(model: NetModel, { net, real }: NetReal): Promise<void> {
    await net.persist();
    const view = await real.view();
    expect(view.headSeq, 'head_seq never decreases').toBeGreaterThanOrEqual(model.headSeen);
    model.headSeen = view.headSeq;
  }

  toString(): string {
    return 'ServerPersist';
  }
}

class ServerCompact implements Command {
  check(): boolean {
    return true;
  }

  async run(model: NetModel, { net }: NetReal): Promise<void> {
    await net.compact();
    model.compacted = true;
  }

  toString(): string {
    return 'ServerCompact';
  }
}

class ServerRestart implements Command {
  check(): boolean {
    return true;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    await net.restartServer();
  }

  toString(): string {
    return 'ServerRestart';
  }
}

export class ClientReload implements Command {
  readonly #peer: number;

  constructor(peer: number) {
    this.#peer = peer;
  }

  check(model: Readonly<NetModel>): boolean {
    return this.#peer < model.peers;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    await net.reloadClient(this.#peer);
  }

  toString(): string {
    return `ClientReload(${String(this.#peer)})`;
  }
}

class PruneUpdateLog implements Command {
  check(model: Readonly<NetModel>): boolean {
    return model.compacted;
  }

  async run(_model: NetModel, { net }: NetReal): Promise<void> {
    // With every queue drained, the re-sync a restart performs brings the server nothing new, so
    // the text it reloads is exactly the text it had.
    net.deliverAll();
    await net.persist();
    await net.pruneUpdateLog();
    // 11. Pruning is safe: a restart from the snapshot and the remaining tail reproduces the text.
    const before = projectMarkdown(net.server.doc);
    await net.restartServer();
    expect(projectMarkdown(net.server.doc)).toBe(before);
  }

  toString(): string {
    return 'PruneUpdateLog';
  }
}

const at = fc.double({ min: 0, max: 1, noNaN: true });
/** Lone surrogate halves are excluded: a Yjs update is UTF-8 on the wire, and no editor produces one. */
const text = noteText({ minLength: 0, maxLength: 8 }).filter((value) => value.isWellFormed());

/** Every peer is addressable in the PR model and the ten-peer nightly soak. */
export function convergenceCommandsFor(peers: number): fc.Arbitrary<Command>[] {
  const peer = fc.nat({ max: peers - 1 });
  return [
    fc.tuple(peer, at, text).map(([who, where, what]) => new Insert(who, where, what)),
    fc.tuple(peer, at, text).map(([who, where, what]) => new Insert(who, where, what)),
    fc
      .tuple(peer, at, fc.nat({ max: 12 }))
      .map(([who, where, count]) => new Delete(who, where, count)),
    peer.map((who) => new Undo(who)),
    peer.map((who) => new Redo(who)),
    peer.map((who) => new DeliverOne(who)),
    peer.map((who) => new DeliverOne(who)),
    fc.constant(new DeliverAll()),
    peer.map((who) => new Disconnect(who)),
    peer.map((who) => new Reconnect(who)),
    fc.constant(new ServerPersist()),
    fc.constant(new ServerCompact()),
    fc.constant(new ServerRestart()),
    peer.map((who) => new ClientReload(who)),
    fc.constant(new PruneUpdateLog()),
  ];
}

export const convergenceCommands: fc.Arbitrary<Command>[] = convergenceCommandsFor(MAX_PEERS);

/** Exactly 2000 commands: twenty blocks of 99 generated operations and a mandatory restart. */
export const convergenceSoakCommands: fc.Arbitrary<Command[]> = fc
  .array(fc.oneof(...convergenceCommandsFor(10)), { minLength: 1980, maxLength: 1980 })
  .map((commands) =>
    commands.flatMap((command, index) =>
      (index + 1) % 99 === 0 ? [command, new ServerRestart()] : [command],
    ),
  );

/** Exercise the same generated commands and all convergence oracles on either persistence port. */
export async function runConvergenceModel(
  peers: number,
  sequence: Iterable<fc.AsyncCommand<NetModel, NetReal>>,
  create: (markdown: string) => Promise<ModelReal>,
): Promise<void> {
  const built: { net: NetReal | null } = { net: null };
  let initialClientIds: number[] = [];
  const model: NetModel = {
    peers,
    markers: Array.from({ length: peers }, (_, index) => createMarkerSequence(`p${String(index)}`)),
    headSeen: 1,
    compacted: false,
  };
  try {
    await fc.asyncModelRun(async () => {
      const real = await create(`${INITIAL_MARKER} kernel note\n`);
      initialClientIds = [...real.document.store.clients.keys()];
      const net = createSimNet({ real, peers });
      built.net = { net, real };
      return { model, real: built.net };
    }, sequence);
    const opened = built.net;
    if (opened === null) throw new Error('the model run built no net');
    for (const each of opened.net.peers) if (!each.connected) opened.net.reconnect(each.id);
    opened.net.deliverAll();
    await opened.net.persist();
    await opened.net.compact();
    await assertConverged({
      net: opened.net,
      real: opened.real,
      markerTags: model.markers.map((_, index) => `p${String(index)}`),
      initialMarker: INITIAL_MARKER,
      initialClientIds,
      headSeen: model.headSeen,
    });
  } finally {
    built.net?.net.dispose();
    built.net?.real.dispose();
  }
}
