const { contextBridge, ipcRenderer, shell, clipboard } = require('electron');
const path = require('node:path');

function normalizeAbsolutePath(root, relPath = '') {
  const value = String(relPath || '');
  if (!root) return value;
  if (path.isAbsolute(value)) return value;
  return path.join(root, value);
}

contextBridge.exposeInMainWorld('recoveryAPI', {
  getState: () => ipcRenderer.invoke('recovery:get-state'),
  getSession: (payload) => ipcRenderer.invoke('recovery:get-session', payload),
  getRoot: () => ipcRenderer.invoke('recovery:root'),
  copyText: (value) => clipboard.writeText(String(value ?? '')),
  openFolder: (folderPath) => shell.openPath(folderPath),
  revealFile: (root, relPath) => shell.showItemInFolder(normalizeAbsolutePath(root, relPath)),
  openFile: (root, relPath) => shell.openPath(normalizeAbsolutePath(root, relPath)),
  normalizeAbsolutePath,
});
