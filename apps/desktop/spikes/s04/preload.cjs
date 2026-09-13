// Spike S04 — a no-op preload. The product's hardened `webPreferences` require a preload path, and
// the harness needs no bridge: main reads the page's report with `webContents.executeJavaScript`.
module.exports = {};
