import { describe, expect, it, vi } from 'vitest';

import { dragStep, IDLE, isArmed, pullOf, releaseStep, sidewaysRoom, SWIPE, wheelStep, type SwipeInput, type SwipeState, type SwipeStep } from './swipeReply';

/** Feeds events into a wheel gesture, one every 16 ms from `from`, and keeps every step. */
function wheel(events: Array<Pick<SwipeInput, 'dx' | 'dy' | 'scrolls'>>, start: SwipeState = IDLE, from = 1000): SwipeStep[] {
    const steps: SwipeStep[] = [];
    let state = start;

    events.forEach((event, index) => {
        const step = wheelStep(state, { ...event, at: from + index * 16 });

        steps.push(step);
        state = step.state;
    });

    return steps;
}

const sideways = (count: number, dx = -10) => Array.from({ length: count }, () => ({ dx, dy: 0 }));

describe('the rubber band', () => {
    it('follows the fingers one to one at first, and never goes past its limit', () => {
        expect(pullOf(2)).toBeCloseTo(2, 1);
        expect(pullOf(-2)).toBeCloseTo(-2, 1);
        expect(Math.abs(pullOf(10_000))).toBeLessThanOrEqual(SWIPE.maxPull);
        expect(Math.abs(pullOf(-10_000))).toBeLessThanOrEqual(SWIPE.maxPull);
    });

    it('tightens: the same travel pulls less the further it is', () => {
        const first = pullOf(40) - pullOf(0);
        const later = pullOf(140) - pullOf(100);

        expect(later).toBeLessThan(first);
    });

    it('is symmetric, and zero for no pull', () => {
        expect(pullOf(0)).toBe(0);
        expect(pullOf(-37)).toBeCloseTo(-pullOf(37));
    });

    it('arms Reply at the threshold, whichever way the message is pulled', () => {
        expect([isArmed(SWIPE.threshold - 1), isArmed(SWIPE.threshold), isArmed(-SWIPE.threshold), isArmed(0)]).toEqual([false, true, true, false]);
    });
});

describe('a scroller inside the message', () => {
    const code = { scrollLeft: 0, scrollWidth: 600, clientWidth: 300 };

    it('has room to the right of where it is, so a pull to the left (content going left) is its own', () => {
        expect(sidewaysRoom(code, -10)).toBe(true);
    });

    it('has none to the left at its start: a pull to the right is the message\'s', () => {
        expect(sidewaysRoom(code, 10)).toBe(false);
    });

    it('has room both ways in the middle', () => {
        const middle = { ...code, scrollLeft: 120 };

        expect([sidewaysRoom(middle, 10), sidewaysRoom(middle, -10)]).toEqual([true, true]);
    });

    it('has none to the right at its end, with a pixel of slack for a fractional position', () => {
        expect(sidewaysRoom({ ...code, scrollLeft: 300 }, -10)).toBe(false);
        expect(sidewaysRoom({ ...code, scrollLeft: 299.5 }, -10)).toBe(false);
        expect(sidewaysRoom({ ...code, scrollLeft: 290 }, -10)).toBe(true);
    });

    it('is no scroller at all when its content fits', () => {
        expect([sidewaysRoom({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }, 10), sidewaysRoom({ scrollLeft: 0, scrollWidth: 300.5, clientWidth: 300 }, -10)]).toEqual([false, false]);
    });
});

