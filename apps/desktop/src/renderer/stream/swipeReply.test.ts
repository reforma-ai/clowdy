import { describe, expect, it, vi } from 'vitest';

import { dragStep, IDLE, isArmed, progressOf, pullOf, reachOf, releaseStep, sidewaysRoom, SWIPE, wheelStep, type SwipeInput, type SwipeState, type SwipeStep } from './swipeReply';

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

/** `count` events of `dx` each (negative: the fingers go left, which is the swipe). */
const sideways = (count: number, dx = -10) => Array.from({ length: count }, () => ({ dx, dy: 0 }));

/** Where a wheel gesture ends up after the events. */
const after = (events: Array<Pick<SwipeInput, 'dx' | 'dy' | 'scrolls'>>, start: SwipeState = IDLE, from = 1000): SwipeState => wheel(events, start, from).at(-1)!.state;

describe('the numbers', () => {
    it('ask for a long swipe: 100 to 150 px of travel', () => {
        expect(SWIPE.threshold).toBeGreaterThanOrEqual(100);
        expect(SWIPE.threshold).toBeLessThanOrEqual(150);
    });

    it('arm Reply on the travel of the fingers, not on how far the message is shown pulled, which is less and never reaches the band\'s limit', () => {
        expect(pullOf(-SWIPE.threshold)).toBeGreaterThan(-SWIPE.maxPull);
        expect(Math.abs(pullOf(-SWIPE.threshold))).toBeLessThan(SWIPE.threshold);
    });

    it('count a pull no further than past the threshold by as much again, so the way back from the farthest point is as long as the way out to arm', () => {
        expect(reachOf()).toBe(SWIPE.threshold * 2);
        expect(isArmed(-reachOf())).toBe(true);
        // At the reach the band shows the message nearly at its limit: the travel beyond it would be invisible.
        expect(Math.abs(pullOf(-reachOf()))).toBeGreaterThan(SWIPE.maxPull * 0.85);
    });
});

