import { describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { TransportError } from '../../daemon/transport';
import { isAppShortcut, shellSequence } from './shellKeys';
import { terminalLabels } from './terminalLabels';
import { TerminalsStore } from './TerminalsStore';
import { terminalTheme } from './terminalTheme';

import type { TerminalStreamHandlers } from '../../daemon/terminalStream';

async function setup() {
    const transport = new FixtureTransport();
    const { projects } = await transport.getRootSnapshot();
    const project = projects.find(candidate => candidate.id === FIXTURE_PROJECT_ID)!;
    const [first, second] = project.folders;

    return { transport, store: new TerminalsStore(transport), projectId: project.id, folderId: first.id, otherFolderId: second?.id };
}

describe('TerminalsStore', () => {
    it('starts a shell in a folder and chooses it', async () => {
        const { store, projectId, folderId } = await setup();
        const session = await store.start(projectId, folderId);

        expect(session?.info).toMatchObject({ projectId, folderId, shell: 'zsh', state: 'running', cols: 80, rows: 24 });
        expect(store.sessionsOf(projectId, folderId)).toEqual([session]);
        expect(store.activeOf(projectId, folderId)).toBe(session);
    });

    it('keeps each folder\'s shells to itself, and the one chosen, the last made when none is', async () => {
        const { store, projectId, folderId, otherFolderId } = await setup();
        const first = await store.start(projectId, folderId);
        const second = await store.start(projectId, folderId);

        expect(store.activeOf(projectId, folderId)).toBe(second);
        store.select(first!);
        expect(store.activeOf(projectId, folderId)).toBe(first);

        if (otherFolderId) {
            expect(store.sessionsOf(projectId, otherFolderId)).toEqual([]);
            expect(store.activeOf(projectId, otherFolderId)).toBeUndefined();
        }
    });

    it('reads the shells the daemon already runs, once, and brings the ones it holds up to date', async () => {
        const { transport, store, projectId, folderId } = await setup();
        const made = await transport.createTerminal({ projectId, folderId, cols: 100, rows: 30 });
        const list = vi.spyOn(transport, 'listTerminals');

        expect(store.isLoaded(projectId)).toBe(false);
        await Promise.all([store.load(projectId), store.load(projectId)]);
        await store.load(projectId);

        expect(list).toHaveBeenCalledTimes(1);
        expect(store.isLoaded(projectId)).toBe(true);
        expect(store.sessionsOf(projectId, folderId).map(session => session.id)).toEqual([made.id]);
        expect(store.sessionsOf(projectId, folderId)[0].info).toMatchObject({ cols: 100, rows: 30 });
    });

    it('forgets a shell the daemon no longer lists when it reads again, and disposes what drew it', async () => {
        const { transport, store, projectId, folderId } = await setup();
        const session = (await store.start(projectId, folderId))!;
        const dispose = vi.fn();

        session.view = { dispose };
        await transport.closeTerminal(session.id);
        await store.load(projectId);

        expect(store.sessionsOf(projectId, folderId)).toEqual([]);
        expect(dispose).toHaveBeenCalledOnce();
        expect(session.view).toBeUndefined();
    });

    it('gives an empty folder its first shell once, and does not start another when the last is closed', async () => {
        const { transport, store, projectId, folderId } = await setup();
        const create = vi.spyOn(transport, 'createTerminal');

        await store.ensureOne(projectId, folderId);
        await store.ensureOne(projectId, folderId);
        expect(create).toHaveBeenCalledOnce();

        await store.close(store.sessionsOf(projectId, folderId)[0]);
        await store.ensureOne(projectId, folderId);
        expect(create).toHaveBeenCalledOnce();
        expect(store.sessionsOf(projectId, folderId)).toEqual([]);
    });

    it('does not start one in a folder that already has some', async () => {
        const { transport, store, projectId, folderId } = await setup();

        await transport.createTerminal({ projectId, folderId, cols: 80, rows: 24 });
        await store.load(projectId);

        const create = vi.spyOn(transport, 'createTerminal');

        await store.ensureOne(projectId, folderId);
        expect(create).not.toHaveBeenCalled();
    });

    it('closes a shell: gone from the list at once, ended in the daemon, its view disposed', async () => {
        const { transport, store, projectId, folderId } = await setup();
        const session = (await store.start(projectId, folderId))!;
        const dispose = vi.fn();

        session.view = { dispose };
        await store.close(session);

        expect(store.sessionsOf(projectId, folderId)).toEqual([]);
        expect(dispose).toHaveBeenCalledOnce();
        expect(await transport.listTerminals(projectId)).toEqual([]);
    });

    it('keeps the daemon\'s reason when a shell could not be started, and when the list could not be read', async () => {
        const { transport, projectId, folderId } = await setup();
        const refusing = new TerminalsStore(overrideTransport(transport, {
            createTerminal: () => Promise.reject(new TransportError('The folder /p is missing', 503)),
            listTerminals: () => Promise.reject(new TransportError('The daemon answered 500 for /v1/terminals', 500)),
        }));

        expect(await refusing.start(projectId, folderId)).toBeUndefined();
        expect(refusing.error).toBe('The folder /p is missing');

        await refusing.load(projectId);
        expect(refusing.error).toBe('The daemon answered 500 for /v1/terminals');
        expect(refusing.isLoaded(projectId)).toBe(false);
    });

    it('drops a terminal the daemon says is gone, and ends every view when it is disposed', async () => {
        const { store, projectId, folderId } = await setup();
        const one = (await store.start(projectId, folderId))!;
        const two = (await store.start(projectId, folderId))!;
        const dispose = vi.fn();

        one.view = { dispose };
        two.view = { dispose };
        store.forget(one);
        expect(store.sessionsOf(projectId, folderId)).toEqual([two]);
        store.dispose();
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(store.sessions).toEqual([]);
    });
});

describe('the fixture shell', () => {
    it('echoes what is typed, answers a line, and ends on exit', async () => {
        const { transport, projectId, folderId } = await setup();
        const info = await transport.createTerminal({ projectId, folderId, cols: 80, rows: 24 });
        const seen: string[] = [];
        const handlers: TerminalStreamHandlers = {
            onScreen: screen => void seen.push(`screen:${ screen.screen.includes('$') }`),
            onOutput: data => void seen.push(new TextDecoder().decode(data)),
            onExit: code => void seen.push(`exit ${ code }`),
            onStatus: status => void seen.push(status),
            onGone: () => void seen.push('gone'),
        };
        const stream = transport.openTerminal(info.id, handlers);

        expect(stream.write('ls\r')).toBe(true);
        stream.write('exit\r');
        expect(seen.slice(0, 3)).toEqual(['open', 'screen:true', 'l']);
        expect(seen.at(-1)).toBe('exit 0');
        expect(stream.write('more')).toBe(false);
        expect((await transport.listTerminals(projectId))[0]).toMatchObject({ state: 'exited', exitCode: 0 });
    });

    it('says a terminal is gone when it is not there', async () => {
        const { transport } = await setup();
        const onGone = vi.fn();

        transport.openTerminal('trm_none', { onScreen: vi.fn(), onOutput: vi.fn(), onExit: vi.fn(), onStatus: vi.fn(), onGone });
        expect(onGone).toHaveBeenCalledOnce();
    });
});

describe('terminalLabels', () => {
    it('names a tab for its shell, and numbers the ones that share a name', () => {
        expect(terminalLabels([{ shell: 'zsh' }])).toEqual(['zsh']);
        expect(terminalLabels([{ shell: 'zsh' }, { shell: 'bash' }, { shell: 'zsh' }, { shell: 'zsh' }])).toEqual(['zsh', 'bash', 'zsh 2', 'zsh 3']);
        expect(terminalLabels([])).toEqual([]);
    });
});

describe('shellSequence', () => {
    const key = (init: Partial<KeyboardEvent> & { key: string }) => ({ type: 'keydown', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init });

    it('gives a Mac its terminal shortcuts: word jumps with Option, line start, end and clear with Cmd', () => {
        expect(shellSequence(key({ key: 'ArrowLeft', altKey: true }), 'darwin')).toBe('\x1bb');
        expect(shellSequence(key({ key: 'ArrowRight', altKey: true }), 'darwin')).toBe('\x1bf');
        expect(shellSequence(key({ key: 'ArrowLeft', metaKey: true }), 'darwin')).toBe('\x01');
        expect(shellSequence(key({ key: 'ArrowRight', metaKey: true }), 'darwin')).toBe('\x05');
        expect(shellSequence(key({ key: 'Backspace', metaKey: true }), 'darwin')).toBe('\x15');
    });

    it('leaves everything else to xterm, and every key off a Mac', () => {
        expect(shellSequence(key({ key: 'ArrowLeft', altKey: true }), 'win32')).toBeUndefined();
        expect(shellSequence(key({ key: 'a' }), 'darwin')).toBeUndefined();
        expect(shellSequence(key({ key: 'ArrowLeft', altKey: true, shiftKey: true }), 'darwin')).toBeUndefined();
        expect(shellSequence({ ...key({ key: 'ArrowLeft', altKey: true }), type: 'keyup' }, 'darwin')).toBeUndefined();
    });
});

describe('terminalTheme', () => {
    const style = { backgroundColor: 'rgb(1, 2, 3)', color: 'rgb(4, 5, 6)' };

    it('takes the plate\'s colors, and a palette for the scheme', () => {
        const dark = terminalTheme(style, true);
        const light = terminalTheme(style, false);

        expect(dark).toMatchObject({ background: 'rgb(1, 2, 3)', foreground: 'rgb(4, 5, 6)', cursor: 'rgb(4, 5, 6)', cursorAccent: 'rgb(1, 2, 3)' });
        expect(light.background).toBe(dark.background);
        expect(light.red).not.toBe(dark.red);
        expect(dark.black).toBeTruthy();
    });
});

describe('isAppShortcut', () => {
    const key = (init: Partial<KeyboardEvent> & { code: string }) => ({ type: 'keydown', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init });

    it('lets the terminal toggle through on every system, and the panel toggle as each system has it', () => {
        expect(isAppShortcut(key({ code: 'Backquote', ctrlKey: true }), 'darwin')).toBe(true);
        expect(isAppShortcut(key({ code: 'Backquote', ctrlKey: true }), 'win32')).toBe(true);
        expect(isAppShortcut(key({ code: 'KeyB', ctrlKey: true, shiftKey: true }), 'win32')).toBe(true);
        expect(isAppShortcut(key({ code: 'KeyB', ctrlKey: true, shiftKey: true }), 'darwin')).toBe(false);
        expect(isAppShortcut(key({ code: 'Escape', metaKey: true }), 'darwin')).toBe(true);
    });

    it('keeps every other key for the shell', () => {
        expect(isAppShortcut(key({ code: 'KeyB', ctrlKey: true }), 'win32')).toBe(false);
        expect(isAppShortcut(key({ code: 'Backquote' }), 'darwin')).toBe(false);
        expect(isAppShortcut(key({ code: 'Backquote', ctrlKey: true, shiftKey: true }), 'darwin')).toBe(false);
        expect(isAppShortcut({ ...key({ code: 'Backquote', ctrlKey: true }), type: 'keyup' }, 'darwin')).toBe(false);
        // A plain Esc is the shell's (vim, a prompt's menu), and so is Esc with Ctrl, Shift or Alt; off a Mac Cmd+Esc is the Windows key's.
        expect(isAppShortcut(key({ code: 'Escape' }), 'darwin')).toBe(false);
        expect(isAppShortcut(key({ code: 'Escape', metaKey: true, ctrlKey: true }), 'darwin')).toBe(false);
        expect(isAppShortcut(key({ code: 'Escape', metaKey: true, shiftKey: true }), 'darwin')).toBe(false);
        expect(isAppShortcut(key({ code: 'Escape', metaKey: true, altKey: true }), 'darwin')).toBe(false);
        expect(isAppShortcut(key({ code: 'Escape', metaKey: true }), 'win32')).toBe(false);
        expect(isAppShortcut({ ...key({ code: 'Escape', metaKey: true }), type: 'keyup' }, 'darwin')).toBe(false);
    });
});
