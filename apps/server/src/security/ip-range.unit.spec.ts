import { describe, expect, it } from 'vitest';

import { ipInRange, ipInRanges, parseIpRange, parseIpRanges, toAddressBytes } from './ip-range.ts';

function range(source: string): NonNullable<ReturnType<typeof parseIpRange>> {
  const result = parseIpRange(source);
  if (result === null) throw new Error(`Invalid fixture range ${source}`);
  return result;
}

describe('security.ip-range.unit [area:security]', () => {
  it.each([
    '',
    'hostname',
    '127.1',
    '256.0.0.1',
    '127.000.0.1',
    '1.2.3.-4',
    '0x7f.0.0.1',
    '1.2.3.4::',
    '1:2:3:4:5:6:7:8::',
    '1::2::3',
    '1:2:3',
    '::ffff:300.0.0.1',
    '::ffff:1.2.3.4:5',
    '::gggg',
    '127.0.0.1%eth0',
  ])('rejects malformed or ambiguous address %s', (address) => {
    expect(toAddressBytes(address)).toBeNull();
    expect(ipInRange(address, range('::/0'))).toBe(false);
  });

  it('normalizes dotted and hexadecimal IPv4-mapped addresses identically', () => {
    expect(toAddressBytes('10.20.30.40')).toEqual(toAddressBytes('::ffff:10.20.30.40'));
    expect(toAddressBytes('10.20.30.40')).toEqual(toAddressBytes('0:0:0:0:0:ffff:a14:1e28'));
    expect(toAddressBytes(' fe80::1%eth0 ')).toEqual(toAddressBytes('fe80:0:0:0:0:0:0:1'));
    expect(toAddressBytes('::')).toEqual(new Uint8Array(16));
  });

  it.each([
    ['10.0.0.0/8', '10.255.255.255', true],
    ['10.0.0.0/8', '11.0.0.0', false],
    ['10.0.0.128/25', '10.0.0.127', false],
    ['10.0.0.128/25', '::ffff:10.0.0.128', true],
    ['0.0.0.0/0', '255.255.255.255', true],
    ['0.0.0.0/0', '::1', false],
    ['127.0.0.1', '127.0.0.2', false],
    ['127.0.0.1', '::ffff:127.0.0.1', true],
    ['2001:db8::/33', '2001:db8:7fff::1', true],
    ['2001:db8::/33', '2001:db8:8000::1', false],
    ['::1/128', '::1', true],
    ['::1', '::2', false],
    ['::/0', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
  ] as const)('matches %s against %s as %s', (source, address, expected) => {
    expect(ipInRange(address, range(source))).toBe(expected);
  });

  it.each(['', 'host/8', '10.0.0.0/33', '::/129', '::/-1', '::/1.5', '::/', '::/1/2', '::/0000'])(
    'rejects an invalid CIDR %s',
    (source) => {
      expect(parseIpRange(source)).toBeNull();
    },
  );

  it('reports every invalid entry instead of silently broadening the trusted range', () => {
    const parsed = parseIpRanges([' 10.0.0.0/8 ', 'bad', '::1', '10.0.0.0/33']);
    expect(parsed.invalid).toEqual(['bad', '10.0.0.0/33']);
    expect(parsed.ranges.map((entry) => entry.source)).toEqual(['10.0.0.0/8', '::1']);
    expect(ipInRanges('10.1.2.3', parsed.ranges)).toBe(true);
    expect(ipInRanges('::1', parsed.ranges)).toBe(true);
    expect(ipInRanges('11.0.0.0', parsed.ranges)).toBe(false);
    expect(ipInRanges(undefined, parsed.ranges)).toBe(false);
    expect(ipInRanges('10.0.0.1', [])).toBe(false);
  });
});
