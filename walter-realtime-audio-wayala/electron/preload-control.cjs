const { contextBridge, ipcRenderer } = require('electron');

// Comunicación segura entre OpenAI Realtime y Electron.
contextBridge.exposeInMainWorld('walterElectron', {
  setHeadState(state) {
    if (state !== 'IDLE' && state !== 'SPEAKING') return;
    ipcRenderer.send('walter-head:set-state', state);
  },
});