# D06-42: strictness of the served OAuth metadata

Status: accepted 2026-09-25.

`oauth.metadata.contract` parses the two served documents with `OAuthProtectedResourceMetadataSchema` and `OAuthMetadataSchema` from `@modelcontextprotocol/core` 2.0.0 only, and, because those pinned schemas are loose, adds a declared-key check: every top-level key of a served document must be declared by its core schema, with one extension, RFC 8414's `ui_locales_supported`. It also checks byte equality with four committed fixtures, one per combination of the dynamic-registration and CIMD policies. `client_id_metadata_document_supported` appears if and only if the effective CIMD policy allows it, and `registration_endpoint` if and only if the effective registration policy does, both rendered from the effective policy per request (D06-33 as amended). The strictness governs Iridium's own served metadata; a client's metadata document is parsed non-strictly (D06-41).

A key-set check against each schema's declared shape restores the strictness the loose schemas lost, so a misspelt or invented member fails the contract instead of being carried to every client, and the fixtures pin the exact bytes each policy combination serves. Rejected: parsing against an OpenID Provider schema, since the document is an OAuth 2.0 Authorization Server Metadata document (AG1); a hand-written field list, which can drift from the specification.

Verification: `oauth.metadata.contract`.

Source: D06-42 in [the decision log](../plan/13-decision-log.md) and in [06-mcp-and-agent-access.md](../plan/06-mcp-and-agent-access.md), "Decisions made in this section".
