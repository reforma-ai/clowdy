import { PROTOCOL_VERSION } from '@clowdy/protocol';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, session, shell, autoUpdater as squirrel, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { watch } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';

import { IPC_CHANNELS } from '../shared/bridge';
import { DEV_BUILD_MARKER } from '../shared/dev';
import { showBootWindow, type BootWindow } from './bootWindow';
import { bundleRuntime, installBun, installOwnBundle, pruneBunCopies, readBundleInfo, updatesDir, type BundleInfo } from './bundle';
import { attachDaemon, currentContext, daemonAddress, ensureDaemon, environmentRuntime, findRunning, type DaemonContext, type DaemonRuntime } from './daemon';
import { askToReplaceDaemon, showDaemonError } from './daemonDialog';
import { daemonHoldsLock } from './daemonFiles';
import { daemonBundle, fromOlderBundle, keepDaemonFresh, newestSourceTime, sourcesChangedSince, type DaemonKeeper, type KeeperOptions } from './daemonKeeper';
import { registerIpc } from './ipc';
import { createAppMenu } from './menu';
import { createOta, type Ota, type RunningBundle } from './ota';
import { createProtocolHandler } from './protocol';
import { releaseConfig, type ReleaseConfig } from './releaseConfig';
import { APP_ORIGIN, APP_SCHEME, appScheme, captionSymbolColor, hasLaunchSwitches, lockNavigation, restrictPermissions, windowOptions, windowsBuild } from './security';
import { createUpdater } from './updater';

const OTA_CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * The renderer's files, served from `app://clowdy` in every run, so a development run has the same origin, the same
 * CSP and no open port, as the packaged app. A packaged app carries its own copy in `renderer`; a development run
 * (`scripts/dev.ts` rebuilds them on every change) names the folder in `CLOWDY_RENDERER_DIR`. An installed OTA bundle
 * brings its own (`ota.ts`).
 */
const ownRendererRoot = app.isPackaged
    ? path.join(app.getAppPath(), 'renderer')
    : process.env.CLOWDY_RENDERER_DIR ?? path.join(app.getAppPath(), 'dist/renderer');
