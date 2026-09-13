/**
 * Spike S04 — the strict-CSP static host, shared by both web hosts.
 *
 * `policy()` is the web shape of the policy the desktop shell already ships
 * (`apps/desktop/src/main/csp.ts` `packagedCsp`): `style-src 'self' 'nonce-<n>'` with no
 * `'unsafe-inline'`, and no `style-src-elem` / `style-src-attr` override, so both the element and
 * the attribute case fall back to that one directive — the strictest reading of the register row.
 *
 * `serveDist()` is a bare Node request handler so the same code path serves the page from the Vite
 * middleware stack (Vitest Browser Mode) and, through `fastify-host.mjs`, from `@fastify/helmet`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CSP_NONCE_PLACEHOLDER = '__IRIDIUM_CSP_NONCE__';
export const NONCE_BYTES = 16;

export function newNonce() {
  return randomBytes(NONCE_BYTES).toString('base64');
}

export function policy(nonce) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolves a request path inside `dist`, refusing traversal; `null` means 403/404. */
export function resolveInside(dist, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.split('/').includes('..')) return null;
  const candidate = path.resolve(dist, `.${decoded === '/' ? '/index.html' : decoded}`);
  const rel = path.relative(dist, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Writes one response. Returns `false` when the path is not part of the harness, so a middleware
 * can fall through.
 */
export function serveDist({ dist, pathname, res, nonce = newNonce() }) {
  const file = resolveInside(dist, pathname);
  if (file === null) return false;
  const isIndex = path.basename(file) === 'index.html';
  const body = isIndex
    ? readFileSync(file, 'utf8').replaceAll(CSP_NONCE_PLACEHOLDER, nonce)
    : readFileSync(file);
  const headers = {
    'Content-Type': contentTypeFor(file),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  // The policy travels on every response so the sub-resources are governed too; the nonce is only
  // consumed by the document that carries it.
  headers['Content-Security-Policy'] = policy(nonce);
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

/**
 * Vite plugin: mounts the built harness page under `prefix` with a per-response nonce and the
 * strict policy as a real header. `enforce: 'pre'` puts the middleware ahead of Vite's own
 * transform middleware and ahead of the Vitest browser middlewares.
 */
export function s04CspHost({ dist, prefix = '/s04', reportDir }) {
  return {
    name: 's04-csp-host',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith(prefix)) {
          next();
          return;
        }
        // The browser-side test posts its report here; the harness has no other way to reach disk.
        if (url.pathname === `${prefix}/__report` && req.method === 'POST') {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('end', () => {
            writeFileSync(
              path.join(reportDir ?? dist, 'report-vitest-browser.json'),
              Buffer.concat(chunks),
            );
            res.writeHead(204);
            res.end();
          });
          return;
        }
        const pathname = url.pathname.slice(prefix.length) || '/';
        if (!serveDist({ dist, pathname, res })) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        }
      });
    },
  };
}
