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

/**
 * Starts `<program> app-server` (JSON-RPC, one message per line on standard input and output), lets `run` talk to it, and
 * stops it. The whole conversation has one deadline. Rejects with what failed, with the end of the program's stderr when
 * that helps. Used for reads only: the program does its own authentication, so nothing here touches a token.
 */
export async function withAppServer<T>(context: ProbeContext, run: (rpc: Rpc) => Promise<T>, timeoutMs: number): Promise<T> {
    const proc = await spawnInOwnGroup({ command: context.program, args: ['app-server'], cwd: context.cwd, env: context.env });
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let closed = false;
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

    proc.child.stdin?.on('error', () => undefined);

    createInterface({ input: proc.child.stdout! }).on('line', (line) => {
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };

        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }

        // Notifications and requests of the server carry no result of ours.
        if (typeof message.id !== 'number' || !pending.has(message.id)) {
            return;
        }

        const waiting = pending.get(message.id)!;

        pending.delete(message.id);

        if (message.error) {
            waiting.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'the program answered with an error'));
        }
        else {
            waiting.resolve(message.result);
        }
    });
    void proc.exited.then(() => {
        closed = true;
        failAll(new Error(`the program ended before it answered${ tail() }`));
    });

    const write = (payload: object) => {
        if (!closed) {
            proc.child.stdin?.write(`${ JSON.stringify({ jsonrpc: '2.0', ...payload }) }\n`);
        }
    };
    const rpc: Rpc = {
        call: (method, params) => new Promise((resolve, reject) => {
            const id = nextId++;

            pending.set(id, { resolve, reject });
            write({ id, method, ...(params !== undefined && { params }) });
        }),
        notify: (method, params) => write({ method, ...(params !== undefined && { params }) }),
    };

    try {
        return await Promise.race([
            run(rpc),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`no answer in ${ Math.round(timeoutMs / 1000) } s${ tail() }`)), timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
        failAll(new Error('stopped'));
        proc.stop();
        await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, 3000).unref())]);
    }
}
