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

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV4_MAPPED_PREFIX = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
const BITS_PER_BYTE = 8;
const IPV4_MAPPED_PREFIX_BITS = 96;
const IPV4_GROUPS = 4;
const IPV6_GROUPS = 8;
const HEX_GROUP_MAX = 0xffff;

/** One parsed range: a 16-byte network address and a prefix length in bits over those 16 bytes. */
export interface IpRange {
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
  /** The spelling the operator wrote, for error messages. */
  readonly source: string;
}

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== IPV4_GROUPS) return null;
  const bytes = new Uint8Array(IPV4_BYTES);
  for (let index = 0; index < IPV4_GROUPS; index += 1) {
    const part = parts[index] ?? '';
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 0xff) return null;
    bytes[index] = value;
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | null {
  let head = text;
  let tail = '';
  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1) {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null;
    head = text.slice(0, doubleColon);
    tail = text.slice(doubleColon + 2);
  }

  const expand = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    const pieces = segment.split(':');
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index] ?? '';
      if (piece.includes('.')) {
        // A trailing dotted quad, as in `::ffff:10.0.0.1`.
        if (index !== pieces.length - 1) return null;
        const embedded = parseIpv4(piece);
        if (embedded === null) return null;
        groups.push(((embedded[0] ?? 0) << BITS_PER_BYTE) | (embedded[1] ?? 0));
        groups.push(((embedded[2] ?? 0) << BITS_PER_BYTE) | (embedded[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      const value = Number.parseInt(piece, 16);
      if (value > HEX_GROUP_MAX) return null;
      groups.push(value);
    }
    return groups;
  };

  const headGroups = expand(head);
  const tailGroups = expand(tail);
  if (headGroups === null || tailGroups === null) return null;

  const total = headGroups.length + tailGroups.length;
  if (doubleColon === -1 ? total !== IPV6_GROUPS : total > IPV6_GROUPS) return null;
  const middle: number[] = Array.from({ length: IPV6_GROUPS - total }, () => 0);
  const groups = [...headGroups, ...middle, ...tailGroups];

  const bytes = new Uint8Array(IPV6_BYTES);
  for (let index = 0; index < IPV6_GROUPS; index += 1) {
    const value = groups[index] ?? 0;
    bytes[index * 2] = value >>> BITS_PER_BYTE;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** Normalises an address to 16 bytes, mapping IPv4 into the IPv4-mapped IPv6 range. */
export function toAddressBytes(address: string): Uint8Array | null {
  const trimmed = address.trim();
  if (trimmed === '') return null;
  // A zone index (`fe80::1%eth0`) is not part of the address for matching purposes.
  const withoutZone = trimmed.split('%')[0] ?? trimmed;

  const asV4 = parseIpv4(withoutZone);
  if (asV4 !== null) {
    const bytes = new Uint8Array(IPV6_BYTES);
    bytes.set(IPV4_MAPPED_PREFIX, 0);
    bytes.set(asV4, IPV4_MAPPED_PREFIX.length);
    return bytes;
  }
  return withoutZone.includes(':') ? parseIpv6(withoutZone) : null;
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
