import type { EngineId } from '@clowdy/protocol';
import type { EngineEvent } from '../engine/types';

type LimitEvent = Extract<EngineEvent, { type: 'limit' }>;

/** A warning halves an engine's cap for this long. */
const WARNING_COOLDOWN_MS = 10 * 60_000;
/** A transient engine failure lowers the cap by one; each quiet period of this length gives one back. */
const QUIET_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** How long an engine pauses when it reports a rejection without saying when it resets. */
const UNKNOWN_RESET_PAUSE_MS = 5 * 60_000;

/** The longest delay a timer takes (about 24 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Epoch seconds are about 1.8e9, milliseconds about 1.8e12. Engines report either. */
const MILLISECONDS_FROM = 1e11;

export interface LimitSignal {
    status: 'warning' | 'rejected';
    kind?: string;
    utilization?: number;
    /** When the quota resets, epoch milliseconds. */
    resetsAt?: number;
}

/** The one place that reads a `limit` engine event: logs it raw when `CLOWDY_DEBUG` is set and normalizes the reset time. */
export function parseLimit(event: LimitEvent): LimitSignal {
    if (process.env.CLOWDY_DEBUG) {
        console.debug('[clowdy] limit event', JSON.stringify(event));
    }

    const resetsAt = typeof event.resetsAt === 'number' && Number.isFinite(event.resetsAt) && event.resetsAt > 0
        ? (event.resetsAt < MILLISECONDS_FROM ? event.resetsAt * 1000 : event.resetsAt)
        : undefined;

    return {
        status: event.status,
        ...(event.kind !== undefined && { kind: event.kind }),
        ...(event.utilization !== undefined && { utilization: event.utilization }),
        ...(resetsAt !== undefined && { resetsAt }),
    };
}

/** Exponential backoff with jitter for the n-th retry (1 is the first): `base` doubling, at most five minutes, between half and all of that. */
export function backoffDelay(attempt: number, baseMs: number, random = Math.random): number {
    return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (attempt - 1)) * (0.5 + random() / 2);
}

const NAMES: Record<EngineId, string> = { claude: 'Claude', codex: 'Codex', fake: 'The fake engine' };

export const engineName = (engine: EngineId) => NAMES[engine];

