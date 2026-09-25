# D06-35: loopback redirect URIs

Status: accepted; amended 2026-09-25: no redirect URI carries a fragment, and a loopback URI matches path and query exactly.

**As accepted.** Loopback redirect URIs accept `127.0.0.1`, `[::1]` and the hostname `localhost`, at any port, with the path, query and fragment matching exactly. Stated as an assumption: BCP 212 prefers the IP literal because `localhost` can be resolved elsewhere, but Cursor's documented callback is `http://localhost:8787/callback`, and refusing it would break a client this section claims to support. The actual defence against a redirected code is PKCE S256 plus the 60-second single-use code bound to client, redirect URI, resource and session, not the spelling of the loopback host. Spike S15 is where the real callback values are observed.

**Amended 2026-09-25.** No redirect URI carries a fragment, whether registered by DCR, published in a CIMD document or entered for a manual client: RFC 6749 §3.1.2 forbids one, so the accepted text's "fragment matching exactly" is withdrawn. A loopback URI matches at any port with its path and query matching exactly. A validated loopback redirect adds the consent page's warning line (D06-31 as amended), and an http loopback-only set of redirect URIs is what derives `application_type` `native` for a CIMD document that carries none (D06-41).

Verification: `oauth.redirect-uri.unit` and `oauth.dcr.integration`.

Source: the D06-35 amendment in [the decision log](../plan/13-decision-log.md), and D06-35 in [06-mcp-and-agent-access.md](../plan/06-mcp-and-agent-access.md), "Decisions made in this section".
