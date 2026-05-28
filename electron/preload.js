// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  version: process.env.npm_package_version || 'dev',
  chooseDownloadFolder: (options) => ipcRenderer.invoke('downloads:choose-directory', options),
  saveFileToFolder: (payload) => ipcRenderer.invoke('downloads:save-file', payload),
  licenseLoad: () => ipcRenderer.invoke('license:load'),
  licenseActivate: (key) => ipcRenderer.invoke('license:activate', key),
  licenseClear: () => ipcRenderer.invoke('license:clear'),
});
