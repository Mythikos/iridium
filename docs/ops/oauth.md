# OAuth authorization server (operator view)

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

The operator's document for the OAuth 2.1 authorization server: the two MCP URLs and which client uses which (`/mcp` for a static integration token, `/mcp/connect` for a connector that signs in); the four `/.well-known/` paths that must return `404` and how to verify them through the proxy with `iridium doctor --oauth`; the public-HTTPS reachability requirement for a cloud connector; the registration policy and how to disable dynamic client registration; how to list registered clients with `iridium oauth clients list` (M3) and what an unverified (dynamic) registration means, with the `/admin/oauth-clients` and consent-list section added at M7 with the console; the browser sign-in surface and the `iridium doctor --oauth` line that reports it (M3 builds serve none; connectors can sign in from M4, AG9); Client ID Metadata Documents: when the server fetches one, the address rule, `OAUTH_CIMD_DENY_CIDR` and egress policy as the primary control; why a connector whose redirect endpoint forwards to another origin cannot complete the consent flow; how to revoke a connector for one user (`DELETE /me/oauth-consents/:consentId`, or `iridium oauth consents revoke`) or for everyone (`iridium oauth clients disable`); and why a restart drops pending consent requests (`ConsentRequestStore` is in-process, so this is a ten-second inconvenience, never a lost grant).

## Source

- docs/plan/11-operations-and-deployment.md, the paragraph on `docs/ops/oauth.md` under egress and reachability
- docs/plan/06-mcp-and-agent-access.md, "Client ID Metadata Documents" and the consent page
- docs/plan/12-milestones.md §7 (M3 scope, new at M3)
- docs/adr/0060-oauth-authorization-server.md (AG1), docs/adr/0062-connector-proof-at-m4-exit.md (AG9), docs/adr/d06-31-consent-page.md, docs/adr/d06-41-cimd-fetch.md

## Client ID Metadata Documents

Written from the settled M3 design, ahead of the rest of this document, because it names an operator key M3 adds, `OAUTH_CIMD_DENY_CIDR` (D06-41).

A connector may identify itself by a URL: its `client_id` is an HTTPS URL at which it publishes a Client ID Metadata Document. A `client_id` is treated as such a URL only when it is an ASCII `https` URL of at most 512 characters with a non-empty path and no userinfo, fragment, query or `.`/`..` segment.

**When the server fetches.** Only while the effective `oauthPolicy.allowClientIdMetadataDocuments` is on (its baseline is `OAUTH_ALLOW_CLIENT_ID_METADATA_DOCUMENTS`), only for a request that carries a live session, that is, a signed-in user completing an authorization, and only within that user's budget of 20 fetches or revalidations per hour. An anonymous request never causes an outbound fetch. Over budget, a stored document serves as if its host were unreachable, and a client with no stored document gets the error page.

**One exchange, bounded.** The server makes one HTTPS request to one checked address, with the socket pinned to it: no redirect is followed (any `3xx` makes the `client_id` unresolvable), no URL inside the document is ever fetched, the body is capped at 32 KiB and the exchange at 5 seconds. The document's own `client_id` must equal the URL byte for byte. A valid document is kept with the client's record and revalidated with its `ETag` after 24 hours. A definitive refusal (a `3xx` or `4xx`, an invalid document, or an address that fails the rule below) makes the `client_id` unresolvable until a later fetch succeeds; an unreachable host (DNS, connect, TLS, timeout or `5xx`) lets the stored document serve.

**The address rule.** Every address the host resolves to must pass it; one failing address refuses the fetch.

- An IPv4 address is refused inside any block of the IANA IPv4 Special-Purpose Address Registry that is not globally reachable (a more specific entry never re-admits it), inside `224.0.0.0/4`, or inside `240.0.0.0/4`.
- Three IPv6 prefixes are unwrapped to the IPv4 rule: `::ffff:0:0/96` and `64:ff9b::/96` by their low 32 bits, and `2002::/16` by bits 16–47.
- Every other IPv6 address must lie inside `2000::/3` and outside every block of the IANA IPv6 Special-Purpose Address Registry that is not globally reachable. So `2001::/23`, `2001:db8::/32`, `3fff::/20`, `::/96`, `64:ff9b:1::/48`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `::1` and `::` are all refused.
- Then the operator's deny list applies, to every resolved address and to the IPv4 address embedded in an unwrapped one.

The registry tables are compiled into the server with their revision date, so a registry change arrives with a release. No configuration relaxes the rule.

**The deny list.** `OAUTH_CIMD_DENY_CIDR` ([configuration.md](./configuration.md)) is a comma-separated list of IPv4 and IPv6 CIDRs, empty by default and tighten-only. List the deployment's own routable internal space: internal global-unicast IPv6 prefixes, any internally routed public IPv4 ranges, and any network-specific NAT64 prefix, as its IPv6 CIDR.

