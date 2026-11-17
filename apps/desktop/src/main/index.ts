import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron';
import { release } from 'node:os';
import path from 'node:path';

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

    app.on('web-contents-created', (_event, contents) => {
        lockNavigation(contents, trustedOrigin, url => void shell.openExternal(url));
    });

    // On macOS the app outlives its window, so a second launch may find none.
    app.on('second-instance', () => {
        const [window] = BrowserWindow.getAllWindows();

        if (!window) return void openWindow();

        if (window.isMinimized()) window.restore();
        window.focus();
    });

    // Closing the last window quits, except on macOS where the app stays in the Dock.
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });

    void app.whenReady().then(() => {
        restrictPermissions(session.defaultSession, trustedOrigin);

        if (!devRendererUrl) {
            protocol.handle(APP_SCHEME, createProtocolHandler(path.join(app.getAppPath(), 'renderer')));
        }

        registerIpc(ipcMain, trustedOrigin, theme => {
            nativeTheme.themeSource = theme;
        });
        Menu.setApplicationMenu(createAppMenu());
        openWindow();
    });
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
