import { arrayDifference } from './array';
import { convertToMilliseconds } from './date';

/**
 * Asynchronous setTimeout
 */
export function wait(time: number | string): Promise<void>;
export function wait<T extends any[]>(fn: (...args: T) => any, time: number | string, ...args: T): Promise<any>;
export async function wait<T extends any[]>(
    fn: number | string | ((...args: T) => any),
    time: number | string = 0,
    ...args: T
) {
    if (typeof fn !== 'function') {
        time = fn;
        fn = undefined as any;
    }

    if (typeof time === 'string') {
        time = convertToMilliseconds(time as `${number}${'d' | 'h' | 'm'}`);
    }

    const method = !time && typeof setImmediate === 'function' ? setImmediate : setTimeout;

    return new Promise(resolve => {
        method(() => resolve(typeof fn === 'function' ? fn(...args) : null), time);
    });
}

/**
 * Class representing an asynchronous task queue.
 * Tasks will resolve when all queued tasks are completed.
 * New tasks can be added to the queue dynamically and will also await completion.
 */
type AsyncQueueTask = Promise<any> | (() => Promise<unknown>) | (() => unknown);

export class AsyncQueue {
    #queue: AsyncQueueTask[] = [];
    isResolving: Promise<PromiseSettledResult<unknown>[]> | null = null;

    // Helper method to run a task
    async #run(task: AsyncQueueTask) {
        return Promise.resolve(typeof task === 'function' ? task() : task);
    }

    // Adds tasks to the queue
    add(tasks: AsyncQueueTask | AsyncQueueTask[]) {
        if (!Array.isArray(tasks)) {
            tasks = [tasks];
        }

        this.#queue = [...this.#queue, ...tasks];

        return this;
    }

    // Removes tasks from the queue
    remove(tasks: AsyncQueueTask | AsyncQueueTask[]) {
        if (!Array.isArray(tasks)) {
            tasks = [tasks];
        }

        this.#queue = arrayDifference(this.#queue, tasks);

        return this;
    }

    // Clears the queue
    clear() {
        this.#queue = [];

        return this;
    }

    async resolve(concurrency?: number): Promise<PromiseSettledResult<unknown>[]> {
        if (this.isResolving != null) {
            return this.isResolving;
        }

        this.isResolving = new Promise(resolve => {
            void (async () => {
                let results: PromiseSettledResult<unknown>[] = [];

                while (this.#queue.length > 0) {
                    const toResolve = concurrency ? this.#queue.slice(0, concurrency) : [...this.#queue];

                    this.remove(toResolve);

                    const stepResults = await Promise.allSettled(toResolve.map(async task => this.#run(task)));

                    results = [...results, ...stepResults];
                }

                this.isResolving = null;
                resolve(results);
            })();
        });

        return this.isResolving;
    }
}