**Egress is the primary control.** The server can classify only what the registries and the deny list describe, so block the same ranges at the network egress layer as well. A site with no egress cannot authorize a connector that identifies itself this way, because its document cannot be fetched; such a site sets `OAUTH_ALLOW_CLIENT_ID_METADATA_DOCUMENTS=false`, so the refusal is a policy with a message rather than a timeout, or `MCP_OAUTH_ENABLED=false`. Dynamic registration and administrator-registered clients need no egress.

**Client records.** A metadata-document client's record is created by the first user who presses Allow on its consent page, never by resolving it, viewing the consent page or pressing Cancel. Such a record is therefore never unused: it does not count against `OAUTH_MAX_UNUSED_CLIENTS` and the unused-client sweep never removes it.

## Redirect endpoints must not forward to another origin

Written from the settled M3 design, ahead of the rest of this document, because it constrains every client registration (the D06-31 amendment of 2026-09-25).

The consent page's Content Security Policy allows its form to submit only to Iridium itself and to the origin of the client's validated `redirect_uri` (`form-action 'self' <origin>`; for an IPv6 loopback literal, `'self' http:`). A browser that applies `form-action` to redirects (Chromium, which the desktop shell also embeds) checks every hop of the navigation that follows the form submission. The authorization therefore completes when the registered redirect endpoint answers the redirected request itself, or redirects onward only within its own origin. An endpoint that forwards to another origin, such as an authentication subdomain's callback that forwards to the application's origin, is refused by the browser: the consent page stays where it is and the browser console reports the policy violation. The remedy is a redirect URI that completes the flow at its own origin.

This is the accepted cost of keeping the injection defence on the one page where an injected form could divert an approval. When the redirect URI is a loopback URI (`127.0.0.1`, `[::1]` or `localhost`), the consent page adds: "This application receives your approval on this computer. Only continue if you started it yourself."

## Registered clients

Written from the settled M3 design, ahead of the rest of this document, because M3 ships the command that lists them; the `/admin/oauth-clients` page and its consent list are added here at M7 with the console.

`iridium oauth clients list [--kind cimd|dynamic|manual] [--unused] [--include-deleted] [--json]` prints each client's `client_id`, registration kind, name, status, live consent count, token count, and first and last authorization. Retired (`deleted`) clients are listed only with `--include-deleted` (D06-43). The registration kind is the verification state:

- `cimd`: the identity is a URL the client controls, and Iridium verified that the document fetched from it names that URL.
- `dynamic`: the client registered itself through `POST /oauth/register`. Iridium cannot verify who operates it, so it is marked unverified everywhere it is shown, and its consent page says so and asks the user to continue only if they started the flow from that application.
- `manual`: a server administrator registered it through `POST /admin/oauth-clients` (step-up); it is always confidential and receives a secret shown once.

`--unused` lists the dynamic clients that have never completed an authorization: the population `OAUTH_MAX_UNUSED_CLIENTS` bounds and the unused-client sweep clears after `OAUTH_UNUSED_CLIENT_TTL_DAYS`. `iridium oauth clients disable` cuts off every token of a client for every user; `DELETE /me/oauth-consents/:consentId` (step-up) and `iridium oauth consents revoke` withdraw one user's grant.

## Browser sign-in surface

Written from the settled M3 design, ahead of the rest of this document, because every M3 build serves no browser sign-in and an operator needs to know what a connector sees (AG9).

A connector's authorization starts in the user's browser at `/oauth/authorize`. A browser with no Iridium session can be sent to sign in only when the server serves a sign-in surface, which the server decides once at boot from the web bundle's entry document: the surface is `/app/login` only when that document carries the `iridium-sign-in` marker, and a marker that names any other path refuses boot with exit 2.

Every M3 build serves none: an API-only server (`IRIDIUM_WEB_DIR` unset), a server whose entry document is missing, and the image, whose web bundle carries no marker until M4. Then, once `client_id` and `redirect_uri` are validated, a browser with no session receives the `access_denied` error redirect to the client, whose description names the missing browser sign-in. The refusal carries no session, so it writes no audit row: it writes one `authz.denied` log line naming the surface and is counted in `iridium_oauth_authorize_denied_total{reason="no_sign_in_surface"}`. A metadata-document client with no stored document gets the HTML error page naming the missing browser sign-in instead, logged and counted the same way, because no `redirect_uri` can be validated without its document.

When `MCP_OAUTH_ENABLED` is true and no sign-in surface is served, the server logs one warn line at boot, `oauth.sign_in_surface.absent {reason}`. `iridium doctor --oauth` prints `Browser sign-in: /app/login` or `Browser sign-in: none (<reason>)` beside the two MCP URLs, where the reason is `web_dir_unset`, `entry_document_missing` or `no_sign_in_route`. That line is information and never fails the command, because no surface is a legitimate state for M3 and for API-only deployments; a marker that names another path is reported as a failure (exit 6). Connectors can sign in from M4 (AG9).
