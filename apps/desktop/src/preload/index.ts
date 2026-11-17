import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, WINDOW_MATERIAL_ARGUMENT, type DesktopBridge } from '../shared/bridge';

const desktop: DesktopBridge = {
    platform: process.platform as DesktopBridge['platform'],
    material: process.argv.includes(WINDOW_MATERIAL_ARGUMENT),
    setThemeSource: theme => ipcRenderer.invoke(IPC_CHANNELS.setThemeSource, theme),
};

contextBridge.exposeInMainWorld('desktop', desktop);
