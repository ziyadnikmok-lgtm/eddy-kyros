'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('redditBot', {
  startSession: (config) => ipcRenderer.invoke('session:start', config),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  runTest: (config) => ipcRenderer.invoke('session:test', config),
  getStatus: () => ipcRenderer.invoke('session:status'),
  saveAccounts: (data) => ipcRenderer.invoke('accounts:save', data),
  loadAccounts: () => ipcRenderer.invoke('accounts:load'),
  resetWatchMemory: () => ipcRenderer.invoke('watch:reset'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onEvent: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('session:event', handler);
    return () => ipcRenderer.removeListener('session:event', handler);
  },
});
