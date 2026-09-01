// Bridge for native hooks (Steamworks, etc). Currently exposes save-file
// persistence — see src/core/save.ts, which prefers this over localStorage
// whenever it's present, so Steam Cloud (or any backup tool) can sync a real
// file in the OS user-data directory instead of chasing browser storage.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swarmNative', {
  /** Synchronous by design — save.ts's load path is synchronous end to end. */
  readFileSync: (name) => ipcRenderer.sendSync('save:read', name),
  /** Fire-and-forget; writes are already throttled on the caller's side. */
  writeFile: (name, content) => ipcRenderer.send('save:write', name, content),
});
