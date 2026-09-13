/**
 * The single normative web Content-Security-Policy (07-client-applications.md section 6.2, decision
 * D07-41) and the hardening header set that travels with it.
 *
 * D07-41 exists because four "exact" variants of this header once lived in four sections, and the
 * one a test asserted added a `script-src` nonce the SPA has no use for while omitting `font-src` —
 * which, under `default-src 'none'`, blocks the self-hosted fonts. So: one string, one home, one
 * fixture. `security.headers.integration` renders this function and compares the response against
 * it, with the nonce matched by pattern.
 *
 * Two directives are deliberate and must not be "tidied":
 *
 *  - `script-src 'self'` carries **no** nonce: the SPA ships no inline script. The nonce exists for
 *    `style-src`, because CodeMirror injects `<style>` elements at runtime through style-mod.
 *  - `font-src 'self'`, `manifest-src 'self'` and the `blob:` in `worker-src` are load-bearing under
 *    `default-src 'none'`: dropping any of them is a product break, not a tightening.
 */

/** The helmet directive object for `/app/*`, with the per-response style nonce filled in. */
export function webCspDirectives(
  publicHost: string,
  styleNonce: string,
  extraConnectSources: readonly string[] = [],
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze({
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", `'nonce-${styleNonce}'`],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", `wss://${publicHost}`, ...extraConnectSources],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  });
}

/** Renders the directives as the header value, in the order 07 section 6.2 prints them. */
export function renderCsp(directives: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(directives)
    .map(([name, values]) => (values.length === 0 ? name : `${name} ${values.join(' ')}`))
    .join('; ');
}

/**
 * The hardening headers of 07 section 6.2 that helmet does not derive from the CSP. `Permissions-Policy`
 * is spelled out rather than generated because its value is an allowlist of *denials* and a generated
 * one would silently shrink when a feature is renamed upstream.
 */
export const HARDENING_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-embedder-policy': 'credentialless',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=(), idle-detection=()',
});

/** HSTS, as helmet configures it: one year, subdomains included, no preload claim. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

/** `Cache-Control` for a content-hashed `/app/assets/*` file. */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** `Cache-Control` for the SPA entry document, which carries a per-request nonce. */
export const ENTRY_DOCUMENT_CACHE_CONTROL = 'no-store';

/** `Cache-Control` for favicons and manifest-like files under `/app/`. */
export const STATIC_METADATA_CACHE_CONTROL = 'public, max-age=3600';

/** The literal the Vite HTML transform emits and the server substitutes per request (D07-10). */
export const CSP_NONCE_PLACEHOLDER = '__IRIDIUM_CSP_NONCE__';
