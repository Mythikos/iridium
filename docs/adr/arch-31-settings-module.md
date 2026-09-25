# ARCH-31: the settings module

Status: accepted 2026-09-25.

**The module.** Server settings are one module, `apps/server/src/settings/`, and `config/` stays environment-only: neither `config/settings-store.ts` nor `config/effective.ts` exists, and this replaces the `config/settings-store.ts` location that 02 and 12 §14.2 named.

- `store.ts` — the `SettingsStore` interface of ARCH-19 and `InProcessSettingsStore`: `load()`, `refresh()`, `loaded()`, `effective()`, `floors()`, `stored()`, `version()` and `install(snapshot, version)`.
- `merge.ts` — `baselinesFrom(config)`, which maps the typed `IridiumConfig` onto the baselines and never reads the environment, and the per-member merge over `SERVER_SETTING_RULES` with the contracts `stricterOf` and `isWeakerThanBaseline` (D03-28); no `tighten()` exists.
- `service.ts` — the `PUT /admin/settings` transaction, whose versioning and post-COMMIT `install` are D09-10's as amended. A `PUT` replaces the named groups' known members; under a tolerated newer schema it merges the members this binary does not know back from the locked row, and the API never deletes a row.
- `routes.ts` — `admin.settings.get` and `admin.settings.update`, registered by the `rest` plugin in boot step 8.
- `plugin.ts` — `applySettingsPlugin`, run by `app.ts` in boot step 2 immediately after the `db` plugin: it constructs the store, decorates `app.settings` and registers the fail-closed `server_settings` readiness check, which performs the first load (ARCH-10 and OPS-24 as amended).

**Three lifecycle rules.**

- **Loaded before served.** The store starts unloaded, and `effective()` throws the named `SettingsNotLoadedError` until the first successful load, so no fabricated policy is ever observable. Boot step 2 constructs and decorates only; the `server_settings` check performs the first load once `migrations` is servable, and while it fails every non-ops route answers `503 not_ready`. In database mode `none` the store loads the empty row set, because there are no committed rows and the environment is the whole truth.
- **Honoured per request.** Every setting is honoured per request, never at route registration, and no boot step reads the store. `POST /oauth/register` is registered whenever `MCP_OAUTH_ENABLED` is true, and answers an empty `404` while the effective `oauthPolicy.allowDynamicClientRegistration` is off (D06-33 as amended); `registration_endpoint` is built per request.
- **Only live consumers.** The store carries no group without a live consumer: at M3 exactly `patPolicy`, `mcpEnabled` and `oauthPolicy` (AG12).

**Consumers and construction.** Consumers receive the store, or a function `app.ts` binds to it, by injection and read `effective()` in the camelCase `ServerSettings` shape (`effective().mcpEnabled.enabled`, `effective().oauthPolicy.*`), never row keys. A stateful service is constructed by the plugin that owns its lifecycle — the `SettingsStore` by `settings/plugin.ts`, the `AccessLogWriter` by the `audit` plugin, `TokenBudget` and the `LastUsedTracker` by the `auth` plugin — and `app.ts` constructs only the instances passed across plugins by injection: the token budget's `RateLimitStore`, `cursorSource()` and the REST and MCP `ContentReadCore` instances through `content/read/factory.ts`.

A settings store inside `config/` would mix the one environment parse with database state, a readiness check and a request-serving route; one module owning the table, its validator, the merge and the route gives "environment values are floors" a single implementation with no second merge path, and constructing each stateful service in the plugin that closes it keeps its lifecycle in one place. Rejected: `config/settings-store.ts`; a `tighten(envFloor, stored)` helper beside the contracts merge; fail-closed default values installed before the first load; reading a setting at route registration.

Verification: `settings-store.contract`, `admin.settings.integration` and `readyz.integration` (an unloaded store throws, database mode `none` reports `ok`, and a failed refresh after the first load warns).

Source: ARCH-31 in [the decision log](../plan/13-decision-log.md) and in [02-system-architecture.md](../plan/02-system-architecture.md), "Decisions made in this section".
