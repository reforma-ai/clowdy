import { describe, expect, it } from 'vitest';

import {
    applyAngleValueRange,
    applyPresetDegrees,
    applyPresetKeepingRevolution,
    clampAngle,
    formatAngle,
    formatAngleDisplay,
    formatAngleDisplayNumber,
    fromDegrees,
    getAngleDialGeometry,
    getAngleFromPoint,
    getPointOnCircle,
    getPresetForAngle,
    isAngleUnit,
    normalizeDegrees,
    normalizeSignedDegrees,
    parseAngle,
    roundAngleValue,
    toDegrees,
} from './angle';

describe('AngleControl utilities', () => {
    it('recognizes CSS angle units', () => {
        expect(isAngleUnit('deg')).toBe(true);
        expect(isAngleUnit('grad')).toBe(true);
        expect(isAngleUnit('rad')).toBe(true);
        expect(isAngleUnit('turn')).toBe(true);
        expect(isAngleUnit('px')).toBe(false);
    });

    it('converts deg to degrees', () => {
        expect(toDegrees({ value: 90, unit: 'deg' })).toBe(90);
    });

    it('converts turn to degrees', () => {
        expect(toDegrees({ value: 2, unit: 'turn' })).toBe(720);
    });

    it('converts rad to degrees', () => {
        expect(toDegrees({ value: Math.PI, unit: 'rad' })).toBeCloseTo(180);
    });

    it('converts grad to degrees', () => {
        expect(toDegrees({ value: 100, unit: 'grad' })).toBe(90);
    });

    it('converts degrees to the target unit', () => {
        expect(fromDegrees(720, 'turn')).toEqual({ value: 2, unit: 'turn' });
        expect(fromDegrees(90, 'grad')).toEqual({ value: 100, unit: 'grad' });
    });

    it('normalizes visual degrees without dropping source revolutions elsewhere', () => {
        expect(normalizeDegrees(720)).toBe(0);
        expect(normalizeDegrees(765)).toBe(45);
        expect(normalizeDegrees(-90)).toBe(270);
        expect(normalizeDegrees(-450)).toBe(270);
    });

    it('normalizes signed and positive output ranges', () => {
        expect(normalizeSignedDegrees(315)).toBe(-45);
        expect(normalizeSignedDegrees(180)).toBe(180);
        expect(normalizeSignedDegrees(181)).toBe(-179);
        expect(normalizeSignedDegrees(-181)).toBe(179);
        expect(applyAngleValueRange(450, 'positive')).toBe(90);
        expect(applyAngleValueRange(270, 'signed')).toBe(-90);
        expect(applyAngleValueRange(450, 'unbounded')).toBe(450);
    });

    it('keeps preset selection near the current revolution', () => {
        expect(applyPresetKeepingRevolution(720, 45)).toBe(765);
        expect(applyPresetKeepingRevolution(730, 90)).toBe(810);
        expect(applyPresetKeepingRevolution(-450, 90)).toBe(-270);
    });

    it('uses canonical preset values by default', () => {
        expect(applyPresetDegrees(270, 90)).toBe(90);
        expect(applyPresetDegrees(90, 270)).toBe(270);
        expect(applyPresetDegrees(90, 270, 'signed')).toBe(-90);
        expect(applyPresetDegrees(270, 90, 'unbounded', 'preserve-revolution')).toBe(450);
    });

    it('parses valid angle strings', () => {
        expect(parseAngle('90deg')).toEqual({ value: 90, unit: 'deg' });
        expect(parseAngle(' 2turn ')).toEqual({ value: 2, unit: 'turn' });
        expect(parseAngle('-12.5grad')).toEqual({ value: -12.5, unit: 'grad' });
        expect(parseAngle('.5rad')).toEqual({ value: 0.5, unit: 'rad' });
        expect(parseAngle('45', 'deg')).toEqual({ value: 45, unit: 'deg' });
    });

    it('rejects invalid angle strings', () => {
        expect(parseAngle('')).toBeNull();
        expect(parseAngle('abc')).toBeNull();
        expect(parseAngle('12px')).toBeNull();
        expect(parseAngle('deg')).toBeNull();
    });

    it('formats without unnecessary trailing zeros', () => {
        expect(formatAngle({ value: 90, unit: 'deg' })).toBe('90deg');
        expect(formatAngle({ value: 1, unit: 'turn' })).toBe('1turn');
        expect(formatAngle({ value: 3.14159, unit: 'rad' }, { precision: 2 })).toBe('3.14rad');
        expect(formatAngle({ value: 100, unit: 'grad' })).toBe('100grad');
    });

    it('formats common radian values as pi fractions for display', () => {
        expect(formatAngleDisplayNumber(fromDegrees(0, 'rad'))).toBe('0');
        expect(formatAngleDisplayNumber(fromDegrees(45, 'rad'))).toBe('π/4');
        expect(formatAngleDisplayNumber(fromDegrees(90, 'rad'))).toBe('π/2');
        expect(formatAngleDisplayNumber(fromDegrees(135, 'rad'))).toBe('3π/4');
        expect(formatAngleDisplayNumber(fromDegrees(180, 'rad'))).toBe('π');
        expect(formatAngleDisplayNumber(fromDegrees(270, 'rad'))).toBe('3π/2');
        expect(formatAngleDisplayNumber(fromDegrees(360, 'rad'))).toBe('2π');
        expect(formatAngleDisplayNumber(fromDegrees(-90, 'rad'))).toBe('-π/2');
        expect(formatAngleDisplay(fromDegrees(90, 'rad'))).toBe('π/2rad');
    });

    it('falls back to pi coefficient radian display when there is no familiar pi fraction', () => {
        expect(formatAngleDisplayNumber({ value: 1.234, unit: 'rad' })).toBe('0.39π');
        expect(formatAngleDisplayNumber({ value: -1.234, unit: 'rad' })).toBe('-0.39π');
        expect(formatAngleDisplayNumber({ value: 0.653, unit: 'rad' })).toBe('0.21π');
        expect(formatAngleDisplayNumber({ value: Math.PI * 0.12345, unit: 'rad' }, { precision: 2 })).toBe('0.12π');
        expect(formatAngleDisplayNumber(roundAngleValue(fromDegrees(90, 'rad')))).toBe('π/2');
        expect(formatAngleDisplayNumber({ value: 45, unit: 'deg' })).toBe('45');
    });

    it('rounds with angle unit defaults', () => {
        expect(roundAngleValue({ value: 14.6, unit: 'deg' })).toEqual({ value: 15, unit: 'deg' });
        expect(roundAngleValue({ value: 12.345, unit: 'grad' })).toEqual({ value: 12.35, unit: 'grad' });
        expect(roundAngleValue({ value: 3.14159, unit: 'rad' })).toEqual({ value: 3.142, unit: 'rad' });
        expect(roundAngleValue({ value: 0.123456, unit: 'turn' })).toEqual({ value: 0.123, unit: 'turn' });
    });

    it('supports custom angle precision', () => {
        expect(roundAngleValue({ value: 14.6, unit: 'deg' }, { deg: 1 })).toEqual({ value: 14.6, unit: 'deg' });
        expect(formatAngle({ value: 0.123456, unit: 'turn' }, { precision: { turn: 4 } })).toBe('0.1235turn');
    });

    it('clamps min and max in degrees', () => {
        expect(clampAngle(120, 0, 90)).toBe(90);
        expect(clampAngle(-20, 0, 90)).toBe(0);
        expect(clampAngle(45, 0, 90)).toBe(45);
    });

    it('finds the closest preset by visual angle', () => {
        expect(getPresetForAngle(47, [0, 45, 90])).toBe(45);
        expect(getPresetForAngle(350, [0, 45, 90])).toBe(0);
    });

    it('maps points and angles using the control orientation', () => {
        const center = { x: 30, y: 30 };

        expect(getAngleFromPoint({ x: 30, y: 0 }, center)).toBe(0);
        expect(getAngleFromPoint({ x: 60, y: 30 }, center)).toBe(90);
        expect(getAngleFromPoint({ x: 30, y: 60 }, center)).toBe(180);
        expect(getAngleFromPoint({ x: 0, y: 30 }, center)).toBe(270);
        const point = getPointOnCircle(90, 30, center);

        expect(point.x).toBeCloseTo(60);
        expect(point.y).toBeCloseTo(30);
    });

    it('derives dial geometry from one expanded size', () => {
        expect(getAngleDialGeometry(80)).toEqual({
            controlSize: 80,
            handleRadius: 28,
            handleSize: 10,
            presetRadius: 30,
        });
    });
});
