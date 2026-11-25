import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchUpdates } from './updateOffer';

import type { Health } from '@clowdy/protocol';
import type { UpdateStatus } from '../shared/bridge';

const STATUS: UpdateStatus = { shell: '0.1.2', bundle: 250, ready: null, daemonWaiting: false };
const health = (activeRuns: number | undefined): Health => ({
    ok: true,
    protocol: 1,
    version: '250',
    pid: 1,
    startedAt: 0,
    activeRuns,
});

/**
 * A page whose update status is `status`; `push` sends a new one and `state.runs` is what the daemon reports. With
 * `late` the first answer waits for `answer`.
 */
function setup(status: UpdateStatus = STATUS, runs: number | undefined = 0, late = false) {
    const first = Promise.withResolvers<UpdateStatus>();
    let listener: ((status: UpdateStatus) => void) | undefined;
    const stopListening = vi.fn();
    const bridge = {
        getUpdateStatus: vi.fn(async () => (late ? first.promise : status)),
        onUpdateStatus: vi.fn((next: (status: UpdateStatus) => void) => {
            listener = next;

            return stopListening;
        }),
        restartToUpdate: vi.fn(async () => undefined),
    };
    const state: { runs: number | undefined } = { runs };
    const transport = { getHealth: vi.fn(async () => health(state.runs)) };
    let keys = 0;
    const show = vi.fn((_restart: () => void) => `offer-${++keys}`);
    const close = vi.fn();
    const stop = watchUpdates(bridge, transport, { intervalMs: 1000, show, close });

    return {
        bridge,
        transport,
        show,
        close,
        stop,
        stopListening,
        state,
        answer: first.resolve,
        push: (next: UpdateStatus) => listener?.(next),
    };
}

/** Lets the promises that are already settled run, and then the timers by `ms`. */
const wait = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('watchUpdates', () => {
    it('offers nothing while no update is installed, and does not ask the daemon', async () => {
        const { show, transport } = setup();

        await wait(5000);

        expect(show).not.toHaveBeenCalled();
        expect(transport.getHealth).not.toHaveBeenCalled();
    });

    it('offers the restart at once when an update is installed and no run is in progress', async () => {
        const { push, show, bridge } = setup();

        await wait();
        push({ ...STATUS, ready: 251 });
        await wait();

        expect(show).toHaveBeenCalledOnce();

        show.mock.calls[0]![0]();

        expect(bridge.restartToUpdate).toHaveBeenCalledOnce();
    });

    it('offers it for an update that was installed before the page loaded', async () => {
        const { show } = setup({ ...STATUS, ready: 251 });

        await wait();

        expect(show).toHaveBeenCalledOnce();
    });

    it('waits for the runs to finish, asking again every interval', async () => {
        const { push, show, state, transport } = setup(STATUS, 2);

        await wait();
        push({ ...STATUS, ready: 251 });
        await wait(3000);

        expect(show).not.toHaveBeenCalled();
        expect(transport.getHealth.mock.calls.length).toBeGreaterThanOrEqual(3);

        state.runs = 0;
        await wait(1000);

        expect(show).toHaveBeenCalledOnce();
    });

    it('takes a daemon that does not say how many runs it has as busy', async () => {
        const { push, show, state } = setup();

        // The default argument would turn undefined into 0.
        state.runs = undefined;
        await wait();
        push({ ...STATUS, ready: 251 });
        await wait(5000);

        expect(show).not.toHaveBeenCalled();
    });

    it('asks again when no daemon answers', async () => {
        const { push, show, transport } = setup();

        transport.getHealth.mockRejectedValueOnce(new Error('No daemon'));
        await wait();
        push({ ...STATUS, ready: 251 });
        await wait(1000);

        expect(show).toHaveBeenCalledOnce();
    });

    it('offers once for a bundle, and stops asking afterwards', async () => {
        const { push, show, transport } = setup();

        await wait();
        push({ ...STATUS, ready: 251 });
        await wait();
        push({ ...STATUS, ready: 251, daemonWaiting: true });
        await wait(5000);

        const asked = transport.getHealth.mock.calls.length;

        await wait(5000);

        expect(show).toHaveBeenCalledOnce();
        expect(transport.getHealth.mock.calls.length).toBe(asked);
    });

    it('replaces the offer when a newer bundle is installed', async () => {
        const { push, show, close } = setup();

        await wait();
        push({ ...STATUS, ready: 251 });
        await wait();
        push({ ...STATUS, ready: 252 });
        await wait();

        expect(close).toHaveBeenCalledWith('offer-1');
        expect(show).toHaveBeenCalledTimes(2);
    });

    it('takes a change that arrives before the first answer as the newer one', async () => {
        const { push, answer, show, close } = setup(STATUS, 0, true);

        push({ ...STATUS, ready: 251 });
        await wait();
        answer(STATUS);
        await wait();

        expect(show).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
    });

    it('stops listening and asking when it is stopped', async () => {
        const { push, show, stop, stopListening, state } = setup(STATUS, 1);

        await wait();
        push({ ...STATUS, ready: 251 });
        await wait(1000);
        stop();
        state.runs = 0;
        await wait(5000);

        expect(stopListening).toHaveBeenCalledOnce();
        expect(show).not.toHaveBeenCalled();
    });
});
