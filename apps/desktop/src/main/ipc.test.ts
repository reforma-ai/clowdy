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
        { setThemeSource: vi.fn(), getDaemon: async () => undefined, ready: async () => undefined, restartToUpdate: vi.fn(), listOpenApps: async () => ({ editors: [], fileManagers: [] }), openFolder: async () => undefined, ...actions }
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

describe('find in page', () => {
    interface Found {
        requestId: number;
        matches: number;
        activeMatchOrdinal: number;
        selectionArea?: { x: number; y: number; width: number; height: number };
        finalUpdate: boolean;
    }

    function contents() {
        const listeners = new Set<(event: unknown, result: Found) => void>();
        const target = {
            mainFrame: null as { url: string } | null,
            findInPage: vi.fn(() => 7),
            stopFindInPage: vi.fn(),
            on: (_event: string, listener: (event: unknown, result: Found) => void) => void listeners.add(listener),
            removeListener: (_event: string, listener: (event: unknown, result: Found) => void) => void listeners.delete(listener),
            emit(result: Found) {
                for (const listener of listeners) listener({}, result);
            },
        };

        return target;
    }

    function eventFor(target: ReturnType<typeof contents>, url: string) {
        const frame = { url };

        target.mainFrame = frame;

        return { sender: target, senderFrame: frame };
    }

    test('answers with the match count once Chromium finishes, and clears the highlights', async () => {
        const { handlers } = register();
        const target = contents();
        const event = eventFor(target, `${ TRUSTED }/`);
        const pending = handlers.get(IPC_CHANNELS.findInPage)!(event, 'booking', { forward: false, findNext: true });

        expect(target.findInPage).toHaveBeenCalledWith('booking', { forward: false, findNext: true });

        target.emit({ requestId: 7, matches: 1, activeMatchOrdinal: 0, finalUpdate: false });
        target.emit({
            requestId: 7,
            matches: 4,
            activeMatchOrdinal: 2,
            selectionArea: { x: 8, y: 12, width: 40, height: 16 },
            finalUpdate: true,
        });

        await expect(pending).resolves.toEqual({
            matches: 4,
            activeMatchOrdinal: 2,
            selectionArea: { x: 8, y: 12, width: 40, height: 16 },
        });

        await handlers.get(IPC_CHANNELS.stopFind)!(event);

        expect(target.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    });

    test('refuses an empty query, bad options, and a page of another origin', async () => {
        const { handlers } = register();
        const target = contents();
        const find = handlers.get(IPC_CHANNELS.findInPage)!;

        expect(() => find(eventFor(target, `${ TRUSTED }/`), '', { forward: true, findNext: true })).toThrow('Empty find');
        expect(() => find(eventFor(target, `${ TRUSTED }/`), 'booking', { forward: true })).toThrow('Bad find options');
        expect(() => find(eventFor(target, 'https://example.com/'), 'booking', { forward: true, findNext: true })).toThrow('Untrusted sender');
        expect(target.findInPage).not.toHaveBeenCalled();
        expect(() => handlers.get(IPC_CHANNELS.stopFind)!(eventFor(target, 'https://example.com/'))).toThrow('Untrusted sender');
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

describe('opening a folder in a program', () => {
    test('the app\'s own page can ask what the computer has and open a folder, and what it sends is handed on as it is', async () => {
        const apps = { editors: [{ id: 'cursor', name: 'Cursor' }], fileManagers: [{ id: 'finder', name: 'Finder' }] };
        const listOpenApps = vi.fn(async () => apps);
        const openFolder = vi.fn(async () => undefined);
        const { handlers } = register({ listOpenApps, openFolder });
        const event = callFrom({ url: `${ TRUSTED }/` });

        expect(await handlers.get(IPC_CHANNELS.openApps)!(event)).toEqual(apps);

        await handlers.get(IPC_CHANNELS.openFolder)!(event, '/Users/dev/web', { kind: 'editor', id: 'cursor' });

        expect(openFolder).toHaveBeenCalledWith('/Users/dev/web', { kind: 'editor', id: 'cursor' });
    });

    test('another page can do neither', async () => {
        const listOpenApps = vi.fn(async () => ({ editors: [], fileManagers: [] }));
        const openFolder = vi.fn(async () => undefined);
        const { handlers } = register({ listOpenApps, openFolder });
        const event = callFrom({ url: 'https://example.com/' });

        expect(() => handlers.get(IPC_CHANNELS.openApps)!(event)).toThrow('Untrusted sender');
        expect(() => handlers.get(IPC_CHANNELS.openFolder)!(event, '/Users/dev/web', { kind: 'editor', id: 'cursor' })).toThrow('Untrusted sender');
        expect(listOpenApps).not.toHaveBeenCalled();
        expect(openFolder).not.toHaveBeenCalled();
    });
});
