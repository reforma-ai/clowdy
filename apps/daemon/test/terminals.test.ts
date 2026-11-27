import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TERMINAL_SCROLLBACK, TERMINAL_SUBPROTOCOL, terminalTokenProtocol } from '@clowdy/protocol';
import { Terminal } from '@xterm/headless';

import { SocketClient } from '../src/http/terminals';
import { spawnPty } from '../src/terminals/pty';
import { TerminalService } from '../src/terminals/service';
import { TerminalSession } from '../src/terminals/session';
import { resolveShell, terminalEnvironment } from '../src/terminals/shell';
import { cleanTempDirs, startHarness, tempDir, waitFor } from './helpers';

import type { Project, TerminalInfo, TerminalServerMessage } from '@clowdy/protocol';
import type { Pty, PtySpec } from '../src/terminals/pty';
import type { ScreenMessage, TerminalListener } from '../src/terminals/session';
import type { Shell } from '../src/terminals/shell';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/** A plain `sh` with a short prompt: what the tests that run a real shell talk to. */
const SH: Shell = { file: '/bin/sh', args: [], name: 'sh' };
const shEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, PS1: '$ ', CLOWDY_TOKEN: 'secret' });

/** What a listener that only watches the screens, or only the end, has no use for. */
const quiet = { output: () => undefined, exit: () => undefined, gone: () => undefined };

/** A PTY that does nothing but remember what it was asked, and lets the test play the shell. */
function fakePty() {
    const state = {
        spec: undefined as PtySpec | undefined,
        written: [] as string[],
        size: { cols: 0, rows: 0 },
        killed: 0,
    };
    const pty: Pty = {
        pid: 1,
        write: data => void state.written.push(typeof data === 'string' ? data : decoder.decode(data)),
        resize: (cols, rows) => void (state.size = { cols, rows }),
        kill: () => void state.killed++,
    };

    return {
        state,
        spawn: (spec: PtySpec) => {
            state.spec = spec;
            state.size = { cols: spec.cols, rows: spec.rows };

            return pty;
        },
        emit: (text: string) => state.spec?.onData(encoder.encode(text)),
        exit: (code: number) => state.spec?.onExit(code),
    };
}

function session(spec: Partial<ConstructorParameters<typeof TerminalSession>[1]> = {}) {
    const pty = fakePty();
    const created = new TerminalSession('trm_test', {
        projectId: 'prj_1',
        folderId: 'fld_1',
        cwd: '/tmp',
        shell: SH,
        env: {},
        cols: 40,
        rows: 10,
        ...spec,
    });

    created.start(pty.spawn);

    return { session: created, pty };
}

/** A client as a window is: a terminal of its own that is shown the screen and then fed the output. */
class Viewer implements TerminalListener {
    readonly screen_: Terminal;
    readonly messages: string[] = [];
    exits: number[] = [];
    screens = 0;
    closed = false;
    #parsed = Promise.resolve();

    constructor(cols = 40, rows = 10) {
        this.screen_ = new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
    }

    /** Everything a window draws goes through one chain, so a screen never lands in the middle of output that was sent before it. */
    #then(step: () => Promise<void>): void {
        this.#parsed = this.#parsed.then(step);
    }

    screen(message: ScreenMessage): void {
        this.screens++;
        this.#then(() => {
            this.screen_.reset();
            this.screen_.resize(message.cols, message.rows);

            return new Promise<void>(resolve => this.screen_.write(message.screen, resolve));
        });
    }

    output(data: Uint8Array): void {
        this.#then(() => new Promise<void>(resolve => this.screen_.write(data, resolve)));
    }

    exit(exitCode: number): void {
        this.exits.push(exitCode);
    }

    gone(): void {
        this.closed = true;
    }

    /** Every line of the screen and its scrollback, trailing blanks cut. */
    async lines(): Promise<string[]> {
        await this.#parsed;

        const buffer = this.screen_.buffer.active;
        const lines: string[] = [];

        for (let index = 0; index < buffer.length; index++) {
            lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
        }

        while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        return lines;
    }
}

