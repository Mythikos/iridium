/**
 * `security.csrf.unit` — 04-auth-and-access-control.md §4.4's algorithm, case by case.
 *
 * The guard is a pure function of eight request fields plus the configured public origin, which is why
 * `csrfDecision` is exported: the whole table can be driven here without a server, and
 * `security.csrf.integration` then only has to prove the *mounted hook* agrees with it and runs in the
 * right phase. Re-deriving the rules in an integration test would be two readings of one algorithm.
 *
 * There is no inventory row for this name yet; the platform stream's report asks for one beside
 * `security.csrf.integration`.
 */
import { describe, expect, it } from 'vitest';

import type { RouteAuth } from '../authz/route-policy.ts';
import { csrfDecision, originOfReferer, type CsrfRequestView } from './csrf.ts';
import { collabAllowedOrigins } from './ws-origin.ts';

const PUBLIC_ORIGIN = 'https://iridium.example';

const PUBLIC_ROUTE: RouteAuth = { public: true };
const SESSION_ROUTE: RouteAuth = { self: true };
const MCP_ROUTE: RouteAuth = {
  permission: 'note:read',
  vaultFrom: 'params.vaultId',
  bearerOnly: true,
};

function view(overrides: Partial<CsrfRequestView> = {}): CsrfRequestView {
  return {
    method: 'POST',
    route: '/api/v1/vaults',
    hasAuthorization: false,
    hasCookie: true,
    client: 'web',
    auth: SESSION_ROUTE,
    ...overrides,
  };
}