const trustedOrigin = APP_ORIGIN;
/** The OTA bundle installed during this run, which every page that loads is told about. */
let updateReady: number | undefined;

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
        Menu.setApplicationMenu(createAppMenu());

        const release = releaseConfig(app.isPackaged, process.env);
        const { dataDir } = currentContext();
        const updates = updatesDir(dataDir);
        let runtimeError: unknown;
        // A development run's own bundle is its checkout: version 0, so a bundle from the test feed is newer.
        const own = app.isPackaged
            ? await readBundleInfo(path.join(app.getAppPath(), 'bundle.json')).catch((error: unknown) => {
                runtimeError = error;

                return undefined;
            })
            : undefined;
        const ota = createOta({
            updates,
            dataDir,
            own: { version: own?.version ?? 0, rendererRoot: ownRendererRoot, dir: null, rendererFiles: null },
            shellVersion: app.getVersion(),
            protocol: PROTOCOL_VERSION,
            publicKey: release.otaPublicKey,
            feed: release.otaFeed,
            fetch: (url, init) => net.fetch(url, init),
            daemonVersion: async () => {
                const context = currentContext();
                const running = await findRunning(context);

                if (running) return daemonBundle(running.health);

                // Busy past its health check's timeout, or still starting: it may run from any bundle.
                if (await daemonHoldsLock(context.dataDir)) throw new Error('A daemon runs but does not answer');

                return undefined;
            },
            relaunch: () => {
                // `app.exit` skips the shutdown that writes the page's recent storage (what the UI remembers) to disk.
                session.defaultSession.flushStorageData();
                app.relaunch();
                app.exit(0);
            },
            onInstalled: (version) => {
                updateReady = version;
                BrowserWindow.getAllWindows().forEach(window => window.webContents.send(IPC_CHANNELS.updateReady, version));
            },
            log: message => console.info(message),
        });
        // Fixed for the life of the process, so the renderer's lazy chunks never mix bundles.
        let bundle = await ota.choose();
        let boot: BootWindow | undefined;

        // The first launch of a shell version installs the newest bundle before any window, so a fresh install does not
        // open on a bundle weeks old and offer a restart a moment later. The boot window shows once a download begins.
        if (await ota.catchUp(fraction => (boot ??= showBootWindow()).progress(fraction))) bundle = await ota.choose();

        // macOS shows it after the shell version: "Version 0.2.0 (Bundle 1234)".
        if (bundle.version) app.setAboutPanelOptions({ version: `Bundle ${ bundle.version }` });

        protocol.handle(APP_SCHEME, createProtocolHandler(bundle.rendererRoot, bundle.rendererFiles));

        if (!app.isPackaged && !bundle.dir) reloadAfterRendererBuilds(bundle.rendererRoot);

        const runtime = await daemonRuntime(bundle, own, updates).catch((error: unknown) => {
            console.error('The daemon cannot be prepared:', error);
            runtimeError ??= error;

            return undefined;
        });
        const context = currentContext(runtime);

        registerIpc(ipcMain, trustedOrigin, {
            setThemeSource: (theme) => {
                nativeTheme.themeSource = theme;
            },
            // Asked on every page load, so a daemon the person restarted is found again by reloading the window.
            getDaemon: async () => {
                const info = await attachDaemon(context);

                return info && daemonAddress(info);
            },
            ready: () => ota.ready(),
            restartToUpdate: () => ota.restart(),
        });

        /**
         * A daemon is up, maybe one this app started (`ours`): a bundle whose daemon it is has proven it, and copies
         * nothing runs from any more can go.
         */
        const daemonUp = async (ours: boolean) => {
            const running = await findRunning(context);

            await ota.daemonUp(running && daemonBundle(running.health));
            await ota.prune();

            // A development run's Bun is the checkout's.
            if (ours && app.isPackaged && runtime) await pruneBunCopies(updates, runtime.bun);
        };
        /**
         * No daemon came up: on the chosen bundle's first daemon start, that sends the app back to the previous bundle.
         * Resolves true when it relaunches.
         */
        const daemonDown = async () => {
            try {
                return Boolean(runtime) && !await findRunning(context) && await ota.daemonFailed();
            }
            catch (error) {
                console.warn('Could not go back to the previous bundle:', error);

                return false;
            }
        };
        const firstWindow = Promise.withResolvers<BrowserWindow>();
        const keeper = startKeeper(context, bundle, firstWindow.promise, {
            onReplaced: () => void daemonUp(true).catch((error: unknown) => console.warn('After the daemon was replaced:', error)),
            onFailed: () => void daemonDown(),
        });
        // Without a runtime the app still joins a daemon that is running; when it cannot, the runtime's failure is the reason shown.
        const { error: daemonError, ours } = await connectDaemon(context, keeper);

        if (daemonError) {
            // Relaunching on the previous bundle.
            if (await daemonDown()) return;
        }
        else {
            void daemonUp(ours).catch((error: unknown) => console.warn('After the daemon came up:', error));
        }

        const window = openWindow();

        firstWindowOpen = true;
        // From the first window's load: an OTA bundle on its first launch has 30 seconds to render.
        ota.watchReady();
        window.once('ready-to-show', () => {
            firstWindow.resolve(window);
            // Not before: on Windows closing the only window quits the app.
            boot?.close();
        });

        // A sheet on the visible window: an unparented dialog would block the main process's event loop on macOS.
        if (daemonError) window.once('ready-to-show', () => void showDaemonError(runtimeError ?? daemonError, window));

        // Once the window shows, so the first question (move to Applications) is a sheet on it.
        void firstWindow.promise.then(() => startUpdates(release, ota, bundle));
    });
}

/**
 * A message box as a sheet over a visible window. Over a hidden window Electron shows it app-modal, which blocks the main
 * process's event loop on macOS, as does the unparented fallback when no window is open (macOS keeps the app without one).
 */
async function showSheet(options: MessageBoxOptions): Promise<number> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);

    return response;
}

/**
 * Updates: shell releases from the GitHub releases a release build names (`releaseConfig.ts`), and OTA bundles from its
 * `ota` release (or a development run's test feed), both checked at launch and hourly, and from "Check for Updates…".
 * A development run and a local build have neither, unless a development run names a test feed.
 */