describe('the shell a terminal runs', () => {
    test("is the person's own, as a terminal app starts it", () => {
        const exists = (file: string) => ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/local/bin/fish'].includes(file);

        expect(resolveShell({ platform: 'darwin', env: { SHELL: '/usr/local/bin/fish' }, exists })).toEqual({
            file: '/usr/local/bin/fish',
            args: ['-l'],
            name: 'fish',
        });
        expect(resolveShell({ platform: 'darwin', env: {}, exists })).toEqual({
            file: '/bin/zsh',
            args: ['-l'],
            name: 'zsh',
        });
        expect(resolveShell({ platform: 'linux', env: { SHELL: '/usr/local/bin/fish' }, exists })).toEqual({
            file: '/usr/local/bin/fish',
            args: [],
            name: 'fish',
        });
    });

    test('falls back past a $SHELL that is not there, and fails when no shell is', () => {
        const exists = (file: string) => file === '/bin/sh';

        expect(resolveShell({ platform: 'linux', env: { SHELL: '/gone/zsh' }, exists }).file).toBe('/bin/sh');
        expect(() => resolveShell({ platform: 'linux', env: {}, exists: () => false })).toThrow('No shell to run');
    });

    test('is `unavailable` to a client when the machine has none, not an internal error', () => {
        const failure = (() => {
            try {
                return resolveShell({ platform: 'linux', env: {}, exists: () => false });
            } catch (error) {
                return error;
            }
        })();

        expect(failure).toMatchObject({ code: 'unavailable' });
    });

    test('on Windows is PowerShell 7, else Windows PowerShell, else the command prompt', () => {
        const which = (found: Record<string, string>) => (program: string) => found[program] ?? null;

        expect(
            resolveShell({
                platform: 'win32',
                env: {},
                which: which({ pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }),
            })
        ).toEqual({ file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'], name: 'pwsh' });
        expect(
            resolveShell({ platform: 'win32', env: {}, which: which({ powershell: 'C:\\Windows\\powershell.exe' }) })
                .name
        ).toBe('powershell');
        expect(
            resolveShell({ platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, which: which({}) })
        ).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [], name: 'cmd' });
    });

    test("inherits the daemon's environment, without what an agent never inherits either, and says what kind of terminal it is", () => {
        const env = terminalEnvironment({
            PATH: '/bin',
            HOME: '/h',
            CLOWDY_TOKEN: 'secret',
            CLOWDY_DATA_DIR: '/d',
            ELECTRON_RUN_AS_NODE: '1',
            NODE_OPTIONS: '--x',
            CLAUDECODE: '1',
            GONE: undefined,
            TERM: 'dumb',
        });

        expect(env).toEqual({
            PATH: '/bin',
            HOME: '/h',
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            TERM_PROGRAM: 'Clowdy',
        });
    });
});

