import { describe, expect, it } from 'vitest';

import {
    gradientStopRangeBackground,
    positionFromKeyboardCommand,
    positionFromKeyboardMove,
    positionFromMoveDelta,
    positionFromTrackOffset,
    visibleGradientStops,
} from './utils';

const BOUNDS = { min: 0, max: 1 };
const STEPS = { ...BOUNDS, step: 0.01, shiftStep: 0.1 };

describe('GradientStopRange utilities', () => {
    it('sorts visible stops and leaves out-of-range stops out of thumb rendering', () => {
        expect(
            visibleGradientStops(
                [
                    { id: 'after', position: 1.2 },
                    { id: 'middle', position: 0.5 },
                    { id: 'before', position: -0.2 },
                    { id: 'start', position: 0 },
                ],
                BOUNDS
            )
        ).toEqual([
            { id: 'start', position: 0 },
            { id: 'middle', position: 0.5 },
        ]);
    });

    it('keeps out-of-range stops in the track background', () => {
        expect(
            gradientStopRangeBackground(
                [
                    { color: '#f00', position: -0.5 },
                    { color: '#0f0', position: 0.5 },
                    { color: '#00f', position: 1.5 },
                ],
                BOUNDS
            )
        ).toBe('linear-gradient(to right, #f00 -50%, #0f0 50%, #00f 150%)');
    });

    it('clamps track press positions to the editable range', () => {
        expect(positionFromTrackOffset(-20, 100, BOUNDS)).toBe(0);
        expect(positionFromTrackOffset(50, 100, BOUNDS)).toBe(0.5);
        expect(positionFromTrackOffset(120, 100, BOUNDS)).toBe(1);
    });

    it('moves pointer drags by track-relative delta', () => {
        expect(positionFromMoveDelta(0.5, 25, 100, BOUNDS)).toBe(0.75);
        expect(positionFromMoveDelta(0.1, -25, 100, BOUNDS)).toBe(0);
        expect(positionFromMoveDelta(0.9, 25, 100, BOUNDS)).toBe(1);
    });

    it('moves keyboard arrows with normal and shifted steps', () => {
        expect(positionFromKeyboardMove(0.5, 1, 0, STEPS, false)).toBe(0.51);
        expect(positionFromKeyboardMove(0.5, -1, 0, STEPS, true)).toBe(0.4);
        expect(positionFromKeyboardMove(0.5, 0, -1, STEPS, false)).toBe(0.51);
        expect(positionFromKeyboardMove(0.5, 0, 1, STEPS, false)).toBe(0.49);
    });

    it('supports direct keyboard position commands', () => {
        expect(positionFromKeyboardCommand('Home', 0.5, STEPS)).toBe(0);
        expect(positionFromKeyboardCommand('End', 0.5, STEPS)).toBe(1);
        expect(positionFromKeyboardCommand('PageUp', 0.95, STEPS)).toBe(1);
        expect(positionFromKeyboardCommand('PageDown', 0.05, STEPS)).toBe(0);
        expect(positionFromKeyboardCommand('Enter', 0.5, STEPS)).toBeNull();
    });
});
