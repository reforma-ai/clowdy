import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { HttpTransport, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from './httpTransport';
import { TransportError, type FeedStatus } from './transport';

import type { ClowdyEvent } from '@clowdy/protocol';

type FetchCall = { url: string; init: RequestInit };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers from a script, one entry per call, and records the calls. Past the script it never answers. */
function scriptedFetch(script: Array<Response | Error | ((call: FetchCall) => Response)>) {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = { url: String(input), init };
        const next = script[calls.length];

        calls.push(call);

        if (next === undefined) return new Promise<Response>(() => undefined);

        if (next instanceof Error) throw next;

        return typeof next === 'function' ? next(call) : next;
    }) as typeof fetch;

    return { fetchImpl, calls };
}

const eventFrame = (cursor: number) => {
    const event: ClowdyEvent = { cursor, at: 0, projectId: 'p', data: { type: 'notice', level: 'info', text: `n${ cursor }` } };

    return `event: clowdy\nid: ${ cursor }\ndata: ${ JSON.stringify(event) }\n\n`;
};

/** An event stream that delivers `chunks` and then closes, like a connection the server dropped. */
function sseResponse(chunks: string[], status = 200) {
    const encoder = new TextEncoder();

    return new Response(new ReadableStream({
        start(controller) {
            chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
            controller.close();
        },
    }), { status, headers: { 'content-type': 'text/event-stream' } });
}

const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe('HttpTransport requests', () => {
    it('sends the bearer token and the protocol version, and reads JSON', async () => {
        const { fetchImpl, calls } = scriptedFetch([json({ cursor: 3, projects: [] })]);
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310/', token: 'secret', fetch: fetchImpl });

        expect(await transport.getRootSnapshot()).toEqual({ cursor: 3, projects: [] });
        expect(calls[0].url).toBe('http://127.0.0.1:4310/v1/snapshot');
        expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer secret', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });
    });

    it('builds the routes for items, a chat, a task and documents', async () => {
        const { fetchImpl, calls } = scriptedFetch(Array.from({ length: 6 }, () => json([])));
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl });

        await transport.getItems({ runId: 'r 1' }, 12);
        await transport.getItems({ chatId: 'c1' });
        await transport.getTaskDetail('t1');
        await transport.getDocsTree('p1');
        await transport.getDocFile('p1', 'decisions/a b.md');
        await transport.getProjectSnapshot('p/1');

        expect(calls.map(call => call.url)).toEqual([
            'http://d/v1/runs/r%201/items?after=12',
            'http://d/v1/chats/c1/items?after=0',
            'http://d/v1/tasks/t1/detail',
            'http://d/v1/projects/p1/docs',
            'http://d/v1/projects/p1/docs/file?path=decisions%2Fa%20b.md',
            'http://d/v1/projects/p%2F1/snapshot',
        ]);
    });

    it('throws a TransportError with the status when the daemon refuses', async () => {
        const { fetchImpl } = scriptedFetch([json({ error: 'nope' }, 401)]);
        const transport = new HttpTransport({ url: 'http://d', token: 'bad', fetch: fetchImpl });

        await expect(transport.getRootSnapshot()).rejects.toMatchObject({ name: 'TransportError', status: 401 });
    });
});

describe('HttpTransport commands', () => {
    const rename = { type: 'chat.rename', chatId: 'c1', title: 'x' } as const;

    it('posts the command with a request id', async () => {
        const { fetchImpl, calls } = scriptedFetch([(call) => json({ ok: true, requestId: JSON.parse(String(call.init.body)).requestId, data: {} })]);
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl, sleep: async () => undefined });
        const result = await transport.command(rename);
        const body = JSON.parse(String(calls[0].init.body));

        expect(calls[0].init.method).toBe('POST');
        expect(body).toMatchObject({ type: 'chat.rename', chatId: 'c1', title: 'x' });
        expect(body.requestId.length).toBeGreaterThanOrEqual(8);
        expect(result).toMatchObject({ ok: true, requestId: body.requestId });
    });

    it('keeps the request id across retries after a dropped connection, so the daemon acts once', async () => {
        const { fetchImpl, calls } = scriptedFetch([new TypeError('fetch failed'), new TypeError('fetch failed'), (call) => json({ ok: true, requestId: JSON.parse(String(call.init.body)).requestId, data: {} })]);
        const sleeps: number[] = [];
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl, sleep: async ms => void sleeps.push(ms) });

        const result = await transport.command(rename);
        const ids = calls.map(call => JSON.parse(String(call.init.body)).requestId);

        expect(result.ok).toBe(true);
        expect(new Set(ids).size).toBe(1);
        expect(calls).toHaveLength(3);
        expect(sleeps).toEqual([500, 1000]);
    });

    it('uses a new request id for a new command', async () => {
        const answer = (call: FetchCall) => json({ ok: true, requestId: JSON.parse(String(call.init.body)).requestId, data: {} });
        const { fetchImpl, calls } = scriptedFetch([answer, answer]);
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl });

        await transport.command(rename);
        await transport.command(rename);

        expect(new Set(calls.map(call => JSON.parse(String(call.init.body)).requestId)).size).toBe(2);
    });

    it('returns a refusal as a result and does not retry it', async () => {
        const refusal = { ok: false, requestId: 'x', error: { code: 'conflict', message: 'The file changed on disk' } };
        const { fetchImpl, calls } = scriptedFetch([json(refusal, 409)]);
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl });

        expect(await transport.command(rename)).toEqual(refusal);
        expect(calls).toHaveLength(1);
    });

    it('gives up after three attempts when the daemon stays unreachable, and when it answers something else', async () => {
        const down = scriptedFetch([new TypeError('a'), new TypeError('b'), new TypeError('c')]);
        const html = scriptedFetch([new Response('<html>bad gateway</html>', { status: 502 }), new Response('bad', { status: 502 }), new Response('bad', { status: 502 })]);
        const sleep = async () => undefined;

        await expect(new HttpTransport({ url: 'http://d', token: 't', fetch: down.fetchImpl, sleep }).command(rename)).rejects.toThrow('c');
        await expect(new HttpTransport({ url: 'http://d', token: 't', fetch: html.fetchImpl, sleep }).command(rename)).rejects.toBeInstanceOf(TransportError);
        expect(down.calls).toHaveLength(3);
        expect(html.calls).toHaveLength(3);
    });
});

