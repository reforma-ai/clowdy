import path from 'node:path';
import { app, type BrowserWindow } from 'electron';

import { IPC_CHANNELS, type NativeScrollEvent, type NativeScrollSnapshot } from '../shared/bridge';

type NativeEvent = Omit<NativeScrollEvent, 'kind' | 'sequence'>;
export type NativeScrollAddon = { start: (handle: Buffer, listener: (event: NativeEvent) => void) => () => void };

const windows = new Map<number, NativeScrollSnapshot>();

export function nativeScrollSnapshot(webContentsId: number): NativeScrollSnapshot | null {
    return windows.get(webContentsId) ?? null;
}

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
        const snapshot: NativeScrollSnapshot = { sequence: 0, gesture: 0, active: false, origin: null, last: null };
        const stop = addon.start(window.getNativeWindowHandle(), event => {
            if (window.isDestroyed()) return;
            const record = { ...event, kind: 'scroll' as const, sequence: ++sequence };
            if (event.phase & 1) {
                snapshot.gesture++;
                snapshot.active = true;
                snapshot.origin = { x: event.x, y: event.y };
            }
            if (event.phase & (8 | 16)) snapshot.active = false;
            Object.assign(snapshot, { sequence, last: record });
            window.webContents.send(IPC_CHANNELS.nativeScroll, record);
        });

        windows.set(window.webContents.id, snapshot);
        window.on('blur', () => {
            if (!window.isDestroyed()) {
                const record = { kind: 'cancel' as const, sequence: ++sequence };
                Object.assign(snapshot, { sequence, active: false, last: record });
                window.webContents.send(IPC_CHANNELS.nativeScroll, record);
            }
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
