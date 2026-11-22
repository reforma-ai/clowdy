import type { WatchSubscriber } from './watcher';

const HEARTBEAT_MS = 15_000;
/** A client that has not read this many events is not keeping up: its stream ends, and it listens again and lists again. */
const MAX_UNREAD = 1000;

const encoder = new TextEncoder();

/**
 * The changes of a watch as Server-Sent Events: the `data:` line of each is the JSON of an `FsWatchEvent`, with no event name. A comment line
 * goes out every 15 s so an idle connection stays open. `subscribe` is called as the stream is made and answers how to stop listening, which
 * happens when the client reads no more, or when the watch ends.
 */
export function watchStream(subscribe: (subscriber: WatchSubscriber) => () => void, heartbeatMs = HEARTBEAT_MS): ReadableStream<Uint8Array> {
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = undefined;
    };

    return new ReadableStream<Uint8Array>({
        start(controller) {
            const end = () => {
                stop();

                try {
                    controller.close();
                }
                catch {
                    // Already closed by the client.
                }
            };

            controller.enqueue(encoder.encode('retry: 2000\n\n'));
            unsubscribe = subscribe({
                send(event) {
                    if ((controller.desiredSize ?? 0) < -MAX_UNREAD) {
                        end();

                        return;
                    }

                    controller.enqueue(encoder.encode(`data: ${ JSON.stringify(event) }\n\n`));
                },
                end,
            });
            heartbeat = setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), heartbeatMs);
        },
        cancel: stop,
    });
}
