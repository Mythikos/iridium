/**
 * The per-load Content-Security-Policy of the Electron renderer (07-client-applications.md §7.3).
 *
 * The policy is generated from the active profile so the server origin is never hard-coded, and the
 * development variant lives in its own function that is unreachable when `app.isPackaged` — which
 * is the property `desktop.csp.spec` asserts at M5 (the packaged variant contains no `localhost`).
 * This module is pure so both variants stay testable without launching a window.
 */

/** Length of the per-load nonce in bytes before base64 encoding (§7.3). */
export const CSP_NONCE_BYTES = 16;

/** The literal the scheme handler replaces in `index.html` (D07-10). */
export const CSP_NONCE_PLACEHOLDER = '__IRIDIUM_CSP_NONCE__';

                             
     
                                                                                                  
                                                         
     
                                       
                         
     
                                                                                               
                                                              
     
                                  
 

function connectSources(options            )         {
  if (options.serverOrigin === null) return "'none'";
  const host = new URL(options.serverOrigin);
  const https = `${host.protocol}//${host.host}`;
  if (options.ipcWebSocket === true) return https;
  const wsScheme = host.protocol === 'http:' ? 'ws:' : 'wss:';
  return `${https} ${wsScheme}//${host.host}`;
}

function render(directives                   )         {
  return directives.join('; ');
}

/**
 * The policy every packaged load carries. It differs from the web CSP of §6.2 exactly as the table
 * in §7.3 records: `img-src` adds `iridium-attachment:`, `connect-src` names the profile's origin
 * rather than `'self'`, `form-action` is `'none'`, and no HSTS/COOP/CORP is meaningful for a custom
 * scheme.
 */
export function packagedCsp(options            )         {
  return render([
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${options.nonce}'`,
    "img-src 'self' data: blob: https: iridium-attachment:",
    "font-src 'self'",
    `connect-src ${connectSources(options)}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]);
}

                                                           
                                                                                              
                                   
 

/**
 * The development variant. It adds the Vite dev origin, its `ws://` HMR endpoint and the React
 * refresh preamble, which needs `'unsafe-inline'` for `script-src` — which is exactly why this
 * function must never be reachable from a packaged build.
 */
export function developmentCsp(options                       )         {
  const dev = new URL(options.devServerOrigin);
  const devOrigin = `${dev.protocol}//${dev.host}`;
  const devWs = `ws://${dev.host}`;
  const connect = connectSources(options);
  return render([
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${devOrigin}`,
    `style-src 'self' 'unsafe-inline' ${devOrigin} 'nonce-${options.nonce}'`,
    `img-src 'self' data: blob: https: iridium-attachment: ${devOrigin}`,
    `font-src 'self' ${devOrigin}`,
    `connect-src ${connect === "'none'" ? '' : `${connect} `}${devOrigin} ${devWs}`.trim(),
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]);
}
