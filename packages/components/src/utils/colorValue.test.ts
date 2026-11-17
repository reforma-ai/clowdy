import { describe, expect, it } from 'vitest';

import {
    detectColorInputEditorFormat,
    parseCssColorChannels,
    serializeCssColorChannels,
} from '../ColorInput/format';
import { parseColorInputValue, serializeColorInputValue } from '../ColorInput/value';
import { parseColorValue } from './colorValue';

interface ExpectedParsedColor {
    hex: string;
    alpha: number;
}

describe('parseColorValue', () => {
    it.each([
        ['#fff', { hex: '#FFFFFF', alpha: 1 }],
        ['#ffffff80', { hex: '#FFFFFF', alpha: 0.5019607843137255 }],
        ['rgb(255, 0, 0)', { hex: '#FF0000', alpha: 1 }],
        ['rgba(255, 0, 0, 0.5)', { hex: '#FF0000', alpha: 0.5 }],
        ['rgb(0, 0, 0, 0.16)', { hex: '#000000', alpha: 0.16 }],
    ])('keeps legacy supported color syntax: %s', (value, expected) => {
        expectParsedColor(value, expected);
    });

    it.each([
        ['rgb(255 0 0)', { hex: '#FF0000', alpha: 1 }],
        ['rgb(255 0 0 / .5)', { hex: '#FF0000', alpha: 0.5 }],
        ['rgb(255 0 0 / 50%)', { hex: '#FF0000', alpha: 0.5 }],
        ['rgb(255 0 0 / 0)', { hex: '#FF0000', alpha: 0 }],
        ['RGB(100% 0% 0% / 16%)', { hex: '#FF0000', alpha: 0.16 }],
        ['rgb(1e2 0 0 / 5e-1)', { hex: '#640000', alpha: 0.5 }],
    ])('parses modern rgb syntax: %s', (value, expected) => {
        expectParsedColor(value, expected);
    });

    it.each([
        ['hsl(120, 100%, 50%)', { hex: '#00FF00', alpha: 1 }],
        ['hsla(120, 100%, 50%, .5)', { hex: '#00FF00', alpha: 0.5 }],
        ['hsl(120 100% 50% / 50%)', { hex: '#00FF00', alpha: 0.5 }],
        ['hsl(.5turn 100% 50% / 25%)', { hex: '#00FFFF', alpha: 0.25 }],
        ['hsl(2.094395rad 100% 50% / .5)', { hex: '#00FF00', alpha: 0.5 }],
        ['hsl(133.333grad 100% 50% / .5)', { hex: '#00FF00', alpha: 0.5 }],
    ])('parses hsl syntax: %s', (value, expected) => {
        expectParsedColor(value, expected);
    });

    it.each([
        ['rgb(300 -10 10 / -0.5)', { hex: '#FF000A', alpha: 0 }],
        ['rgb(0 0 0 / 150%)', { hex: '#000000', alpha: 1 }],
        ['hsl(720 150% -10% / 2)', { hex: '#000000', alpha: 1 }],
    ])('clamps out-of-range channel values: %s', (value, expected) => {
        expectParsedColor(value, expected);
    });

    it.each([
        'rgb(0 0 / .5)',
        'rgb(0 0 0 /)',
        'rgb(0, 0, 0 / .5)',
        'hsl(120 100 50 / .5)',
        'color(display-p3 1 0 0)',
        'var(--color)',
        'currentColor',
        '',
    ])('returns null for unsupported or invalid color syntax: %s', (value) => {
        expect(parseColorValue(value)).toBeNull();
    });

    it('exposes modern rgb slash alpha to ColorInput as hex input plus percent alpha', () => {
        const parsed = parseColorInputValue('rgb(0 0 0 / 0.16)');

        expect(parsed.color?.toString('hex')).toBe('#000000');
        expect(parsed.alpha).toBe(16);
        expect(serializeColorInputValue(parsed.color, parsed.alpha, 'css')).toBe('rgba(0, 0, 0, 0.16)');
    });

    it.each([
        ['#ffffff80', 50, '#FFFFFF80'],
        ['rgb(255 0 0 / 50%)', 50, '#FF000080'],
        ['rgba(0, 0, 0, 0.16)', 16, '#00000029'],
    ])('serializes alpha colors from ColorInput helpers: %s', (value, alpha, serialized) => {
        const parsed = parseColorInputValue(value);

        expect(parsed.alpha).toBe(alpha);
        expect(serializeColorInputValue(parsed.color, parsed.alpha, 'auto')).toBe(serialized);
    });

    it.each([
        ['#ffffff', 'hex'],
        ['rgb(255 0 0 / 50%)', 'rgb'],
        ['hsl(120 100% 50%)', 'hsl'],
        ['hwb(120 0% 0%)', 'hwb'],
        ['lab(70% -12 -28)', 'lab'],
        ['lch(70% 40 240)', 'lch'],
        ['oklab(70% -0.04 -0.12)', 'oklab'],
        ['oklch(70% 0.12 240)', 'oklch'],
        ['color(display-p3 0.44 0.73 0.91)', 'color'],
        ['color-mix(in oklch, red 30%, blue)', 'raw'],
        ['var(--color-primary)', 'raw'],
    ])('detects ColorInput editor format for %s', (value, format) => {
        expect(detectColorInputEditorFormat(value)).toBe(format);
    });

    it.each([
        ['hwb(202 20% 9% / 0.8)', 'hwb(202 20% 9% / 0.8)'],
        ['lab(70% -12 -28 / 0.8)', 'lab(70% -12 -28 / 0.8)'],
        ['lch(70% 40 240 / 0.8)', 'lch(70% 40 240 / 0.8)'],
        ['oklab(70% -0.04 -0.12 / 0.8)', 'oklab(70% -0.04 -0.12 / 0.8)'],
        ['oklch(70% 0.12 240 / 0.8)', 'oklch(70% 0.12 240 / 0.8)'],
        ['oklch(0.7 0.297 333)', 'oklch(70% 0.297 333)'],
        ['oklab(0.7 -0.04 -0.12)', 'oklab(70% -0.04 -0.12)'],
        ['color(display-p3 0.44 0.73 0.91 / 0.8)', 'color(display-p3 0.44 0.73 0.91 / 0.8)'],
    ])('round-trips editable CSS color function channels: %s', (value, serialized) => {
        const parsed = parseCssColorChannels(value);

        expect(parsed).not.toBeNull();
        expect(serializeCssColorChannels(parsed!)).toBe(serialized);
    });
});

function expectParsedColor(value: string, expected: ExpectedParsedColor): void {
    const color = parseColorValue(value);

    expect(color?.toString('hex')).toBe(expected.hex);
    expect(color?.getChannelValue('alpha')).toBeCloseTo(expected.alpha);
}
