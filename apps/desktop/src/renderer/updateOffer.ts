import { toast } from '@clowdy/components/Toast';

import type { DesktopBridge } from '../shared/bridge';
import type { Transport } from './daemon/transport';

/** How often an installed update asks whether the daemon is idle yet. */
const IDLE_CHECK_MS = 10_000;

export interface UpdateOfferOptions {
    intervalMs?: number;
    /** Shows the offer and returns its key; `restart` is what its button does. */
    show?: (restart: () => void) => string;
    close?: (key: string) => void;
}

const showToast = (restart: () => void) =>
    toast.info({
        title: 'Update ready',
        message: 'Restart Clowdy to use the new version',
        timeout: 0,
        action: { label: 'Restart', onPress: restart },
    });

/**
 * An OTA bundle starts at the next launch, and the app may stay open for weeks. Offers the restart in a toast once one
 * is installed, but only when the daemon has no run in progress (an unknown count is busy): the daemon of the new
 * bundle then replaces it at once, and the new interface never talks to an old one. It asks every few seconds, offers
 * once for each installed bundle, and leaves the toast up until it is answered or closed. Settings > About has the same
 * button at any time. Returns a function that stops it.
 */
export function watchUpdates(
    bridge: Pick<DesktopBridge, 'getUpdateStatus' | 'onUpdateStatus' | 'restartToUpdate'>,
    transport: Pick<Transport, 'getHealth'>,
    { intervalMs = IDLE_CHECK_MS, show = showToast, close = key => toast.queue.close(key) }: UpdateOfferOptions = {}
): () => void {
    /** The installed bundle that waits for a restart, and the one the person was last offered. */
    let ready: number | null = null;
    let offered: number | null = null;
    let offer: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let asking = false;
    let stopped = false;
    // A change that arrives first is newer than the answer to the question asked before it.
    let pushed = false;

    const stopAsking = () => {
        clearInterval(timer);
        timer = undefined;
    };

    const askIfIdle = async () => {
        const bundle = ready;

        if (asking || bundle === null || bundle === offered) return;

        asking = true;

        try {
            const { activeRuns } = await transport.getHealth();

            // The status may have moved on while the daemon answered.
            if (stopped || activeRuns !== 0 || ready !== bundle) return;

            offered = bundle;
            offer = show(() => void bridge.restartToUpdate());
            stopAsking();
        } catch {
            // No daemon answers now: it is asked again.
        } finally {
            asking = false;
        }
    };

    const follow = (next: number | null) => {
        if (next === ready) return;

        ready = next;

        if (offer) close(offer);

        offer = undefined;
        stopAsking();

        if (next === null) return;

        timer = setInterval(() => void askIfIdle(), intervalMs);
        void askIfIdle();
    };

    bridge.getUpdateStatus().then(
        status => !pushed && !stopped && follow(status.ready),
        () => undefined
    );

    const stopListening = bridge.onUpdateStatus(status => {
        pushed = true;
        follow(status.ready);
    });

    return () => {
        stopped = true;
        stopAsking();
        stopListening();
    };
}
