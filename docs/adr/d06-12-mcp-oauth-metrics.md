# D06-12: the MCP and OAuth metrics

Status: accepted; amended 2026-09-25: the M3 metric set is the closed catalogue 11 "Metrics" lists, with operation, layer, surface and reason labels drawn from closed lists.

**As accepted.** Add five metrics to the A49 registry: `iridium_mcp_tool_errors_total{tool}`, `iridium_token_auth_failures_total{reason}` (`malformed`, `unknown_id`, `secret_mismatch`, `revoked`, `expired`, `user_inactive`, `rotation_overlap_elapsed`, `wrong_kind_for_route`, `audience_mismatch`, `consent_revoked`, `client_disabled`), `iridium_access_log_dropped_total`, `iridium_oauth_refresh_reuse_total` and `iridium_oauth_registration_refused_total`. A49 covers MCP calls, rate limiting and factory errors but not tool-level failures, credential-rejection reasons (the signal that distinguishes a misconfigured agent from a credential-stuffing attempt) or access-log loss. The OAuth rejection reasons are what separates "a connector is pointed at the wrong URL" from "a credential is being probed", and refresh reuse is a security event an operator must be able to alert on.

**Amended 2026-09-25.** The M3 metric set, each series registered with its closed label values zero-initialised in `ops/metrics.ts`, and each listed in 11's catalogue and 12 §7.2:

- `iridium_mcp_calls_total{operation, status}` — `operation` from `MCP_OPERATIONS` (the `access_log` action without `mcp.`, an unknown method or tool being `other`), `status` the five `access_log` statuses — incremented exactly once per MCP `access_log` record, so it equals the MCP row count while `iridium_access_log_dropped_total` is zero. 11's label discipline defines `tool` (one of the six tools) and `operation` separately.
- `iridium_mcp_tool_errors_total{tool}`; `iridium_mcp_factory_errors_total`; `iridium_mcp_rate_limited_total{layer='ip'|'process'}`, the MCP-only layers; `iridium_token_budget_refused_total{surface='mcp'|'rest', layer='burst'|'hourly'}`, counted once by `TokenBudget` (D04-37).
- `iridium_tokens_active{kind='pat'|'oauth'}`, whose 60-second live count is served by `ix_tokens_expires` (D04-35); `iridium_oauth_consents_active`; `iridium_oauth_tokens_issued_total{grant='authorization_code'|'refresh_token'}`.
- `iridium_oauth_authorize_denied_total{reason}` over `unknown_client`, `invalid_redirect_uri`, `cimd_disabled`, `unsupported_response_type`, `invalid_request`, `invalid_target`, `invalid_scope`, `unauthorized_client`, `rate_limited` and `no_sign_in_surface`.
- `iridium_oauth_registration_refused_total{reason}` over `rate_limited`, `ceiling`, `policy_disabled`, `invalid_client_metadata` and `invalid_redirect_uri`.
- `iridium_oauth_refresh_reuse_total`, counting only the `REUSE_SIGNAL_REVOKE_REASONS` cases (D06-29 as amended); `iridium_oauth_code_replay_total` and `iridium_oauth_code_client_mismatch_total`, without labels (D03-26).
- `iridium_token_auth_failures_total{reason}` keeps the nine labels shipped at M1: `mcpAuth` maps its fine reasons through `TOKEN_AUTH_FAILURE_REASONS` (so `malformed` counts as `bad_format`), and the fine reason stays in the `token.denied` audit row. A token-endpoint `400` is not counted there.
- `iridium_access_log_dropped_total{reason='overflow'|'write_failed'}` (D06-11 as amended) and `iridium_token_last_used_dropped_total` (D06-49).

Rejected: widening a label named `tool` to protocol methods; counting only `tools/call`; passing caller-supplied names into a label; a second set of token-auth-failure labels beside the nine shipped at M1.

Verification: `metrics.integration` (the catalogue, each series zero-initialised, the calls counter equal to the MCP row count, and the `iridium_tokens_active` query's `EXPLAIN` on `ix_tokens_expires`) and `ops.alerts.unit`.

Source: the D06-12 amendment in [the decision log](../plan/13-decision-log.md), and D06-12 in [06-mcp-and-agent-access.md](../plan/06-mcp-and-agent-access.md), "Decisions made in this section".
