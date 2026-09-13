/**
 * Spike S07 — the four local TLS endpoints, shared by the server and the Electron harness.
 *
 * `*.localhost` hostnames are deliberate: Chromium's host resolver maps `localhost` and every
 * `*.localhost` label to loopback internally, so two distinct hostnames exist without a `hosts`
 * entry and therefore without administrator rights, while `subjectAltName` hostname verification is
 * still exercised for real.
 */
export const ENDPOINTS = [
  {
    name: 'trustedCA_iridium',
    leaf: 'leafA_iridium',
    ca: 'caA',
    host: 'iridium-test.localhost',
    port: 18_701,
  },
  {
    name: 'untrustedCA_iridium',
    leaf: 'leafB_iridium',
    ca: 'caB',
    host: 'iridium-test.localhost',
    port: 18_702,
  },
  {
    name: 'untrustedCA_other',
    leaf: 'leafB_other',
    ca: 'caB',
    host: 'other-test.localhost',
    port: 18_703,
  },
  {
    name: 'untrustedCA_pinmiss',
    leaf: 'leafB_pinmiss',
    ca: 'caB',
    host: 'pinmiss-test.localhost',
    port: 18_704,
  },
];

export function originOf(name) {
  const endpoint = ENDPOINTS.find((candidate) => candidate.name === name);
  if (endpoint === undefined) throw new Error(`s07: unknown endpoint ${name}`);
  return `https://${endpoint.host}:${endpoint.port}`;
}

export function wsOriginOf(name) {
  return originOf(name).replace('https://', 'wss://');
}