describe('a wheel gesture', () => {
    it('lets a vertical scroll pass, all of it, and claims none of it', () => {
        const steps = wheel(Array.from({ length: 20 }, () => ({ dx: 0, dy: -30 })));

        expect(steps.every(step => !step.claim && !step.fire)).toBe(true);
        expect(steps.at(-1)?.state.phase).toBe('passing');
        expect(steps.at(-1)?.state.offset).toBe(0);
    });

    it('does not take a mostly vertical scroll with a little sideways drift for a pull', () => {
        const steps = wheel(Array.from({ length: 20 }, () => ({ dx: -4, dy: -12 })));

        expect(steps.every(step => !step.claim && step.state.offset === 0)).toBe(true);
    });

    it('keeps a vertical gesture vertical even when it turns sideways later, until the wheel goes quiet', () => {
        const steps = wheel([...Array.from({ length: 5 }, () => ({ dx: 0, dy: -20 })), ...sideways(30)]);

        expect(steps.every(step => !step.claim && !step.fire)).toBe(true);
    });

    it('claims nothing while it is too short to say which way it goes', () => {
        const [first] = wheel([{ dx: -2, dy: 1 }]);

        expect(first.state.phase).toBe('deciding');
        expect(first.claim).toBe(false);
        expect(first.state.offset).toBe(0);
    });

    it('locks onto a sideways swipe, claims its events and pulls the message the way the fingers go', () => {
        const left = wheel(sideways(4, -10));
        const right = wheel(sideways(4, 10));

        expect(left.at(-1)?.state.phase).toBe('pulling');
        expect(left.slice(1).every(step => step.claim)).toBe(true);
        expect(left.at(-1)?.state.offset).toBeLessThan(0);
        expect(right.at(-1)?.state.offset).toBeGreaterThan(0);
    });

    it('counts what was travelled while deciding as part of the pull', () => {
        const steps = wheel([{ dx: -3, dy: 0 }, { dx: -4, dy: 0 }]);

        expect(steps[1].state.phase).toBe('pulling');
        expect(steps[1].state.x).toBe(-7);
    });

    it('pulls with resistance: the message shows less than the fingers travelled', () => {
        const steps = wheel(sideways(6, -10));
        const last = steps.at(-1)!.state;

        expect(Math.abs(last.offset)).toBeLessThan(Math.abs(last.x));
        expect(Math.abs(last.offset)).toBeLessThan(SWIPE.threshold);
    });

    it('fires Reply once the pull reaches the threshold, and only then', () => {
        const steps = wheel(sideways(30, -10));
        const fired = steps.findIndex(step => step.fire);

        expect(fired).toBeGreaterThan(0);
        expect(steps.slice(0, fired).every(step => Math.abs(step.state.offset) < SWIPE.threshold)).toBe(true);
        expect(steps.filter(step => step.fire)).toHaveLength(1);
    });

    it('fires for a swipe the other way too', () => {
        expect(wheel(sideways(30, 10)).some(step => step.fire)).toBe(true);
    });

    it('is spent after it fired: the settled message is at rest and the inertia that follows is ignored, once', () => {
        const steps = wheel(sideways(80, -10));
        const fired = steps.findIndex(step => step.fire);

        expect(steps[fired].state.phase).toBe('spent');
        expect(steps[fired].state.offset).toBe(0);
        // The tail goes on for a long time with the fingers gone: no second Reply, no new pull, and its events are not left to scroll anything.
        expect(steps.slice(fired + 1).every(step => !step.fire && step.state.offset === 0 && step.claim)).toBe(true);
    });

    it('stays spent through a tail that keeps coming, however long, and ends with the quiet', () => {
        const fired = wheel(sideways(30, -10));
        const last = fired.at(-1)!;
        const tail = wheelStep(last.state, { dx: -2, dy: 0, at: last.state.at + SWIPE.idleMs - 1 });

        expect(tail.fire).toBe(false);
        expect(tail.state.phase).toBe('spent');

        // After a pause the next swipe is a new one, and can reply again.
        const again = wheel(sideways(30, -10), tail.state, tail.state.at + SWIPE.idleMs + 1);

        expect(again.some(step => step.fire)).toBe(true);
    });

    it('starts a new gesture after the wheel was quiet for the idle time, whatever phase it was in', () => {
        const pulling = wheel(sideways(3, -10)).at(-1)!.state;
        const later = wheelStep(pulling, { dx: 0, dy: -30, at: pulling.at + SWIPE.idleMs + 1 });

        // The pull is gone and this is a vertical scroll of its own.
        expect(later.state.phase).toBe('passing');
        expect(later.state.offset).toBe(0);
        expect(later.claim).toBe(false);

        const quietVertical = wheel(Array.from({ length: 3 }, () => ({ dx: 0, dy: -30 }))).at(-1)!.state;
        const swipe = wheelStep(quietVertical, { dx: -20, dy: 0, at: quietVertical.at + SWIPE.idleMs + 1 });

        expect(swipe.state.phase).toBe('pulling');
        expect(swipe.claim).toBe(true);
    });

    it('goes on with a gesture whose events come within the idle time', () => {
        const steps = wheel(sideways(3, -10));
        const next = wheelStep(steps.at(-1)!.state, { dx: -10, dy: 0, at: steps.at(-1)!.state.at + SWIPE.idleMs });

        expect(next.state.phase).toBe('pulling');
        expect(next.state.x).toBe(-40);
    });

    it('turns back when the fingers do: the message follows the pull to rest and beyond', () => {
        const out = wheel(sideways(4, -10)).at(-1)!.state;
        const back = wheel(sideways(4, 10), out, out.at + 16).at(-1)!.state;

        expect(out.offset).toBeLessThan(0);
        expect(back.offset).toBeCloseTo(0);
    });
});