describe('the rubber band', () => {
    it('follows the fingers one to one at first, and never goes past its limit', () => {
        expect(pullOf(2)).toBeCloseTo(2, 1);
        expect(pullOf(-2)).toBeCloseTo(-2, 1);
        expect(Math.abs(pullOf(10_000))).toBeLessThanOrEqual(SWIPE.maxPull);
        expect(Math.abs(pullOf(-10_000))).toBeLessThanOrEqual(SWIPE.maxPull);
    });

    it('tightens: the same travel pulls less the further it is', () => {
        const first = pullOf(-40) - pullOf(0);
        const later = pullOf(-140) - pullOf(-100);

        expect(Math.abs(later)).toBeLessThan(Math.abs(first));
    });

    it('is symmetric, and zero for no pull', () => {
        expect(pullOf(0)).toBe(0);
        expect(pullOf(-37)).toBeCloseTo(-pullOf(37));
    });

    it('arms Reply at the threshold of a pull to the left, and never for one to the right', () => {
        expect([isArmed(-(SWIPE.threshold - 1)), isArmed(-SWIPE.threshold), isArmed(-SWIPE.threshold * 3), isArmed(0), isArmed(SWIPE.threshold), isArmed(SWIPE.threshold * 3)])
            .toEqual([false, true, true, false, false, false]);
    });

    it('shows how near Reply is: nothing at rest, whole at the threshold and no more beyond it, and nothing for the right', () => {
        expect([progressOf(0), progressOf(-SWIPE.threshold / 2), progressOf(-SWIPE.threshold), progressOf(-SWIPE.threshold * 3), progressOf(50)]).toEqual([0, 0.5, 1, 1, 0]);
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

        expect(steps.every(step => !step.claim)).toBe(true);
        expect(steps.at(-1)?.state.phase).toBe('passing');
        expect(steps.at(-1)?.state.offset).toBe(0);
    });

    it('does not take a mostly vertical scroll with a little sideways drift for a pull', () => {
        const steps = wheel(Array.from({ length: 20 }, () => ({ dx: -4, dy: -12 })));

        expect(steps.every(step => !step.claim && step.state.offset === 0)).toBe(true);
    });

    it('keeps a vertical gesture vertical even when it turns sideways later, until the wheel goes quiet', () => {
        const steps = wheel([...Array.from({ length: 5 }, () => ({ dx: 0, dy: -20 })), ...sideways(30)]);

        expect(steps.every(step => !step.claim)).toBe(true);
    });

    it('claims nothing while it is too short to say which way it goes', () => {
        const [first] = wheel([{ dx: -2, dy: 1 }]);

        expect(first.state.phase).toBe('deciding');
        expect(first.claim).toBe(false);
        expect(first.state.offset).toBe(0);
    });

    it('locks onto a swipe to the left, claims its events and pulls the message the way the fingers go', () => {
        const steps = wheel(sideways(4));

        expect(steps.at(-1)?.state.phase).toBe('pulling');
        expect(steps.slice(1).every(step => step.claim)).toBe(true);
        expect(steps.at(-1)?.state.offset).toBeLessThan(0);
        expect(steps.at(-1)?.state.x).toBeLessThan(0);
    });

    it('leaves a swipe to the right alone, whole: nothing claimed, nothing pulled, however far it goes', () => {
        const steps = wheel(sideways(40, 10));

        expect(steps.every(step => !step.claim && step.state.offset === 0)).toBe(true);
        expect(steps.at(-1)?.state.phase).toBe('passing');
        expect(releaseStep(steps.at(-1)!.state).fire).toBe(false);
    });

    it('keeps a swipe to the right to the right, even when it turns left later, until the wheel goes quiet', () => {
        const steps = wheel([...sideways(5, 10), ...sideways(40)]);

        expect(steps.every(step => !step.claim && step.state.offset === 0)).toBe(true);
    });

    it('takes a swipe to the left for one even when its first events wobble to the right, as long as it nets out to the left', () => {
        const steps = wheel([{ dx: 2, dy: 0 }, { dx: -1, dy: 1 }, { dx: -12, dy: 1 }, ...sideways(3)]);

        expect(steps.slice(0, 2).every(step => step.state.phase === 'deciding' && !step.claim)).toBe(true);
        expect(steps[2].state.phase).toBe('pulling');
        expect(steps[2].state.x).toBe(-11);
        expect(steps.slice(2).every(step => step.claim)).toBe(true);
    });

    it('passes a gesture whose first events add up to the right, even when it turns left at once', () => {
        const steps = wheel([{ dx: 4, dy: 0 }, { dx: 4, dy: 0 }, ...sideways(10)]);

        expect(steps[1].state.phase).toBe('passing');
        expect(steps.every(step => !step.claim && step.state.offset === 0)).toBe(true);
    });

    it('counts what was travelled while deciding as part of the pull', () => {
        const steps = wheel([{ dx: -3, dy: 0 }, { dx: -4, dy: 0 }]);

        expect(steps[1].state.phase).toBe('pulling');
        expect(steps[1].state.x).toBe(-7);
    });

    it('pulls with resistance: the message shows less than the fingers travelled', () => {
        const last = after(sideways(6));

        expect(Math.abs(last.offset)).toBeLessThan(Math.abs(last.x));
        expect(Math.abs(last.offset)).toBeLessThan(SWIPE.threshold);
    });

    it('keeps pulling however far it goes, within the band and the reach: replying is for the release', () => {
        const steps = wheel(sideways(200));

        expect(steps.at(-1)?.state.phase).toBe('pulling');
        expect(steps.every(step => step.state.x >= -reachOf())).toBe(true);
        expect(steps.at(-1)?.state.x).toBe(-reachOf());
        expect(Math.abs(steps.at(-1)!.state.offset)).toBeLessThanOrEqual(SWIPE.maxPull);
    });

    it('takes one huge event for a pull at the reach, not beyond it', () => {
        const [step] = wheel([{ dx: -5000, dy: 0 }]);

        expect(step.state.phase).toBe('pulling');
        expect(step.state.x).toBe(-reachOf());
    });

    it('starts a new gesture after the wheel was quiet for the idle time, whatever phase it was in', () => {
        const pulling = after(sideways(3));
        const later = wheelStep(pulling, { dx: 0, dy: -30, at: pulling.at + SWIPE.idleMs + 1 });

        // The pull is gone and this is a vertical scroll of its own.
        expect(later.state.phase).toBe('passing');
        expect(later.state.offset).toBe(0);
        expect(later.claim).toBe(false);

        const quietVertical = after(Array.from({ length: 3 }, () => ({ dx: 0, dy: -30 })));
        const swipe = wheelStep(quietVertical, { dx: -20, dy: 0, at: quietVertical.at + SWIPE.idleMs + 1 });

        expect(swipe.state.phase).toBe('pulling');
        expect(swipe.claim).toBe(true);
    });

    it('goes on with a gesture whose events come within the idle time', () => {
        const state = after(sideways(3));
        const next = wheelStep(state, { dx: -10, dy: 0, at: state.at + SWIPE.idleMs });

        expect(next.state.phase).toBe('pulling');
        expect(next.state.x).toBe(-40);
    });

    describe('taking it back', () => {
        it('turns back when the fingers do: the message follows the pull to rest', () => {
            const out = after(sideways(4));
            const back = after(sideways(4, 10), out, out.at + 16);

            expect(out.offset).toBeLessThan(0);
            expect(back.offset).toBeCloseTo(0);
            expect(back.x).toBeCloseTo(0);
        });

        it('stops at rest: pulled back past it, the message stays there and does not go to the right, and the way out starts from rest again', () => {
            const out = after(sideways(4));
            const past = wheel(sideways(10, 10), out, out.at + 16);

            expect(past.every(step => step.claim && step.state.offset <= 0 && step.state.x <= 0)).toBe(true);
            expect(past.at(-1)?.state.x).toBe(0);
            expect(past.at(-1)?.state.phase).toBe('pulling');

            const again = after(sideways(3), past.at(-1)!.state, past.at(-1)!.state.at + 16);

            expect(again.x).toBe(-30);
        });

        it('is as short a way back from a hard swipe as from the farthest a gentle one goes: the inertia piled up beyond the reach does not have to be undone', () => {
            const hard = after(sideways(200));
            // The same fingers' travel back as the way out to arm (the threshold), and a few px more.
            const back = after(sideways(Math.ceil(SWIPE.threshold / 10) + 1, 10), hard, hard.at + 16);

            expect(isArmed(hard.x)).toBe(true);
            expect(isArmed(back.x)).toBe(false);
            expect(back.offset).toBeGreaterThan(hard.offset);
            expect(releaseStep(back).fire).toBe(false);
        });

        it('is armed by where the pull is now, not by how far it once went: taken back below the threshold it needs the rest of the way again', () => {
            const out = after(sideways(20));
            const back = after(sideways(10, 10), out, out.at + 16);
            const near = after(sideways(1), back, back.at + 16);
            const far = after(sideways(3), back, back.at + 16);

            expect(isArmed(out.x)).toBe(true);
            expect(isArmed(back.x)).toBe(false);
            expect(isArmed(near.x)).toBe(false);
            expect(isArmed(far.x)).toBe(true);
        });
    });
});

