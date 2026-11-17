import type { Transport } from './transport';

/** For tests: a transport that behaves like `base` except for the methods in `overrides`. */
export function overrideTransport(base: Transport, overrides: Partial<Transport>): Transport {
    return new Proxy(base, {
        get: (target, key: keyof Transport) => overrides[key] ?? target[key].bind(target),
    });
}
