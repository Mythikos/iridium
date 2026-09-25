# D06-51: the all-vaults policy

Status: accepted 2026-09-25. With it D09-19 and D07-31 are amended the same day: `/meta.policies` gains `patAllowAllVaultsForNonAdmins`.

**The policy.** `patPolicy.allowAllVaultsForNonAdmins` is the single policy governing who may scope a credential to every vault, for PATs and for OAuth consent alike (03 §13.1). It is permissive and defaults to `true`; its environment baseline is `PAT_ALLOW_ALL_VAULTS_FOR_NON_ADMINS` (boolean, default `true`, declared with the server-settings vocabulary of D03-28), and the stored value merges with it by logical AND, so either side can switch it off (ARCH-10). A server administrator is refused `all_vaults` whatever the flag says, with `all_vaults_admin_forbidden`, checked first. The effective value is published as `/meta.policies.patAllowAllVaultsForNonAdmins`, which the M4 token dialog reads to hide its all-vaults switch.

**While the effective value is `false`,** a non-administrator's `all_vaults` is refused wherever a credential's lifetime would restart:

- `POST /me/tokens {vaults: 'all'}` answers `422 validation_failed` with `errors[].code` `all_vaults_disabled`;
- `POST /me/tokens/:tokenId/rotate` of an `all_vaults` token answers the same, because rotation mints a new credential with a fresh full lifetime;
- the consent screen shows no all-vaults choice to anyone, and a `POST /oauth/consent` carrying `all_vaults` — a forged form, or an administrator — is answered by re-rendering the consent page with a refusal line: HTTP `422` `text/html`, a fresh `request_id` bound to the same pending request and session (the presented one is consumed), no consent row, no code and no redirect; the server-administrator refusal takes the same path;
- an authorization request for a client whose live consent has `all_vaults = 1` is never granted silently: it re-prompts with the all-vaults choice hidden, and the user's explicit selection updates the consent, audited as `oauth.consent.updated` whose metadata carries `allVaults` for this transition (D04-35).

Existing `all_vaults` PATs keep working to their own `expires_at`, and existing refresh families keep refreshing to their `absolute_expires_at`: a refresh cannot outlive its family, whereas a rotation or a new family would restart a full lifetime, which is why rotation and re-consent are refused and refresh is not. Revoke-all is the operator's tool to cut them sooner.

The policy needs no owner answer: it gives live semantics to a field that 03 §13.1 and 09 §2.15.3 already name under AG12's `patPolicy` group, so no question is raised and G13 remains the only open one. Applying the flag wherever a lifetime restarts makes it bite without a live kill switch, and an `all_vaults` token's reach is already bounded by its owner's live explicit memberships. An HTML browser route never answers `ProblemDetails`, so the consent refusal is a re-rendered page. Rejected: a live kill switch that empties `all_vaults` at verification, which would put a policy branch in `authorize()`'s input resolution against D04-31; default `false`, which changes A31's behaviour and the settled dialogs without cause; letting silent re-consent mint new families under an `all_vaults` consent, which renews the grant indefinitely while the flag says no.

Verification: `tokens.lifecycle.integration` (the creation and rotation `all_vaults_disabled` refusals) and `oauth.consent.integration` (while the flag is false the all-vaults choice is hidden, a forged `all_vaults` POST re-renders the page with no consent row and no code, and a client holding an `all_vaults` consent is re-prompted rather than granted silently).

Source: D06-51 in [the decision log](../plan/13-decision-log.md) and in [06-mcp-and-agent-access.md](../plan/06-mcp-and-agent-access.md), "Decisions made in this section"; D09-19 in [09-api-reference.md](../plan/09-api-reference.md) and D07-31 in [07-client-applications.md](../plan/07-client-applications.md), as amended.