function startUpdates(release: ReleaseConfig, ota: Ota, bundle: RunningBundle): void {
    const updates = release.repo
        ? createUpdater({
            updater: autoUpdater,
            squirrel,
            platform: process.platform,
            // Squirrel.Mac installs only an update signed by the same Developer ID, so an ad-hoc build points to the download.
            selfUpdates: process.platform !== 'darwin' || release.signed,
            app,
            ask: async ({ message, detail, accept, decline }) =>
                await showSheet({ type: 'info', message, detail, buttons: [accept, decline], defaultId: 0, cancelId: 1 }) === 0,
            openReleasePage: () => void shell.openExternal(`https://github.com/${ release.repo }/releases/latest`),
        })
        : undefined;

    if (!updates && !ota.enabled) return;

    const tell = (message: string, detail: string) => showSheet({ type: 'info', message, detail });
    const checkBundles = () => ota.check().catch((error: unknown) => console.warn('OTA update check failed:', error instanceof Error ? error.message : error));

    /** A newer shell wins; otherwise a newly installed or waiting bundle gets the page's restart offer. */
    // electron-updater's messages go on with a stack and the response headers; it logs them whole.
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.trim();

    async function checkForUpdates(): Promise<void> {
        // A shell that cannot update (outside Applications, say) still takes bundles.
        let shellProblem: string | undefined;

        try {
            if (await updates?.checkNow(version => void tell(`Downloading Clowdy ${ version }…`, 'Clowdy asks you to restart once the download is done'))) return;
        }
        catch (error) {
            shellProblem = reason(error);
        }

        try {
            await ota.check();
        }
        catch (error) {
            await tell('Couldn\'t update Clowdy', shellProblem ?? reason(error));

            return;
        }

        const pending = ota.pending();

        if (pending !== null) BrowserWindow.getAllWindows().forEach(window => window.webContents.send(IPC_CHANNELS.updateReady, pending));
        else if (shellProblem) await tell('Couldn\'t update Clowdy', shellProblem);
        else await tell('Clowdy is up to date', `Version ${ app.getVersion() }${ bundle.version ? ` (bundle ${ bundle.version })` : '' }`);
    }

    Menu.setApplicationMenu(createAppMenu({
        checkForUpdates: (item) => {
            item.enabled = false;
            void checkForUpdates().finally(() => {
                item.enabled = true;
            });
        },
    }));
    void updates?.start();
    void checkBundles();
    setInterval(() => void checkBundles(), OTA_CHECK_INTERVAL_MS);
}

/**
 * What runs the daemon of the chosen bundle. A packaged app copies the Bun it ships out of its install folder, and runs
 * an installed OTA bundle's daemon from its folder, or its own bundle's from a copy (`bundle.ts`). A development run
 * takes the Bun and the checkout `./clowdy dev` names, or that Bun and a bundle from the test feed.
 */
async function daemonRuntime(bundle: RunningBundle, own: BundleInfo | undefined, updates: string): Promise<DaemonRuntime | undefined> {
    if (!app.isPackaged) {
        const checkout = environmentRuntime(process.env);

        return checkout && bundle.dir ? bundleRuntime(checkout.bun, bundle.dir) : checkout;
    }

    const resources = process.resourcesPath;
    const bun = await installBun({ resources, updates });

    if (bundle.dir) return bundleRuntime(bun, bundle.dir);

    if (!own) throw new Error('The app\'s own bundle is unreadable');

    return bundleRuntime(bun, await installOwnBundle({ resources, updates, version: own.version }));
}

/**
 * Finds the daemon or starts one before the window opens, so the page loads with its address. Resolves with the
 * reason when there is none (the window opens anyway), and whether the daemon is one this app started. Quitting never
 * stops the daemon: it outlives the app, and only the keeper replaces a stale one (see `startKeeper`).
 */
