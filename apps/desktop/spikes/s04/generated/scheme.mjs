/**
 * The `app://iridium` privileged scheme (07-client-applications.md §7.3, hardening row H7).
 *
 * The renderer is never loaded from `file://` and never from a remote origin. Pages on this scheme
 * send `Origin: app://iridium`, which is exactly the literal string the server's WebSocket origin
 * allowlist contains (13-decision-log.md A24).
 */

import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';
                                        

import {
  CSP_NONCE_BYTES,
  CSP_NONCE_PLACEHOLDER,
  developmentCsp,
  packagedCsp,
                  
} from './csp.mjs';

/** The renderer's origin. Every IPC handler requires it (H13) and the server allowlists it. */
export const APP_ORIGIN = 'app://iridium';

export const APP_SCHEME = 'app';
export const APP_HOST = 'iridium';

/** The attachment scheme main serves with the bearer credential (§7.7); registered at M0, served at M5. */
export const ATTACHMENT_SCHEME = 'iridium-attachment';

/**
 * Must run at module top level, before `ready`.
 *
 * `corsEnabled: true` is explicit and load-bearing: schemes registered with `supportFetchAPI` but
 * without it leaked cross-origin reads before CVE-2026-70604.
 */
export function registerAppSchemePrivileges()       {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
    {
      scheme: ATTACHMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const CONTENT_TYPES                                   = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(file        )         {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The traversal guard. Returns the absolute path inside `root` that `pathname` names, or `null` when
 * the request is refused with `403` by the caller — `../`, a backslash, an absolute path, a NUL and
 * every percent-encoded spelling of those.
 *
 * A `..` segment is rejected outright rather than normalised away. `path.posix.normalize` would
 * collapse `/../../secret` to `/secret`, which is inside the root and therefore "safe" — but it turns
 * an attempted escape into a silent 200 for a different resource, and it makes `desktop.scheme.spec`'s
 * "`../` → 403" unobservable. Rejecting the segment keeps the refusal visible; the `path.relative`
 * check below stays as defence in depth for the spellings the platform resolver invents (a backslash
 * is a separator on Windows and is not one in a URL path).
 */
export function resolveRendererPath(root        , pathname        )                {
  let decoded        ;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').includes('..')) return null;

  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return resolved;
}

async function isFile(candidate        )                   {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

                                          
                                                                                                    
                                
                                                                                   
                                             
                                                                                  
                               
                                                                          
                                          
 

function cspFor(options                         , nonce        )         {
  const base             = { serverOrigin: options.serverOrigin(), nonce };
  if (!options.isPackaged && options.devServerOrigin !== null) {
    return developmentCsp({ ...base, devServerOrigin: options.devServerOrigin });
  }
  return packagedCsp(base);
}

/**
 * Registers the `app` handler on one session. It is per session rather than global because the
 * window runs in the dedicated `persist:iridium` partition (H6).
 */
export function installAppProtocolHandler(
  session         ,
  options                         ,
)       {
  session.protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 });

    const resolved = resolveRendererPath(options.rendererRoot, url.pathname);
    if (resolved === null) return new Response('forbidden', { status: 403 });

    // SPA fallback: any path the build did not emit is the application's own route.
    const indexHtml = path.join(options.rendererRoot, 'index.html');
    const file = (await isFile(resolved)) ? resolved : indexHtml;

    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Type', contentTypeFor(file));
    headers.set('X-Content-Type-Options', 'nosniff');

    if (file === indexHtml) {
      const nonce = randomBytes(CSP_NONCE_BYTES).toString('base64');
      headers.set('Content-Security-Policy', cspFor(options, nonce));
      const html = (await res.text()).replaceAll(CSP_NONCE_PLACEHOLDER, nonce);
      return new Response(html, { headers, status: res.status });
    }
    return new Response(res.body, { headers, status: res.status });
  });
}

/**
 * Development only: the renderer is loaded from the Vite dev server rather than from `app://`, so the
 * per-load CSP cannot come from the scheme handler. This attaches the development variant to the dev
 * server's own responses, which is what keeps the shell hardened in development rather than only at
 * packaging time (§7.1). The caller must not invoke it when `app.isPackaged`.
 */
export function installDevelopmentCsp(
  session         ,
  options                                                                                  ,
)       {
  const devOrigin = new URL(options.devServerOrigin).origin;
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith(devOrigin)) {
      callback({});
      return;
    }
    const nonce = randomBytes(CSP_NONCE_BYTES).toString('base64');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          developmentCsp({
            serverOrigin: options.serverOrigin(),
            nonce,
            devServerOrigin: devOrigin,
          }),
        ],
      },
    });
  });
}
