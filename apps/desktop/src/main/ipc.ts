import { THEMES, type Theme } from '@clowdy/constants';
import { BrowserWindow, dialog } from 'electron';

import {
    type ClipboardFile,
    type DesktopBridge,
    type FindOptions,
    type FindRect,
    type FindResult,
    IPC_CHANNELS,
    type OpenApps,
    type UpdateStatus,
} from '../shared/bridge';
import { nativeScrollAvailable, nativeScrollSnapshot } from './nativeScroll';
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
    /** What is known about updates now. */
    getUpdateStatus: () => UpdateStatus;
    /** Replaces an old daemon now, though it has agent runs in progress; without an old one, nothing happens. */
    replaceDaemon: () => Promise<void>;
    /** The editors and file managers this computer has. */
    listOpenApps: () => Promise<OpenApps>;
    /** Opens a folder or a file in one of them; it checks what the page sent. */
    openPath: (path: unknown, app: unknown) => Promise<void>;
    /** The files and folders on the system clipboard. */
    readClipboardFiles: () => Promise<ClipboardFile[]>;
    /** Puts files and folders on the system clipboard; it checks what the page sent. */
    writeClipboardFiles: (paths: unknown) => Promise<void>;
    /** Copies files and folders of the system clipboard into a folder; it checks what the page sent. */
    pasteClipboardFiles: (folder: unknown, items: unknown) => Promise<void>;
}

