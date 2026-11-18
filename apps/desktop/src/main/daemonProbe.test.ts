import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { parseDaemonInfo, parseHealth, probeHealth } from './daemonProbe';

const info = { pid: 4242, port: 51000, token: 'secret', protocol: 1, startedAt: 1_700_000_000_000 };
const health = { ok: true, protocol: 1, version: '0.0.1', pid: 4242, startedAt: 1_700_000_000_000 };

describe('parseDaemonInfo', () => {
    test('accepts what the daemon writes', () => {
        expect(parseDaemonInfo(JSON.stringify(info, null, 4))).toEqual(info);
    });

    test('keeps only the known fields', () => {
        expect(parseDaemonInfo(JSON.stringify({ ...info, extra: 1 }))).toEqual(info);
    });

    test.each([
        ['empty text', ''],
        ['broken JSON', '{"pid": 1'],
        ['a JSON array', '[]'],
        ['null', 'null'],
        ['a missing token', JSON.stringify({ ...info, token: undefined })],
        ['an empty token', JSON.stringify({ ...info, token: '' })],
        ['a pid that is not a number', JSON.stringify({ ...info, pid: '4242' })],
        ['a pid of zero', JSON.stringify({ ...info, pid: 0 })],
        ['a port out of range', JSON.stringify({ ...info, port: 70_000 })],
        ['a fractional port', JSON.stringify({ ...info, port: 80.5 })],
        ['a missing protocol', JSON.stringify({ ...info, protocol: undefined })],
        ['a missing start time', JSON.stringify({ ...info, startedAt: undefined })],
    ])('rejects %s', (_name, text) => {
        expect(parseDaemonInfo(text)).toBeUndefined();
    });
});

describe('parseHealth', () => {
    test('accepts the daemon health answer', () => {
        expect(parseHealth(JSON.stringify(health))).toEqual(health);
    });

    test('keeps the count of active runs, which a restart must not ignore, and drops one that is not a count', () => {
        expect(parseHealth(JSON.stringify({ ...health, activeRuns: 3 }))).toEqual({ ...health, activeRuns: 3 });
        expect(parseHealth(JSON.stringify({ ...health, activeRuns: 0 }))).toEqual({ ...health, activeRuns: 0 });
        expect(parseHealth(JSON.stringify({ ...health, activeRuns: -1 }))).toEqual(health);
        expect(parseHealth(JSON.stringify({ ...health, activeRuns: 'many' }))).toEqual(health);
    });

    test.each([
        ['not JSON', '<html>'],
        ['ok false', JSON.stringify({ ...health, ok: false })],
        ['another service answering', JSON.stringify({ status: 'up' })],
        ['a missing pid', JSON.stringify({ ...health, pid: undefined })],
        ['a missing version', JSON.stringify({ ...health, version: undefined })],
    ])('rejects %s', (_name, text) => {
        expect(parseHealth(text)).toBeUndefined();
    });
});

describe('probeHealth', () => {
    const servers: Server[] = [];

    /** A fake daemon on a free loopback port; `answer` decides the response. */
    async function fakeDaemon(answer: Parameters<typeof createServer>[1]): Promise<number> {
        const server = createServer(answer);

        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

        return (server.address() as { port: number }).port;
    }

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
            server.closeAllConnections();
            server.close(resolve);
        })));
    });

    test('reads the health of a daemon, asking /v1/health without credentials', async () => {
        const seen: { url?: string; authorization?: string; protocol?: string } = {};
        const port = await fakeDaemon((request, response) => {
            seen.url = request.url;
            seen.authorization = request.headers.authorization;
            seen.protocol = request.headers['x-clowdy-protocol'] as string | undefined;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(health));
        });

        expect(await probeHealth(port, 1000)).toEqual(health);
        expect(seen).toEqual({ url: '/v1/health' });
    });

    test('ignores proxies from the environment', async () => {
        const port = await fakeDaemon((_request, response) => response.end(JSON.stringify(health)));

        vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:9');
        vi.stubEnv('http_proxy', 'http://127.0.0.1:9');
        vi.stubEnv('NODE_USE_ENV_PROXY', '1');

        expect(await probeHealth(port, 1000)).toEqual(health);
    });

    test('gives up on a status other than 200, on other content, and on an oversized body', async () => {
        const unauthorized = await fakeDaemon((_request, response) => {
            response.statusCode = 401;
            response.end(JSON.stringify(health));
        });
        const other = await fakeDaemon((_request, response) => response.end('<html>hello</html>'));
        const huge = await fakeDaemon((_request, response) => response.end(JSON.stringify({ ...health, padding: 'x'.repeat(100_000) })));

        expect(await probeHealth(unauthorized, 1000)).toBeUndefined();
        expect(await probeHealth(other, 1000)).toBeUndefined();
        expect(await probeHealth(huge, 1000)).toBeUndefined();
    });

    test('gives up on a daemon that does not answer in time', async () => {
        const port = await fakeDaemon(() => undefined);
        const started = Date.now();

        expect(await probeHealth(port, 150)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test('finds nothing on a port nobody listens on', async () => {
        const port = await fakeDaemon(() => undefined);

        await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));

        expect(await probeHealth(port, 500)).toBeUndefined();
    });
});