describe('the release of a wheel gesture', () => {
    it('replies when the swipe is held at the threshold or beyond it when the wheel goes quiet', () => {
        const held = after(sideways(Math.ceil(SWIPE.threshold / 10)));

        expect(releaseStep(held).fire).toBe(true);
        expect(releaseStep(held).state).toBe(IDLE);
        expect(releaseStep(after(sideways(200))).fire).toBe(true);
    });

    it('replies to nothing when the swipe did not reach it', () => {
        const short = after(sideways(Math.floor(SWIPE.threshold / 10) - 2));

        expect(isArmed(short.x)).toBe(false);
        expect(releaseStep(short).fire).toBe(false);
        expect(releaseStep(short).state).toBe(IDLE);
    });

    it('replies to nothing when the swipe was taken back below the threshold on the way, the change of mind', () => {
        const out = after(sideways(20));

        expect(releaseStep(out).fire).toBe(true);

        const some = after(sideways(10, 10), out, out.at + 16);
        const all = after(sideways(30, 10), out, out.at + 16);

        expect(isArmed(some.x)).toBe(false);
        expect(releaseStep(some).fire).toBe(false);
        expect(releaseStep(all).fire).toBe(false);
    });

    it('replies to nothing for a gesture that was not a pull to the left: still deciding, vertical, to the right, or inside a scroller', () => {
        expect(releaseStep(IDLE).fire).toBe(false);
        expect(releaseStep(after([{ dx: -2, dy: 1 }])).fire).toBe(false);
        expect(releaseStep(after(Array.from({ length: 30 }, () => ({ dx: 0, dy: -30 })))).fire).toBe(false);
        expect(releaseStep(after(sideways(60, 10))).fire).toBe(false);
        expect(releaseStep(after(sideways(60).map(event => ({ ...event, scrolls: () => true })))).fire).toBe(false);
    });
});

