import { SSE_EVENT } from '@clowdy/protocol';

import { CommandError, HTTP_STATUS } from '../errors';

import type { GitCloneEvent, GitErrorDetails, GitSyncEvent, GitSyncProgress, GitSyncResult } from '@clowdy/protocol';
import type { CloneStep } from '../git/clone';
import type { EventRow, Store } from '../store';

const HEARTBEAT_MS = 15_000;
const BATCH = 200;

const encoder = new TextEncoder();

/**
 * An event's frame, its data the `ClowdyEvent` as JSON. The stored data goes in as it was serialized when it was emitted, so no client parses it and
 * serializes it again however many streams send it.
 */
const frame = (row: EventRow) =>
    encoder.encode(
        `id: ${row.cursor}\nevent: ${SSE_EVENT}\ndata: {"cursor":${row.cursor},"at":${row.at},"projectId":${JSON.stringify(row.project_id)},"data":${row.data}}\n\n`
    );

/** A write runs to completion even if the client stops reading its progress. */
export function gitSyncStream(
    run: (progress: (step: GitSyncProgress) => void) => Promise<GitSyncResult>
): ReadableStream<Uint8Array<ArrayBuffer>> {
    let cancelled = false;

    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            const send = (event: GitSyncEvent) => {
                if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            const sync = async () => {
                try {
                    const result = await run(step => send({ type: 'phase', ...step }));
                    send({ type: 'result', result });
                } catch (error) {
                    if (error instanceof CommandError) {
                        const hint = (error.details as GitErrorDetails | undefined)?.hint;
                        send({
                            type: 'error',
                            status: HTTP_STATUS[error.code],
                            message: error.message,
                            ...(typeof hint === 'string' && { hint }),
                        });
                    } else {
                        console.error('Git sync failed', error);
                        send({ type: 'error', status: 500, message: "Couldn't sync the branch" });
                    }
                } finally {
                    if (!cancelled) controller.close();
                }
            };

            void sync();
        },
        cancel() {
            cancelled = true;
        },
    });
}

/**
 * The stream of a clone: git's progress as it comes, then the real path or the failure. Unlike a sync, a clone stops with its request: when the client closes the stream, or `request` (the
 * connection) is aborted, `run` is told through its signal and ends git, and nothing more is sent.
 */
export function gitCloneStream(
    run: (progress: (step: CloneStep) => void, signal: AbortSignal) => Promise<string>,
    request: AbortSignal
): ReadableStream<Uint8Array<ArrayBuffer>> {
    const closed = new AbortController();
    const stop = () => closed.abort();

    request.addEventListener('abort', stop, { once: true });

    return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
            const send = (event: GitCloneEvent) => {
                if (!closed.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            const clone = async () => {
                try {
                    send({
                        type: 'result',
                        path: await run(step => send({ type: 'progress', ...step }), closed.signal),
                    });
                } catch (error) {
                    if (error instanceof CommandError) {
                        const hint = (error.details as GitErrorDetails | undefined)?.hint;
                        send({
                            type: 'error',
                            status: HTTP_STATUS[error.code],
                            message: error.message,
                            ...(typeof hint === 'string' && { hint }),
                        });
                    } else {
                        // Not the error itself: what a failed spawn or a failed read says may hold the address, and with it a credential.
                        console.error('Git clone failed');
                        send({ type: 'error', status: 500, message: "Couldn't clone the repository" });
                    }
                } finally {
                    request.removeEventListener('abort', stop);

                    if (!closed.signal.aborted) controller.close();
                }
            };

            if (request.aborted) stop();

            void clone();
        },
        cancel() {
            stop();
        },
    });
}

/** Resolves true when a transaction commits, false after `ms`, and true at once if `signal` aborts. */
function nextCommit(store: Store, ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
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
export function eventStream(
    store: Store,
    cursor: number,
    projectId: string | undefined,
    heartbeatMs = HEARTBEAT_MS
): ReadableStream<Uint8Array> {
    const closed = new AbortController();
    let position = cursor;

    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode('retry: 2000\n\n'));
        },
        async pull(controller) {
            for (;;) {
                const events = store.eventRowsAfter(position, projectId, BATCH);

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