describe('a terminal session', () => {
    test('shows a client that comes later the screen as it is, and then what follows', async () => {
        const { session: s, pty } = session();
        const viewer = new Viewer();

        pty.emit('one\r\ntwo\r\n');
        await s.attach(viewer);
        pty.emit('three\r\n');
        await tick();

        expect(viewer.screens).toBe(1);
        expect(await viewer.lines()).toEqual(['one', 'two', 'three']);
    });

    test('loses nothing and repeats nothing when the shell prints while the client is being given its screen', async () => {
        const { session: s, pty } = session({ cols: 20, rows: 5 });
        const viewer = new Viewer(20, 5);
        let next = 1;
        const print = () => pty.emit(`line ${next++}\r\n`);

        for (; next <= 30; ) {
            print();
        }

        await tick();

        // Lines arrive in separate turns of the event loop around the moment the screen is taken: some are in the screen, some in the queue.
        const attached = s.attach(viewer);

        for (let round = 0; round < 40; round++) {
            print();
            await tick();
        }

        await attached;
        await tick(20);

        const lines = await viewer.lines();

        expect(lines).toEqual(Array.from({ length: next - 1 }, (_, index) => `line ${index + 1}`));
    });

    test('starts a client over with a new screen when it is attached again, as one that fell behind is', async () => {
        const { session: s, pty } = session();
        const viewer = new Viewer();

        await s.attach(viewer);
        pty.emit('before\r\n');
        await tick();
        await s.attach(viewer);
        pty.emit('after\r\n');
        await tick();

        expect(viewer.screens).toBe(2);
        expect(await viewer.lines()).toEqual(['before', 'after']);
    });

    test('keeps the cursor hidden and the mouse reports a full-screen program asked for', async () => {
        const { session: s, pty } = session();
        const screens: ScreenMessage[] = [];

        pty.emit('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
        await s.attach({ screen: message => void screens.push(message), ...quiet });

        expect(screens[0].screen).toContain('\x1b[?25l');
        expect(screens[0].screen).toContain('\x1b[?1006h');

        pty.emit('\x1b[?25h\x1b[?1006l');
        await s.attach({ screen: message => void screens.push(message), ...quiet });

        expect(screens[1].screen).not.toContain('\x1b[?25l');
        expect(screens[1].screen).not.toContain('\x1b[?1006h');
    });

    test('tells its clients the shell ended, after all its output, and shows the end to one that comes later', async () => {
        const { session: s, pty } = session();
        const seen: string[] = [];

        await s.attach({
            screen: () => undefined,
            output: data => void seen.push(decoder.decode(data)),
            exit: code => void seen.push(`exit ${code}`),
            gone: () => undefined,
        });
        pty.emit('bye\r\n');
        pty.exit(3);

        expect(seen).toEqual(['bye\r\n', 'exit 3']);
        expect(s.state).toBe('exited');
        expect(s.exitCode).toBe(3);
        expect(s.info()).toMatchObject({ state: 'exited', exitCode: 3 });

        const screens: ScreenMessage[] = [];

        await s.attach({ screen: message => void screens.push(message), ...quiet });

        expect(screens[0]).toMatchObject({ state: 'exited', exitCode: 3 });
        expect(screens[0].screen).toContain('bye');
    });

    test('resizes the shell and its own copy of the screen together, and ignores a size no PTY can take', async () => {
        const { session: s, pty } = session();
        const screens: ScreenMessage[] = [];

        expect(s.resize(100, 30)).toBe(true);
        expect(pty.state.size).toEqual({ cols: 100, rows: 30 });
        expect(s.resize(1, 30)).toBe(false);
        expect(s.resize(100.5, 30)).toBe(false);
        expect(pty.state.size).toEqual({ cols: 100, rows: 30 });

        await s.attach({ screen: message => void screens.push(message), ...quiet });

        expect(screens[0]).toMatchObject({ cols: 100, rows: 30 });
        expect(s.info()).toMatchObject({ cols: 100, rows: 30 });
    });

    test('tells its clients when it is closed, also one still being given its screen, and a client that comes after', async () => {
        const { session: s, pty } = session();
        const seen: string[] = [];
        const listener: TerminalListener = {
            screen: () => void seen.push('screen'),
            output: () => void seen.push('output'),
            exit: () => void seen.push('exit'),
            gone: () => void seen.push('gone'),
        };

        pty.emit('text');

        const attaching = s.attach(listener);

        s.dispose();
        pty.emit('more');
        await attaching;
        await tick();

        expect(seen).toEqual(['gone']);
        expect(pty.state.killed).toBe(1);

        await s.attach(listener);

        expect(seen).toEqual(['gone', 'gone']);
    });

    test('hands the shell what a client types, and nothing once it ended', () => {
        const { session: s, pty } = session();

        s.write('ls\r');
        pty.exit(0);
        s.write('lost');

        expect(pty.state.written).toEqual(['ls\r']);
    });
});

describe('the plain log of a terminal', () => {
    /** The log once it holds `marker`, or undefined until it does. */
    async function untilLogged(path: string, marker: string): Promise<string> {
        return waitFor(
            () => {
                try {
                    const text = readFileSync(path, 'utf8');

                    return text.includes(marker) ? text : false;
                } catch {
                    return false;
                }
            },
            `${marker} in the log`,
            6000
        );
    }

    test('rewrites the active buffer as plain rows, and drops the file when the session goes', async () => {
        const logPath = join(tempDir('terminal-log'), 'prj_1', 'trm_test.log');
        const { session: s, pty } = session({ logPath, cols: 10 });

        pty.emit('\x1b[31mred\x1b[0m\r\nabcdefghijKLM\r\n');

        const text = await untilLogged(logPath, 'KLM');

        expect(text).not.toContain('\u001b');
        expect(text.replace(/\n$/, '').split('\n')).toEqual(expect.arrayContaining(['red', 'abcdefghij']));
        expect(text).toContain('KLM');
        expect(s.info().logPath).toBe(logPath);
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(logPath)).mode & 0o777).toBe(0o700);
        expect(existsSync(join(dirname(logPath), '.trm_test.log.tmp'))).toBe(false);

        s.resize(8, 10);

        const wrapped = await waitFor(
            () => {
                try {
                    const next = readFileSync(logPath, 'utf8');

                    return !next.includes('abcdefghij') && next.includes('abcdefgh') ? next : false;
                } catch {
                    return false;
                }
            },
            'the reflowed log',
            6000
        );

        expect(wrapped).toContain('abcdefgh');
        s.dispose();
        await tick(30);

        expect(existsSync(logPath)).toBe(false);
    });

    test('keeps only the scrollback', async () => {
        const logPath = join(tempDir('terminal-log'), 'scroll.log');
        const { session: s, pty } = session({ logPath, rows: 10 });
        const count = TERMINAL_SCROLLBACK + 300;

        pty.emit(`${Array.from({ length: count }, (_, index) => `line-${index}`).join('\r\n')}\r\n`);

        const text = await untilLogged(logPath, `line-${count - 1}`);
        const rows = text.replace(/\n$/, '').split('\n');

        expect(rows.length).toBeGreaterThan(TERMINAL_SCROLLBACK);
        expect(rows.length).toBeLessThanOrEqual(TERMINAL_SCROLLBACK + 10);
        expect(rows.at(-1)).toBe(`line-${count - 1}`);
        expect(rows).not.toContain('line-0');
        s.dispose();
    });

    test('writes what the shell printed last as soon as it exits, not a second later', async () => {
        const logPath = join(tempDir('terminal-log'), 'exit.log');
        const { session: s, pty } = session({ logPath });

        pty.emit('bye\r\n');
        pty.exit(0);

        // Well inside the second that the output of a running shell waits before it is written.
        expect(await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8'), 'the log', 500)).toContain(
            'bye'
        );
        s.dispose();
    });

    test('names the file under the project, and a write still in flight does not bring it back', async () => {
        const root = tempDir('terminal-home');
        const logs = tempDir('terminal-logs');
        const pty = fakePty();
        const service = new TerminalService({
            shell: () => SH,
            env: () => ({}),
            spawn: pty.spawn,
            logsDir: logs,
        });
        const project = { id: 'prj_1', name: 'P', folders: [{ id: 'fld_1', path: root }] } as unknown as Project;
        const info = service.create(project, { projectId: 'prj_1', folderId: 'fld_1', cols: 40, rows: 10 });

        const logPath = join(logs, 'prj_1', `${info.id}.log`);

        expect(info.logPath).toBe(logPath);
        // The shell ends, so the log is rewritten at once (a timer of 0 ms); the terminal is removed on the next timer, while that write is on the disk.
        pty.emit('last words\r\n');
        pty.exit(0);
        setTimeout(() => service.remove(info.id), 0);
        await tick(300);

        expect(existsSync(logPath)).toBe(false);
        expect(existsSync(join(logs, 'prj_1', `.${info.id}.log.tmp`))).toBe(false);
        service.stop();
    });

    test('a shell that fails to start leaves no log', async () => {
        const logs = tempDir('terminal-logs-fail');
        const root = tempDir('terminal-home-fail');
        const service = new TerminalService({
            shell: () => SH,
            env: () => ({}),
            spawn: spec => {
                spec.onData(encoder.encode('x'.repeat(64 * 1024)));

                throw new Error('no shell');
            },
            logsDir: logs,
        });
        const project = { id: 'prj_1', name: 'P', folders: [{ id: 'fld_1', path: root }] } as unknown as Project;

        expect(() => service.create(project, { projectId: 'prj_1', folderId: 'fld_1', cols: 40, rows: 10 })).toThrow(
            'could not be started'
        );
        await tick(300);

        expect(existsSync(join(logs, 'prj_1'))).toBe(false);
        service.stop();
    });

    test('drops logs a daemon that did not stop left behind', () => {
        const logs = tempDir('terminal-logs-stale');
        const stale = join(logs, 'prj_old', 'trm_old.log');
        const partial = join(logs, 'prj_old', '.trm_old.log.tmp');
        const kept = join(logs, 'notes.txt');

        mkdirSync(dirname(stale), { recursive: true });
        writeFileSync(stale, 'old\n');
        writeFileSync(partial, 'partial');
        writeFileSync(kept, 'keep');

        const service = new TerminalService({ logsDir: logs });

        expect(existsSync(stale)).toBe(false);
        expect(existsSync(partial)).toBe(false);
        expect(existsSync(dirname(stale))).toBe(false);
        expect(existsSync(kept)).toBe(true);
        service.stop();
    });
});

