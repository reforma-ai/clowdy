import { describe, expect, it } from 'vitest';

import { SwipeTracker, swipeDecision } from './swipeTracker';

describe('SwipeTracker', () => {
    it('waits for the slop before picking an axis, and counts the movement spent on it', () => {
        const tracker = new SwipeTracker();
        expect(tracker.move(3, 1, 0)).toBe('pending');
        expect(tracker.move(4, 1, 10)).toBe('horizontal');
        expect(tracker.x).toBe(7);
    });

    it('stays vertical for the rest of a gesture that began up or down', () => {
        const tracker = new SwipeTracker();
        expect(tracker.move(2, 8, 0)).toBe('vertical');
        expect(tracker.move(50, 0, 10)).toBe('vertical');
        expect(tracker.x).toBe(0);
    });

    it('ignores vertical drift once sideways', () => {
        const tracker = new SwipeTracker();
        tracker.move(10, 0, 0);
        expect(tracker.move(1, 20, 10)).toBe('horizontal');
        expect(tracker.x).toBe(11);
    });

    it('measures the speed of the last moments only', () => {
        const tracker = new SwipeTracker();
        for (let t = 0; t <= 300; t += 10) tracker.move(t < 200 ? 1 : 5, 0, t);
        expect(tracker.velocity(300)).toBeCloseTo(0.5);
        // The fingers stopped before they lifted.
        expect(tracker.velocity(400)).toBe(0);
    });

    it('moves the pull with its samples', () => {
        const tracker = new SwipeTracker();
        tracker.move(10, 0, 0);
        tracker.move(10, 0, 10);
        tracker.shift(-100);
        expect([tracker.x, tracker.velocity(10)]).toEqual([-80, 1]);
    });
});

describe('swipeDecision', () => {
    it.each([
        ['a slow pull past a quarter', 70, 0, 1],
        ['the same pull the other way', -70, 0, -1],
        ['a slow pull short of a quarter', 60, 0.1, 0],
        ['a quick flick', 20, 0.5, 1],
        ['a quick flick the other way', -20, -0.5, -1],
        ['a twitch', 8, 1, 0],
        ['a far pull flicked back', 120, -0.5, 0],
        ['no pull', 0, 1, 0],
    ])('%s', (_, x, velocity, expected) => {
        expect(swipeDecision(x, velocity, 270)).toBe(expected);
    });
});
