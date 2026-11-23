import type { DesktopBridge } from '../shared/bridge';

declare global {
    interface Window {
        /** Exposed by the preload; absent when the page runs outside the desktop shell. */
        desktop?: DesktopBridge;
    }
}
