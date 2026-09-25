# D06-40: one definition of the read-permission labels

Status: accepted 2026-09-25.

`packages/contracts/src/permission-labels.ts` exports `READ_PERMISSION_LABELS`, a frozen record over exactly the six `READ_SCOPES` permissions, exported through the contracts barrel and declared so that a new read scope without a label does not compile. The server-rendered consent page, `apps/server/src/oauth/consent-page.ts`, renders its six permission lines from it (D06-31 as amended). At M4, `packages/ui/src/i18n/en.ts` derives its `permission.<scope>` group from it — imported, never copied — through a typed mapped-key helper that keeps literal key types, so `t()` stays compile-checked, the typed table remains the UI's only string source (A55, D07-17) and `guards.i18n.guard` still holds. The consent page and the token dialog therefore cannot describe one permission two ways.

Strings that both tags need belong in the `core` package both may import: `apps/server` cannot import the browser-tagged `@iridium/ui`, and the page is live from M3 while `@iridium/ui` arrives at M4. One definition keeps the PAT dialog and the consent page from diverging. Rejected: the labels in `packages/contracts/src/tokens.ts` beside the credential format; hand-copying the labels into the server; generating them from `en.ts` into the server.

Verification: `oauth.permission-labels.unit` (`packages/contracts/src/oauth.permission-labels.unit.spec.ts`: the key set equals `READ_SCOPES`); `oauth.consent-page.integration` (the page's permission lines equal `READ_PERMISSION_LABELS`); `guards.i18n.guard` from M4.

Source: D06-40 in [the decision log](../plan/13-decision-log.md) and in [06-mcp-and-agent-access.md](../plan/06-mcp-and-agent-access.md), "Decisions made in this section".
