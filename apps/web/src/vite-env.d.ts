/// <reference types="vite/client" />

/**
 * The single Changesets product version, injected by the shared renderer config's `define`
 * (07-client-applications.md §6.1). It is the only build-time value in the bundle: the web host has
 * no runtime configuration and no way to inject a secret.
 */
declare const __IRIDIUM_VERSION__: string;
