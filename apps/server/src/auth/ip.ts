/**
 * The `VARBINARY(16)` form of a peer address (03-data-model.md section 3, `sessions.ip`;
 * section 12.1, `audit_events.context.ip`).
 *
 * IPv4 is stored as its four bytes and IPv6 as sixteen; an IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.1`, which a dual-stack socket reports for an IPv4 peer) is stored as the four
 * bytes of the address it maps, so one peer has one stored form whatever the kernel produced.
 * Anything that is not an address is `null`: the column is nullable and a malformed value must
 * never reach SQL as bytes.
 */
import { isIPv4, isIPv6 } from 'node:net';

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV6_GROUPS = 8;
const IPV4_MAPPED_PREFIX = '::ffff:';

function ipv4Bytes(address: string): Buffer {
  return Buffer.from(address.split('.').map((part) => Number(part)));
}

/** The 16-bit groups of one colon-separated segment; an empty segment is no groups. */
function expandGroups(segment: string): number[] {
  return segment === '' ? [] : segment.split(':').map((group) => Number.parseInt(group, 16));
}

/**
 * The sixteen bytes of an address `node:net`'s `isIPv6` has already accepted. Validity is that
 * function's job, so nothing here re-checks a group or a trailing dotted quad: the caller's guard
 * is the only guard, which keeps one address grammar in the process.
 */
function ipv6Bytes(address: string): Buffer {
  // A trailing dotted quad (`::ffff:10.0.0.1`, `64:ff9b::1.2.3.4`) is two groups.
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  let embedded: readonly number[] = [];
  if (tail.includes('.')) {
    const quad = ipv4Bytes(tail);
    embedded = [quad.readUInt16BE(0), quad.readUInt16BE(2)];
    // Keep a `::` that precedes the quad (it is the compression marker); drop a lone separator.
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const doubleColon = text.indexOf('::');
  let groups: number[];
  if (doubleColon === -1) {
    groups = [...expandGroups(text), ...embedded];
  } else {
    const head = expandGroups(text.slice(0, doubleColon));
    const rest = expandGroups(text.slice(doubleColon + 2));
    const fill = Math.max(0, IPV6_GROUPS - head.length - rest.length - embedded.length);
    groups = [...head, ...Array.from({ length: fill }, () => 0), ...rest, ...embedded];
  }
  const bytes = Buffer.alloc(IPV6_BYTES);
  groups.forEach((group, index) => {
    bytes.writeUInt16BE(group, index * 2);
  });
  return bytes;
}

/** The stored bytes of a peer address, or `null` when the value is not an address. */
export function ipToBytes(address: string | undefined | null): Buffer | null {
  if (address === undefined || address === null) return null;
  const lowered = address.toLowerCase();
  if (isIPv4(lowered)) return ipv4Bytes(lowered);
  if (lowered.startsWith(IPV4_MAPPED_PREFIX) && isIPv4(lowered.slice(IPV4_MAPPED_PREFIX.length))) {
    return ipv4Bytes(lowered.slice(IPV4_MAPPED_PREFIX.length));
  }
  if (isIPv6(lowered)) return ipv6Bytes(lowered);
  return null;
}

/** The textual address of stored bytes, for `GET /me/sessions`; `null` for a malformed length. */
export function ipFromBytes(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  if (bytes.byteLength === IPV4_BYTES) return Array.from(bytes).join('.');
  if (bytes.byteLength !== IPV6_BYTES) return null;
  const view = Buffer.from(bytes);
  const groups: string[] = [];
  for (let offset = 0; offset < IPV6_BYTES; offset += 2) {
    groups.push(view.readUInt16BE(offset).toString(16));
  }
  return groups.join(':');
}
