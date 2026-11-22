import { TERMINAL_SUBPROTOCOL, tokenFromTerminalProtocols } from '@clowdy/protocol';
import { describe, expect, it, vi } from 'vitest';

import { HttpTransport } from './httpTransport';
import { chunkInput, RECONNECT_MAX_MS, RECONNECT_MIN_MS, TerminalSocket, type TerminalStreamHandlers } from './terminalStream';

import type { TerminalInfo, TerminalScreen } from '@clowdy/protocol';

/** A WebSocket the test plays the daemon on: it records what is sent, and the test opens, feeds and drops it. */
class FakeSocket {
    static all: FakeSocket[] = [];
    binaryType = '';
    sent: Array<string | Uint8Array> = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string, readonly protocols: string[]) {
        FakeSocket.all.push(this);
    }

    send(data: string | Uint8Array) {
        this.sent.push(data);
    }

    close() {
        this.closed = true;
        this.onclose?.();
    }

    open() {
        this.onopen?.();
    }

    text(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    bytes(text: string) {
        this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
    }

    drop() {
        this.onclose?.();
    }
}

const screen: TerminalScreen = { screen: 'S', cols: 80, rows: 24, state: 'running' };

function setup(exists: () => Promise<boolean | undefined> = async () => true) {
    FakeSocket.all = [];

    const events: string[] = [];
    const sleeps: number[] = [];
    const handlers: TerminalStreamHandlers = {
        onScreen: value => void events.push(`screen ${ value.screen }`),
        onOutput: data => void events.push(`output ${ new TextDecoder().decode(data) }`),
        onExit: code => void events.push(`exit ${ code }`),
        onStatus: status => void events.push(status),
        onGone: () => void events.push('gone'),
    };
    const stream = new TerminalSocket({
        handlers,
        exists,
        address: () => ({ url: 'ws://127.0.0.1:1/v1/terminals/trm_1/stream', token: 'secret' }),
        WebSocket: FakeSocket as unknown as typeof WebSocket,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
    });

    return { stream, events, sleeps, socket: () => FakeSocket.all[FakeSocket.all.length - 1] };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('chunkInput', () => {
    it('keeps a short paste whole and cuts a long one below what a frame carries', () => {
        expect(chunkInput('ls')).toEqual(['ls']);
        expect(chunkInput('')).toEqual([]);

        const chunks = chunkInput('é'.repeat(100_000));

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join('')).toBe('é'.repeat(100_000));

        for (const chunk of chunks) expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(64 * 1024);
    });

    it('never cuts between the halves of a character outside the BMP', () => {
        const text = '😀'.repeat(30_000);
        const chunks = chunkInput(text);

        expect(chunks.join('')).toBe(text);

        for (const chunk of chunks) expect([...chunk].join('')).toBe(chunk);
    });
});

describe('TerminalSocket', () => {
    it('offers the protocol and the token as subprotocols, and is open once the screen came', async () => {
        const { events, socket, stream } = setup();

        await settle();
        expect(socket().url).toBe('ws://127.0.0.1:1/v1/terminals/trm_1/stream');
        expect(socket().protocols[0]).toBe(TERMINAL_SUBPROTOCOL);
        expect(tokenFromTerminalProtocols(socket().protocols.join(', '))).toBe('secret');
        expect(stream.write('x')).toBe(false);

        socket().open();
        expect(stream.write('x')).toBe(false);

        socket().text({ type: 'screen', ...screen });
        expect(events).toEqual(['connecting', 'open', 'screen S']);
        expect(stream.write('x')).toBe(true);
    });

    it('hands on the output as bytes, in order, and the end of the shell', async () => {
        const { events, socket } = setup();

        await settle();
        socket().open();
        socket().text({ type: 'screen', ...screen });
        socket().bytes('one ');
        socket().bytes('two');
        socket().text({ type: 'exit', exitCode: 3 });
        expect(events.slice(3)).toEqual(['output one ', 'output two', 'exit 3']);
    });

    it('sends input as binary frames and the size as a message, only while it is open', async () => {
        const { socket, stream } = setup();

        await settle();
        socket().open();
        stream.resize(100, 30);
        expect(socket().sent).toEqual([]);

        socket().text({ type: 'screen', ...screen });
        stream.write('ls\r');
        stream.resize(100, 30);

        const [input, size] = socket().sent;

        expect(new TextDecoder().decode(input as Uint8Array)).toBe('ls\r');
        expect(JSON.parse(size as string)).toEqual({ type: 'resize', cols: 100, rows: 30 });
    });

    it('connects again when the connection drops, with the screen the daemon sends then, and a pause that grows while it cannot', async () => {
        const { events, sleeps, socket } = setup();

        await settle();
        socket().open();
        socket().text({ type: 'screen', ...screen });
        socket().drop();
        await settle();

        expect(events.slice(-1)).toEqual(['reconnecting']);
        expect(FakeSocket.all).toHaveLength(2);

        // The next two connections never open.
        socket().drop();
        await settle();
        socket().drop();
        await settle();

        // The first pause follows a connection that was up, so it is the shortest; the ones after it follow connections that never opened.
        expect(sleeps).toEqual([RECONNECT_MIN_MS, RECONNECT_MIN_MS * 2, RECONNECT_MIN_MS * 4]);

        socket().open();
        socket().text({ type: 'screen', ...{ ...screen, screen: 'T' } });
        expect(events.slice(-2)).toEqual(['open', 'screen T']);
        expect(RECONNECT_MAX_MS).toBeGreaterThan(RECONNECT_MIN_MS * 4);
    });

    it('gives up when the daemon no longer has the terminal, and keeps trying when it cannot say', async () => {
        const answers: Array<boolean | undefined> = [undefined, false];
        const { events, socket } = setup(async () => answers.shift());

        await settle();
        socket().drop();
        await settle();
        expect(events).toEqual(['connecting', 'reconnecting']);
        expect(FakeSocket.all).toHaveLength(2);

        socket().drop();
        await settle();
        expect(events.slice(-1)).toEqual(['gone']);
        expect(FakeSocket.all).toHaveLength(2);
    });

    it('says nothing of a terminal that is gone when it was closed while the daemon was being asked', async () => {
        let answer: (value: boolean) => void = () => undefined;
        const { events, socket, stream } = setup(() => new Promise<boolean>((resolve) => {
            answer = resolve;
        }));

        await settle();
        socket().drop();
        await settle();
        stream.close();
        answer(false);
        await settle();

        expect(events).toEqual(['connecting', 'reconnecting']);
        expect(FakeSocket.all).toHaveLength(1);
    });

    it('stops for good when it is closed', async () => {
        const { socket, stream } = setup();

        await settle();
        socket().open();
        socket().text({ type: 'screen', ...screen });
        stream.close();
        await settle();

        expect(socket().closed).toBe(true);
        expect(FakeSocket.all).toHaveLength(1);
        expect(stream.write('x')).toBe(false);
    });

    it('ignores a message that is not one of the protocol', async () => {
        const { events, socket } = setup();

        await settle();
        socket().open();
        socket().onmessage?.({ data: 'not json' });
        socket().text({ type: 'nonsense' });
        socket().text(null);
        expect(events).toEqual(['connecting']);
    });
});

