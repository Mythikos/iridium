/**
 * Spike S07 — the local TLS endpoints.
 *
 * Four HTTPS servers on loopback, each presenting a different leaf certificate, plus a hand-rolled
 * RFC 6455 echo endpoint on `/ws` so the WebSocket probe needs no dependency outside Node.
 *
 * Hostnames are `*.localhost` names on purpose: Chromium's host resolver maps `localhost` and every
 * `*.localhost` label to loopback internally, so two distinct hostnames are available without a
 * `hosts` entry and therefore without administrator rights. The leaves carry the matching
 * `subjectAltName` DNS entries, so hostname verification is exercised for real.
 *
 * Throwaway harness for `docs/spikes/S07-electron-enterprise-ca.md`. Not part of the product build.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import path from 'node:path';
import process from 'node:process';

import { ENDPOINTS } from './endpoints.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const pkiDir = process.argv[2];
if (pkiDir === undefined) throw new Error('tls-server: pass the PKI directory as argv[2]');
/** Optional: a `.jsonl` file every observation is appended to, so the orchestrator can read it. */
const observationLog = process.argv[3];

function observe(record) {
  if (observationLog === undefined) return;
  appendFileSync(observationLog, `${JSON.stringify(record)}\n`);
}

function acceptKey(key) {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/** Decode one client frame (always masked) far enough to echo its text payload back. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload };
}

/** Encode one unmasked server text frame (payloads here are always tiny). */
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.from([0x81, payload.length]);
  return Buffer.concat([header, payload]);
}

function startEndpoint(endpoint) {
  const server = createServer({
    cert: readFileSync(path.join(pkiDir, `${endpoint.leaf}.crt`)),
    key: readFileSync(path.join(pkiDir, `${endpoint.leaf}.key`)),
    minVersion: 'TLSv1.2',
  });

  server.on('request', (request, response) => {
    observe({
      endpoint: endpoint.name,
      kind: 'request',
      url: request.url,
      origin: request.headers.origin ?? null,
      secFetchDest: request.headers['sec-fetch-dest'] ?? null,
      secFetchMode: request.headers['sec-fetch-mode'] ?? null,
    });
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    if (request.url === '/pixel.png') {
      response.writeHead(200, { ...headers, 'Content-Type': 'image/png' });
      response.end(PIXEL_PNG);
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, endpoint: endpoint.name, host: endpoint.host }));
  });

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    observe({
      endpoint: endpoint.name,
      kind: 'upgrade',
      url: request.url,
      origin: request.headers.origin ?? null,
      protocolVersion: request.headers['sec-websocket-version'] ?? null,
    });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.on('data', (chunk) => {
      const frame = decodeFrame(chunk);
      if (frame === null) return;
      if (frame.opcode === 0x08) {
        socket.end();
        return;
      }
      socket.write(encodeFrame(`echo:${frame.payload.toString('utf8')}`));
    });
    socket.on('error', () => {});
  });

  // A client that rejects the certificate aborts the handshake; this is the server-side witness.
  server.on('tlsClientError', (error) => {
    observe({ endpoint: endpoint.name, kind: 'tlsClientError', code: error.code ?? null });
  });

  server.listen(endpoint.port, '::');
  return server;
}

const servers = ENDPOINTS.map(startEndpoint);

process.on('SIGTERM', () => {
  for (const server of servers) server.close();
  process.exit(0);
});

// eslint-disable-next-line no-console -- throwaway harness; the orchestrator reads stdout
console.log(`s07-tls-server ready: ${ENDPOINTS.map((e) => `${e.host}:${e.port}`).join(' ')}`);
