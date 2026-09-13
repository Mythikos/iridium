/**
 * Spike S3 — the throwaway origin-logging servers.
 *
 * Two kinds of listener, each in a plain `http://` and a TLS `https://` variant:
 *
 *  - `startServer()` is a real `ws` server (the repository's catalog pin, 8.21.3, loaded out of the
 *    pnpm store — this harness installs nothing). It logs `request.headers.origin` on the `/collab`
 *    upgrade and on `GET /meta`, completes the handshake, and round-trips one binary frame, so the
 *    evidence is a working connection and not only a header.
 *  - `startRawServer()` is a bare TCP/TLS socket that speaks the handshake by hand and records the
 *    literal bytes of the request head. Node's HTTP parser consumes the socket handle, so no `data`
 *    listener on an `http.Server` socket can see an upgrade request's bytes; the register's method
 *    asks for the exact header bytes, and this is the only way to get them undisturbed.
 *
 * Neither listener rejects anything: the question is what the client sends, not what the policy
 * would do with it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { createServer as createTlsServer } from 'node:tls';

const require = createRequire(import.meta.url);

export function loadWs(repoRoot) {
  try {
    return require('ws');
  } catch {
    const pinned = path.join(repoRoot, 'node_modules', '.pnpm', 'ws@8.21.3', 'node_modules', 'ws');
    return require(pinned);
  }
}

function originOf(headers) {
  return Object.prototype.hasOwnProperty.call(headers, 'origin') ? headers.origin : null;
}

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': originOf(req.headers) ?? '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    Vary: 'Origin',
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve(server.address().port));
  });
}

/**
 * @param {{ leg: string, record: (event: object) => void, repoRoot: string, tls?: { key: Buffer, cert: Buffer } }} options
 */
export async function startServer(options) {
  const { WebSocketServer } = loadWs(options.repoRoot);
  const server = options.tls === undefined ? http.createServer() : https.createServer(options.tls);

  server.on('request', (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const probe = url.searchParams.get('probe');
    if (req.method === 'OPTIONS') {
      options.record({
        kind: 'preflight',
        leg: options.leg,
        probe,
        path: url.pathname,
        origin: originOf(req.headers),
        originPresent: Object.prototype.hasOwnProperty.call(req.headers, 'origin'),
      });
      res.writeHead(204, corsHeaders(req)).end();
      return;
    }
    if (url.pathname === '/report') {
      let payload = null;
      try {
        payload = JSON.parse(url.searchParams.get('data') ?? 'null');
      } catch (error) {
        payload = { parseError: String(error) };
      }
      options.record({ kind: 'renderer-report', leg: options.leg, payload });
      res.writeHead(200, { ...corsHeaders(req), 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    if (url.pathname === '/meta') {
      options.record({
        kind: 'fetch',
        leg: options.leg,
        probe,
        path: url.pathname,
        method: req.method,
        origin: originOf(req.headers),
        originPresent: Object.prototype.hasOwnProperty.call(req.headers, 'origin'),
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        secFetchMode: req.headers['sec-fetch-mode'] ?? null,
        secFetchDest: req.headers['sec-fetch-dest'] ?? null,
        referer: req.headers.referer ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        rawHeaders: req.rawHeaders,
      });
      res
        .writeHead(200, { ...corsHeaders(req), 'Content-Type': 'application/json' })
        .end(JSON.stringify({ leg: options.leg, probe, origin: originOf(req.headers) }));
      return;
    }
    res.writeHead(404, corsHeaders(req)).end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://placeholder');
    const probe = url.searchParams.get('probe');
    options.record({
      kind: 'ws-upgrade',
      leg: options.leg,
      probe,
      path: url.pathname,
      origin: originOf(req.headers),
      originPresent: Object.prototype.hasOwnProperty.call(req.headers, 'origin'),
      host: req.headers.host ?? null,
      subprotocol: req.headers['sec-websocket-protocol'] ?? null,
      cookie: req.headers.cookie ?? null,
      extensions: req.headers['sec-websocket-extensions'] ?? null,
      rawHeaders: req.rawHeaders,
    });
    if (url.pathname !== '/collab') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ hello: probe, origin: originOf(req.headers) }));
      ws.on('message', (data, isBinary) => {
        options.record({
          kind: 'ws-message',
          leg: options.leg,
          probe,
          isBinary,
          bytes: data.length ?? null,
        });
        ws.close(4001, 'spike-s03');
      });
    });
  });

  const port = await listen(server);
  const scheme = options.tls === undefined ? 'http' : 'https';
  return {
    port,
    origin: `${scheme}://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        wss.close();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** RFC 6455 close frame, server-to-client (unmasked). */
function closeFrame(code, reason) {
  const body = Buffer.concat([
    Buffer.from([(code >> 8) & 0xff, code & 0xff]),
    Buffer.from(reason, 'utf8'),
  ]);
  return Buffer.concat([Buffer.from([0x88, body.length]), body]);
}

/**
 * @param {{ leg: string, record: (event: object) => void, tls?: { key: Buffer, cert: Buffer } }} options
 */
export async function startRawServer(options) {
  const sockets = new Set();
  const onConnection = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      handled = true;
      const headBytes = buffer.subarray(0, end + 4);
      const head = headBytes.toString('latin1');
      const lines = head.split('\r\n');
      const requestLine = lines[0] ?? '';
      const originLine = lines.find((line) => /^origin:/i.test(line)) ?? null;
      const keyLine = lines.find((line) => /^sec-websocket-key:/i.test(line)) ?? null;
      const url = new URL(requestLine.split(' ')[1] ?? '/', 'http://placeholder');
      options.record({
        kind: keyLine === null ? 'raw-fetch' : 'raw-ws-upgrade',
        leg: options.leg,
        probe: url.searchParams.get('probe'),
        path: url.pathname,
        requestLine,
        origin: originLine === null ? null : originLine.slice(originLine.indexOf(':') + 1).trim(),
        originPresent: originLine !== null,
        originLine,
        originLineHex:
          originLine === null ? null : Buffer.from(originLine, 'latin1').toString('hex'),
        headerBytes: head,
        headerByteLength: headBytes.length,
      });
      if (keyLine !== null) {
        const key = keyLine.slice(keyLine.indexOf(':') + 1).trim();
        const accept = createHash('sha1')
          .update(key + WS_GUID)
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.write(closeFrame(4001, 'spike-s03-raw'));
        setTimeout(() => socket.end(), 250);
        return;
      }
      const body = JSON.stringify({ leg: options.leg, raw: true, origin: originLine });
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
          `Access-Control-Allow-Origin: *\r\nVary: Origin\r\nConnection: close\r\n\r\n${body}`,
      );
      socket.end();
    });
  };

  const server =
    options.tls === undefined
      ? createTcpServer(onConnection)
      : createTlsServer(options.tls, onConnection);
  const port = await listen(server);
  const scheme = options.tls === undefined ? 'http' : 'https';
  return {
    port,
    origin: `${scheme}://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

export function readTls(certDir) {
  return {
    key: readFileSync(path.join(certDir, 'key.pem')),
    cert: readFileSync(path.join(certDir, 'cert.pem')),
  };
}
