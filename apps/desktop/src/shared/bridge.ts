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
} as const;

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
}
