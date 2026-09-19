/**
 * IP and CIDR matching for `TRUST_PROXY` and `METRICS_ALLOW_CIDR`.
 *
 * Two decisions need an exact answer to "is this peer inside that list?": whether an inbound
 * `X-Request-Id` may be honoured (ARCH-14 — only from a `TRUST_PROXY` address, so a client cannot
 * inject log content) and whether `/metrics` may be served without a bearer token (ARCH-04). Both
 * are security boundaries, so the matcher is explicit rather than inferred from a forwarded header.
 *
 * IPv4, IPv6 and IPv4-mapped IPv6 (`::ffff:10.0.0.1`, which is what a dual-stack Node socket
 * reports for an IPv4 peer) all normalise to a 16-byte address before comparison, so a list written
 * in IPv4 matches a peer reported in IPv4-mapped form and the operator never has to know which form
 * their kernel produced.
 */

import { isIP } from 'node:net';

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV4_MAPPED_PREFIX = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
const BITS_PER_BYTE = 8;
const IPV4_MAPPED_PREFIX_BITS = 96;
const IPV6_GROUPS = 8;

/** One parsed range: a 16-byte network address and a prefix length in bits over those 16 bytes. */
export interface IpRange {
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
  /** The spelling the operator wrote, for error messages. */
  readonly source: string;
}

/** Inputs are validated by node:net before byte conversion. */
function parseIpv4(text: string): Uint8Array {
  return Uint8Array.from(text.split('.').map(Number));
}

function parseIpv6(text: string): Uint8Array {
  const doubleColon = text.indexOf('::');
  const head = doubleColon === -1 ? text : text.slice(0, doubleColon);
  const tail = doubleColon === -1 ? '' : text.slice(doubleColon + 2);
  const expand = (segment: string): number[] =>
    segment === ''
      ? []
      : segment.split(':').flatMap((piece) => {
          if (!piece.includes('.')) return [Number.parseInt(piece, 16)];
          const word = piece
            .split('.')
            .reduce((value, octet) => (value << BITS_PER_BYTE) | Number(octet), 0);
          return [word >>> 16, word & 0xffff];
        });
  const headGroups = expand(head);
  const tailGroups = expand(tail);
  const middle = Array.from(
    { length: IPV6_GROUPS - headGroups.length - tailGroups.length },
    () => 0,
  );
  const bytes = new Uint8Array(IPV6_BYTES);
  for (const [index, value] of [...headGroups, ...middle, ...tailGroups].entries()) {
    bytes[index * 2] = value >>> BITS_PER_BYTE;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** Normalises an address to 16 bytes, mapping IPv4 into the IPv4-mapped IPv6 range. */
export function toAddressBytes(address: string): Uint8Array | null {
  const trimmed = address.trim();
  const family = isIP(trimmed);
  if (family === 0) return null;
  // A zone index (`fe80::1%eth0`) is not part of the address for matching purposes.
  const withoutZone = trimmed.split('%')[0] ?? trimmed;

  if (family === 4) {
    const asV4 = parseIpv4(withoutZone);
    const bytes = new Uint8Array(IPV6_BYTES);
    bytes.set(IPV4_MAPPED_PREFIX, 0);
    bytes.set(asV4, IPV4_MAPPED_PREFIX.length);
    return bytes;
  }
  return parseIpv6(withoutZone);
}

/**
 * Parses `10.0.0.0/8`, `172.20.0.0/24`, `::1/128`, `127.0.0.1` (an implicit `/32`) or `::1`
 * (an implicit `/128`).
 *
 * @returns the range, or `null` when the spelling is not an address or CIDR.
 */
export function parseIpRange(source: string): IpRange | null {
  const trimmed = source.trim();
  if (trimmed === '') return null;
  const slash = trimmed.lastIndexOf('/');
  const addressText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const bytes = toAddressBytes(addressText);
  if (bytes === null) return null;

  const isMappedV4 = addressText.includes('.') && !addressText.includes(':');
  if (slash === -1) {
    return { bytes, prefixBits: IPV6_BYTES * BITS_PER_BYTE, source: trimmed };
  }
  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const declared = Number(prefixText);
  const maxBits = isMappedV4 ? IPV4_BYTES * BITS_PER_BYTE : IPV6_BYTES * BITS_PER_BYTE;
  if (declared > maxBits) return null;
  // An IPv4 prefix is expressed over the mapped range, so /24 becomes /120.
  const prefixBits = isMappedV4 ? IPV4_MAPPED_PREFIX_BITS + declared : declared;
  return { bytes, prefixBits, source: trimmed };
}

/** Parses a list, dropping nothing silently: an unparsable entry is returned in `invalid`. */
export function parseIpRanges(sources: readonly string[]): {
  ranges: readonly IpRange[];
  invalid: readonly string[];
} {
  const ranges: IpRange[] = [];
  const invalid: string[] = [];
  for (const source of sources) {
    const parsed = parseIpRange(source);
    if (parsed === null) invalid.push(source);
    else ranges.push(parsed);
  }
  return { ranges, invalid };
}

/** Whether `address` falls inside `range`. */
export function ipInRange(address: string, range: IpRange): boolean {
  const bytes = toAddressBytes(address);
  if (bytes === null) return false;
  const wholeBytes = Math.floor(range.prefixBits / BITS_PER_BYTE);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== range.bytes[index]) return false;
  }
  const remainingBits = range.prefixBits % BITS_PER_BYTE;
  if (remainingBits === 0) return true;
  const mask = (0xff << (BITS_PER_BYTE - remainingBits)) & 0xff;
  return ((bytes[wholeBytes] ?? 0) & mask) === ((range.bytes[wholeBytes] ?? 0) & mask);
}

/** Whether `address` falls inside any of `ranges`. An empty list matches nothing. */
export function ipInRanges(address: string | undefined, ranges: readonly IpRange[]): boolean {
  if (address === undefined) return false;
  return ranges.some((range) => ipInRange(address, range));
}
