import { ROUTES, type DaemonInfo, type Health } from '@clowdy/protocol';
import { request } from 'node:http';

const MAX_HEALTH_BYTES = 4096;

function parseJson(text: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(text);

        return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    }
    catch {
        return undefined;
    }
}

const isPid = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** The contents of a `daemon.json`, or `undefined` when the text is not what the daemon writes. */
export function parseDaemonInfo(text: string): DaemonInfo | undefined {
    const raw = parseJson(text);

    if (!raw) return undefined;

    const { pid, port, token, protocol, startedAt } = raw;

    if (!isPid(pid) || !isPort(port) || typeof token !== 'string' || token === '' || !isCount(protocol) || !isCount(startedAt)) {
        return undefined;
    }

    return { pid, port, token, protocol, startedAt };
}

/** An answer of `GET /v1/health`, or `undefined` when something else answered. */
export function parseHealth(text: string): Health | undefined {
    const raw = parseJson(text);

    if (!raw) return undefined;

    const { ok, protocol, version, pid, startedAt, activeRuns } = raw;

    if (ok !== true || !isCount(protocol) || typeof version !== 'string' || !isPid(pid) || !isCount(startedAt)) {
        return undefined;
    }

    return { ok, protocol, version, pid, startedAt, ...isCount(activeRuns) && { activeRuns } };
}

/**
 * Asks the daemon on a loopback port for its health. Plain `node:http` to 127.0.0.1, so no proxy of the
 * system or the environment is involved. Resolves `undefined` on any failure, including the timeout.
 * The protocol header is left out on purpose: a daemon of another major still answers, and the caller compares.
 */
export function probeHealth(port: number, timeoutMs: number): Promise<Health | undefined> {
    return new Promise(resolve => {
        const req = request({
            host: '127.0.0.1',
            port,
            path: ROUTES.health,
            agent: false,
            signal: AbortSignal.timeout(timeoutMs),
        }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                resolve(undefined);

                return;
            }

            let body = '';

            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;

                if (body.length > MAX_HEALTH_BYTES) req.destroy();
            });
            response.on('end', () => resolve(parseHealth(body)));
            // After a normal 'end' the promise is settled already; this covers a response cut off in flight.
            response.on('close', () => resolve(undefined));
        });

        req.on('error', () => resolve(undefined));
        req.end();
    });
}
