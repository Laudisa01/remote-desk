const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  setPin: (pin, oldPin) => ipcRenderer.invoke('pin:set', { pin, oldPin }),
  verifyPin: (pin) => ipcRenderer.invoke('pin:verify', pin),
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectDisplay: (displayId) => ipcRenderer.invoke('display:select', displayId),
  confirmAccess: () => ipcRenderer.invoke('access:confirm'),
  checkPermissions: () => ipcRenderer.invoke('permissions:check'),
  requestPermission: (which) => ipcRenderer.invoke('permissions:request', which),
  openViewer: () => ipcRenderer.invoke('open:viewer'),
  setSessionActive: (active) => ipcRenderer.send('session:active', active),
  onStopRequest: (fn) => ipcRenderer.on('session:stop', () => fn()),
  input: (msg) => ipcRenderer.send('input', msg),
  platform: process.platform,
});
