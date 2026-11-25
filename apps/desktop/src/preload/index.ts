import { contextBridge, ipcRenderer } from 'electron';

import {
    type DesktopBridge,
    type FindCommand,
    IPC_CHANNELS,
    parseUpdateStatus,
    WINDOW_MATERIAL_ARGUMENT,
} from '../shared/bridge';

// Synchronous, so the field exists before the page's first script runs. The main process answers only the app's own top frame.
const daemon = ipcRenderer.sendSync(IPC_CHANNELS.getDaemon) as DesktopBridge['daemon'] | null;

const desktop: DesktopBridge = {
    platform: process.platform as DesktopBridge['platform'],
    material: process.argv.includes(WINDOW_MATERIAL_ARGUMENT),
    setThemeSource: theme => ipcRenderer.invoke(IPC_CHANNELS.setThemeSource, theme),
    chooseDirectories: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDirectories),
    onDaemonChange: listener => {
        const handler = (_event: unknown, address: unknown) => {
            if (
                typeof address === 'object' &&
                address !== null &&
                typeof (address as { url?: unknown }).url === 'string' &&
                typeof (address as { token?: unknown }).token === 'string'
            ) {
                listener({ url: (address as { url: string }).url, token: (address as { token: string }).token });
            }
        };

        ipcRenderer.on(IPC_CHANNELS.daemonChanged, handler);

        return () => void ipcRenderer.removeListener(IPC_CHANNELS.daemonChanged, handler);
    },
    ready: () => ipcRenderer.invoke(IPC_CHANNELS.ready),
    restartToUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.restartToUpdate),
    replaceDaemon: () => ipcRenderer.invoke(IPC_CHANNELS.replaceDaemon),
    getUpdateStatus: async () => {
        const status = parseUpdateStatus(await ipcRenderer.invoke(IPC_CHANNELS.getUpdateStatus));

        if (!status) throw new Error('The main process sent no update status');

        return status;
    },
    onUpdateStatus: listener => {
        const handler = (_event: unknown, value: unknown) => {
            const status = parseUpdateStatus(value);

            if (status) listener(status);
        };

        ipcRenderer.on(IPC_CHANNELS.updateStatus, handler);

        return () => void ipcRenderer.removeListener(IPC_CHANNELS.updateStatus, handler);
    },
    findInPage: (text, options) => ipcRenderer.invoke(IPC_CHANNELS.findInPage, text, options),
    stopFind: () => ipcRenderer.invoke(IPC_CHANNELS.stopFind),
    onFindCommand: listener => {
        const handler = (_event: unknown, command: unknown) => {
            if (command === 'open' || command === 'next' || command === 'previous') listener(command as FindCommand);
        };

        ipcRenderer.on(IPC_CHANNELS.findCommand, handler);

        return () => void ipcRenderer.removeListener(IPC_CHANNELS.findCommand, handler);
    },
    getOpenApps: () => ipcRenderer.invoke(IPC_CHANNELS.openApps),
    openPath: (path, app) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path, app),
    readClipboardFiles: () => ipcRenderer.invoke(IPC_CHANNELS.clipboardFiles),
    writeClipboardFiles: paths => ipcRenderer.invoke(IPC_CHANNELS.copyFiles, paths),
    pasteClipboardFiles: (folder, items) => ipcRenderer.invoke(IPC_CHANNELS.pasteFiles, folder, items),
    ...(daemon && { daemon }),
};

contextBridge.exposeInMainWorld('desktop', desktop);