describe('security.csrf.unit [area:security]', () => {
  describe('the passes that come before any header is read', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('never inspects a %s request', (method) => {
      expect(csrfDecision(view({ method, client: null }), PUBLIC_ORIGIN)).toEqual({ pass: true });
    });

    it('passes a bearer request, because it carries no ambient credential', () => {
      expect(csrfDecision(view({ hasAuthorization: true, client: null }), PUBLIC_ORIGIN)).toEqual({
        pass: true,
      });
    });

    it('passes a bearerOnly route, where authentication already required a bearer', () => {
      expect(csrfDecision(view({ auth: MCP_ROUTE, client: null }), PUBLIC_ORIGIN)).toEqual({
        pass: true,
      });
    });

    it('passes a route that declares csrfExempt, the closed enumeration of D04-32', () => {
      expect(csrfDecision(view({ csrfExempt: true, client: null }), PUBLIC_ORIGIN)).toEqual({
        pass: true,
      });
    });
  });

  describe('the custom header', () => {
    it('refuses an absent X-Iridium-Client', () => {
      expect(csrfDecision(view({ client: null }), PUBLIC_ORIGIN)).toEqual({
        pass: false,
        reason: 'client_header',
      });
    });

    it('refuses a mutating request on a public route just as firmly as on an authenticated one', () => {
      // §4.4: the rule covers `POST /auth/sessions` and `POST /auth/set-password` too — they are the only
      // state-changing routes a client reaches before any credential exists.
      expect(csrfDecision(view({ client: null, auth: PUBLIC_ROUTE }), PUBLIC_ORIGIN)).toEqual({
        pass: false,
        reason: 'client_header',
      });
    });
  });

  describe('the desktop branch', () => {
    it('passes a public route with no cookie', () => {
      expect(
        csrfDecision(
          view({ client: 'desktop', hasCookie: false, auth: PUBLIC_ROUTE }),
          PUBLIC_ORIGIN,
        ),
      ).toEqual({ pass: true });
    });

    it('refuses a desktop request that carries a cookie (D04-06 channel binding)', () => {
      expect(
        csrfDecision(
          view({ client: 'desktop', hasCookie: true, auth: PUBLIC_ROUTE }),
          PUBLIC_ORIGIN,
        ),
      ).toEqual({ pass: false, reason: 'desktop_cookie' });
    });

    it('refuses a desktop request without a bearer on an authenticated route', () => {
      expect(
        csrfDecision(
          view({ client: 'desktop', hasCookie: false, auth: SESSION_ROUTE }),
          PUBLIC_ORIGIN,
        ),
      ).toEqual({ pass: false, reason: 'desktop_non_public' });
    });

    it('never applies the Origin comparison to a desktop request', () => {
      // A main-process `net.fetch` sends no Origin, no Referer and no Sec-Fetch-Site. Applying the web
      // branch would reject every desktop login.
      expect(
        csrfDecision(
          view({
            client: 'desktop',
            hasCookie: false,
            auth: PUBLIC_ROUTE,
            origin: 'https://evil.example',
          }),
          PUBLIC_ORIGIN,
        ),
      ).toEqual({ pass: true });
    });
  });

  describe('the web branch: Fetch Metadata first, then Origin or Referer', () => {
    it.each(['same-origin', 'none'])('passes Sec-Fetch-Site: %s', (secFetchSite) => {
      expect(csrfDecision(view({ secFetchSite }), PUBLIC_ORIGIN)).toEqual({ pass: true });
    });

    it.each(['cross-site', 'same-site'])('refuses Sec-Fetch-Site: %s', (secFetchSite) => {
      expect(csrfDecision(view({ secFetchSite }), PUBLIC_ORIGIN)).toEqual({
        pass: false,
        reason: 'fetch_site',
      });
    });

    it('does not fall back to Origin when Sec-Fetch-Site is present but cross-site', () => {
      // The fallback exists for clients that send no Fetch Metadata at all. A browser that says
      // "cross-site" and also sends the right Origin is a browser whose Origin cannot be trusted here.
      expect(
        csrfDecision(view({ secFetchSite: 'cross-site', origin: PUBLIC_ORIGIN }), PUBLIC_ORIGIN),
      ).toEqual({ pass: false, reason: 'fetch_site' });
    });

    it('passes an exact Origin match when no Fetch Metadata is present', () => {
      expect(csrfDecision(view({ origin: PUBLIC_ORIGIN }), PUBLIC_ORIGIN)).toEqual({ pass: true });
    });

    it('refuses a foreign Origin, a different port and a different scheme', () => {
      for (const origin of [
        'https://evil.example',
        'https://iridium.example:8443',
        'http://iridium.example',
      ]) {
        expect(csrfDecision(view({ origin }), PUBLIC_ORIGIN)).toEqual({
          pass: false,
          reason: 'origin',
        });
      }
    });

    it('falls back to the Referer origin, and only to its origin', () => {
      expect(
        csrfDecision(view({ referer: `${PUBLIC_ORIGIN}/app/notes/abc?q=1` }), PUBLIC_ORIGIN),
      ).toEqual({ pass: true });
      expect(csrfDecision(view({ referer: 'https://evil.example/app' }), PUBLIC_ORIGIN)).toEqual({
        pass: false,
        reason: 'origin',
      });
    });

    it('refuses when neither Origin nor Referer is present', () => {
      expect(csrfDecision(view(), PUBLIC_ORIGIN)).toEqual({ pass: false, reason: 'origin' });
    });

    it('treats an unparsable Referer as absent rather than as a match', () => {
      expect(originOfReferer('not a url')).toBeUndefined();
      expect(csrfDecision(view({ referer: 'not a url' }), PUBLIC_ORIGIN)).toEqual({
        pass: false,
        reason: 'origin',
      });
    });
  });

  describe('the two guards do not share an allowlist', () => {
    it('never accepts app://iridium as a REST Origin, though /collab does', () => {
      // The desktop renderer opens `/collab` itself and its Origin is allowlisted there (§7.5). Its REST
      // calls go through the main process with a bearer and no cookie, so `app://iridium` has no business
      // passing the CSRF guard — and the two allowlists are deliberately different lists.
      expect(csrfDecision(view({ origin: 'app://iridium' }), PUBLIC_ORIGIN)).toEqual({
        pass: false,
        reason: 'origin',
      });
      expect(
        collabAllowedOrigins({ env: 'production', publicOrigin: PUBLIC_ORIGIN, devOrigins: [] }),
      ).toContain('app://iridium');
    });
  });
});
