import type { Theme } from '@clowdy/constants';

/** Passed to the preload when the window draws a system material behind transparent pixels. */
export const WINDOW_MATERIAL_ARGUMENT = '--clowdy-window-material';

export const IPC_CHANNELS = {
    setThemeSource: 'desktop:set-theme-source',
    chooseDirectories: 'desktop:choose-directories',
    /** Synchronous (`sendSync`): the preload needs the answer before the page's scripts run. */
    getDaemon: 'desktop:get-daemon',
    /** Main to renderer: the daemon was replaced and listens elsewhere now. */
    daemonChanged: 'desktop:daemon-changed',
    ready: 'desktop:ready',
    restartToUpdate: 'desktop:restart-to-update',
    /** Main to renderer: an OTA bundle is installed and runs from the next launch. */
    updateReady: 'desktop:update-ready',
    /** Renderer to main: search the text Chromium has drawn in this window. */
    findInPage: 'desktop:find-in-page',
    /** Renderer to main: drop the highlights of that search. */
    stopFind: 'desktop:stop-find',
    /** Main to renderer: the Edit menu's Find, Find Next or Find Previous. */
    findCommand: 'desktop:find-command',
    /** Renderer to main: which editors and file managers this computer has. */
    openApps: 'desktop:open-apps',
    /** Renderer to main: open a folder or a file in one of them. */
    openPath: 'desktop:open-path',
    /** Renderer to main: the files and folders on the system clipboard. */
    clipboardFiles: 'desktop:clipboard-files',
    /** Renderer to main: put files and folders on the system clipboard. */
    copyFiles: 'desktop:copy-files',
    /** Renderer to main: copy files and folders of the system clipboard into a folder. */
    pasteFiles: 'desktop:paste-files',
} as const;

/** A program that can open a folder or a file: an editor or a file manager, found on this computer. `id` is the catalog's, `name` is what the person reads, and `icon` is its own icon as a `data:` image, none when it could not be read. */
export interface OpenApp {
    id: string;
    name: string;
    icon?: string;
}

/** What this computer has, in the order the choices go in: the first program of a kind is the one that opens a folder until another is picked, and the system's file manager is the first of its list. */
export interface OpenApps {
    editors: OpenApp[];
    terminals: OpenApp[];
    fileManagers: OpenApp[];
}

/** Which program opens a folder or a file. */
export interface OpenPathApp {
    kind: 'editor' | 'terminal' | 'fileManager';
    id: string;
}

/** A file or a folder on the system clipboard: copied in the app, or in Finder or Explorer. */
export interface ClipboardFile {
    /** Where it is, absolute, as the system writes a path. */
    path: string;
    /** The last part of the path. */
    name: string;
    kind: 'file' | 'directory';
}

/** One entry of a paste: which of the files on the clipboard (by its path), and the name its copy gets in the folder. */
export interface PasteItem {
    path: string;
    name: string;
}

/** What the Edit menu asked the page to do. */
export type FindCommand = 'open' | 'next' | 'previous';

/** Viewport pixels of the active match, the same space as `getBoundingClientRect`. */
export interface FindRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** How many matches Chromium found, and which one is current. `activeMatchOrdinal` counts from 1. */
export interface FindResult {
    matches: number;
    activeMatchOrdinal: number;
    /** Where the active match is drawn, when Chromium reported it. */
    selectionArea?: FindRect;
}

/** `findNext` starts a session (a new query). A follow-up moves through it, `forward` saying which way. */
export interface FindOptions {
    forward: boolean;
    findNext: boolean;
}

/**
 * What the preload exposes as `window.desktop`. Keep it minimal: the renderer is untrusted and
 * business logic lives behind the daemon's contract, not behind Electron IPC.
 */
export interface DesktopBridge {
    platform: 'darwin' | 'win32' | 'linux';
    /** True when the window draws vibrancy or Mica behind transparent page pixels. */
    material: boolean;
    /** Makes the window's native material follow the chosen appearance. */
    setThemeSource: (theme: Theme) => Promise<void>;
    /** Where the daemon listens and the token it wants. Set when the page loads and a daemon answers; unset otherwise (reload to look again). */
    daemon?: { url: string; token: string };
    /** Called with the new address when the daemon is replaced while the window is open (a development run restarts it after its sources change). Returns a function that stops listening. */
    onDaemonChange: (listener: (daemon: { url: string; token: string }) => void) => () => void;
    /** Asks the person for one or more folders with the system dialog. Resolves an empty list when they cancel. */
    chooseDirectories: () => Promise<string[]>;
    /** Says the page has rendered. An update on its first launch that never says so within 30 seconds is rolled back. */
    ready: () => Promise<void>;
    /** Called with its version when an update is installed and waits for a restart. Returns a function that stops listening. */
    onUpdateReady: (listener: (version: number) => void) => () => void;
    /** Restarts the app into the installed update. */
    restartToUpdate: () => Promise<void>;
    /** Searches the text drawn in this window. Rejects an empty query: clear the highlights with `stopFind` instead. */
    findInPage: (text: string, options: FindOptions) => Promise<FindResult>;
    /** Clears the highlights of `findInPage`. */
    stopFind: () => Promise<void>;
    /** The Edit menu's Find commands. Returns a function that stops listening. */
    onFindCommand: (listener: (command: FindCommand) => void) => () => void;
    /** The editors and file managers this computer has, read each time it is asked: a program may be installed while the app runs. */
    getOpenApps: () => Promise<OpenApps>;
    /** Opens a folder or a file in one of them: a file is opened by an editor and shown by a file manager, and a terminal takes folders only. Rejects when the path is gone or the program cannot be started. */
    openPath: (path: string, app: OpenPathApp) => Promise<void>;
    /** The files and folders the system clipboard holds that are still on the disk, in the order they were copied. */
    readClipboardFiles: () => Promise<ClipboardFile[]>;
    /** Replaces the clipboard with these files and folders (absolute paths): they paste as files into the system's file manager and other programs, and as their paths into a text field. */
    writeClipboardFiles: (paths: readonly string[]) => Promise<void>;
    /**
     * Copies files and folders of the clipboard into `folder`, each under the name it is given. The entries only say which of the files on the clipboard now go where: a path
     * that is not on it is refused, and so is a name that is taken. Rejects with what went wrong.
     */
    pasteClipboardFiles: (folder: string, items: readonly PasteItem[]) => Promise<void>;
}
