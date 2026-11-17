import { describe, expect, it } from 'vitest';

import {
    ANGLE_UNITS,
    angleFromDegrees,
    angleToDegrees,
    isAngleUnit,
    parseAngleValue,
    parseUnitValue,
    roundForUnit,
} from '../src/css-units';

describe('css unit helpers', () => {
    it('keeps CSS angle units in the shared registry', () => {
        expect(ANGLE_UNITS).toEqual(['deg', 'grad', 'rad', 'turn']);
        expect(isAngleUnit('grad')).toBe(true);
        expect(isAngleUnit('px')).toBe(false);
    });

    it('parses and converts CSS angle values', () => {
        expect(parseAngleValue('100grad')).toEqual({ value: 100, unit: 'grad' });
        expect(parseAngleValue('.5turn')).toEqual({ value: 0.5, unit: 'turn' });
        expect(parseAngleValue('45', 'deg')).toEqual({ value: 45, unit: 'deg' });
        expect(parseAngleValue('12px')).toBeNull();

        expect(angleToDegrees({ value: 100, unit: 'grad' })).toBe(90);
        expect(angleFromDegrees(90, 'grad')).toEqual({ value: 100, unit: 'grad' });
    });

    it('uses shared precision for angle units', () => {
        expect(roundForUnit(14.6, 'deg')).toBe(15);
        expect(roundForUnit(12.345, 'grad')).toBe(12.35);
        expect(parseUnitValue('12grad')).toEqual({ value: 12, unit: 'grad' });
    });
});
