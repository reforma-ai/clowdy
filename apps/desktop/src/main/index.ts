import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron';
import { watch } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';

import { IPC_CHANNELS } from '../shared/bridge';
import { DEV_BUILD_MARKER } from '../shared/dev';
import { installRuntime, readBundleInfo, updatesDir } from './bundle';
import { attachDaemon, currentContext, daemonAddress, ensureDaemon, environmentRuntime, type DaemonContext, type DaemonRuntime } from './daemon';
import { showDaemonError } from './daemonDialog';
import { keepDaemonFresh, type DaemonKeeper } from './daemonKeeper';
import { registerIpc } from './ipc';
import { createAppMenu } from './menu';
import { createProtocolHandler } from './protocol';
import { APP_ORIGIN, APP_SCHEME, appScheme, captionSymbolColor, hasLaunchSwitches, lockNavigation, restrictPermissions, windowOptions, windowsBuild } from './security';

/**
 * The renderer's files, served from `app://clowdy` in every run, so a development run has the same origin, the same
 * CSP and no open port, as the packaged app. A packaged app carries them in `renderer`; a development run
 * (`scripts/dev.ts` rebuilds them on every change) names the folder in `CLOWDY_RENDERER_DIR`.
 */
const rendererRoot = app.isPackaged
    ? path.join(app.getAppPath(), 'renderer')
    : process.env.CLOWDY_RENDERER_DIR ?? path.join(app.getAppPath(), 'dist/renderer');
const trustedOrigin = APP_ORIGIN;

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

        protocol.handle(APP_SCHEME, createProtocolHandler(rendererRoot));

        if (!app.isPackaged) reloadAfterRendererBuilds(rendererRoot);

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

        let runtimeError: unknown;
        const runtime = await daemonRuntime().catch((error: unknown) => {
            console.error('The daemon cannot be prepared:', error);
            runtimeError = error;

            return undefined;
        });
        const context = currentContext(runtime);
        const keeper = startKeeper(context);
        // Without a runtime the app still joins a daemon that is running; when it cannot, the runtime's failure is the reason shown.
        const daemonError = await connectDaemon(context, keeper);
        const window = openWindow();

        firstWindowOpen = true;

        // A sheet on the visible window: an unparented dialog would block the main process's event loop on macOS.
        if (daemonError) window.once('ready-to-show', () => void showDaemonError(runtimeError ?? daemonError, window));
    });
}

/**
 * What runs the daemon. A packaged app copies the Bun and the daemon it ships out of its install folder and runs those
 * (`bundle.ts`); a development run takes the Bun and the checkout `./clowdy dev` names.
 */
async function daemonRuntime(): Promise<DaemonRuntime | undefined> {
    if (!app.isPackaged) return environmentRuntime(process.env);

    const bundle = await readBundleInfo(path.join(app.getAppPath(), 'bundle.json'));

    return installRuntime({ resources: process.resourcesPath, updates: updatesDir(currentContext().dataDir), bundle });
}

/**
 * Finds the daemon or starts one before the window opens, so the page loads with its address. Resolves with the
 * reason when there is none, and the window opens anyway. Quitting never stops the daemon: it outlives the app (only a development run replaces a stale one, see `startKeeper`).
 */
async function connectDaemon(context: DaemonContext, keeper: DaemonKeeper | undefined): Promise<unknown> {
    try {
        const { pid, port } = await ensureDaemon(context);

        console.info(`Using the daemon with pid ${ pid } on port ${ port }.`);

        // A daemon left over from before the last source change is replaced now, while no window depends on it.
        await keeper?.checkNow();
    }
    catch (error) {
        console.error('No daemon:', error);

        return error;
    }
}

/**
 * A development run (`CLOWDY_DAEMON_WATCH` names the daemon's source folders, `scripts/dev.ts` sets it) replaces the
 * daemon with a new one when its sources change, but only while it has no runs in progress. The windows are told
 * where the new one is, and their event feed resumes from its cursor. A packaged app never does this.
 */
function startKeeper(context: DaemonContext): DaemonKeeper | undefined {
    const dirs = app.isPackaged ? [] : (process.env.CLOWDY_DAEMON_WATCH ?? '').split(path.delimiter).filter(Boolean);

    if (dirs.length === 0) return undefined;

    return keepDaemonFresh({
        context,
        dirs,
        log: message => console.info(message),
        onRestarted: (info) => {
            const address = daemonAddress(info);

            BrowserWindow.getAllWindows().forEach(window => window.webContents.send(IPC_CHANNELS.daemonChanged, address));
        },
    });
}

/** A development run: every rebuild of the renderer ends with the marker, and the windows load the new files. */
function reloadAfterRendererBuilds(root: string): void {
    let pending: ReturnType<typeof setTimeout> | undefined;

    try {
        watch(root, (_event, file) => {
            if (file !== DEV_BUILD_MARKER) return;

            // A rename can arrive as more than one event.
            clearTimeout(pending);
            pending = setTimeout(() => BrowserWindow.getAllWindows().forEach(window => window.webContents.reloadIgnoringCache()), 50);
        });
    }
    catch (error) {
        console.warn('Not watching the renderer build; reload the window by hand after a rebuild:', error);
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
    window.loadURL(`${ APP_ORIGIN }/`).catch((error: unknown) => console.error('The window did not load:', error));

    if (process.platform === 'win32') {
        // Windows draws the caption buttons over the page; their symbols follow the appearance.
        const followTheme = () => window.setTitleBarOverlay({ symbolColor: captionSymbolColor(nativeTheme.shouldUseDarkColors) });

        nativeTheme.on('updated', followTheme);
        window.once('closed', () => nativeTheme.off('updated', followTheme));
    }

    return window;
}