describe('a scroller under the pointer', () => {
    it('keeps the gesture: it passes whole, however sideways it is', () => {
        const scrolls = vi.fn(() => true);
        const steps = wheel(sideways(10, -10).map(event => ({ ...event, scrolls })));

        expect(steps.every(step => !step.claim && !step.fire && step.state.offset === 0)).toBe(true);
        expect(steps.at(-1)?.state.phase).toBe('passing');
    });

    it('is asked once, with the direction of the pull, when the gesture is about to be taken', () => {
        const scrolls = vi.fn(() => false);

        wheel(sideways(10, -10).map(event => ({ ...event, scrolls })));

        expect(scrolls).toHaveBeenCalledOnce();
        expect(scrolls.mock.calls[0]).toEqual([-10]);
    });

    it('is not asked about a vertical gesture, which is not ours anyway', () => {
        const scrolls = vi.fn(() => true);

        wheel(Array.from({ length: 5 }, () => ({ dx: 0, dy: -20, scrolls })));

        expect(scrolls).not.toHaveBeenCalled();
    });

    it('gives the swipe to the message once the scroller has no room left', () => {
        const steps = wheel(sideways(5, -10).map(event => ({ ...event, scrolls: () => false })));

        expect(steps.at(-1)?.state.phase).toBe('pulling');
    });
});

describe('a drag of a finger or a pen', () => {
    const drag = (events: Array<Pick<SwipeInput, 'dx' | 'dy' | 'scrolls'>>) => {
        const steps: SwipeStep[] = [];
        let state: SwipeState = IDLE;

        for (const event of events) {
            const step = dragStep(state, { ...event, at: 0 });

            steps.push(step);
            state = step.state;
        }

        return steps;
    };

    it('pulls the message along with resistance, and does not reply while it is still down', () => {
        const steps = drag(sideways(40, 10));

        expect(steps.at(-1)?.state.phase).toBe('pulling');
        expect(steps.at(-1)?.state.offset).toBeGreaterThan(SWIPE.threshold);
        expect(steps.every(step => !step.fire)).toBe(true);
    });

    it('leaves a vertical drag to the browser', () => {
        const steps = drag(Array.from({ length: 10 }, () => ({ dx: 1, dy: 10 })));

        expect(steps.every(step => !step.claim && step.state.offset === 0)).toBe(true);
    });

    it('replies on release when it is held past the threshold, and only then', () => {
        const far = drag(sideways(40, 10)).at(-1)!.state;
        const near = drag(sideways(3, 10)).at(-1)!.state;

        expect(releaseStep(far).fire).toBe(true);
        expect(releaseStep(near).fire).toBe(false);
        expect(releaseStep(near).state).toBe(IDLE);
    });

    it('replies to nothing when it was released before it was a swipe at all', () => {
        expect(releaseStep(IDLE).fire).toBe(false);
        expect(releaseStep(drag([{ dx: 1, dy: 0 }]).at(-1)!.state).fire).toBe(false);
        expect(releaseStep(drag(Array.from({ length: 20 }, () => ({ dx: 0, dy: 20 }))).at(-1)!.state).fire).toBe(false);
    });

    it('lets a pull back below the threshold be a cancel', () => {
        const out = drag(sideways(40, 10)).at(-1)!.state;
        const back = dragStep(out, { dx: -out.x, dy: 0, at: 0 }).state;

        expect(releaseStep(back).fire).toBe(false);
    });
});
