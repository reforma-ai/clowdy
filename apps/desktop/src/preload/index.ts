import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, WINDOW_MATERIAL_ARGUMENT, type DesktopBridge } from '../shared/bridge';

// Synchronous, so the field exists before the page's first script runs. The main process answers only the app's own top frame.
const daemon = ipcRenderer.sendSync(IPC_CHANNELS.getDaemon) as DesktopBridge['daemon'] | null;

const desktop: DesktopBridge = {
    platform: process.platform as DesktopBridge['platform'],
    material: process.argv.includes(WINDOW_MATERIAL_ARGUMENT),
    setThemeSource: theme => ipcRenderer.invoke(IPC_CHANNELS.setThemeSource, theme),
    chooseDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory),
    onDaemonChange: (listener) => {
        const handler = (_event: unknown, address: unknown) => {
            if (typeof address === 'object' && address !== null && typeof (address as { url?: unknown }).url === 'string' && typeof (address as { token?: unknown }).token === 'string') {
                listener({ url: (address as { url: string }).url, token: (address as { token: string }).token });
            }
        };

        ipcRenderer.on(IPC_CHANNELS.daemonChanged, handler);

        return () => void ipcRenderer.removeListener(IPC_CHANNELS.daemonChanged, handler);
    },
    ...daemon && { daemon },
};

contextBridge.exposeInMainWorld('desktop', desktop);
