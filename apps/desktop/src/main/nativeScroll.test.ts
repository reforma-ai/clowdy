import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, type NativeScrollEvent } from '../shared/bridge';
import {
    attachNativeScroll,
    type NativeScrollAddon,
    nativeScrollAvailable,
    nativeScrollSnapshot,
} from './nativeScroll';

import type { BrowserWindow } from 'electron';

describe('native scroll bridge', () => {
    it('keeps each window ordered, cancels on blur and removes its monitor on close', () => {
        const callbacks = new Map<number, (event: Omit<NativeScrollEvent, 'kind' | 'sequence'>) => void>();
        const stopped: number[] = [];
        const addon: NativeScrollAddon = {
            start: (handle, callback) => {
                const id = handle[0];

                callbacks.set(id, callback);
                return () => {
                    stopped.push(id);
                    callbacks.delete(id);
                };
            },
        };
        const createWindow = (id: number) => {
            const window = new EventEmitter() as EventEmitter & {
                webContents: { id: number; send: ReturnType<typeof vi.fn> };
                getNativeWindowHandle: () => Buffer;
                isDestroyed: () => boolean;
            };

            window.webContents = { id, send: vi.fn() };
            window.getNativeWindowHandle = () => Buffer.from([id]);
            window.isDestroyed = () => false;
            attachNativeScroll(window as unknown as BrowserWindow, () => addon, 'darwin');
            return window;
        };
        const first = createWindow(11);
        const second = createWindow(12);
        const event = { phase: 1, momentumPhase: 0, deltaX: 7, deltaY: 0, x: 42, y: 31, timestamp: 500, precise: true };

        callbacks.get(11)?.(event);
        expect(nativeScrollSnapshot(11)).toEqual({
            sequence: 1,
            gesture: 1,
            active: true,
            origin: { x: 42, y: 31 },
            last: { ...event, kind: 'scroll', sequence: 1 },
        });
        first.emit('blur');
        expect(nativeScrollSnapshot(11)?.active).toBe(false);
        callbacks.get(12)?.({ ...event, phase: 8, momentumPhase: 1 });
        expect(first.webContents.send.mock.calls).toEqual([
            [IPC_CHANNELS.nativeScroll, { ...event, kind: 'scroll', sequence: 1 }],
            [IPC_CHANNELS.nativeScroll, { kind: 'cancel', sequence: 2 }],
        ]);
        expect(second.webContents.send.mock.calls).toEqual([
            [IPC_CHANNELS.nativeScroll, { ...event, phase: 8, momentumPhase: 1, kind: 'scroll', sequence: 1 }],
        ]);
        expect(nativeScrollAvailable(11)).toBe(true);
        first.emit('closed');
        expect([nativeScrollAvailable(11), nativeScrollAvailable(12), stopped]).toEqual([false, true, [11]]);
        second.emit('closed');
    });

    it('falls back when the native addon cannot load', () => {
        const window = new EventEmitter() as EventEmitter & { webContents: { id: number } };
        window.webContents = { id: 19 };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        attachNativeScroll(
            window as unknown as BrowserWindow,
            () => {
                throw new Error('missing addon');
            },
            'darwin'
        );
        expect(nativeScrollAvailable(19)).toBe(false);
        warn.mockRestore();
    });
});
