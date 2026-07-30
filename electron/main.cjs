const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const defaultConfig = {
  autoCopy: true,
  templatesFile: 'templates.json',
  window: { width: 1320, height: 860, minWidth: 1024, minHeight: 680 }
};

function appDirectory() {
  return isDev ? app.getAppPath() : path.dirname(process.execPath);
}

function configPath() {
  return path.join(appDirectory(), 'config.json');
}

function loadConfig() {
  try {
    const filePath = configPath();
    if (!fs.existsSync(filePath)) return structuredClone(defaultConfig);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...defaultConfig,
      ...saved,
      window: { ...defaultConfig.window, ...(saved.window || {}) }
    };
  } catch (error) {
    console.error('Failed to load config', error);
    return structuredClone(defaultConfig);
  }
}

function templatesPath() {
  if (isDev) return path.join(appDirectory(), 'src', 'bundled-templates.json');
  const configuredName = path.basename(String(loadConfig().templatesFile || 'templates.json'));
  return path.join(appDirectory(), configuredName);
}

function legacyTemplatesPath() {
  return path.join(app.getPath('userData'), 'templates.json');
}

function readTemplates(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(value) ? value : [];
}

function mergeTemplates(...groups) {
  const merged = [];
  for (const template of groups.flat()) {
    const index = merged.findIndex((item) => item.id === template.id || (item.name === template.name && item.width === template.width && item.height === template.height));
    if (index < 0) merged.push(template);
    else if ((template.updatedAt || 0) > (merged[index].updatedAt || 0)) merged[index] = template;
  }
  return merged;
}

function writeTemplates(filePath, templates) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(templates, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function createWindow(config = loadConfig()) {
  const windowConfig = config.window || defaultConfig.window;
  const win = new BrowserWindow({
    width: Math.max(800, Number(windowConfig.width) || defaultConfig.window.width),
    height: Math.max(600, Number(windowConfig.height) || defaultConfig.window.height),
    minWidth: Math.max(800, Number(windowConfig.minWidth) || defaultConfig.window.minWidth),
    minHeight: Math.max(600, Number(windowConfig.minHeight) || defaultConfig.window.minHeight),
    backgroundColor: '#f5f4ef',
    title: 'MemeHelper',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('clipboard:write-image', (_event, dataUrl) => {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('生成图片为空');
  clipboard.writeImage(image);
  return true;
});

ipcMain.handle('file:save-image', async (_event, { dataUrl, suggestedName }) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName || 'meme.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return null;
  const bytes = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  fs.writeFileSync(result.filePath, bytes);
  return result.filePath;
});

ipcMain.handle('shell:show-item', (_event, filePath) => shell.showItemInFolder(filePath));
ipcMain.handle('config:load', () => loadConfig());

ipcMain.handle('templates:load', () => {
  try {
    const filePath = templatesPath();
    const externalTemplates = readTemplates(filePath);
    if (isDev) return externalTemplates;
    const legacyTemplates = readTemplates(legacyTemplatesPath());
    const merged = mergeTemplates(externalTemplates, legacyTemplates);
    if (JSON.stringify(merged) !== JSON.stringify(externalTemplates)) writeTemplates(filePath, merged);
    return merged;
  } catch (error) {
    console.error('Failed to load templates', error);
    return [];
  }
});

ipcMain.handle('templates:save', (_event, templates) => {
  const filePath = templatesPath();
  writeTemplates(filePath, templates);
  return true;
});

ipcMain.handle('templates:publish', (_event, templates) => {
  const filePath = templatesPath();
  writeTemplates(filePath, templates);
  return filePath;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
