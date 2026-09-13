/**
 * Spike S04 — web host, second measurement: the nonce produced by `@fastify/helmet`'s
 * `enableCSPNonces`, which is the mechanism the register's pass criterion names for the web host
 * ("the nonce is the per-response nonce from `@fastify/helmet` `enableCSPNonces` on web").
 *
 * Serves the *same* built artefact as the Vitest Browser Mode host and the Electron shell, drives
 * it with Playwright's chromium, and writes `report-fastify-helmet.json`.
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { chromium } from 'playwright';

import { contentTypeFor, CSP_NONCE_PLACEHOLDER, resolveInside } from './csp-host.mjs';

const here = import.meta.dirname;
const dist = path.join(here, 'dist');

const app = Fastify({ logger: false });

await app.register(helmet, {
  // The per-response nonce. `enableCSPNonces` appends `'nonce-<n>'` to `script-src` and `style-src`
  // and exposes it as `reply.cspNonce`.
  enableCSPNonces: true,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'worker-src': ["'self'", 'blob:'],
      'frame-src': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  strictTransportSecurity: false,
});

app.get('/*', async (request, reply) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = resolveInside(dist, pathname);
  if (file === null) return reply.code(404).send('not found');
  if (path.basename(file) === 'index.html') {
    const html = await readFile(file, 'utf8');
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(html.replaceAll(CSP_NONCE_PLACEHOLDER, reply.cspNonce.style));
  }
  return reply
    .type(contentTypeFor(file))
    .header('Cache-Control', 'no-store')
    .send(await readFile(file));
});

const address = await app.listen({ port: 0, host: '127.0.0.1' });
console.info(`fastify host at ${address}`);

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleMessages = [];
page.on('console', (message) => {
  consoleMessages.push(`${message.type()}: ${message.text()}`);
});

const headers = [];
page.on('response', (response) => {
  if (response.url() === `${address}/` || response.url() === `${address}/index.html`) {
    headers.push(response.headers()['content-security-policy']);
  }
});

await page.goto(`${address}/index.html`, { waitUntil: 'load' });
// A second load proves the nonce is per response, not per process.
await page.goto(`${address}/index.html`, { waitUntil: 'load' });

// Function form, not a string: the page's own `script-src 'self'` refuses `eval`, which is itself
// evidence that the policy is enforcing.
await page.waitForFunction(() => window.s04?.awaitInput ?? false, undefined, {
  timeout: 60_000,
});
await page.keyboard.type('typed by the host');
await page.keyboard.press('Enter');
await page.keyboard.type('second line');
await page.evaluate(() => {
  window.s04.inputDone = true;
});
await page.waitForFunction(() => window.s04.report !== undefined, undefined, {
  timeout: 120_000,
});
const report = await page.evaluate(() => window.s04.report);

writeFileSync(
  path.join(here, 'report-fastify-helmet.json'),
  JSON.stringify(
    {
      host: 'fastify-5.12.4 + @fastify/helmet-13.1.1 enableCSPNonces',
      cspHeaders: headers,
      noncesDiffer: headers.length > 1 && headers[0] !== headers[1],
      consoleMessages,
      report,
    },
    null,
    2,
  ),
);

console.info('violations:', JSON.stringify(report.violations));
console.info('remedy violations:', JSON.stringify(report.remedy.violations));
console.info('control enforcing:', report.control.enforcing);

await browser.close();
await app.close();