describe('HttpTransport event feed', () => {
    it('delivers events from the stream, however the chunks are cut, and reports the connection', async () => {
        const frame = eventFrame(11);
        const { fetchImpl, calls } = scriptedFetch([sseResponse([frame.slice(0, 20), frame.slice(20), eventFrame(12)])]);
        const events: number[] = [];
        const statuses: FeedStatus[] = [];
        const transport = new HttpTransport({ url: 'http://d', token: 'tok', fetch: fetchImpl, sleep: () => new Promise(() => undefined) });
        const stop = transport.subscribe(10, event => events.push(event.cursor), status => statuses.push(status));

        await settled();
        stop();

        expect(events).toEqual([11, 12]);
        expect(statuses).toEqual(['connected', 'reconnecting']);
        expect(calls[0].url).toBe('http://d/v1/events?cursor=10');
        expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer tok', accept: 'text/event-stream' });
    });

    it('reconnects after a drop and resumes from the last cursor it saw, backing off up to the cap', async () => {
        const failures = Array.from({ length: 6 }, () => new TypeError('network down'));
        const { fetchImpl, calls } = scriptedFetch([sseResponse([eventFrame(21)]), ...failures, sseResponse([eventFrame(22)])]);
        const sleeps: number[] = [];
        const events: number[] = [];
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl, sleep: async ms => void sleeps.push(ms) });
        const stop = transport.subscribe(20, event => events.push(event.cursor), () => undefined);

        await settled();
        stop();

        expect(events).toEqual([21, 22]);
        // Every attempt after the first event asks for the events after it; the last one, after 22.
        expect(calls.map(call => new URL(call.url).searchParams.get('cursor'))).toEqual(['20', ...Array(7).fill('21'), '22']);
        // 0.5 s, doubling up to the cap, and back to 0.5 s once a connection held.
        expect(sleeps).toEqual([RECONNECT_MIN_MS, 1000, 2000, 4000, 8000, RECONNECT_MAX_MS, RECONNECT_MAX_MS, RECONNECT_MIN_MS]);
    });

    it('starts the backoff over once a connection holds', async () => {
        const { fetchImpl } = scriptedFetch([new TypeError('down'), new TypeError('down'), sseResponse([eventFrame(1)]), new TypeError('down'), new TypeError('down')]);
        const sleeps: number[] = [];
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl, sleep: async ms => void sleeps.push(ms) });
        const stop = transport.subscribe(0, () => undefined, () => undefined);

        await settled();
        stop();

        expect(sleeps.slice(0, 5)).toEqual([500, 1000, 500, 1000, 2000]);
    });

    it('asks for a full resync, and stops, when the daemon answers 410', async () => {
        const { fetchImpl, calls } = scriptedFetch([new Response(null, { status: 410 })]);
        const statuses: FeedStatus[] = [];
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl, sleep: async () => undefined });

        transport.subscribe(5, () => undefined, status => statuses.push(status));
        await settled();

        expect(statuses).toEqual(['resync']);
        expect(calls).toHaveLength(1);
    });

    it('stops without a further request once unsubscribed', async () => {
        const { fetchImpl, calls } = scriptedFetch([new TypeError('down'), sseResponse([])]);
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl, sleep: () => new Promise(resolve => setTimeout(resolve, 20)) });
        const stop = transport.subscribe(0, () => undefined, () => undefined);

        await settled();
        stop();
        await new Promise(resolve => setTimeout(resolve, 60));

        expect(calls).toHaveLength(1);
    });
});
