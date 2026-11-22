import { describe, expect, it } from 'vitest';

import { thoughtLabel } from './reasoning';

describe('thoughtLabel', () => {
    it('says it is thinking while the thought goes on, whatever time it has', () => {
        expect(thoughtLabel(false)).toBe('Thinking…');
        expect(thoughtLabel(false, 4000)).toBe('Thinking…');
    });

    it('names the seconds a finished thought took', () => {
        expect(thoughtLabel(true, 1000)).toBe('Thought 1s');
        expect(thoughtLabel(true, 3400)).toBe('Thought 3s');
        expect(thoughtLabel(true, 59_400)).toBe('Thought 59s');
    });

    it('says only that it thought when it took under a second or the time is not known', () => {
        expect(thoughtLabel(true, 999)).toBe('Thought');
        expect(thoughtLabel(true, 0)).toBe('Thought');
        expect(thoughtLabel(true)).toBe('Thought');
        expect(thoughtLabel(true, Number.NaN)).toBe('Thought');
    });

    it('counts minutes and hours past a minute', () => {
        expect(thoughtLabel(true, 60_000)).toBe('Thought 1m');
        expect(thoughtLabel(true, 125_000)).toBe('Thought 2m 5s');
        expect(thoughtLabel(true, 3_600_000)).toBe('Thought 1h');
        expect(thoughtLabel(true, 4_200_000)).toBe('Thought 1h 10m');
    });
});
