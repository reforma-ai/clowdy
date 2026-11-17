import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron';
import { release } from 'node:os';
import path from 'node:path';

import { attachDaemon, daemonAddress, ensureDaemon } from './daemon';
import { showDaemonError } from './daemonDialog';
import { registerIpc } from './ipc';
import { createAppMenu } from './menu';
import { createProtocolHandler } from './protocol';
import { APP_ORIGIN, APP_SCHEME, appScheme, captionSymbolColor, hasLaunchSwitches, lockNavigation, originOf, restrictPermissions, windowOptions, windowsBuild } from './security';

/**
 * A development run loads the renderer from the Vite dev server (`scripts/dev.ts` sets this),
 * which is what gives it HMR. A packaged app never reads it and serves its own files.
 */
const devRendererUrl = app.isPackaged ? undefined : process.env.CLOWDY_RENDERER_URL;
const trustedOrigin = (devRendererUrl && originOf(devRendererUrl)) || APP_ORIGIN;

if (app.isPackaged && hasLaunchSwitches(process.argv.slice(1))) {
    console.error('Clowdy does not start with command-line switches.');
    app.exit(1);
}
else if (!app.requestSingleInstanceLock()) {
    // The running instance comes forward (`second-instance`); this one has nothing to do.
    console.info('Clowdy is already running; switching to it.');
    app.quit();
}
else {
    start();
}

function start(): void {
    protocol.registerSchemesAsPrivileged([appScheme]);
    // The ID the installer gives its shortcuts (`appId`), so Windows groups the window and notifications under them.
    if (process.platform === 'win32') app.setAppUserModelId('app.clowdy.desktop');

    // False while the first window waits for the daemon (up to 15 s). macOS sends `activate` at launch, and a window
    // opened then would load without a daemon and be followed by a second one.
    let firstWindowOpen = false;

    app.on('web-contents-created', (_event, contents) => {
        lockNavigation(contents, trustedOrigin, url => void shell.openExternal(url));
    });

    // On macOS the app outlives its window, so a second launch may find none.
    app.on('second-instance', () => {
        const [window] = BrowserWindow.getAllWindows();

        if (!window) {
            if (firstWindowOpen) openWindow();

            return;
        }

        if (window.isMinimized()) window.restore();
        window.focus();
    });

    // Closing the last window quits, except on macOS where the app stays in the Dock.
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        if (firstWindowOpen && BrowserWindow.getAllWindows().length === 0) openWindow();
    });

    void app.whenReady().then(async () => {
        restrictPermissions(session.defaultSession, trustedOrigin);

        if (!devRendererUrl) {
            protocol.handle(APP_SCHEME, createProtocolHandler(path.join(app.getAppPath(), 'renderer')));
        }

        registerIpc(ipcMain, trustedOrigin, {
            setThemeSource: theme => {
                nativeTheme.themeSource = theme;
            },
            // Asked on every page load, so a daemon the person restarted is found again by reloading the window.
            getDaemon: async () => {
                const info = await attachDaemon();

                return info && daemonAddress(info);
            },
        });
        Menu.setApplicationMenu(createAppMenu());

        const daemonError = await connectDaemon();
        const window = openWindow();

        firstWindowOpen = true;

        // A sheet on the visible window: an unparented dialog would block the main process's event loop on macOS.
        if (daemonError) window.once('ready-to-show', () => void showDaemonError(daemonError, window));
    });
}

/**
 * Finds the daemon or starts one before the window opens, so the page loads with its address. Resolves with the
 * reason when there is none, and the window opens anyway. The daemon is never stopped from here: it outlives the app.
 */
async function connectDaemon(): Promise<unknown> {
    try {
        const { pid, port } = await ensureDaemon();

        console.info(`Using the daemon with pid ${ pid } on port ${ port }.`);
    }
    catch (error) {
        console.error('No daemon:', error);

        return error;
    }
}

function openWindow(): BrowserWindow {
    const window = new BrowserWindow(windowOptions(
        path.join(app.getAppPath(), 'dist/preload/index.cjs'),
        process.platform,
        windowsBuild(release()),
        nativeTheme.shouldUseDarkColors
    ));

    window.once('ready-to-show', () => window.show());
    window.loadURL(devRendererUrl ?? `${ APP_ORIGIN }/`).catch((error: unknown) => console.error('The window did not load:', error));

    if (process.platform === 'win32') {
        // Windows draws the caption buttons over the page; their symbols follow the appearance.
        const followTheme = () => window.setTitleBarOverlay({ symbolColor: captionSymbolColor(nativeTheme.shouldUseDarkColors) });

        nativeTheme.on('updated', followTheme);
        window.once('closed', () => nativeTheme.off('updated', followTheme));
    }

    return window;
}
