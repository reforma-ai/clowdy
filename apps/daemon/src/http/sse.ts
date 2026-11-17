import { SSE_EVENT } from '@clowdy/protocol';

import type { ClowdyEvent } from '@clowdy/protocol';
import type { Store } from '../store';

const HEARTBEAT_MS = 15_000;
const BATCH = 200;

const encoder = new TextEncoder();

export const frame = (event: ClowdyEvent) => encoder.encode(`id: ${ event.cursor }\nevent: ${ SSE_EVENT }\ndata: ${ JSON.stringify(event) }\n\n`);

/** Resolves true when a transaction commits, false after `ms`, and true at once if `signal` aborts. */
function nextCommit(store: Store, ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        const finish = (woken: boolean) => {
            clearTimeout(timer);
            unsubscribe();
            signal.removeEventListener('abort', onAbort);
            resolve(woken);
        };
        const onAbort = () => finish(true);
        const timer = setTimeout(() => finish(false), ms);
        const unsubscribe = store.subscribe(() => finish(true));

        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * The event stream from `cursor` on: the stored events first, then live ones as they commit. The consumer's pace
 * sets the pace (`pull`), a comment line goes out every 15 s so idle connections stay open.
 */
export function eventStream(store: Store, cursor: number, projectId: string | undefined, heartbeatMs = HEARTBEAT_MS): ReadableStream<Uint8Array> {
    const closed = new AbortController();
    let position = cursor;

    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode('retry: 2000\n\n'));
        },
        async pull(controller) {
            for (;;) {
                const events = store.eventsAfter(position, projectId, BATCH);

                if (events.length > 0) {
                    for (const event of events) {
                        controller.enqueue(frame(event));
                    }

                    position = events[events.length - 1].cursor;

                    return;
                }

                // Nothing between the read above and the subscription inside `nextCommit` can commit: both run in one turn.
                if (!(await nextCommit(store, heartbeatMs, closed.signal))) {
                    controller.enqueue(encoder.encode(': heartbeat\n\n'));

                    return;
                }

                if (closed.signal.aborted) {
                    return;
                }
            }
        },
        cancel() {
            closed.abort();
        },
    });
}