describe.skipIf(!posix)('a terminal on a real PTY', () => {
    let root: string;
    let service: TerminalService;
    let project: Project;
    let sessions: TerminalSession[];

    beforeEach(() => {
        root = tempDir('terminals');
        mkdirSync(join(root, 'sub'));
        service = new TerminalService({ shell: () => SH, env: shEnv });
        sessions = [];
        project = { id: 'prj_1', name: 'P', folders: [{ id: 'fld_1', path: root }] } as unknown as Project;
    });

    afterEach(() => service.stop());

    /** Creates a terminal and collects what it prints as text. */
    async function open(request: Partial<{ path: string; cols: number; rows: number }> = {}) {
        const info = service.create(project, { projectId: 'prj_1', folderId: 'fld_1', cols: 80, rows: 24, ...request });
        const found = service.require(info.id);
        let text = '';
        const exits: number[] = [];

        sessions.push(found);
        await found.attach({
            screen: message => void (text += message.screen),
            output: data => void (text += decoder.decode(data)),
            exit: code => void exits.push(code),
            gone: () => undefined,
        });

        return {
            info,
            session: found,
            exits,
            text: () => text,
            type: (input: string) => found.write(input),
            until: (what: string | RegExp) =>
                waitFor(
                    () => (typeof what === 'string' ? text.includes(what) : what.test(text)) && text,
                    `${String(what)} on the screen`,
                    6000
                ),
        };
    }

    test('runs a shell in the folder that answers what is typed', async () => {
        const terminal = await open();

        await terminal.until('$ ');
        terminal.type('echo hello-$((1+2))\r');
        await terminal.until('hello-3');
        terminal.type('pwd\r');
        await terminal.until(root.replace(/^\/private/, ''));

        expect(terminal.info).toMatchObject({ shell: 'sh', state: 'running', projectId: 'prj_1', folderId: 'fld_1' });
    });

    test('starts in a folder below the project folder when asked', async () => {
        const terminal = await open({ path: 'sub' });

        await terminal.until('$ ');
        terminal.type('pwd\r');
        await terminal.until('/sub');
    });

    test('lets Ctrl+C stop a command without ending the shell, and reports the exit code of the shell', async () => {
        const terminal = await open();

        await terminal.until('$ ');
        terminal.type('sleep 30\r');
        await tick(300);
        terminal.type('\x03');
        terminal.type('echo still-here\r');
        await terminal.until('still-here');
        terminal.type('exit 3\r');
        await waitFor(() => terminal.exits.length > 0, 'the shell to exit', 6000);

        expect(terminal.exits).toEqual([3]);
        expect(service.require(terminal.info.id).info()).toMatchObject({ state: 'exited', exitCode: 3 });
    });

    test('gives the shell the size of the screen, and the new one after a resize', async () => {
        const terminal = await open({ cols: 90, rows: 20 });

        await terminal.until('$ ');
        terminal.type('stty size\r');
        await terminal.until('20 90');
        terminal.session.resize(120, 40);
        terminal.type('stty size\r');
        await terminal.until('40 120');
    });

    test("gives the shell a terminal that draws colors, and not the daemon's token", async () => {
        const terminal = await open();

        await terminal.until('$ ');
        terminal.type('echo "[$TERM|$COLORTERM|$TERM_PROGRAM|$CLOWDY_TOKEN]"\r');
        await terminal.until('[xterm-256color|truecolor|Clowdy|]');
    });

    test('ends the shell and everything it started when the terminal is closed', async () => {
        const terminal = await open();

        await terminal.until('$ ');
        terminal.type('sleep 60 & echo child=$!\r');

        const child = Number((await terminal.until(/child=(\d+)/)).match(/child=(\d+)/)![1]);
        const shell = terminal.session.pid!;

        service.remove(terminal.info.id);

        await waitFor(
            () => {
                try {
                    process.kill(shell, 0);

                    return false;
                } catch {
                    return true;
                }
            },
            'the shell to be gone',
            6000
        );
        // The foreground jobs are hung up with it; a background job of a non-interactive-job-control `sh` may outlive it, so only clean up.
        try {
            process.kill(child, 'SIGKILL');
        } catch {
            // Already gone.
        }

        expect(service.find(terminal.info.id)).toBeUndefined();
    });

    test('kills a shell that ignores the hang-up when the grace time is over, and reports the signal as 128 plus its number', async () => {
        const exits: number[] = [];
        const pty = spawnPty({
            cmd: ['/bin/sh', '-c', 'trap "" HUP; while :; do sleep 0.1; done'],
            cwd: root,
            env: { PATH: process.env.PATH! },
            cols: 80,
            rows: 24,
            onData: () => undefined,
            onExit: code => void exits.push(code),
        });

        await tick(300);
        pty.kill(100);
        await waitFor(() => exits.length > 0 && exits, 'the shell to be killed', 6000);

        expect(exits).toEqual([137]);
        // A second kill after the end changes nothing.
        pty.kill();
    });

    test('refuses a path that leaves the folder, one that is not there and one that is not a folder', async () => {
        symlinkSync(tempDir('elsewhere'), join(root, 'link'));
        await Bun.write(join(root, 'file.txt'), 'x');

        const create = (path: string) => () =>
            service.create(project, { projectId: 'prj_1', folderId: 'fld_1', path, cols: 80, rows: 24 });

        expect(create('..')).toThrow('must not contain');
        expect(create('/etc')).toThrow('relative');
        expect(create('link')).toThrow('leads out');
        expect(create('nope')).toThrow('does not exist');
        expect(create('file.txt')).toThrow('not a folder');
        expect(service.list()).toEqual([]);
    });

    test('refuses a folder the project does not have, a folder that is gone, and a size no terminal has', () => {
        expect(() => service.create(project, { projectId: 'prj_1', folderId: 'fld_9', cols: 80, rows: 24 })).toThrow(
            'does not exist'
        );
        expect(() =>
            service.create(
                { ...project, folders: [{ id: 'fld_1', path: join(root, 'gone') }] },
                { projectId: 'prj_1', folderId: 'fld_1', cols: 80, rows: 24 }
            )
        ).toThrow('is missing');
        expect(() => service.create(project, { projectId: 'prj_1', folderId: 'fld_1', cols: 0, rows: 24 })).toThrow(
            'size'
        );
    });

    test('runs only so many shells at once, and frees a place when one is closed', async () => {
        const small = new TerminalService({ shell: () => SH, env: shEnv, maxTerminals: 2 });
        const create = () => small.create(project, { projectId: 'prj_1', folderId: 'fld_1', cols: 80, rows: 24 });

        try {
            const first = create();

            create();
            expect(create).toThrow('already runs 2 terminals');
            small.remove(first.id);
            expect(create).not.toThrow();
        } finally {
            small.stop();
        }
    });

    test('says when the shell cannot be started, and leaves nothing running', () => {
        const broken = new TerminalService({
            shell: () => ({ file: join(root, 'no-such-shell'), args: [], name: 'x' }),
            env: shEnv,
        });

        expect(() => broken.create(project, { projectId: 'prj_1', folderId: 'fld_1', cols: 80, rows: 24 })).toThrow(
            'could not be started'
        );
        expect(broken.list()).toEqual([]);
        broken.stop();
    });

    test('forgets a shell that ended after a while, and lists the running ones with it before', async () => {
        const quick = new TerminalService({ shell: () => SH, env: shEnv, exitedTtlMs: 0 });
        const info = quick.create(project, { projectId: 'prj_1', folderId: 'fld_1', cols: 80, rows: 24 });
        const found = quick.require(info.id);

        expect(quick.list('prj_1').map(entry => entry.id)).toEqual([info.id]);
        expect(quick.list('prj_2')).toEqual([]);
        found.write('exit\r');
        await waitFor(() => !found.isRunning, 'the shell to exit', 6000);
        expect(quick.list()).toHaveLength(1);
        quick.stop();
    });
});

