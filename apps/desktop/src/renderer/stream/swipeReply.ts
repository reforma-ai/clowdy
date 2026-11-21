/*
 * The gesture behind "swipe a message to reply", with no DOM and no React in it, so the decisions can be tested as plain functions: which axis a gesture
 * belongs to, how far the message is pulled for how far the fingers went, when Reply fires, and when a gesture is over. `useSwipeReply` measures the
 * page, feeds the events in and draws what comes out.
 *
 * Everything here speaks in the direction of the pull: positive is toward the right, negative toward the left, in px. A trackpad's wheel reports
 * the direction the content would scroll, so the hook turns its deltas around before they come in.
 */

/** The numbers of the gesture. */
export interface SwipeTuning {
    /** How far a gesture travels (`|x| + |y|`, px) before its axis is decided: a few stray pixels of a vertical scroll must not start a pull. */
    slop: number;
    /** A gesture is a sideways pull when its horizontal travel is more than this many times its vertical travel. */
    dominance: number;
    /** The most the message is ever shown pulled (px): the rubber band never goes past it, however far the fingers go. */
    maxPull: number;
    /** The pull (px) at which Reply fires. Below `maxPull`, since the band tightens toward it. */
    threshold: number;
    /** A wheel gesture is over once no wheel event came for this long (ms): a wheel has no end event. */
    idleMs: number;
}

export const SWIPE: SwipeTuning = { slop: 6, dominance: 1.5, maxPull: 96, threshold: 56, idleMs: 150 };

/**
 * Where a gesture is. `idle`: nothing yet. `deciding`: it has not travelled far enough to say which way it goes (nothing is claimed, so a vertical scroll
 * is not held up). `pulling`: it is sideways and the message follows it. `passing`: it is not ours (vertical, or inside something that scrolls sideways),
 * so every event of it goes where it would have gone, until the gesture is over. `spent`: it fired already; the rest of it, the inertia a trackpad keeps
 * sending after the fingers left, is ignored so one swipe replies once.
 */
export type SwipePhase = 'idle' | 'deciding' | 'pulling' | 'passing' | 'spent';

export interface SwipeState {
    phase: SwipePhase;
    /** The pull the gesture asks for before the band (px, signed), and the vertical travel beside it. */
    x: number;
    y: number;
    /** When the last event of the gesture came (ms, the caller's clock). */
    at: number;
    /** How far the message is shown pulled (px, signed): `x` through the band. */
    offset: number;
}

export const IDLE: SwipeState = { phase: 'idle', x: 0, y: 0, at: -Infinity, offset: 0 };

/** One event of a gesture, in the direction of the pull. */
export interface SwipeInput {
    dx: number;
    dy: number;
    /** When it came (ms), on a clock that only goes forward. */
    at: number;
    /**
     * Asked once, when the gesture is about to be taken as a sideways pull: whether something under the pointer can still scroll sideways that way (`pull` is
     * the direction asked for, see `sidewaysRoom`). When it can, the gesture is the scroller's, not ours.
     */
    scrolls?: (pull: number) => boolean;
}

export interface SwipeStep {
    state: SwipeState;
    /** The event belongs to the pull: the caller cancels its default action and keeps it from the other listeners. False lets it pass. */
    claim: boolean;
    /** Reply now. */
    fire: boolean;
}

/** How far the message is shown pulled for a pull of `x`: one to one at first, then a band that tightens toward `maxPull`. */
export function pullOf(x: number, { maxPull }: SwipeTuning = SWIPE): number {
    return Math.sign(x) * maxPull * (1 - Math.exp(-Math.abs(x) / maxPull));
}

/** Whether the pull is far enough for Reply. */
export function isArmed(offset: number, { threshold }: SwipeTuning = SWIPE): boolean {
    return Math.abs(offset) >= threshold;
}

/** What a scroller reports about itself. */
export interface ScrollMetrics {
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
}

/**
 * Whether a scroller measured as `metrics` can still move for a pull toward `pull` (positive: the finger goes right, so the content goes right and the
 * scroller shows what lies to its left; negative: the other way). Code blocks and wide tables are scrollers: a sideways swipe on one of them is
 * for the scroller until it reaches its end, and only then for the message. A pixel of slack covers fractional scroll positions.
 */
export function sidewaysRoom({ scrollLeft, scrollWidth, clientWidth }: ScrollMetrics, pull: number): boolean {
    if (scrollWidth - clientWidth <= 1) return false;

    return pull > 0 ? scrollLeft > 1 : scrollLeft + clientWidth < scrollWidth - 1;
}

function step(state: SwipeState, input: SwipeInput, fireOnCross: boolean, tuning: SwipeTuning): SwipeStep {
    const { at } = input;

    switch (state.phase) {
        case 'spent':
            // Ignored, but still claimed: it is the tail of a sideways swipe, and its stray vertical bits are no scroll.
            return { state: { ...state, at }, claim: true, fire: false };
        case 'passing':
            return { state: { ...state, at }, claim: false, fire: false };
        case 'pulling': {
            const x = state.x + input.dx;
            const offset = pullOf(x, tuning);

            if (fireOnCross && isArmed(offset, tuning)) return { state: { phase: 'spent', x: 0, y: 0, at, offset: 0 }, claim: true, fire: true };

            return { state: { phase: 'pulling', x, y: state.y, at, offset }, claim: true, fire: false };
        }
        default: {
            const x = state.x + input.dx;
            const y = state.y + input.dy;

            if (Math.abs(x) + Math.abs(y) < tuning.slop) return { state: { phase: 'deciding', x, y, at, offset: 0 }, claim: false, fire: false };

            if (Math.abs(x) <= Math.abs(y) * tuning.dominance || input.scrolls?.(x)) return { state: { phase: 'passing', x, y, at, offset: 0 }, claim: false, fire: false };

            // Sideways: what was travelled while deciding counts as part of the pull.
            return step({ phase: 'pulling', x: state.x, y: state.y, at, offset: 0 }, input, fireOnCross, tuning);
        }
    }
}

/**
 * One wheel event. A pause of `idleMs` ends the gesture before the event is read, so a trackpad that went quiet and starts again is a new gesture. A wheel
 * has no end, so Reply fires the moment the pull reaches the threshold, and the rest of that swipe is ignored (`spent`) until the wheel goes quiet.
 */
export function wheelStep(state: SwipeState, input: SwipeInput, tuning: SwipeTuning = SWIPE): SwipeStep {
    const base = input.at - state.at > tuning.idleMs ? IDLE : state;

    return step(base, input, true, tuning);
}

/** One move of a pointer that is down (touch or pen: a mouse drag would fight text selection). The pull follows the finger; Reply waits for the release (`releaseStep`). */
export function dragStep(state: SwipeState, input: SwipeInput, tuning: SwipeTuning = SWIPE): SwipeStep {
    return step(state, input, false, tuning);
}

/** The pointer was let go: Reply fires when the message is held past the threshold, and nothing otherwise. The gesture is over either way. */
export function releaseStep(state: SwipeState, tuning: SwipeTuning = SWIPE): { state: SwipeState; fire: boolean } {
    return { state: IDLE, fire: state.phase === 'pulling' && isArmed(state.offset, tuning) };
}
