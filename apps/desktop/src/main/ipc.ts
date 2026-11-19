import { THEMES, type Theme } from '@clowdy/constants';
import { BrowserWindow, dialog } from 'electron';

import { IPC_CHANNELS, type DesktopBridge } from '../shared/bridge';
import { isTrustedUrl } from './security';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

type Sender = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

function isTrustedSender({ sender, senderFrame }: Sender, trustedOrigin: string): boolean {
    return senderFrame !== null && senderFrame === sender.mainFrame && isTrustedUrl(senderFrame.url, trustedOrigin);
}

/** Every call is checked against the frame it came from: only the app's own top-level page may use the bridge. */
function assertTrustedSender(event: Sender, trustedOrigin: string): void {
    if (!isTrustedSender(event, trustedOrigin)) {
        throw new Error('Untrusted sender');
    }
}

export interface IpcActions {
    setThemeSource: (theme: Theme) => void;
    /** Where the daemon is, or `undefined` when none answers. */
    getDaemon: () => Promise<DesktopBridge['daemon']>;
    /** The page rendered: an OTA bundle on its first launch stays. */
    ready: () => Promise<void>;
    /** Restarts into the OTA bundle installed during this run; without one, nothing happens. */
    restartToUpdate: () => void;
}

export function registerIpc(
    ipcMain: Pick<IpcMain, 'handle' | 'on'>,
    trustedOrigin: string,
    { setThemeSource, getDaemon, ready, restartToUpdate }: IpcActions
): void {
    // The preload asks while the page loads and cannot wait for a promise, so this one is synchronous for it.
    // The reply may come later: the renderer blocks until `returnValue` is set. Anyone else gets `null`.
    ipcMain.on(IPC_CHANNELS.getDaemon, event => {
        if (!isTrustedSender(event, trustedOrigin)) {
            event.returnValue = null;

            return;
        }

        void getDaemon().catch(() => undefined).then(daemon => {
            event.returnValue = daemon ?? null;
        });
    });

    ipcMain.handle(IPC_CHANNELS.setThemeSource, (event, theme: unknown) => {
        assertTrustedSender(event, trustedOrigin);

        if (typeof theme !== 'string' || !THEMES.includes(theme as Theme)) {
            throw new Error('Unknown theme');
        }

        setThemeSource(theme as Theme);
    });

    ipcMain.handle(IPC_CHANNELS.ready, async (event) => {
        assertTrustedSender(event, trustedOrigin);
        await ready();
    });

    ipcMain.handle(IPC_CHANNELS.restartToUpdate, (event) => {
        assertTrustedSender(event, trustedOrigin);
        restartToUpdate();
    });

    ipcMain.handle(IPC_CHANNELS.chooseDirectories, async (event): Promise<string[]> => {
        assertTrustedSender(event, trustedOrigin);

        // The dialog belongs to the window that asked, so it opens as a sheet over it.
        const window = BrowserWindow.fromWebContents(event.sender);
        const options = { properties: ['openDirectory' as const, 'createDirectory' as const, 'multiSelections' as const] };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

        return result.canceled ? [] : result.filePaths;
    });
}
