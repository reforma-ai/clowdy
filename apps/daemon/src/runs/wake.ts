import { getRun, pendingMailbox, runsWithPendingMailbox } from '../db/runs';

import type { Store } from '../store';
import type { RunDriver } from './driver';
import type { RunService } from './service';

/**
 * Wakes parked orchestrators. When a child finishes, its parent (which ended its turn and sits in `waiting_children`)
 * is queued for a new turn of the same session, once the children finishing together have all arrived. Only the
 * parent's mailbox decides what the turn is told, and the turn takes each entry once.
 *
 * A parent that is running, was cancelled, or has nothing unseen is left alone: a running parent looks at its mailbox
 * when its turn ends, and a cancelled one hears about its children when the user writes to it again.
 */
export class Wakeups {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private store: Store,
        private runs: RunService,
        private driver: RunDriver,
        private windowMs: number
    ) {
        runs.onChildSettled = parentId => this.schedule(parentId);
    }

    /** Wakes the parent after the coalescing window; calls inside the window share one wake-up. */
    schedule(parentId: string): void {
        if (this.timers.has(parentId)) {
            return;
        }

        const timer = setTimeout(() => {
            this.timers.delete(parentId);
            this.wake(parentId);
        }, this.windowMs);

        timer.unref();
        this.timers.set(parentId, timer);
    }

    /** After a restart: parents whose children finished while the daemon was down. */
    resumePending(): void {
        for (const runId of runsWithPendingMailbox(this.store.db)) {
            this.schedule(runId);
        }
    }

    stop(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.timers.clear();
    }

    private wake(parentId: string): void {
        this.store.tx(() => {
            const run = getRun(this.store.db, parentId);

            if (run?.status !== 'waiting_children' || pendingMailbox(this.store.db, parentId).length === 0) {
                return;
            }

            this.runs.resume(parentId);
            this.driver.launch(parentId);
        });
    }
}
