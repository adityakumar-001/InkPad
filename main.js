/* main.js — InkPad desktop app (Electron): khulte hi FULLSCREEN, bina click */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true, // launch hote hi poori screen (koi gesture/F11 nahi chahiye)
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: 'InkPad',
    icon: path.join(__dirname, 'assets', 'icon-512.png'),
    webPreferences: { contextIsolation: true }
  });
  win.loadFile('index.html');
  // Esc se bahar aaye to maximized window me rahe (app band nahi hoga)
  win.on('leave-full-screen', () => { if (!win.isMaximized()) win.maximize(); });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
