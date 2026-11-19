import { BrowserWindow, dialog } from 'electron';
import { describe, expect, test, vi } from 'vitest';

import { IPC_CHANNELS } from '../shared/bridge';
import { registerIpc } from './ipc';

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));

const TRUSTED = 'http://127.0.0.1:5273';
const ADDRESS = { url: 'http://127.0.0.1:51000', token: 'secret' };

type Listener = (event: { sender: unknown; senderFrame: unknown; returnValue?: unknown }) => void;

type Handler = (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => unknown;

/** Registers the IPC handlers on a fake `ipcMain`. */
function register(actions: Partial<Parameters<typeof registerIpc>[2]> = {}) {
    const listeners = new Map<string, Listener>();
    const handlers = new Map<string, Handler>();

    registerIpc(
        {
            handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
            on: (channel: string, listener: Listener) => void listeners.set(channel, listener),
        } as never,
        TRUSTED,
        { setThemeSource: vi.fn(), getDaemon: async () => undefined, ready: async () => undefined, restartToUpdate: vi.fn(), ...actions }
    );

    return { listeners, handlers };
}

/** The listener of the synchronous daemon call. */
function setup(getDaemon: () => Promise<typeof ADDRESS | undefined>) {
    return register({ getDaemon }).listeners.get(IPC_CHANNELS.getDaemon) as Listener;
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
    /** The handler of the folder dialog. */
    function chooser() {
        return register().handlers.get(IPC_CHANNELS.chooseDirectories)! as (event: unknown) => Promise<unknown>;
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

describe('OTA updates', () => {
    test('the app\'s own page can say it is ready and restart into an update', async () => {
        const ready = vi.fn(async () => undefined);
        const restartToUpdate = vi.fn();
        const { handlers } = register({ ready, restartToUpdate });
        const event = callFrom({ url: `${ TRUSTED }/` });

        await handlers.get(IPC_CHANNELS.ready)!(event);
        await handlers.get(IPC_CHANNELS.restartToUpdate)!(event);

        expect(ready).toHaveBeenCalledOnce();
        expect(restartToUpdate).toHaveBeenCalledOnce();
    });

    test('another page can do neither', async () => {
        const ready = vi.fn(async () => undefined);
        const restartToUpdate = vi.fn();
        const { handlers } = register({ ready, restartToUpdate });
        const event = callFrom({ url: 'https://example.com/' });

        await expect(async () => handlers.get(IPC_CHANNELS.ready)!(event)).rejects.toThrow('Untrusted sender');
        expect(() => handlers.get(IPC_CHANNELS.restartToUpdate)!(event)).toThrow('Untrusted sender');
        expect(ready).not.toHaveBeenCalled();
        expect(restartToUpdate).not.toHaveBeenCalled();
    });
});
