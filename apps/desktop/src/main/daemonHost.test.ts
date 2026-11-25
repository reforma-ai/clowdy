import { createServer, type IncomingHttpHeaders } from 'node:http';
import { PROTOCOL_HEADER, ROUTES } from '@clowdy/protocol';
import { expect, test } from 'vitest';

import { nodeHost } from './daemonHost';

test("stop names the daemon's own protocol, so a daemon an update left behind still accepts it", async () => {
    const requests: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => {
        requests.push({ url: request.url, headers: request.headers });
        response.end('{}');
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const { port } = server.address() as { port: number };

        expect(await nodeHost.stop({ pid: 1, port, token: 'secret', protocol: 7, startedAt: 0 })).toBe(true);

        expect(requests).toEqual([expect.objectContaining({ url: `${ROUTES.shutdown}?ifGitIdle=1` })]);
        expect(requests[0]!.headers[PROTOCOL_HEADER]).toBe('7');
        expect(requests[0]!.headers.authorization).toBe('Bearer secret');
    } finally {
        server.close();
    }
});

test('a busy Git operation refuses the restart without stopping the daemon', async () => {
    const server = createServer((_request, response) => {
        response.statusCode = 409;
        response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
        const { port } = server.address() as { port: number };
        expect(await nodeHost.stop({ pid: 1, port, token: 'secret', protocol: 1, startedAt: 0 })).toBe(false);
    } finally {
        server.close();
    }
});