/** A moment for a person: the time today, the date and time on another day. */
export function formatMoment(at: number, now: number): string {
    const date = new Date(at);
    const sameDay = date.toDateString() === new Date(now).toDateString();

    return new Intl.DateTimeFormat('en-GB', sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

interface EngineState {
    /** The cap after transient failures: one lower for each, one back up for each quiet period. */
    cap: number;
    /** From when quiet time counts towards the next step back up. */
    capSince: number;
    /** The cap is halved until this time. */
    halvedUntil: number;
    pausedUntil: number;
}

export interface LimitOptions {
    /** Remembers pauses, so a restart does not forget that an engine is out of quota. */
    store?: {
        /** Pauses that were still running when the daemon stopped. */
        pauses: { engine: string; until: number }[];
        save(engine: EngineId, until: number | undefined): void;
    };
    clock?: () => number;
    random?: () => number;
    /** Engines resume up to this long after a reset, spread at random, so their runs do not all hit the limit at once. */
    jitterMs?: number;
}

/**
 * How many runs each engine may have in `running` right now, and whether it may start any. Subscription signals
 * lower the base cap (`engineCaps` in the config) for a while, or stop the engine until its quota resets.
 */
export class EngineLimits {
    private states = new Map<EngineId, EngineState>();
    private store: LimitOptions['store'];
    private clock: () => number;
    private random: () => number;
    private jitterMs: number;

    constructor(private caps: Record<EngineId, number>, options: LimitOptions = {}) {
        this.store = options.store;
        this.clock = options.clock ?? Date.now;
        this.random = options.random ?? Math.random;
        this.jitterMs = options.jitterMs ?? 30_000;

        for (const { engine, until } of options.store?.pauses ?? []) {
            if (engine in caps) {
                this.state(engine as EngineId).pausedUntil = until;
            }
        }
    }

    now(): number {
        return this.clock();
    }

    /** Runs of `engine` that may be `running` at once. */
    capOf(engine: EngineId): number {
        const state = this.current(engine);
        const base = this.caps[engine];
        const halved = state.halvedUntil > this.now() ? Math.floor(base / 2) : base;

        return Math.max(1, Math.min(state.cap, halved));
    }

    /** When the engine accepts work again, or `undefined` when it is not paused. */
    pausedUntil(engine: EngineId): number | undefined {
        const state = this.state(engine);

        if (state.pausedUntil > this.now()) {
            return state.pausedUntil;
        }

        if (state.pausedUntil > 0) {
            state.pausedUntil = 0;
            this.store?.save(engine, undefined);
        }

        return undefined;
    }

    /** Quota nearly used up: run half as many for a while. Repeated warnings only extend the cooldown. */
    warn(engine: EngineId): void {
        this.state(engine).halvedUntil = this.now() + WARNING_COOLDOWN_MS;
    }

    /**
     * Quota used up: no new work until it resets. Returns when the engine is available again. A reset time that is not
     * ahead of us (a stale event, a clock that disagrees) says nothing about when to try again, so it counts as unknown:
     * otherwise every run would retry at once, be rejected again, and loop.
     */
    pause(engine: EngineId, resetsAt?: number): number {
        const state = this.state(engine);
        const known = resetsAt !== undefined && resetsAt > this.now();
        const until = (known ? resetsAt : this.now() + UNKNOWN_RESET_PAUSE_MS) + this.random() * this.jitterMs;

        state.pausedUntil = Math.max(state.pausedUntil, until);
        this.store?.save(engine, state.pausedUntil);

        return state.pausedUntil;
    }

    /** The engine failed with an overload or rate-limit error that a retry may cure: one run fewer for each such event. */
    transientFailure(engine: EngineId): void {
        const state = this.current(engine);

        state.cap = Math.max(1, state.cap - 1);
        state.capSince = this.now();
    }

    /** The earliest time something here changes by itself (a cooldown ends, a pause ends, a step back up), for arming a timer. */
    nextChange(): number | undefined {
        const times: number[] = [];

        for (const engine of Object.keys(this.caps) as EngineId[]) {
            const state = this.current(engine);

            for (const at of [state.halvedUntil, state.pausedUntil, state.cap < this.caps[engine] ? state.capSince + QUIET_MS : 0]) {
                if (at > this.now()) {
                    times.push(at);
                }
            }
        }

        return times.length > 0 ? Math.min(...times) : undefined;
    }

    /** Resolves once the engine is no longer paused (immediately if it is not); rejects when `signal` aborts first. */
    async untilResumed(engine: EngineId, signal: AbortSignal): Promise<void> {
        for (let until = this.pausedUntil(engine); until !== undefined; until = this.pausedUntil(engine)) {
            await sleep(until - this.now() + 1, signal);
        }
    }

    private state(engine: EngineId): EngineState {
        let state = this.states.get(engine);

        if (!state) {
            state = { cap: this.caps[engine], capSince: this.now(), halvedUntil: 0, pausedUntil: 0 };
            this.states.set(engine, state);
        }

        return state;
    }

    /** The state with the quiet periods since the last failure counted in. */
    private current(engine: EngineId): EngineState {
        const state = this.state(engine);
        const steps = Math.floor((this.now() - state.capSince) / QUIET_MS);

        if (steps > 0) {
            state.cap = Math.min(this.caps[engine], state.cap + steps);
            state.capSince += steps * QUIET_MS;
        }

        return state;
    }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);

            return;
        }

        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, Math.min(ms, MAX_TIMER_MS));

        signal.addEventListener('abort', onAbort, { once: true });
    });
}