describe('a scroller under the pointer', () => {
    it('keeps the gesture: it passes whole, however sideways it is', () => {
        const scrolls = vi.fn(() => true);
        const steps = wheel(sideways(10).map(event => ({ ...event, scrolls })));

        expect(steps.every(step => !step.claim && step.state.offset === 0)).toBe(true);
        expect(steps.at(-1)?.state.phase).toBe('passing');
    });

    it('is asked once, with the direction of the pull, when the gesture is about to be taken', () => {
        const scrolls = vi.fn(() => false);

        wheel(sideways(10).map(event => ({ ...event, scrolls })));

        expect(scrolls).toHaveBeenCalledOnce();
        expect(scrolls.mock.calls[0]).toEqual([-10]);
    });

    it('is not asked about a vertical gesture or one to the right, which are not ours anyway', () => {
        const scrolls = vi.fn(() => true);

        wheel(Array.from({ length: 5 }, () => ({ dx: 0, dy: -20, scrolls })));
        wheel(sideways(10, 10).map(event => ({ ...event, scrolls })));

        expect(scrolls).not.toHaveBeenCalled();
    });

    it('gives the swipe to the message once the scroller has no room left', () => {
        const steps = wheel(sideways(5).map(event => ({ ...event, scrolls: () => false })));

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

    it('pulls the message along with resistance as the finger goes left', () => {
        const steps = drag(sideways(40));

        expect(steps.at(-1)?.state.phase).toBe('pulling');
        expect(steps.at(-1)?.state.offset).toBeLessThan(0);
        expect(Math.abs(steps.at(-1)!.state.offset)).toBeLessThanOrEqual(SWIPE.maxPull);
    });

    it('leaves a vertical drag, and a drag to the right, to the browser', () => {
        const vertical = drag(Array.from({ length: 10 }, () => ({ dx: 1, dy: 10 })));
        const right = drag(sideways(40, 10));

        expect(vertical.every(step => !step.claim && step.state.offset === 0)).toBe(true);
        expect(right.every(step => !step.claim && step.state.offset === 0)).toBe(true);
    });

    it('replies on release when it is held past the threshold, and only then', () => {
        const far = drag(sideways(40)).at(-1)!.state;
        const near = drag(sideways(3)).at(-1)!.state;

        expect(releaseStep(far).fire).toBe(true);
        expect(releaseStep(near).fire).toBe(false);
        expect(releaseStep(near).state).toBe(IDLE);
    });

    it('replies to nothing when it was released before it was a swipe at all', () => {
        expect(releaseStep(IDLE).fire).toBe(false);
        expect(releaseStep(drag([{ dx: -1, dy: 0 }]).at(-1)!.state).fire).toBe(false);
        expect(releaseStep(drag(Array.from({ length: 20 }, () => ({ dx: 0, dy: 20 }))).at(-1)!.state).fire).toBe(false);
    });

    it('lets a pull back below the threshold be a cancel', () => {
        const out = drag(sideways(40)).at(-1)!.state;
        const back = dragStep(out, { dx: -out.x, dy: 0, at: 0 }).state;

        expect(releaseStep(back).fire).toBe(false);
    });
});
