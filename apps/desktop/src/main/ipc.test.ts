import { BrowserWindow, dialog } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { IPC_CHANNELS } from '../shared/bridge';
import { registerIpc } from './ipc';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));

const TRUSTED = 'http://127.0.0.1:5273';
const ADDRESS = { url: 'http://127.0.0.1:51000', token: 'secret' };

type Listener = (event: { sender: unknown; senderFrame: unknown; returnValue?: unknown }) => void;

/** Registers the IPC handlers on a fake `ipcMain` and returns the listener of the synchronous daemon call. */
function setup(getDaemon: () => Promise<typeof ADDRESS | undefined>) {
    const listeners = new Map<string, Listener>();

    registerIpc(
        { handle: vi.fn(), on: (channel: string, listener: Listener) => void listeners.set(channel, listener) } as never,
        TRUSTED,
        { setThemeSource: vi.fn(), getDaemon }
    );

    return listeners.get(IPC_CHANNELS.getDaemon) as Listener;
}

/** The event of a call from `frame`; the page's top-level frame is `mainFrame`. */
function callFrom(frame: { url: string } | null, mainFrame: unknown = frame) {
    return { sender: { mainFrame }, senderFrame: frame } as Parameters<Listener>[0];
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the daemon address for the preload', () => {
    test('is answered to the app\'s own top-level frame, possibly after the daemon is found', async () => {
        const listener = setup(async () => ADDRESS);
        const event = callFrom({ url: `${ TRUSTED }/` });

        listener(event);

        // The renderer waits for `returnValue`, so it may be set later.
        expect(event.returnValue).toBeUndefined();

        await settle();

        expect(event.returnValue).toEqual(ADDRESS);
    });

    test('is `null` when no daemon answers, or looking for it fails', async () => {
        for (const getDaemon of [async () => undefined, () => Promise.reject(new Error('boom'))]) {
            const event = callFrom({ url: `${ TRUSTED }/` });

            setup(getDaemon)(event);
            await settle();

            expect(event.returnValue).toBeNull();
        }
    });

    test('is `null` at once for a page of another origin', () => {
        const getDaemon = vi.fn(async () => ADDRESS);
        const event = callFrom({ url: 'https://example.com/' });

        setup(getDaemon)(event);

        expect(event.returnValue).toBeNull();
        expect(getDaemon).not.toHaveBeenCalled();
    });

    test('is `null` at once for a frame that is not the top-level one, and for a frame that is gone', () => {
        const getDaemon = vi.fn(async () => ADDRESS);
        const listener = setup(getDaemon);
        const nested = callFrom({ url: `${ TRUSTED }/` }, { url: `${ TRUSTED }/` });
        const gone = callFrom(null);

        listener(nested);
        listener(gone);

        expect(nested.returnValue).toBeNull();
        expect(gone.returnValue).toBeNull();
        expect(getDaemon).not.toHaveBeenCalled();
    });
});

describe('the folder dialog', () => {
    /** Registers the IPC handlers on a fake `ipcMain` and returns the handler of the folder dialog. */
    function chooser() {
        const handlers = new Map<string, (event: unknown) => Promise<unknown>>();

        registerIpc(
            { handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => void handlers.set(channel, handler), on: vi.fn() } as never,
            TRUSTED,
            { setThemeSource: vi.fn(), getDaemon: async () => undefined }
        );

        return handlers.get(IPC_CHANNELS.chooseDirectories)!;
    }

    test('opens over the window that asked with several folders selectable, and answers every folder chosen, or none on cancel', async () => {
        const window = { id: 1 };
        const showOpenDialog = vi.fn()
            .mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/dev/web', '/Users/dev/api'] })
            .mockResolvedValueOnce({ canceled: true, filePaths: [] });

        Object.assign(BrowserWindow, { fromWebContents: () => window });
        Object.assign(dialog, { showOpenDialog });

        const choose = chooser();

        expect(await choose(callFrom({ url: `${ TRUSTED }/` }))).toEqual(['/Users/dev/web', '/Users/dev/api']);
        expect(showOpenDialog).toHaveBeenCalledWith(window, { properties: ['openDirectory', 'createDirectory', 'multiSelections'] });
        expect(await choose(callFrom({ url: `${ TRUSTED }/` }))).toEqual([]);
    });

    test('refuses a page of another origin', async () => {
        await expect(chooser()(callFrom({ url: 'https://example.com/' }))).rejects.toThrow('Untrusted sender');
    });
});
