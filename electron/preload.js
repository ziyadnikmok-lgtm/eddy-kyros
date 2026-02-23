// electron/preload.js
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  version: process.env.npm_package_version || 'dev',
});
