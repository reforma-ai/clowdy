import { dialog, type BrowserWindow } from 'electron';

import { DaemonError } from './daemon';

/** Tells the person the app has no daemon, as a sheet over the window, which shows its "Cannot reach the daemon" screen. */
export async function showDaemonError(error: unknown, window: BrowserWindow): Promise<void> {
    const { message, details } = error instanceof DaemonError ? error : { message: 'Clowdy cannot start its daemon.', details: String(error) };

    await dialog.showMessageBox(window, { type: 'error', title: 'Clowdy', message, detail: details, buttons: ['OK'] });
}

/**
 * Asks, as a sheet over the window, whether to replace a daemon from another version of Clowdy that has runs in progress.
 * Resolves true for "Restart now"; waiting is the default, and the app then switches once the runs finish. `signal`
 * closes the sheet as if the person chose to wait.
 */
export async function askToReplaceDaemon(window: BrowserWindow, activeRuns: number | undefined, signal?: AbortSignal): Promise<boolean> {
    const runs = activeRuns === undefined
        ? 'It may have agent runs in progress.'
        : `${ activeRuns } agent run${ activeRuns === 1 ? ' is' : 's are' } in progress.`;
    const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Clowdy',
        message: 'The running daemon is from another version of Clowdy',
        detail: `${ runs } Restart it now, and they stop and continue when you send them a message. Or wait, and Clowdy switches once they finish.`,
        buttons: ['Restart now', 'Wait'],
        defaultId: 1,
        cancelId: 1,
        signal,
    });

    return response === 0;
}
