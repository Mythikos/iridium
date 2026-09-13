/**
 * Spike S07 — the sandboxed preload. Single CJS file, exactly as the shipped shell's preload is.
 * Throwaway harness for `docs/spikes/S07-electron-enterprise-ca.md`.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('s07', {
  ready: () => ipcRenderer.invoke('s07:ready'),
  onStage: (handler) => {
    ipcRenderer.on('s07:stage', (_event, stage) => {
      void handler(stage);
    });
  },
  report: (payload) => ipcRenderer.invoke('s07:report', payload),
});
