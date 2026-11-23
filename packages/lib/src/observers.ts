type Callback<TArgs extends any[], TReturn> = (...args: TArgs) => TReturn | Promise<TReturn>;

export type IObservable<T = any> = T & ObservableInterface;

/**
 * Observable interface
 */
export interface ObservableInterface<TArgs extends any[] = any[], TReturn = any> {
    on: (events: string | string[], callback: Callback<TArgs, TReturn>) => ThisType<any>;
    one: (events: string | string[], callback: Callback<TArgs, TReturn>) => ThisType<any>;
    off: (events: string | string[], callback?: Callback<TArgs, TReturn>) => ThisType<any>;
    emit: (eventName: string, ...args: TArgs) => Promise<unknown[]>;
    clear: () => ThisType<any>;
}

const defaultNamespace = 'default';

type ListenerMeta = { once: boolean; namespace: string };

type ListenersMap = Map<string, Map<Callback<any[], any>, ListenerMeta>>;

const listenersSymbol = Symbol('listeners');

function getListeners(instance: object): ListenersMap {
    const list = (instance as Record<symbol, ListenersMap>)[listenersSymbol];

    if (!list) {
        throw new Error('makeObservable(instance) must be called before using observable methods');
    }

    return list;
}

function addEventListeners(
    instance: object,
    events: string | string[],
    callback: Callback<any[], any>,
    once: boolean
): void {
    const listeners = getListeners(instance);
    const eventNames = Array.isArray(events) ? events : events.split(' ');

    eventNames.forEach(fullEventName => {
        const [eventName, ...namespaceParts] = fullEventName.includes('.')
            ? fullEventName.split('.')
            : [fullEventName, defaultNamespace];
        const namespace = namespaceParts.join('.') || defaultNamespace;

        if (!listeners.has(eventName)) {
            listeners.set(eventName, new Map());
        }

        listeners.get(eventName)?.set(callback, { once, namespace });
    });
}

/**
 * Attaches observable behavior (on, one, off, emit, clear) to any instance.
 * Use when the instance extends another base (e.g. Disposable) and cannot extend Observable.
 */
export function makeObservable<T extends object>(instance: T): T & ObservableInterface {
    const listeners: ListenersMap = new Map();

    (instance as Record<symbol, ListenersMap>)[listenersSymbol] = listeners;

    Object.assign(instance, {
        on(events: string | string[], callback: Callback<any[], any>) {
            addEventListeners(instance, events, callback, false);

            return instance;
        },

        one(events: string | string[], callback: Callback<any[], any>) {
            addEventListeners(instance, events, callback, true);

            return instance;
        },

        off(events: string | string[], callback?: Callback<any[], any>) {
            const list = getListeners(instance);
            const eventNames = Array.isArray(events) ? events : events.split(' ');

            eventNames.forEach(fullEventName => {
                const [eventName, ...namespaceParts] = fullEventName.includes('.')
                    ? fullEventName.split('.')
                    : [fullEventName, defaultNamespace];
                const namespace = namespaceParts.join('.') || defaultNamespace;

                const callbacksByEvent = eventName ? [list.get(eventName)] : [...list.values()];

                callbacksByEvent
                    .filter((map): map is Map<Callback<any[], any>, ListenerMeta> => map != null)
                    .forEach(callbacksMap => {
                        Array.from(callbacksMap.entries()).forEach(([cb, meta]) => {
                            if ((!callback || callback === cb) && meta.namespace === namespace) {
                                callbacksMap.delete(cb);
                            }
                        });

                        if (callbacksMap.size === 0 && eventName) {
                            list.delete(eventName);
                        }
                    });
            });

            return instance;
        },

        clear() {
            getListeners(instance).clear();

            return instance;
        },

        async emit(eventName: string, ...args: any[]) {
            const list = getListeners(instance);
            const [event, ...namespaceParts] = eventName.split('.');
            const namespace = namespaceParts.join('.');
            const callbacks = list.get(event);
            const callbacksAll = list.get('*');

            const results: Promise<unknown>[] = [];

            if (callbacks) {
                callbacks.forEach((meta, callback) => {
                    if (!namespace || meta.namespace.startsWith(namespace)) {
                        results.push(Promise.resolve(callback.call(instance, ...args)));

                        if (meta.once) {
                            callbacks.delete(callback);
                        }
                    }
                });
            }

            if (callbacksAll) {
                callbacksAll.forEach((_meta, callback) => {
                    results.push(Promise.resolve((callback as any).call(instance, eventName, ...args)));
                });
            }

            return Promise.all(results);
        },
    });

    return instance as T & ObservableInterface;
}

/**
 * Extend this when you don't need another base class; otherwise use makeObservable(instance).
 */
export abstract class Observable<TArgs extends any[] = any[], TReturn = any>
    implements ObservableInterface<TArgs, TReturn>
{
    declare on: ObservableInterface<TArgs, TReturn>['on'];
    declare one: ObservableInterface<TArgs, TReturn>['one'];
    declare off: ObservableInterface<TArgs, TReturn>['off'];
    declare emit: ObservableInterface<TArgs, TReturn>['emit'];
    declare clear: ObservableInterface<TArgs, TReturn>['clear'];

    constructor() {
        makeObservable(this);
    }
}
