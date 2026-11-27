import path from 'node:path';
import { app, type BrowserWindow } from 'electron';

import { IPC_CHANNELS, type NativeScrollEvent } from '../shared/bridge';

type NativeEvent = Omit<NativeScrollEvent, 'kind' | 'sequence'>;
export type NativeScrollAddon = { start: (handle: Buffer, listener: (event: NativeEvent) => void) => () => void };

const windows = new Set<number>();

export function nativeScrollAvailable(webContentsId: number): boolean {
    return windows.has(webContentsId);
}

/** The addon observes this window only and returns every event to AppKit unchanged. */
function loadAddon(): NativeScrollAddon {
    const location = app.isPackaged
        ? path.join(process.resourcesPath, 'scroll.node')
        : path.join(app.getAppPath(), 'runtime', `darwin-${process.arch}`, 'scroll.node');

    return require(location) as NativeScrollAddon;
}

export function attachNativeScroll(
    window: BrowserWindow,
    load: () => NativeScrollAddon = loadAddon,
    platform: string = process.platform
): void {
    if (platform !== 'darwin') return;

    try {
        const addon = load();
        let sequence = 0;
        const stop = addon.start(window.getNativeWindowHandle(), event => {
            if (!window.isDestroyed())
                window.webContents.send(IPC_CHANNELS.nativeScroll, { ...event, kind: 'scroll', sequence: ++sequence });
        });

        windows.add(window.webContents.id);
        window.on('blur', () => {
            if (!window.isDestroyed())
                window.webContents.send(IPC_CHANNELS.nativeScroll, { kind: 'cancel', sequence: ++sequence });
        });
        const id = window.webContents.id;
        window.once('closed', () => {
            windows.delete(id);
            stop();
        });
    } catch (error) {
        console.warn('Native scroll phases unavailable:', error);
    }
}
