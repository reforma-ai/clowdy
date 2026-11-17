import type { Theme } from '@clowdy/constants';

/** Passed to the preload when the window draws a system material behind transparent pixels. */
export const WINDOW_MATERIAL_ARGUMENT = '--clowdy-window-material';

export const IPC_CHANNELS = {
    setThemeSource: 'desktop:set-theme-source',
    chooseDirectory: 'desktop:choose-directory',
    /** Synchronous (`sendSync`): the preload needs the answer before the page's scripts run. */
    getDaemon: 'desktop:get-daemon',
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
    /** Asks the person for a folder with the system dialog. Resolves `null` when they cancel. */
    chooseDirectory: () => Promise<string | null>;
}