describe('HttpTransport terminals', () => {
    const info: TerminalInfo = { id: 'trm 1', projectId: 'prj_1', folderId: 'fld_1', cwd: '/p', shell: 'zsh', cols: 80, rows: 24, state: 'running', createdAt: 1 };

    function transport(respond: (url: string, init: RequestInit | undefined) => Response) {
        const calls: Array<{ url: string; method: string; body?: string; authorization?: string }> = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string | undefined, authorization: (init?.headers as Record<string, string>).authorization });

            return respond(String(input), init);
        }) as typeof fetch;

        return { calls, transport: new HttpTransport({ url: 'http://127.0.0.1:4310/', token: 'tok', fetch: fetchImpl }) };
    }

    it('lists the terminals of a project, or of all', async () => {
        const { calls, transport: http } = transport(() => Response.json([info]));

        expect(await http.listTerminals('prj 1')).toEqual([info]);
        expect(await http.listTerminals()).toEqual([info]);
        expect(calls.map(call => call.url)).toEqual(['http://127.0.0.1:4310/v1/terminals?projectId=prj%201', 'http://127.0.0.1:4310/v1/terminals']);
        expect(calls[0].authorization).toBe('Bearer tok');
    });

    it('creates one from the request, and says why the daemon refused', async () => {
        const request = { projectId: 'prj_1', folderId: 'fld_1', cols: 80, rows: 24 };
        const ok = transport(() => Response.json(info));

        expect(await ok.transport.createTerminal(request)).toEqual(info);
        expect(ok.calls[0]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:4310/v1/terminals', body: JSON.stringify(request) });

        const refused = transport(() => Response.json({ ok: false, error: { code: 'unavailable', message: 'The folder /p is missing' } }, { status: 503 }));

        await expect(refused.transport.createTerminal(request)).rejects.toMatchObject({ message: 'The folder /p is missing', status: 503 });
    });

    it('closes one, and takes a terminal that is already gone as closed', async () => {
        const { calls, transport: http } = transport((_url, init) => (init?.method === 'DELETE' ? new Response(null, { status: 404 }) : Response.json([])));

        await expect(http.closeTerminal('trm 1')).resolves.toBeUndefined();
        expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'http://127.0.0.1:4310/v1/terminals/trm%201' });

        const failing = transport(() => new Response('', { status: 500 }));

        await expect(failing.transport.closeTerminal('x')).rejects.toMatchObject({ status: 500 });
    });

    it('opens the stream on the websocket address of the daemon, with the token it has now', async () => {
        vi.stubGlobal('WebSocket', FakeSocket);
        FakeSocket.all = [];

        try {
            const { transport: http } = transport(() => Response.json([]));

            // A daemon that was replaced is found where it is now.
            http.setAddress({ url: 'http://127.0.0.1:4311', token: 'newer' });

            const stream = http.openTerminal('trm_1', { onScreen: () => undefined, onOutput: () => undefined, onExit: () => undefined, onStatus: () => undefined, onGone: () => undefined });

            await settle();
            expect(FakeSocket.all[0].url).toBe('ws://127.0.0.1:4311/v1/terminals/trm_1/stream');
            expect(tokenFromTerminalProtocols(FakeSocket.all[0].protocols.join(', '))).toBe('newer');
            stream.close();
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
});
