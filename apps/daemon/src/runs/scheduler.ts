import { getProject } from '../db/projects';
import { getRun, runningCounts } from '../db/runs';
import { engineName, formatMoment } from './limits';

import type { Config } from '../config';
import type { Store } from '../store';
import type { EngineLimits } from './limits';

export const QUEUE_REASON = 'Waiting for a free slot';

interface Waiter {
    runId: string;
    projectId: string;
    resolve(): void;
    reject(reason: unknown): void;
}

/**
 * Keeps the runs in the `running` state within the global cap, the engine's cap (which subscription limits lower),
 * and the project's `maxParallelRuns`. Runs that want a slot wait here in arrival order; `tick` promotes them whenever
 * a slot frees up. A project or engine at its limit does not hold back the others. A waiting run always says why.
 */
export class Scheduler {
    private waiting: Waiter[] = [];
    private ticking = false;
    private again = false;
    private timer?: ReturnType<typeof setTimeout>;

    constructor(
        private store: Store,
        private config: Config,
        private limits: EngineLimits,
        /** Moves a queued run to `running`. */
        private promote: (runId: string) => void,
        /** Says why a queued run still waits. */
        private hold: (runId: string, reason: string) => void
    ) {}

    /** Resolves once the run has been promoted to `running`; rejects when `signal` aborts first. */
    wait(runId: string, projectId: string, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);

                return;
            }

            const waiter: Waiter = { runId, projectId, resolve, reject };

            this.waiting.push(waiter);
            signal.addEventListener(
                'abort',
                () => {
                    this.remove(waiter);
                    reject(signal.reason);
                },
                { once: true }
            );
            this.tick();
        });
    }

    tick(): void {
        // Promoting a run commits a transaction that asks for another tick: run it after this one, not inside it.
        if (this.ticking) {
            this.again = true;

            return;
        }

        this.ticking = true;

        try {
            do {
                this.again = false;
                this.promoteWhatFits();
            } while (this.again);
        } finally {
            this.ticking = false;
        }

        this.rearm();
    }

    private promoteWhatFits(): void {
        const total = { all: 0, engines: new Map<string, number>(), projects: new Map<string, number>() };

        for (const { engine, projectId, count } of runningCounts(this.store.db)) {
            total.all += count;
            total.engines.set(engine, (total.engines.get(engine) ?? 0) + count);
            total.projects.set(projectId, (total.projects.get(projectId) ?? 0) + count);
        }

        for (const waiter of [...this.waiting]) {
            const run = getRun(this.store.db, waiter.runId);

            if (run?.status !== 'queued') {
                this.remove(waiter);
                waiter.reject(new Error(`Run ${waiter.runId} is no longer queued`));
                continue;
            }

            const pausedUntil = this.limits.pausedUntil(run.engine);
            const projectLimit = getProject(this.store.db, waiter.projectId)?.settings.maxParallelRuns;
            const fits =
                pausedUntil === undefined &&
                total.all < this.config.maxRuns &&
                (total.engines.get(run.engine) ?? 0) < this.limits.capOf(run.engine) &&
                (projectLimit === undefined || (total.projects.get(waiter.projectId) ?? 0) < projectLimit);

            if (!fits) {
                const reason =
                    pausedUntil === undefined
                        ? QUEUE_REASON
                        : `${engineName(run.engine)} is at its usage limit until ${formatMoment(pausedUntil, this.limits.now())}`;

                this.hold(waiter.runId, reason);
                continue;
            }

            this.remove(waiter);

            try {
                this.promote(waiter.runId);
            } catch (error) {
                // The run's driver hears of it and fails the run; one broken run must not strand the others.
                waiter.reject(error);
                continue;
            }

            total.all++;
            total.engines.set(run.engine, (total.engines.get(run.engine) ?? 0) + 1);
            total.projects.set(waiter.projectId, (total.projects.get(waiter.projectId) ?? 0) + 1);
            waiter.resolve();
        }
    }

    /** A cooldown, a pause or a quiet period ends by itself: look again then. */
    private rearm(): void {
        clearTimeout(this.timer);
        this.timer = undefined;

        const at = this.waiting.length > 0 ? this.limits.nextChange() : undefined;

        if (at !== undefined) {
            this.timer = setTimeout(() => this.tick(), Math.max(0, at - this.limits.now()) + 5);
            this.timer.unref();
        }
    }

    private remove(waiter: Waiter): void {
        const index = this.waiting.indexOf(waiter);

        if (index >= 0) {
            this.waiting.splice(index, 1);
        }
    }
}