async function connectDaemon(context: DaemonContext, keeper: DaemonKeeper | undefined): Promise<{ error?: unknown; ours: boolean }> {
    try {
        // A stale daemon (another bundle's, or one older than its sources) is replaced now, while no window depends on it.
        const outcome = await keeper?.checkNow();

        // The new daemon did not start: starting it again would fail again, after another wait.
        if (outcome?.kind === 'failed' && !await findRunning(context)) return { error: outcome.error, ours: false };

        // A busy one this app cannot talk to stays until the keeper swaps it; the window shows that it cannot reach a daemon
        // and reloads on the swap.
        if (outcome?.kind === 'busy' && outcome.protocol !== PROTOCOL_VERSION) return { ours: false };

        const { pid, port } = await ensureDaemon(context);

        console.info(`Using the daemon with pid ${ pid } on port ${ port }.`);

        // With none running, `ensureDaemon` started this one.
        return { ours: outcome?.kind === 'restarted' || outcome?.kind === 'none' };
    }
    catch (error) {
        console.error('No daemon:', error);

        return { error, ours: false };
    }
}

/**
 * Keeps the daemon the one this app wants, replacing a stale one once it has no runs in progress. The windows are told
 * where the new one is, and their event feed resumes from its cursor.
 *
 * - An app that runs a bundle (a packaged app, or a development run on the test feed) wants that bundle's daemon: one
 *   from an older bundle (left by the previous version) is replaced, and when it is busy a sheet asks whether to
 *   interrupt its runs or wait for them.
 * - A development run on its checkout (`CLOWDY_DAEMON_WATCH` names the daemon's source folders, `scripts/dev.ts` sets
 *   it) replaces the daemon when its sources change, or when it runs a bundle.
 */
function startKeeper(
    context: DaemonContext,
    bundle: RunningBundle,
    firstWindow: Promise<BrowserWindow>,
    { onReplaced, onFailed }: { onReplaced: () => void; onFailed: () => void }
): DaemonKeeper | undefined {
    // The sheet about a busy daemon; it closes when that daemon is replaced without an answer (its runs finished first).
    let question: AbortController | undefined;
    const common: Pick<KeeperOptions, 'context' | 'log' | 'onRestarted' | 'onFailed'> = {
        context,
        onFailed,
        log: message => console.info(message),
        onRestarted: (info) => {
            const address = daemonAddress(info);

            question?.abort();
            BrowserWindow.getAllWindows().forEach(window => window.webContents.send(IPC_CHANNELS.daemonChanged, address));
            onReplaced();
        },
    };

    // A bundle: a packaged app's, or one a development run took from the test feed.
    if (bundle.version > 0) {
        const keeper: DaemonKeeper = keepDaemonFresh({
            ...common,
            isStale: fromOlderBundle(bundle.version),
            // A sheet on the visible window: an unparented dialog would block the main process's event loop on macOS.
            onBusy: ({ activeRuns }) => {
                question = new AbortController();
                const { signal } = question;

                void firstWindow
                    .then(window => askToReplaceDaemon(window, activeRuns, signal))
                    .then(async (replace) => {
                        if (replace) await keeper.replaceNow();
                    });
            },
        });

        return keeper;
    }

    // A packaged app whose own bundle is unreadable cannot tell which daemon it wants.
    if (app.isPackaged) return undefined;

    const dirs = (process.env.CLOWDY_DAEMON_WATCH ?? '').split(path.delimiter).filter(Boolean);

    if (dirs.length === 0) return undefined;

    return keepDaemonFresh({ ...common, dirs, isStale: sourcesChangedSince(() => newestSourceTime(dirs)) });
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
    // A page that loads after an OTA bundle was installed still offers the restart.
    window.webContents.on('did-finish-load', () => {
        if (updateReady !== undefined) window.webContents.send(IPC_CHANNELS.updateReady, updateReady);
    });
    window.loadURL(`${ APP_ORIGIN }/`).catch((error: unknown) => console.error('The window did not load:', error));

    if (process.platform === 'win32') {
        // Windows draws the caption buttons over the page; their symbols follow the appearance.
        const followTheme = () => window.setTitleBarOverlay({ symbolColor: captionSymbolColor(nativeTheme.shouldUseDarkColors) });

        nativeTheme.on('updated', followTheme);
        window.once('closed', () => nativeTheme.off('updated', followTheme));
    }

    return window;
}
