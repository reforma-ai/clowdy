/*
 * The gesture behind "swipe a message to reply", with no DOM and no React in it, so the decisions can be tested as plain functions: which axis a gesture
 * belongs to, how far the message is pulled for how far the fingers went, when Reply is armed, and when a gesture is over. `useSwipeReply` measures the
 * page, feeds the events in and draws what comes out.
 *
 * Everything here speaks in the direction of the pull: negative is toward the left, where the chat list and the rail are, in px. Only a pull to the left is
 * a swipe to reply; the right is left alone, for something else. A trackpad's wheel reports the direction the content would scroll, so the hook turns its
 * deltas around before they come in.
 *
 * Reply never fires while the fingers are moving: it fires when the gesture is over (the pointer is let go, or the wheel goes quiet), and only if the
 * message is held past the threshold then. A pull can be taken back, to any point, on the way.
 */

/** The numbers of the gesture. */
export interface SwipeTuning {
    /** How far a gesture travels (`|x| + |y|`, px) before its axis is decided: a few stray pixels of a vertical scroll must not start a pull. */
    slop: number;
    /** A gesture is a sideways pull when its horizontal travel is more than this many times its vertical travel. */
    dominance: number;
    /** The most the message is ever shown pulled (px): the rubber band never goes past it, however far the fingers go. */
    maxPull: number;
    /** How far the fingers must have pulled to the left (px of travel, before the band) for a release to reply: a long swipe, and the message is shown less pulled. */
    threshold: number;
    /** A wheel gesture is over once no wheel event came for this long (ms): a wheel has no end event, and a trackpad keeps sending its inertia after the fingers left. */
    idleMs: number;
}

export const SWIPE: SwipeTuning = { slop: 6, dominance: 1.5, maxPull: 96, threshold: 120, idleMs: 200 };

/**
 * Where a gesture is. `idle`: nothing yet. `deciding`: it has not travelled far enough to say which way it goes (nothing is claimed, so a vertical scroll
 * is not held up). `pulling`: it is a pull to the left and the message follows it. `passing`: it is not ours (vertical, to the right, or inside something that
 * scrolls sideways), so every event of it goes where it would have gone, until the gesture is over.
 */
export type SwipePhase = 'idle' | 'deciding' | 'pulling' | 'passing';

export interface SwipeState {
    phase: SwipePhase;
    /** The pull the gesture asks for before the band (px, signed; once it pulls, between 0 and minus `reachOf`), and the vertical travel beside it. */
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
     * Asked once, when the gesture is about to be taken as a pull to the left: whether something under the pointer can still scroll sideways that way (`pull`
     * is the direction asked for, see `sidewaysRoom`). When it can, the gesture is the scroller's, not ours.
     */
    scrolls?: (pull: number) => boolean;
}

export interface SwipeStep {
    state: SwipeState;
    /** The event belongs to the pull: the caller cancels its default action and keeps it from the other listeners. False lets it pass. */
    claim: boolean;
}

/** How far the message is shown pulled for a pull of `x`: one to one at first, then a band that tightens toward `maxPull`. */
export function pullOf(x: number, { maxPull }: SwipeTuning = SWIPE): number {
    return Math.sign(x) * maxPull * (1 - Math.exp(-Math.abs(x) / maxPull));
}

/** Whether a pull of `x` is far enough for a release to reply: to the left, by the threshold or more. */
export function isArmed(x: number, { threshold }: SwipeTuning = SWIPE): boolean {
    return -x >= threshold;
}

/** How near a pull of `x` is to arming Reply, from 0 (none, or to the right) to 1 (armed). */
export function progressOf(x: number, { threshold }: SwipeTuning = SWIPE): number {
    return Math.min(1, Math.max(0, -x / threshold));
}

/**
 * How far a pull to the left is counted at most (px of travel): twice the threshold. A hard swipe, with the inertia after it, piles up hundreds of px, and the
 * band shows the message at its limit long before: taking such a swipe back would need every one of them, with nothing on screen moving to say it works. Capped,
 * the way back to disarm is as long as the way out to arm.
 */
export function reachOf({ threshold }: SwipeTuning = SWIPE): number {
    return threshold * 2;
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

function step(state: SwipeState, input: SwipeInput, tuning: SwipeTuning): SwipeStep {
    const { at } = input;

    switch (state.phase) {
        case 'passing':
            return { state: { ...state, at }, claim: false };
        case 'pulling': {
            // Never past rest: a pull taken back to rest and beyond stays at rest until the fingers go left again, so the way back is as long as the way out. And
            // never past the reach, so a hard swipe is as easy to take back as a gentle one.
            const x = Math.max(-reachOf(tuning), Math.min(0, state.x + input.dx));

            return { state: { phase: 'pulling', x, y: state.y, at, offset: pullOf(x, tuning) }, claim: true };
        }
        default: {
            const x = state.x + input.dx;
            const y = state.y + input.dy;

            if (Math.abs(x) + Math.abs(y) < tuning.slop)
                return { state: { phase: 'deciding', x, y, at, offset: 0 }, claim: false };

            // Not ours: mostly vertical, to the right, or in a scroller that can still go that way.
            if (Math.abs(x) <= Math.abs(y) * tuning.dominance || x > 0 || input.scrolls?.(x))
                return { state: { phase: 'passing', x, y, at, offset: 0 }, claim: false };

            // A pull to the left: what was travelled while deciding counts as part of it.
            return step({ phase: 'pulling', x: state.x, y: state.y, at, offset: 0 }, input, tuning);
        }
    }
}

/**
 * One wheel event. A pause of `idleMs` ends the gesture before the event is read, so a trackpad that went quiet and starts again is a new gesture. A wheel
 * has no end event: the caller ends the gesture with `releaseStep` once it has been quiet for `idleMs`, and Reply is for that moment, never for this one.
 */
export function wheelStep(state: SwipeState, input: SwipeInput, tuning: SwipeTuning = SWIPE): SwipeStep {
    const base = input.at - state.at > tuning.idleMs ? IDLE : state;

    return step(base, input, tuning);
}

/** One move of a pointer that is down (touch or pen: a mouse drag would fight text selection). The pull follows the finger. */
export function dragStep(state: SwipeState, input: SwipeInput, tuning: SwipeTuning = SWIPE): SwipeStep {
    return step(state, input, tuning);
}

/**
 * The gesture is over, the pointer was let go or the wheel went quiet: Reply fires when the message is held past the threshold, and nothing otherwise, so a
 * pull taken back below it is a change of mind. The gesture is over either way.
 */
export function releaseStep(state: SwipeState, tuning: SwipeTuning = SWIPE): { state: SwipeState; fire: boolean } {
    return { state: IDLE, fire: state.phase === 'pulling' && isArmed(state.x, tuning) };
}