describe('a client that cannot keep up', () => {
    function socket(buffered: () => number) {
        const sent: Array<string | Uint8Array> = [];

        return {
            sent,
            ws: { send: (data: string | Uint8Array) => void sent.push(data), getBufferedAmount: buffered } as never,
        };
    }

    test('is passed over while its socket is full, and starts again from a new screen once the socket has drained', () => {
        let buffered = 0;
        const { sent, ws } = socket(() => buffered);
        const attached: TerminalListener[] = [];
        const client = new SocketClient(ws, async listener => {
            attached.push(listener);
        });

        client.output(encoder.encode('a'));
        buffered = 2 * 1024 * 1024;
        client.output(encoder.encode('b'));
        client.output(encoder.encode('c'));
        client.drained();

        expect(sent).toHaveLength(1);
        expect(attached).toHaveLength(0);

        buffered = 0;
        client.drained();
        client.drained();

        expect(attached).toEqual([client]);

        client.screen({ type: 'screen', screen: 'S', cols: 1, rows: 1, state: 'running' } as ScreenMessage);
        client.output(encoder.encode('d'));

        expect(
            sent.map(frame =>
                typeof frame === 'string' ? (JSON.parse(frame) as TerminalServerMessage).type : decoder.decode(frame)
            )
        ).toEqual(['a', 'screen', 'd']);
    });
});

