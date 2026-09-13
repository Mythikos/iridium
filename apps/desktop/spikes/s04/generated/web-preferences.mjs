/**
 * The hardened `webPreferences` (07-client-applications.md §7.4, rows H1–H6).
 *
 * This module imports nothing at runtime on purpose: the object is the security boundary between
 * untrusted note content and the operating system, so it is a pure value that
 * `desktop.webPreferences.guard` can snapshot without stubbing Electron, and `window.ts` is the only
 * caller. Every row below is mandatory; none of it is optional configuration.
 */
                                               

/**
 * The dedicated session (H6). Logout clears this partition's cookies, cache storage, IndexedDB,
 * WebSQL and service workers — never its `localStorage`, which is shared by every profile on the
 * machine (07-client-applications.md D07-06, D07-39).
 */
export const IRIDIUM_PARTITION = 'persist:iridium';

                                                
                                                                                                    
                           
                                                                                            
                             
 

export function hardenedWebPreferences(options                               )                 {
  return {
    // H1 — sandbox everywhere. `app.enableSandbox()` sets the process-wide default; this is the
    // explicit per-window restatement the snapshot pins.
    sandbox: true,
    // H2 — context isolation; no Node in the renderer, not even in a worker.
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    // H3 — no `<webview>`, and a dropped file never navigates the window.
    webviewTag: false,
    navigateOnDragDrop: false,
    // H4 — DevTools only unpackaged.
    devTools: options.devTools,
    // H5 — content cannot spam `alert`/`confirm`/`prompt`.
    safeDialogs: true,
    // H6 — the dedicated session.
    partition: IRIDIUM_PARTITION,
    // The only bridge between Electron APIs and the renderer (H15).
    preload: options.preload,
    // Never relaxed. The two anti-patterns banned by the CI greps of §7.4 are `webSecurity: false`
    // and `ignore-certificate-errors`; stating the safe value here makes a regression a diff.
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    // Iridium is a writing tool (§7.13); the dictionary lives in the session's own storage.
    spellcheck: true,
  };
}
