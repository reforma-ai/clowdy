const CHECK_INTERVAL_MS = 60 * 60_000;

/** The part of electron-updater's `autoUpdater` the shell uses. */
export interface ShellUpdater {
    autoDownload: boolean;
    checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
    /** Resolves once the download matches the feed's SHA-512 (and, on macOS, Squirrel.Mac has fetched it). */
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(): void;
}

/** Electron's own `autoUpdater`: Squirrel.Mac, which electron-updater hands the zip to. */
export interface Squirrel {
    on(event: 'update-downloaded', listener: () => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    removeListener(event: 'update-downloaded', listener: () => void): unknown;
    removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

/** A two-button sheet; resolves true for the first button. */
export type Ask = (question: { message: string; detail: string; accept: string; decline: string }) => Promise<boolean>;

export interface UpdaterOptions {
    updater: ShellUpdater;
    squirrel: Squirrel;
    platform: NodeJS.Platform;
    /**
     * False for a macOS build signed ad hoc: Squirrel.Mac installs only an update signed by the same Developer ID as the
     * running app, so such a build offers the download page instead of downloading.
     */
    selfUpdates: boolean;
    /** macOS: `app.isInApplicationsFolder` and `app.moveToApplicationsFolder`, which relaunches the moved app. */
    app: { isInApplicationsFolder(): boolean; moveToApplicationsFolder(): boolean };
    ask: Ask;
    /** Opens the page of the latest release in the browser. */
    openReleasePage: () => void;
}

/**
 * Shell updates from the GitHub release marked Latest (electron-updater's GitHub provider, configured by the
 * `app-update.yml` a release build carries): `start` checks at launch and hourly, `checkNow` when the person asks. A newer
 * shell downloads in the background, then a sheet offers a restart; a downloaded update also installs on quit. Nothing
 * restarts the app without the person. A build that cannot update itself offers the release page instead. A failed
 * check or download, or an update Squirrel.Mac refuses, leaves the app as it is and is retried at the next check.
 */
export function createUpdater(options: UpdaterOptions) {
    const { updater } = options;
    let started = false;
    let running: Promise<string | null> | null = null;
    /** The version that installs on quit, once its download is done. */
    let downloaded: string | null = null;
    /** The version a build that cannot update itself has already pointed to; it is not offered again in this run. */
    let offered: string | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;

    /** Resolves to the newer version after its sheet, or null when the shell is current. */
    function check(onFound?: (version: string) => void, again = false): Promise<string | null> {
        running ??= (async () => {
            if (downloaded === null) {
                const result = await updater.checkForUpdates();

                if (!result?.isUpdateAvailable) return null;

                const { version } = result.updateInfo;

                if (!options.selfUpdates) return offerDownload(version, again);

                onFound?.(version);
                await download();
                downloaded = version;
                // It installs on quit from here on; checking again would only ask again.
                clearInterval(timer);
            }

            const restart = await options.ask({
                message: `Clowdy ${ downloaded } is ready to install`,
                detail: 'Restart now, or it installs the next time you quit Clowdy',
                accept: 'Restart to update',
                decline: 'Later',
            });

            if (restart) updater.quitAndInstall();

            return downloaded;
        })().finally(() => {
            running = null;
        });

        return running;
    }

    /** Points a build that cannot update itself to the release page, once per version unless the person asks. */
    async function offerDownload(version: string, again: boolean): Promise<string> {
        if (offered === version && !again) return version;

        offered = version;

        const open = await options.ask({
            message: `Clowdy ${ version } is available`,
            detail: 'This build can\'t update itself. Download the new version and replace the app with it.',
            accept: 'Download',
            decline: 'Later',
        });

        if (open) options.openReleasePage();

        return version;
    }

    async function scheduledCheck(): Promise<void> {
        try {
            await check();
        }
        catch (error) {
            // electron-updater also emits every failure as `error`; the next check tries again.
            console.warn('Shell update check failed:', error instanceof Error ? error.message : error);
        }
    }

    /** The download, and on macOS Squirrel.Mac's verdict: it unzips the update and checks its signature after the download. */
    async function download(): Promise<void> {
        if (options.platform !== 'darwin') {
            await updater.downloadUpdate();

            return;
        }

        const { squirrel } = options;
        let accept!: () => void;
        let refuse!: (error: Error) => void;
        const verdict = new Promise<void>((resolve, reject) => {
            accept = resolve;
            refuse = reject;
        });

        squirrel.on('update-downloaded', accept);
        squirrel.on('error', refuse);

        try {
            await Promise.all([updater.downloadUpdate(), verdict]);
        }
        finally {
            squirrel.removeListener('update-downloaded', accept);
            squirrel.removeListener('error', refuse);
        }
    }

    return {
        async start(): Promise<void> {
            if (options.selfUpdates && !await installedWhereUpdatesWork(options)) return;

            updater.autoDownload = false;
            started = true;
            timer = setInterval(() => void scheduledCheck(), CHECK_INTERVAL_MS);
            await scheduledCheck();
        },
        /**
         * The check behind "Check for Updates…". Resolves like a scheduled check once the sheet is answered, or at once
         * with null when the shell is current; `onFound` runs before a download. A downloaded update is offered again
         * without a check. Rejects when the check or download fails.
         */
        async checkNow(onFound: (version: string) => void): Promise<string | null> {
            if (!started) throw new Error('Clowdy can update itself only from the Applications folder');

            return check(onFound, true);
        },
    };
}

/** Squirrel.Mac replaces the app only in an Applications folder, not on a disk image or a translocated copy. */
async function installedWhereUpdatesWork({ platform, app, ask }: UpdaterOptions): Promise<boolean> {
    if (platform !== 'darwin' || app.isInApplicationsFolder()) return true;

    const move = await ask({
        message: 'Move Clowdy to Applications?',
        detail: 'Clowdy can update itself only from the Applications folder',
        accept: 'Move to Applications',
        decline: 'Not now',
    });

    if (move) {
        try {
            app.moveToApplicationsFolder();
        }
        catch (error) {
            console.warn('Moving to Applications failed:', error instanceof Error ? error.message : error);
        }
    }

    return false;
}
