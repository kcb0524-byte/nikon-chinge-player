const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  getMusicFilesFromFolder: (folderPath) => ipcRenderer.invoke('get-music-files-from-folder', folderPath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  onAddFiles: (callback) => ipcRenderer.on('add-files', (event, files) => callback(files))
});