describe.skipIf(!posix)('the terminal routes', () => {
    let h: Harness;
    let project: Project;
    let dir: string;

    beforeEach(async () => {
        h = await startHarness({}, { terminals: new TerminalService({ shell: () => SH, env: shEnv }) });
        dir = tempDir('terminal-http');

        const { project: added } = h.ok('project.add', { folders: [dir] });

        project = added;
    });

    afterEach(() => h.stop());

    const body = (extra: Record<string, unknown> = {}) =>
        JSON.stringify({ projectId: project.id, folderId: project.folders[0].id, cols: 80, rows: 24, ...extra });
    const create = async (extra: Record<string, unknown> = {}) =>
        (await (await h.fetch('/v1/terminals', { method: 'POST', body: body(extra) })).json()) as TerminalInfo;

    /** A stream as the app opens it: the token in a subprotocol, from the app's own origin. */
    async function connect(id: string, options: { token?: string; origin?: string } = {}) {
        const url = `ws://127.0.0.1:${h.daemon.info.port}/v1/terminals/${id}/stream`;
        const socket = new WebSocket(url, {
            protocols: [TERMINAL_SUBPROTOCOL, terminalTokenProtocol(options.token ?? h.config.token)],
            headers: { origin: options.origin ?? 'app://clowdy' },
        } as never);
        const messages: TerminalServerMessage[] = [];
        let output = '';

        socket.binaryType = 'arraybuffer';
        socket.onmessage = event => {
            if (typeof event.data === 'string') {
                messages.push(JSON.parse(event.data) as TerminalServerMessage);
            } else {
                output += decoder.decode(event.data as ArrayBuffer);
            }
        };
        await new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.onerror = () => reject(new Error('The stream was refused'));
        });

        /** What the shell showed: the screen the stream began with, which holds a prompt a fast shell drew before the stream opened, and then its output. */
        const shown = () =>
            [...messages.flatMap(message => (message.type === 'screen' ? [message.screen] : [])), output].join('\n');

        return {
            socket,
            messages,
            output: () => output,
            send: (text: string) => socket.send(encoder.encode(text)),
            until: (what: string) => waitFor(() => shown().includes(what) && shown(), `${what} on the stream`, 6000),
            close: () => socket.close(),
        };
    }

    test('creates, lists and closes terminals', async () => {
        const info = await create();

        expect(info).toMatchObject({
            projectId: project.id,
            folderId: project.folders[0].id,
            shell: 'sh',
            state: 'running',
            cols: 80,
            rows: 24,
        });
        expect(info.id).toMatch(/^trm_/);
        expect(await (await h.fetch('/v1/terminals')).json()).toEqual([info]);
        expect(await (await h.fetch(`/v1/terminals?projectId=${project.id}`)).json()).toEqual([info]);
        expect(await (await h.fetch('/v1/terminals?projectId=prj_other')).json()).toEqual([]);

        const closed = await h.fetch(`/v1/terminals/${info.id}`, { method: 'DELETE' });

        expect(closed.status).toBe(200);
        expect(await (await h.fetch('/v1/terminals')).json()).toEqual([]);
        expect((await h.fetch(`/v1/terminals/${info.id}`, { method: 'DELETE' })).status).toBe(404);
    });

    test("answers what is wrong with a request in the daemon's usual way", async () => {
        const post = (text: string) => h.fetch('/v1/terminals', { method: 'POST', body: text });

        expect((await post('not json')).status).toBe(400);
        expect((await post(JSON.stringify({ projectId: project.id }))).status).toBe(400);
        expect((await post(body({ cols: 1 }))).status).toBe(400);
        expect((await post(body({ projectId: 'prj_gone' }))).status).toBe(404);
        expect((await post(body({ folderId: 'fld_gone' }))).status).toBe(404);
        expect((await post(body({ path: '../x' }))).status).toBe(400);
    });

    test('is behind the token, the stream too', async () => {
        const info = await create();

        for (const route of ['/v1/terminals', `/v1/terminals/${info.id}/stream`]) {
            expect((await fetch(`${h.url}${route}`)).status).toBe(401);
            expect((await fetch(`${h.url}${route}`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
        }

        expect((await fetch(`${h.url}/v1/terminals`, { method: 'POST', body: body() })).status).toBe(401);
        expect((await fetch(`${h.url}/v1/terminals/${info.id}`, { method: 'DELETE' })).status).toBe(401);
        await expect(connect(info.id, { token: 'wrong' })).rejects.toThrow('refused');
    });

    test("refuses a stream from an origin that is not the app's, even with the token", async () => {
        const info = await create();

        await expect(connect(info.id, { origin: 'https://evil.example' })).rejects.toThrow('refused');
    });

    test('answers a stream path with a malformed escape as any other that names no terminal, and asks for the token first', async () => {
        const route = `${h.url}/v1/terminals/%zz/stream`;

        expect((await fetch(route)).status).toBe(401);
        expect((await fetch(route, { headers: { authorization: `Bearer ${h.config.token}` } })).status).toBe(404);
    });

    test('says what is wrong with a stream that is not one', async () => {
        expect((await h.fetch('/v1/terminals/trm_gone/stream')).status).toBe(404);
        expect((await h.fetch(`/v1/terminals/${(await create()).id}/stream`)).status).toBe(400);
    });

    test('streams the shell: the screen first, then its output, and takes input and a new size', async () => {
        const info = await create();
        const stream = await connect(info.id);

        await waitFor(() => stream.messages.length > 0, 'the screen', 6000);
        expect(stream.messages[0]).toMatchObject({ type: 'screen', cols: 80, rows: 24, state: 'running' });
        await stream.until('$ ');
        stream.send('echo over-the-wire\r');
        await stream.until('over-the-wire');
        stream.socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
        stream.send('stty size\r');
        await stream.until('30 100');
        expect(((await (await h.fetch('/v1/terminals')).json()) as TerminalInfo[])[0]).toMatchObject({
            cols: 100,
            rows: 30,
        });
        stream.close();
    });

    test('shows a second window the screen as the first left it, and keeps the shell when a window goes', async () => {
        const info = await create();
        const first = await connect(info.id);

        await first.until('$ ');
        first.send('echo remembered\r');
        await first.until('remembered');
        first.close();
        await tick(50);

        const second = await connect(info.id);

        await waitFor(() => second.messages.length > 0, 'the screen', 6000);

        const screen = second.messages[0] as Extract<TerminalServerMessage, { type: 'screen' }>;

        expect(screen.screen).toContain('remembered');
        second.send('echo again\r');
        await second.until('again');
        second.close();
    });

    test('lets go of a window whose terminal was closed from elsewhere', async () => {
        const info = await create();
        const stream = await connect(info.id);
        const closed = new Promise<number>(resolve => void (stream.socket.onclose = event => resolve(event.code)));

        await waitFor(() => stream.messages.length > 0, 'the screen', 6000);
        expect((await h.fetch(`/v1/terminals/${info.id}`, { method: 'DELETE' })).status).toBe(200);
        expect(await closed).toBe(1001);
        await expect(connect(info.id)).rejects.toThrow('refused');
    });

    test('tells the stream the shell exited', async () => {
        const stream = await connect((await create()).id);

        await stream.until('$ ');
        stream.send('exit 7\r');
        await waitFor(() => stream.messages.find(message => message.type === 'exit'), 'the exit', 6000);
        expect(stream.messages.find(message => message.type === 'exit')).toEqual({ type: 'exit', exitCode: 7 });
    });

    test('closes a stream that sends what the protocol does not know', async () => {
        const stream = await connect((await create()).id);
        const closed = new Promise<number>(resolve => void (stream.socket.onclose = event => resolve(event.code)));

        stream.socket.send('{"type":"nonsense"}');
        expect(await closed).toBe(1008);
    });

    test('ends the shells when the daemon stops, with a window still attached', async () => {
        const info = await create();
        const pid = h.daemon.services.terminals.require(info.id).pid!;
        const stream = await connect(info.id);

        await waitFor(() => stream.messages.length > 0, 'the screen', 6000);

        await h.stop();
        await waitFor(
            () => {
                try {
                    process.kill(pid, 0);

                    return false;
                } catch {
                    return true;
                }
            },
            'the shell to be gone',
            6000
        );
        h = await startHarness();
    });
});
