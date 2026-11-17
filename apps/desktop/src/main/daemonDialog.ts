import { dialog, type BrowserWindow } from 'electron';

import { DaemonError } from './daemon';

/** Tells the person the app has no daemon, as a sheet over the window, which shows its "Cannot reach the daemon" screen. */
export async function showDaemonError(error: unknown, window: BrowserWindow): Promise<void> {
    const { message, details } = error instanceof DaemonError ? error : { message: 'Clowdy cannot start its daemon.', details: String(error) };

    await dialog.showMessageBox(window, { type: 'error', title: 'Clowdy', message, detail: details, buttons: ['OK'] });
}
