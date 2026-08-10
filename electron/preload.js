// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  version: process.env.npm_package_version || 'dev',
  chooseDownloadFolder: (options) => ipcRenderer.invoke('downloads:choose-directory', options),
  autoDownloadFolder: (options) => ipcRenderer.invoke('downloads:auto-directory', options),
  saveFileToFolder: (payload) => ipcRenderer.invoke('downloads:save-file', payload),
  licenseLoad: () => ipcRenderer.invoke('license:load'),
  licenseActivate: (payload) => ipcRenderer.invoke('license:activate', payload),
  licenseClear: () => ipcRenderer.invoke('license:clear'),
  startDragFiles: (payload) => ipcRenderer.send('drag:start-files', payload),
});
