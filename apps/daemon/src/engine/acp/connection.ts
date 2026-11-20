import type { AgentProcess } from '../process';
import type { LayerHost } from './layer';

/**
 * How long a program may take to answer `initialize`. A command that is not an ACP agent never does, and the first start
 * of an adapter fetched with `bun x` can be slow, so the bound is generous.
 */
const INITIALIZE_TIMEOUT_MS = 120_000;

/** An unbounded queue read with `await next()`. */
export class Channel<T> {
    private items: T[] = [];
    private waiting?: (item: T) => void;

    push(item: T): void {
        if (this.waiting) {
            const resolve = this.waiting;

            this.waiting = undefined;
            resolve(item);
        }
        else {
            this.items.push(item);
        }
    }

    next(): Promise<T> {
        const item = this.items.shift();

        return item !== undefined ? Promise.resolve(item) : new Promise<T>((resolve) => {
            this.waiting = resolve;
        });
    }
}

/** The process went away while the session still needed it. */
export class ProcessEnded extends Error {}

/**
 * Something that rejects when the process goes away or the turn's signal is aborted, to race against requests that would wait forever. Either also
 * calls `wake`, so the loop that waits for the agent's next word ends at once. Gives back the race: `request(call)` settles with `call`, or fails
 * with `ProcessEnded` or the abort's reason.
 */
export function watchEnd(proc: AgentProcess, signal: AbortSignal, wake: (ending: 'exited' | 'aborted') => void): <T>(call: Promise<T>) => Promise<T> {
    const gone = new Promise<never>((_, reject) => {
        void proc.exited.then(() => {
            wake('exited');
            reject(new ProcessEnded());
        });
        signal.addEventListener('abort', () => {
            wake('aborted');
            reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
    });

    gone.catch(() => undefined);

    return call => Promise.race([call, gone]);
}

/**
 * Waits for the agent's answer to `initialize`, at most `initializeTimeoutMs`; the program's own words (the end of its stderr) go into the failure. A program
 * that stays silent is no ACP agent or too slow to start, not one that refused a protocol, so the timeout is a plain error that no layer takes for a refusal.
 */
export function answeredInTime<T>(call: Promise<T>, { agent, proc, deps }: Pick<LayerHost, 'agent' | 'proc' | 'deps'>): Promise<T> {
    const ms = deps.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const tail = proc.stderr().trim().slice(-500);

            reject(new Error(`${ agent.name } did not answer the ACP handshake in ${ Math.max(1, Math.round(ms / 1000)) } s. Check that the command speaks ACP.${ tail ? ` Last output: ${ tail }` : '' }`));
        }, ms);
    });

    silent.catch(() => undefined);

    return Promise.race([call, silent]).finally(() => clearTimeout(timer));
}
