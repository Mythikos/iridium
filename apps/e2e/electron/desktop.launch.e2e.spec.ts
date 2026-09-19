/**
 * `desktop.launch.e2e` — the M0 desktop smoke (12-milestones.md §4.3 and §4.6;
 * 10-testing-and-quality.md, "E2E inventory").
 *
 * The shell must launch on app://iridium with no Node and a real CSP. S03 additionally requires
 * renderer fetch and WebSocket Origin evidence across navigation, on plain and TLS listeners.
 * The @smoke selector runs both proofs on ubuntu, windows and macos in e2e-electron.
 */
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';

import type { Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

import { expect, test } from '../fixtures/index.ts';

const APP_ORIGIN = 'app://iridium';

type OriginTransport = 'http' | 'https';

interface OriginObservation {
  readonly transport: 'fetch' | 'websocket';
  readonly path: string;
  readonly origin: string | null;
}

interface OriginListener {
  readonly serverOrigin: string;
  readonly certificate: string | null;
  readonly observations: readonly OriginObservation[];
  close(): Promise<void>;
}

/** Records headers on the receiving socket; neither browser request API sets Origin explicitly. */
async function startOriginListener(transport: OriginTransport): Promise<OriginListener> {
  // Disposable self-signed fixture, never installed in a trust store. The test pins its exact PEM.
  // Generated with OpenSSL req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 and a loopback SAN.
  const tls =
    transport === 'https'
      ? {
          cert: await readFile(
            new URL('./fixtures/origin-probe.cert.pem', import.meta.url),
            'utf8',
          ),
          key: await readFile(new URL('./fixtures/origin-probe.key.pem', import.meta.url), 'utf8'),
        }
      : null;
  const observations: OriginObservation[] = [];
  const sockets = new Set<Socket>();
  const server = tls === null ? createServer() : createHttpsServer(tls);
  server.on('request', (request, response) => {
    observations.push({
      transport: 'fetch',
      path: request.url ?? '',
      origin: request.headers.origin ?? null,
    });
    response.writeHead(200, {
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    });
    response.end('origin-probe');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const webSockets = new WebSocketServer({ server });
  webSockets.on('connection', (_socket, request) => {
    observations.push({
      transport: 'websocket',
      path: request.url ?? '',
      origin: request.headers.origin ?? null,
    });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The desktop Origin probe must listen on an ephemeral TCP port.');
  }
  return {
    serverOrigin: `${transport}://127.0.0.1:${address.port}`,
    certificate: tls?.cert ?? null,
    observations,
    async close(): Promise<void> {
      for (const client of webSockets.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          webSockets.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
      ]);
    },
  };
}

/** Read the policy from the real application response, including its generated nonce. */
async function reloadWithCsp(page: Page): Promise<string> {
  const [document] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${APP_ORIGIN}/`),
    page.reload(),
  ]);
  const csp = await document.headerValue('content-security-policy');
  if (csp === null) throw new Error('The app://iridium document must carry its CSP header.');
  return csp;
}

/** Exercise the browser APIs, then compare the receiver's observations after each document load. */
async function observeOrigin(page: Page, listener: OriginListener, leg: string): Promise<void> {
  const result = await page.evaluate(
    async ({ serverOrigin, leg: phase }) => {
      const response = await fetch(`${serverOrigin}/fetch?leg=${phase}`);
      const body = await response.text();
      const websocketClosed = await new Promise<boolean>((resolve, reject) => {
        const socket = new WebSocket(`${serverOrigin.replace(/^http/, 'ws')}/collab?leg=${phase}`);
        socket.addEventListener('open', () => socket.close(1000), { once: true });
        socket.addEventListener('close', (event) => resolve(event.wasClean), { once: true });
        socket.addEventListener(
          'error',
          () => reject(new Error('Origin probe WebSocket failed.')),
          {
            once: true,
          },
        );
      });
      return {
        body,
        websocketClosed,
        origin: location.origin,
        require: typeof require,
        process: typeof process,
      };
    },
    { serverOrigin: listener.serverOrigin, leg },
  );
  expect(result).toStrictEqual({
    body: 'origin-probe',
    websocketClosed: true,
    origin: APP_ORIGIN,
    require: 'undefined',
    process: 'undefined',
  });
  expect(
    listener.observations.filter((observation) => observation.path.endsWith(`leg=${leg}`)),
  ).toStrictEqual([
    { transport: 'fetch', path: `/fetch?leg=${leg}`, origin: APP_ORIGIN },
    { transport: 'websocket', path: `/collab?leg=${leg}`, origin: APP_ORIGIN },
  ]);
}

test.describe('desktop.launch.e2e [area:clients]', { tag: ['@smoke', '@area-clients'] }, () => {
  test('launches a window on app://iridium with a CSP and no Node in the renderer', async ({
    electronApp,
    firstWindow,
  }) => {
    // The app launched and opened exactly one window (07-client-applications.md D07-16).
    expect(electronApp.windows()).toHaveLength(1);

    // The renderer is never loaded from file:// and never from a remote origin (§7.3).
    expect(firstWindow.url()).toBe('app://iridium/');
    await expect.poll(() => firstWindow.title()).toBe('Iridium');

    // The source guard holds webPreferences; the real launch must also reject a launcher flag
    // that overrides that sandbox policy (Playwright's default on Linux unless explicitly enabled).
    const sandboxDisabled = await electronApp.evaluate(({ app }) =>
      app.commandLine.hasSwitch('no-sandbox'),
    );
    expect(sandboxDisabled).toBe(false);

    // Hardening rows H1 and H2: sandbox plus context isolation, so the page has no Node at all.
    const rendererGlobals = await firstWindow.evaluate(() => ({
      require: typeof require,
      process: typeof process,
      module: typeof module,
    }));
    expect(rendererGlobals).toStrictEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
    });

    // The policy sets connect-src 'none' until profiles exist, so observe a real page reload.
    const csp = await reloadWithCsp(firstWindow);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain('localhost');
  });

  for (const transport of ['http', 'https'] as const) {
    test(`sends app://iridium Origin over ${transport} after navigation and reload`, async ({
      electronApp,
      firstWindow,
    }, testInfo) => {
      const csp = await reloadWithCsp(firstWindow);
      expect(csp).toContain("connect-src 'none'");
      const listener = await startOriginListener(transport);
      try {
        // S03 follow-up 1: M0 has no active profile, so its real document cannot connect anywhere.
        // Serve a focused probe in the actual product window and privileged scheme, changing only
        // its document and CSP connection destinations. Requests and received headers are real;
        // the product's scheme privileges, session hardening and webPreferences remain in force.
        const probeCsp = csp.replace(
          "connect-src 'none'",
          `connect-src ${listener.serverOrigin} ${listener.serverOrigin.replace(/^http/, 'ws')}`,
        );
        await electronApp.evaluate(
          ({ BrowserWindow }, { probeCsp: contentSecurityPolicy, certificate }) => {
            const window = BrowserWindow.getAllWindows()[0];
            if (window === undefined)
              throw new Error('The desktop Origin probe needs the product window.');
            const appSession = window.webContents.session;
            if (certificate !== null) {
              // Pin only this disposable certificate at loopback; every other certificate follows
              // Chromium verification. This is the same narrow pinning method recorded by S03.
              appSession.setCertificateVerifyProc((request, callback) => {
                const matches =
                  request.hostname === '127.0.0.1' &&
                  request.certificate.data.trim() === certificate.trim();
                callback(matches ? 0 : -3);
              });
            }
            appSession.protocol.unhandle('app');
            appSession.protocol.handle('app', (request) => {
              const url = new URL(request.url);
              if (url.host !== 'iridium') return new Response('not found', { status: 404 });
              return new Response('<!doctype html><title>Iridium Origin probe</title>', {
                headers: {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Content-Security-Policy': contentSecurityPolicy,
                  'Cache-Control': 'no-store',
                },
              });
            });
          },
          { probeCsp, certificate: listener.certificate },
        );

        await firstWindow.goto(`${APP_ORIGIN}/`);
        await observeOrigin(firstWindow, listener, 'root');
        await firstWindow.goto(`${APP_ORIGIN}/vault/notes/deep/child`);
        await observeOrigin(firstWindow, listener, 'subpage-navigated');
        await firstWindow.goto(`${APP_ORIGIN}/`);
        await firstWindow.evaluate(() => history.pushState({}, '', '/vault/notes/deep/child'));
        await observeOrigin(firstWindow, listener, 'subpage-pushstate');
        await firstWindow.goto(`${APP_ORIGIN}/`);
        await observeOrigin(firstWindow, listener, 'before-reload');
        await firstWindow.reload();
        await observeOrigin(firstWindow, listener, 'after-reload');
        expect(listener.observations).toHaveLength(10);
      } finally {
        await listener.close();
        // The fresh electronApp fixture owns the process, protocol handler and certificate pin.
        await testInfo.attach(`desktop-origin-${transport}-observations`, {
          body: JSON.stringify(
            { platform: process.platform, transport, observations: listener.observations },
            null,
            2,
          ),
          contentType: 'application/json',
        });
      }
    });
  }
});
