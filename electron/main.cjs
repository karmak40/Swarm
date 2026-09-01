const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

/**
 * Save files live under Electron's per-OS user-data directory (e.g.
 * %APPDATA%/SWARM on Windows) — point Steam Cloud's sync path at this same
 * directory once the app is registered in Steamworks. `name` is a save.ts
 * storage key (`swarm.save.v1` / `swarm.run.v1`); it never contains path
 * separators, so joining it in directly is safe.
 */
function saveFilePath(name) {
  return path.join(app.getPath('userData'), `${name}.json`);
}

ipcMain.on('save:read', (event, name) => {
  try {
    event.returnValue = fs.readFileSync(saveFilePath(name), 'utf8');
  } catch {
    event.returnValue = null;
  }
});

ipcMain.on('save:write', (event, name, content) => {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(saveFilePath(name), content, 'utf8');
  } catch {
    /* best-effort — a failed write just means this session doesn't persist */
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#05070c',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

Menu.setApplicationMenu(null);

void app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
