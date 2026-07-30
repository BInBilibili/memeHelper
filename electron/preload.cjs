const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memeDesktop', {
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  saveImage: (dataUrl, suggestedName) => ipcRenderer.invoke('file:save-image', { dataUrl, suggestedName }),
  showItem: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  loadTemplates: () => ipcRenderer.invoke('templates:load'),
  saveTemplates: (templates) => ipcRenderer.invoke('templates:save', templates),
  publishTemplates: (templates) => ipcRenderer.invoke('templates:publish', templates),
  isDesktop: true
});
