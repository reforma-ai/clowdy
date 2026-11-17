import { parseColorValue } from '../utils/colorValue';

import type { Color } from 'react-stately';
import type { ColorInputFormat } from './format';

export interface ParsedColorInputValue {
    color: Color | null;
    alpha: number;
}

export interface ColorInputChangeDetails extends ParsedColorInputValue {
    value: string | null;
    format?: ColorInputFormat;
    inputValue?: string;
}

export interface ParsedHexAlphaInput {
    color: Color;
    inputValue: string;
    alpha: number;
}

const MAX_HEX = 0xffffff;
const HEX_RE = /^#?[0-9a-f]{3,8}$/i;
const HEX_COLOR_LENGTHS = [3, 6];
const HEX_ALPHA_LENGTHS = [4, 8];

export function parseColorInputValue(value: string | Color | null | undefined): ParsedColorInputValue {
    if (!value) {
        return { color: null, alpha: 100 };
    }

    const color = parseColorValue(value);

    if (!color) {
        return { color: null, alpha: 100 };
    }

    return {
        color,
        alpha: alphaFromColor(color),
    };
}

export function colorInputValueToString(value: string | Color | null | undefined): string {
    if (!value) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    return value.toString('css');
}

export function colorToHexInput(color: Color | null): string {
    if (!color) {
        return '';
    }

    return color.toString('hex').replace(/^#/, '').toUpperCase();
}

export function normalizeHexInput(value: string): string | null {
    const normalized = value.trim().replace(/^#/, '').toUpperCase();

    if (/^[0-9A-F]{0,6}$/.test(normalized)) {
        return normalized;
    }

    return null;
}

export function parseHexInput(value: string): Color | null {
    const normalized = value.trim().replace(/^#/, '');

    if (!normalized) {
        return null;
    }

    if (!HEX_RE.test(normalized) || !HEX_COLOR_LENGTHS.includes(normalized.length)) {
        return null;
    }

    return parseColorValue(`#${ normalized }`);
}

export function parseHexAlphaInput(value: string): ParsedHexAlphaInput | null {
    const normalized = value.trim().replace(/^#/, '');

    if (!HEX_RE.test(normalized) || !HEX_ALPHA_LENGTHS.includes(normalized.length)) {
        return null;
    }

    const color = parseColorValue(`#${ normalized }`);

    if (!color) {
        return null;
    }

    return {
        color,
        inputValue: colorToHexInput(color),
        alpha: alphaFromColor(color),
    };
}

export function normalizeAlphaInput(value: number): number {
    if (!Number.isFinite(value)) {
        return 100;
    }

    return Math.min(100, Math.max(0, Math.round(value)));
}

export function withAlpha(color: Color | null, alpha: number): Color | null {
    if (!color) {
        return null;
    }

    try {
        return color.withChannelValue('alpha', normalizeAlphaInput(alpha) / 100);
    }
    catch {
        return color;
    }
}

export function serializeColorInputValue(
    color: Color | null,
    alpha: number,
    format: ColorInputFormat = 'auto'
): string | null {
    const colorWithAlpha = withAlpha(color, alpha);

    if (!colorWithAlpha) {
        return null;
    }

    if (format === 'css' || format === 'hexa') {
        return normalizeAlphaInput(alpha) < 100
            ? colorWithAlpha.toString('hexa')
            : colorWithAlpha.toString('hex');
    }

    if (format === 'rgba') {
        return colorWithAlpha.toString('rgba');
    }

    if (format === 'auto' && normalizeAlphaInput(alpha) < 100) {
        return colorWithAlpha.toString('hexa');
    }

    return colorWithAlpha.toString('hex');
}

export function shiftHexColor(color: Color | null, delta: number): Color | null {
    const current = color?.toHexInt() ?? 0;
    const next = Math.min(MAX_HEX, Math.max(0, current + delta));

    return parseColorValue(`#${ next.toString(16).padStart(6, '0') }`);
}

function alphaFromColor(color: Color): number {
    try {
        return normalizeAlphaInput(color.getChannelValue('alpha') * 100);
    }
    catch {
        return 100;
    }
}
