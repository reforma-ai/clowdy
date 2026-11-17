import { THEMES, type Theme } from '@clowdy/constants';

import { IPC_CHANNELS } from '../shared/bridge';
import { isTrustedUrl } from './security';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/** Every call is checked against the frame it came from: only the app's own top-level page may use the bridge. */
function assertTrustedSender(event: IpcMainInvokeEvent, trustedOrigin: string): void {
    const frame = event.senderFrame;

    if (!frame || frame !== event.sender.mainFrame || !isTrustedUrl(frame.url, trustedOrigin)) {
        throw new Error('Untrusted sender');
    }
}

export function registerIpc(
    ipcMain: Pick<IpcMain, 'handle'>,
    trustedOrigin: string,
    setThemeSource: (theme: Theme) => void
): void {
    ipcMain.handle(IPC_CHANNELS.setThemeSource, (event, theme: unknown) => {
        assertTrustedSender(event, trustedOrigin);

        if (typeof theme !== 'string' || !THEMES.includes(theme as Theme)) {
            throw new Error('Unknown theme');
        }

        setThemeSource(theme as Theme);
    });
}
