import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { SSE_EVENT } from '@clowdy/protocol';

import { isAllowedOrigin, isLoopbackHost, tokenMatches } from '../src/http/guard';
import { cleanTempDirs, command, Harness, startHarness } from './helpers';

import type { ClowdyEvent } from '@clowdy/protocol';

afterAll(cleanTempDirs);

let h: Harness;

beforeEach(async () => {
    h = await startHarness();
});

afterEach(() => h.stop());

const bearer = { authorization: 'Bearer test-token' };

/** Sends hand-written HTTP, so the Host header can be anything. */
function rawRequest(port: number, host: string, path = '/v1/health'): Promise<string> {
    return new Promise((resolve, reject) => {
        let received = '';

        Bun.connect({
            hostname: '127.0.0.1',
            port,
            socket: {
                open(socket) {
                    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
                },
                data(_socket, chunk) {
                    received += chunk.toString();
                },
                close() {
                    resolve(received);
                },
                error(_socket, error) {
                    reject(error);
                },
            },
        }).catch(reject);
    });
}

describe('auth', () => {
    test('health is open and describes the daemon', async () => {
        const response = await fetch(`${h.url}/v1/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            ok: true,
            protocol: 1,
            version: '0.0.1',
            pid: process.pid,
            startedAt: h.daemon.info.startedAt,
            activeRuns: 0,
        });
    });

    test('everything else needs the bearer token', async () => {
        const paths = [
            '/v1/snapshot',
            '/v1/projects/p/snapshot',
            '/v1/events',
            '/v1/runs/r/items',
            '/v1/chats/c/items',
            '/v1/tasks/t/detail',
            '/v1/projects/p/tasks/CAR-1/detail',
            '/v1/tasks/t/comments',
            '/v1/projects/p/docs',
        ];

        for (const path of paths) {
            for (const headers of [
                {},
                { authorization: 'Bearer wrong' },
                { authorization: 'test-token' },
                { authorization: 'Basic dGVzdC10b2tlbg==' },
            ] as Record<string, string>[]) {
                const response = await fetch(`${h.url}${path}`, { headers });

                expect(response.status).toBe(401);
                expect(response.headers.get('www-authenticate')).toBe('Bearer');
            }
        }

        expect((await fetch(`${h.url}/v1/snapshot`, { headers: bearer })).status).toBe(200);
    });

    test('the root snapshot says the home folder of the person the daemon runs as, which the app shows as ~', async () => {
        const snapshot = (await (await fetch(`${h.url}/v1/snapshot`, { headers: bearer })).json()) as {
            cursor: number;
            projects: unknown[];
            home?: string;
        };

        expect(snapshot.home).toBe(homedir());
        expect(snapshot.cursor).toBe(h.store.headCursor());
    });

    test('an unauthorized command gets a CommandResult-shaped error and does nothing', async () => {
        const body = JSON.stringify(command('project.add', { name: 'Nope' }));
        const before = h.store.headCursor();
        const response = await fetch(`${h.url}/v1/commands`, {
            method: 'POST',
            body,
            headers: { authorization: 'Bearer wrong' },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            ok: false,
            requestId: '',
            error: { code: 'unauthorized', message: expect.any(String) },
        });
        expect(h.store.headCursor()).toBe(before);
    });

    test('the token comparison is exact', () => {
        expect(tokenMatches('Bearer abc', 'abc')).toBe(true);
        expect(tokenMatches('bearer abc', 'abc')).toBe(true);
        expect(tokenMatches('Bearer abcd', 'abc')).toBe(false);
        expect(tokenMatches('Bearer ab', 'abc')).toBe(false);
        expect(tokenMatches('Bearer ', 'abc')).toBe(false);
        expect(tokenMatches(null, 'abc')).toBe(false);
    });
});

describe('host guard', () => {
    test('only loopback host names are served', async () => {
        for (const host of ['127.0.0.1', `127.0.0.1:${h.daemon.info.port}`, 'localhost:3000', '[::1]:80']) {
            expect(isLoopbackHost(host)).toBe(true);
        }

        for (const host of [
            'evil.example',
            'evil.example:80',
            '127.0.0.1.evil.example',
            '192.168.1.5',
            '0.0.0.0',
            'localhost.evil.example',
            '',
        ]) {
            expect(isLoopbackHost(host)).toBe(false);
        }

        expect(isLoopbackHost(null)).toBe(false);
    });

    test('a request addressed to another name is refused, even the health check (DNS rebinding)', async () => {
        const rebound = await rawRequest(h.daemon.info.port, 'evil.example');

        expect(rebound).toStartWith('HTTP/1.1 403');
        expect(rebound).not.toContain('"protocol"');
        expect(await rawRequest(h.daemon.info.port, `localhost:${h.daemon.info.port}`)).toStartWith('HTTP/1.1 200');
    });
});

describe('CORS', () => {
    test('allowed origins', () => {
        expect(isAllowedOrigin('app://clowdy')).toBe(true);

        // No loopback page is trusted by default, only what is listed.
        for (const origin of [
            'http://127.0.0.1:5273',
            'http://localhost:5173',
            'http://localhost',
            'https://evil.example',
            'http://evil.example',
            'app://evil',
            'http://127.0.0.1.evil.example',
            'http://localhost.evil.example:80',
            'https://localhost:3000',
            'null',
            'file://',
        ]) {
            expect(isAllowedOrigin(origin)).toBe(false);
        }

        const extra = ['http://127.0.0.1:5300'];

        expect(isAllowedOrigin('http://127.0.0.1:5300', extra)).toBe(true);
        expect(isAllowedOrigin('http://127.0.0.1:5301', extra)).toBe(false);
        expect(isAllowedOrigin('app://clowdy', extra)).toBe(true);
    });

    test('a loopback page is refused unless the daemon was started with its origin, and then only that one', async () => {
        const tool = 'http://127.0.0.1:5300';

        expect((await fetch(`${h.url}/v1/snapshot`, { headers: { origin: tool, ...bearer } })).status).toBe(403);

        const listed = await startHarness({ corsOrigins: [tool] });

        try {
            const allowed = await fetch(`${listed.url}/v1/snapshot`, {
                headers: { origin: tool, authorization: 'Bearer test-token' },
            });
            const other = await fetch(`${listed.url}/v1/snapshot`, {
                headers: { origin: 'http://127.0.0.1:5301', authorization: 'Bearer test-token' },
            });

            expect(allowed.status).toBe(200);
            expect(allowed.headers.get('access-control-allow-origin')).toBe(tool);
            expect(other.status).toBe(403);
        } finally {
            await listed.stop();
        }
    });

    test('an allowed origin is echoed back; a foreign one is refused before any work', async () => {
        const allowed = await h.fetch('/v1/snapshot', { headers: { origin: 'app://clowdy' } });

        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('access-control-allow-origin')).toBe('app://clowdy');
        expect(allowed.headers.get('vary')).toBe('Origin');

        const foreign = await h.fetch('/v1/snapshot', { headers: { origin: 'https://evil.example' } });

        expect(foreign.status).toBe(403);
        expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
        expect(
            (await fetch(`${h.url}/v1/snapshot`, { headers: bearer })).headers.get('access-control-allow-origin')
        ).toBeNull();
    });

    test('preflight answers without a token and lists the headers the client needs', async () => {
        const response = await fetch(`${h.url}/v1/commands`, {
            method: 'OPTIONS',
            headers: {
                origin: 'app://clowdy',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'authorization,content-type,x-clowdy-protocol',
            },
        });

        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('app://clowdy');
        expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');

        const allowed = response.headers.get('access-control-allow-headers')!.toLowerCase();

        for (const header of [
            'authorization',
            'content-type',
            'x-clowdy-protocol',
            'last-event-id',
            'if-match',
            'if-none-match',
        ]) {
            expect(allowed).toContain(header);
        }

        const foreign = await fetch(`${h.url}/v1/commands`, {
            method: 'OPTIONS',
            headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        });

        expect(foreign.status).toBe(403);
        expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    });
});

describe('protocol header', () => {
    test('the same major passes, another major is refused, none is fine', async () => {
        expect((await h.fetch('/v1/snapshot', { headers: { 'x-clowdy-protocol': '1' } })).status).toBe(200);
        expect((await h.fetch('/v1/snapshot', { headers: { 'x-clowdy-protocol': '1.4' } })).status).toBe(200);

        const refused = await h.fetch('/v1/snapshot', { headers: { 'x-clowdy-protocol': '2' } });

        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({
            ok: false,
            error: { code: 'invalid', details: { supported: 1 } },
        });
        expect((await h.fetch('/v1/snapshot', { headers: { 'x-clowdy-protocol': 'abc' } })).status).toBe(400);
    });
});

describe('commands endpoint', () => {
    const post = (body: string) =>
        h.fetch('/v1/commands', { method: 'POST', body, headers: { 'content-type': 'application/json' } });

    test('replays a lost first-message response without making another chat or message', async () => {
        const project = h.openRepo();
        const create = JSON.stringify({ type: 'chat.create', requestId: 'lost-create-1', projectId: project.id });
        await post(create); // The client did not receive the response.
        const created = (await (await post(create)).json()) as { ok: boolean; data: { chat: { id: string } } };
        expect(created.ok).toBe(true);
        const send = JSON.stringify({
            type: 'chat.send',
            requestId: 'lost-send-1',
            chatId: created.data.chat.id,
            text: 'Only once',
        });
        const first = await (await post(send)).json();
        const replay = await (await post(send)).json();
        expect(replay).toEqual(first);
        expect(
            (h.store.db.query('SELECT COUNT(*) AS n FROM chats WHERE project_id = ?').get(project.id) as { n: number })
                .n
        ).toBe(1);
        const items = h.store.db.query('SELECT body FROM stream_items').all() as { body: string }[];
        expect(items.filter(item => item.body.includes('Only once'))).toHaveLength(1);
    });

    test('answers a CommandResult for success and for caller errors, with matching statuses', async () => {
        const { path } = { path: h.openRepo().path };
        const ok = await post(JSON.stringify({ requestId: 'req-http-open-1', type: 'project.add', folders: [path] }));

        expect(ok.status).toBe(200);
        expect(await ok.json()).toMatchObject({
            ok: true,
            requestId: 'req-http-open-1',
            data: { project: { folders: [{ path }] }, existing: true },
        });

        const missing = await post(
            JSON.stringify({ requestId: 'req-http-chat-1', type: 'chat.create', projectId: 'prj_nope' })
        );

        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({
            ok: false,
            requestId: 'req-http-chat-1',
            error: { code: 'not_found' },
        });
    });

    test('malformed bodies and unknown commands are invalid, carrying the request id when there is one', async () => {
        const notJson = await post('{nope');

        expect(notJson.status).toBe(400);
        expect(await notJson.json()).toMatchObject({ ok: false, requestId: '', error: { code: 'invalid' } });

        const unknown = await post(JSON.stringify({ requestId: 'req-http-bad-1', type: 'nope' }));

        expect(unknown.status).toBe(400);
        expect(await unknown.json()).toMatchObject({
            ok: false,
            requestId: 'req-http-bad-1',
            error: { code: 'invalid' },
        });

        const shortId = await post(JSON.stringify({ requestId: 'x', type: 'chat.rename', chatId: 'c', title: 't' }));

        expect(shortId.status).toBe(400);
    });

    test('unknown routes are 404, wrong methods 405, malformed escapes 400', async () => {
        expect((await h.fetch('/v1/nope')).status).toBe(404);
        expect((await h.fetch('/v1/runs/%E0%A4%A/items')).status).toBe(400);
        expect((await h.fetch('/v1/commands')).status).toBe(405);
        expect((await h.fetch('/v1/snapshot', { method: 'POST' })).status).toBe(405);
    });
});

describe('items endpoints', () => {
    test('run and chat items come in seq order and honour ?after', async () => {
        const { id } = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: id });

        expect(await (await h.fetch(`/v1/chats/${chat.id}/items`)).json()).toEqual([]);

        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Build a thing' });

        await Bun.sleep(150);

        const items = (await (await h.fetch(`/v1/runs/${runId}/items`)).json()) as { seq: number; body: unknown }[];

        expect(items.map(item => item.seq)).toEqual(items.map((_, index) => index + 1));
        expect(items[0].body).toEqual({ kind: 'user', text: 'Build a thing' });
        expect(await (await h.fetch(`/v1/chats/${chat.id}/items`)).json()).toEqual(items);
        expect(await (await h.fetch(`/v1/runs/${runId}/items?after=${items.length - 1}`)).json()).toEqual(
            items.slice(-1)
        );
        expect((await h.fetch(`/v1/runs/${runId}/items?after=-1`)).status).toBe(400);
        expect((await h.fetch('/v1/runs/run_nope/items')).status).toBe(404);
        expect((await h.fetch('/v1/chats/cht_nope/items')).status).toBe(404);
    });
});

interface Frame {
    id: string;
    event: string;
    data: ClowdyEvent;
}

/** Reads SSE frames from a response until `count` events arrived (or the stream ends). */
async function readFrames(
    response: Response,
    count: number,
    timeoutMs = 3000
): Promise<{ frames: Frame[]; raw: string }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Frame[] = [];
    let raw = '';
    const deadline = Date.now() + timeoutMs;

    while (frames.length < count && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)]);

        if (!chunk || chunk.done) {
            break;
        }

        raw += decoder.decode(chunk.value, { stream: true });

        frames.length = 0;

        for (const block of raw.split('\n\n')) {
            const id = /^id: (.*)$/m.exec(block)?.[1];
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];

            if (id && event && data) {
                frames.push({ id, event, data: JSON.parse(data) });
            }
        }
    }

    await reader.cancel();

    return { frames, raw };
}

describe('event stream', () => {
    // The log is not empty at start: the daemon made the personal space, and that event has the first cursor.
    const seed = () => {
        const { id } = h.openRepo();

        h.ok('chat.create', { projectId: id, title: 'one' });
        h.ok('chat.create', { projectId: id, title: 'two' });

        return id;
    };

    test('replays from a cursor, then goes live; ids are cursors and the frame name is clowdy', async () => {
        const start = h.store.headCursor();
        const projectId = seed();

        // After the event of opening the project: the two chats come first, the live one after them.
        const abort = new AbortController();
        const response = await h.fetch(`/v1/events?cursor=${start + 1}`, { signal: abort.signal });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        const pending = readFrames(response, 3);

        await Bun.sleep(30);
        h.ok('chat.create', { projectId, title: 'live' });

        const { frames } = await pending;

        expect(frames.map(frame => frame.id)).toEqual([start + 2, start + 3, start + 4].map(String));
        expect(frames.every(frame => frame.event === SSE_EVENT)).toBe(true);
        expect(frames.map(frame => frame.data.cursor)).toEqual([start + 2, start + 3, start + 4]);
        expect(frames[2].data.data).toMatchObject({ type: 'chat.upserted', chat: { title: 'live' } });
    });

    test('the stream carries CORS headers for an allowed origin', async () => {
        const response = await h.fetch('/v1/events', { headers: { origin: 'app://clowdy' } });

        expect(response.headers.get('access-control-allow-origin')).toBe('app://clowdy');
        await response.body!.cancel();
    });

    test('Last-Event-ID resumes without gaps or repeats', async () => {
        const start = h.store.headCursor();
        const projectId = seed();

        const first = await readFrames(await h.fetch(`/v1/events?cursor=${start}`), 2);
        const lastId = first.frames[1].id;

        h.ok('chat.create', { projectId, title: 'after the drop' });

        const resumed = await readFrames(await h.fetch('/v1/events', { headers: { 'last-event-id': lastId } }), 2);

        expect(lastId).toBe(String(start + 2));
        expect(resumed.frames.map(frame => frame.id)).toEqual([start + 3, start + 4].map(String));
    });

    test('without a cursor only new events arrive', async () => {
        const projectId = seed();
        const head = h.store.headCursor();

        const pending = readFrames(await h.fetch('/v1/events'), 1);

        await Bun.sleep(30);
        h.ok('chat.create', { projectId, title: 'new' });

        expect((await pending).frames.map(frame => frame.id)).toEqual([String(head + 1)]);
    });

    test('a cursor ahead of the log is 410 with a JSON body; a bad one is 400', async () => {
        seed();

        const gone = await h.fetch('/v1/events?cursor=999');

        expect(gone.status).toBe(410);
        expect(await gone.json()).toMatchObject({
            ok: false,
            error: { code: 'invalid', details: { cursor: 999, head: h.store.headCursor() } },
        });
        expect((await h.fetch('/v1/events', { headers: { 'last-event-id': '999' } })).status).toBe(410);
        expect((await h.fetch('/v1/events?cursor=abc')).status).toBe(400);
        expect((await h.fetch('/v1/events?cursor=-1')).status).toBe(400);
    });

    test('the projectId filter hides other projects', async () => {
        const mine = seed();
        const other = h.openRepo('other');

        h.ok('chat.create', { projectId: other.id });
        h.ok('chat.create', { projectId: mine, title: 'three' });

        const { frames } = await readFrames(await h.fetch(`/v1/events?cursor=0&projectId=${other.id}`), 2, 600);

        expect(frames.map(frame => frame.data.projectId)).toEqual([other.id, other.id]);
    });

    test('an idle stream gets heartbeat comments', async () => {
        await h.stop();
        h = await startHarness({}, { heartbeatMs: 40 });

        const response = await h.fetch('/v1/events');
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let raw = '';

        while (!raw.includes(': heartbeat\n\n')) {
            const chunk = await reader.read();

            raw += decoder.decode(chunk.value);
        }

        await reader.cancel();
        expect(raw).toContain('retry: 2000');
    });

    test('a closed connection stops the stream and releases its subscription', async () => {
        const subscribers = () => (h.store as unknown as { listeners: Set<unknown> }).listeners.size;
        const before = subscribers();
        const response = await h.fetch('/v1/events');
        const reader = response.body!.getReader();

        await reader.read();
        await Bun.sleep(30);
        expect(subscribers()).toBe(before + 1);
        await reader.cancel();
        await Bun.sleep(50);
        expect(subscribers()).toBe(before);
    });
});
