import { createInterface } from 'node:readline';

import { spawnInOwnGroup } from '../engine/process';

import type { ProbeContext } from './types';

/** A call on a started `codex app-server`: a request that answers with its result, and the one-way `initialized`. */
export interface Rpc {
    call(method: string, params?: unknown): Promise<unknown>;
    notify(method: string, params?: unknown): void;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

/** The program refused a call: its message and, when it sent one, its JSON-RPC code (ACP's `-32000` is "authentication required"). */
export class RpcError extends Error {
    constructor(message: string, readonly code?: number) {
        super(message);
    }
}

/** The conversation's deadline passed with no answer. */
export class RpcTimeout extends Error {}

/** JSON-RPC's "method not found", the answer to a request of the program that Clowdy does not serve. */
const METHOD_NOT_FOUND = -32601;

/**
 * Starts `<program> app-server` (or the program with `args`, as Cursor's `acp`: JSON-RPC, one message per line on standard input and output), lets `run` talk to it, and
 * stops it. The whole conversation has one deadline. Rejects with what failed, with the end of the program's stderr when
 * that helps. Used for reads only: the program does its own authentication, so nothing here touches a token.
 */
export async function withAppServer<T>(context: ProbeContext, run: (rpc: Rpc) => Promise<T>, timeoutMs: number, args: string[] = ['app-server']): Promise<T> {
    if (context.signal?.aborted) {
        throw new Error('stopped');
    }

    const proc = await spawnInOwnGroup({ command: context.program, args, cwd: context.cwd, env: context.env });
    const pending = new Map<number, Pending>();
    let nextId = 1;
    /** Set when the program ended: nothing it was asked after that will ever be answered. */
    let ended: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failAll = (error: Error) => {
        for (const waiting of pending.values()) {
            waiting.reject(error);
        }

        pending.clear();
    };
    const tail = () => {
        const text = proc.stderr().trim().slice(-300);

        return text ? ` (it wrote: ${ text })` : '';
    };

    const write = (payload: object) => {
        if (!ended) {
            proc.child.stdin?.write(`${ JSON.stringify({ jsonrpc: '2.0', ...payload }) }\n`);
        }
    };

    proc.child.stdin?.on('error', () => undefined);

    createInterface({ input: proc.child.stdout! }).on('line', (line) => {
        let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } };

        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }

        // A request or notification of the program, whatever its id: it may reuse the id of a call of ours, and it is not the answer to it. A request
        // is refused (a program that waits for the reply, a permission or a login for one, goes on), a notification is not ours to answer.
        if (typeof message.method === 'string') {
            if (typeof message.id === 'number' || typeof message.id === 'string') {
                write({ id: message.id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } });
            }

            return;
        }

        if (typeof message.id !== 'number' || !pending.has(message.id)) {
            return;
        }

        const waiting = pending.get(message.id)!;

        pending.delete(message.id);

        if (message.error) {
            waiting.reject(new RpcError(typeof message.error.message === 'string' ? message.error.message : 'the program answered with an error', typeof message.error.code === 'number' ? message.error.code : undefined));
        }
        else {
            waiting.resolve(message.result);
        }
    });
    void proc.exited.then(() => {
        ended = new Error(`the program ended before it answered${ tail() }`);
        failAll(ended);
    });
    const rpc: Rpc = {
        call: (method, params) => new Promise((resolve, reject) => {
            // Asked after the program ended, a call would wait for the deadline for an answer that cannot come.
            if (ended) {
                reject(ended);

                return;
            }

            const id = nextId++;

            pending.set(id, { resolve, reject });
            write({ id, method, ...(params !== undefined && { params }) });
        }),
        notify: (method, params) => write({ method, ...(params !== undefined && { params }) }),
    };

    const onAbort = () => proc.stop();

    // The daemon stopping ends the program, which fails every call that waits for it.
    context.signal?.addEventListener('abort', onAbort, { once: true });

    if (context.signal?.aborted) {
        onAbort();
    }

    try {
        return await Promise.race([
            run(rpc),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new RpcTimeout(`no answer in ${ Math.round(timeoutMs / 1000) } s${ tail() }`)), timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        failAll(new Error('stopped'));
        proc.stop();
        await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, 3000).unref())]);
    }
}