export function registerIpc(
    ipcMain: Pick<IpcMain, 'handle' | 'on'>,
    trustedOrigin: string,
    {
        setThemeSource,
        getDaemon,
        ready,
        restartToUpdate,
        getUpdateStatus,
        replaceDaemon,
        listOpenApps,
        openPath,
        readClipboardFiles,
        writeClipboardFiles,
        pasteClipboardFiles,
    }: IpcActions
): void {
    ipcMain.on(IPC_CHANNELS.nativeScrollAvailable, event => {
        event.returnValue = isTrustedSender(event, trustedOrigin) && nativeScrollAvailable(event.sender.id);
    });

    ipcMain.on(IPC_CHANNELS.nativeScrollSnapshot, event => {
        event.returnValue = isTrustedSender(event, trustedOrigin) ? nativeScrollSnapshot(event.sender.id) : null;
    });

    // The preload asks while the page loads and cannot wait for a promise, so this one is synchronous for it.
    // The reply may come later: the renderer blocks until `returnValue` is set. Anyone else gets `null`.
    ipcMain.on(IPC_CHANNELS.getDaemon, event => {
        if (!isTrustedSender(event, trustedOrigin)) {
            event.returnValue = null;

            return;
        }

        void getDaemon()
            .catch(() => undefined)
            .then(daemon => {
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

    ipcMain.handle(IPC_CHANNELS.ready, async event => {
        assertTrustedSender(event, trustedOrigin);
        await ready();
    });

    ipcMain.handle(IPC_CHANNELS.restartToUpdate, event => {
        assertTrustedSender(event, trustedOrigin);
        restartToUpdate();
    });

    ipcMain.handle(IPC_CHANNELS.getUpdateStatus, event => {
        assertTrustedSender(event, trustedOrigin);

        return getUpdateStatus();
    });

    ipcMain.handle(IPC_CHANNELS.replaceDaemon, async event => {
        assertTrustedSender(event, trustedOrigin);
        await replaceDaemon();
    });

    ipcMain.handle(IPC_CHANNELS.chooseDirectories, async (event): Promise<string[]> => {
        assertTrustedSender(event, trustedOrigin);

        // The dialog belongs to the window that asked, so it opens as a sheet over it.
        const window = BrowserWindow.fromWebContents(event.sender);
        const options = {
            properties: ['openDirectory' as const, 'createDirectory' as const, 'multiSelections' as const],
        };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

        return result.canceled ? [] : result.filePaths;
    });

    ipcMain.handle(IPC_CHANNELS.openApps, event => {
        assertTrustedSender(event, trustedOrigin);

        return listOpenApps();
    });

    ipcMain.handle(IPC_CHANNELS.openPath, (event, path: unknown, app: unknown) => {
        assertTrustedSender(event, trustedOrigin);

        return openPath(path, app);
    });

    ipcMain.handle(IPC_CHANNELS.clipboardFiles, event => {
        assertTrustedSender(event, trustedOrigin);

        return readClipboardFiles();
    });

    ipcMain.handle(IPC_CHANNELS.copyFiles, (event, paths: unknown) => {
        assertTrustedSender(event, trustedOrigin);

        return writeClipboardFiles(paths);
    });

    ipcMain.handle(IPC_CHANNELS.pasteFiles, (event, folder: unknown, items: unknown) => {
        assertTrustedSender(event, trustedOrigin);

        return pasteClipboardFiles(folder, items);
    });

    ipcMain.handle(IPC_CHANNELS.findInPage, (event, text: unknown, options: unknown) => {
        assertTrustedSender(event, trustedOrigin);

        return findInPage(event.sender, text, options);
    });

    ipcMain.handle(IPC_CHANNELS.stopFind, event => {
        assertTrustedSender(event, trustedOrigin);
        event.sender.stopFindInPage('clearSelection');
    });
}

/** How long a search may run before the page gives up on a result that never arrives. */
const FIND_TIMEOUT_MS = 5000;

interface FoundInPage {
    requestId: number;
    matches: number;
    activeMatchOrdinal: number;
    selectionArea?: Partial<FindRect>;
    finalUpdate: boolean;
}

/** The slice of `WebContents` the search uses. */
interface FindTarget {
    findInPage: (text: string, options: FindOptions) => number;
    stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
    on: (event: 'found-in-page', listener: (event: unknown, result: FoundInPage) => void) => void;
    removeListener: (event: 'found-in-page', listener: (event: unknown, result: FoundInPage) => void) => void;
}

function selectionArea(value: Partial<FindRect> | undefined): FindRect | undefined {
    if (!value) return undefined;

    const { x, y, width, height } = value;

    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number')
        return undefined;

    if (![x, y, width, height].every(Number.isFinite)) return undefined;

    return { x, y, width, height };
}

function findOptions(value: unknown): FindOptions {
    if (typeof value !== 'object' || value === null) throw new Error('Bad find options');

    const { forward, findNext } = value as { forward?: unknown; findNext?: unknown };

    if (typeof forward !== 'boolean' || typeof findNext !== 'boolean') throw new Error('Bad find options');

    return { forward, findNext };
}

/**
 * Chromium's own search of the text drawn in the window. The count arrives on `found-in-page` once the pass is done.
 * An empty query is refused: `findInPage` cannot take one, and clearing is `stopFindInPage`.
 */
function findInPage(contents: FindTarget, text: unknown, options: unknown): Promise<FindResult> {
    if (typeof text !== 'string' || text.length === 0) throw new Error('Empty find');

    const parsed = findOptions(options);
    const requestId = contents.findInPage(text, parsed);

    return new Promise(resolve => {
        let settled = false;
        const finish = (result: FindResult) => {
            if (settled) return;

            settled = true;
            clearTimeout(timer);
            contents.removeListener('found-in-page', onFound);
            resolve(result);
        };
        const onFound = (_event: unknown, result: FoundInPage) => {
            if (result.requestId !== requestId || !result.finalUpdate) return;

            const area = selectionArea(result.selectionArea);

            finish({
                matches: Number.isInteger(result.matches) ? result.matches : 0,
                activeMatchOrdinal: Number.isInteger(result.activeMatchOrdinal) ? result.activeMatchOrdinal : 0,
                ...(area ? { selectionArea: area } : {}),
            });
        };
        const timer = setTimeout(() => finish({ matches: 0, activeMatchOrdinal: 0 }), FIND_TIMEOUT_MS);

        contents.on('found-in-page', onFound);
    });
}
