/**
 * @iridium/desktop — the sandboxed preload (single-file CJS). M0 placeholder; the desktop work item
 * exposes iridium:app:info through contextBridge and the preload-surface snapshot test pins it.
 */
const preloadName = '@iridium/desktop/preload' as const;

module.exports = { preloadName };
