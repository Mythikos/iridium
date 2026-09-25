# D04-10: token principals on step-up routes

Status: accepted; amended 2026-09-25: the `403 token_scope_insufficient` refusal holds in every branch of the route policy, including a policy applied without the boot assertion.

**As accepted.** **Token principals are refused on step-up routes with `403 token_scope_insufficient`**, never `403 step_up_required`.

**Amended 2026-09-25.** A token principal is refused `403 token_scope_insufficient`, with the SIEM reason `token_scope`, on every step-up policy in every branch of `applyRoutePolicy`, including a policy applied without the boot assertion; it is never answered `403 step_up_required`, whose retry a token can never satisfy. `applyRoutePolicy` answered `step_up_required` to a token that reached its step-up check, and two of the route policy's unit cases asserted it; both are corrected. The public-route token boundary is a separate decision, D04-34.

Verification: `authz.rest-token.integration` and the route policy's unit cases.

Source: the D04-10 amendment in [the decision log](../plan/13-decision-log.md), and D04-10 in [04-auth-and-access-control.md](../plan/04-auth-and-access-control.md), "Decisions made in this section".
