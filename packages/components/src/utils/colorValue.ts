import { parseColor } from 'react-stately';

import type { Color } from 'react-stately';

const COLOR_FUNCTION_RE = /^(rgba?|hsla?)\(\s*(.*?)\s*\)$/i;
const NUMBER_RE = /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i;
const PERCENT_RE = /^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)%$/i;
const HUE_RE = /^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i;

export function parseColorValue(value: string | Color | null | undefined): Color | null {
    if (!value) {
        return null;
    }

    if (typeof value !== 'string') {
        return isUsableColor(value) ? value : null;
    }

    const trimmed = value.trim();
    const parsed = parseReactColor(trimmed);

    if (parsed) {
        return parsed;
    }

    const normalized = normalizeFunctionalColor(trimmed);

    return normalized ? parseReactColor(normalized) : null;
}

function normalizeFunctionalColor(value: string): string | null {
    const match = COLOR_FUNCTION_RE.exec(value);

    if (!match) {
        return null;
    }

    const functionName = match[1].toLowerCase();
    const parts = parseFunctionParts(match[2]);

    if (!parts) {
        return null;
    }

    if (functionName.startsWith('rgb')) {
        return normalizeRgbFunction(parts);
    }

    return normalizeHslFunction(parts);
}

function normalizeRgbFunction(parts: ParsedFunctionParts): string | null {
    const channels = parts.channels.map(formatRgbChannel);
    const alpha = formatAlpha(parts.alpha ?? '1');

    if (!alpha || channels.some(channel => channel == null)) {
        return null;
    }

    return `rgba(${channels.join(', ')}, ${alpha})`;
}

function normalizeHslFunction(parts: ParsedFunctionParts): string | null {
    const hue = formatHue(parts.channels[0]);
    const saturation = formatHslPercent(parts.channels[1]);
    const lightness = formatHslPercent(parts.channels[2]);
    const alpha = formatAlpha(parts.alpha ?? '1');

    if (!hue || !saturation || !lightness || !alpha) {
        return null;
    }

    return `hsla(${hue}, ${saturation}, ${lightness}, ${alpha})`;
}

interface ParsedFunctionParts {
    channels: string[];
    alpha?: string;
}

function parseFunctionParts(body: string): ParsedFunctionParts | null {
    if (body.includes(',')) {
        const args = body.split(',').map(arg => arg.trim());

        if (args.length < 3 || args.length > 4 || args.some(arg => !arg)) {
            return null;
        }

        return {
            channels: args.slice(0, 3),
            alpha: args[3],
        };
    }

    const parts = body.split('/').map(part => part.trim());

    if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) {
        return null;
    }

    const channels = parts[0].split(/\s+/).filter(Boolean);

    if (channels.length !== 3) {
        return null;
    }

    return {
        channels,
        alpha: parts[1],
    };
}

function formatRgbChannel(value: string): string | null {
    const percent = parsePercent(value);

    if (percent != null) {
        return String(Math.round(clamp(percent, 0, 100) * 2.55));
    }

    const number = parseNumber(value);

    if (number == null) {
        return null;
    }

    return String(Math.round(clamp(number, 0, 255)));
}

function formatHslPercent(value: string): string | null {
    const percent = parsePercent(value);

    return percent == null ? null : `${formatNumber(clamp(percent, 0, 100))}%`;
}

function formatHue(value: string): string | null {
    const match = HUE_RE.exec(value.trim());

    if (!match) {
        return null;
    }

    const number = Number(match[1]);
    const unit = match[2]?.toLowerCase();

    if (!Number.isFinite(number)) {
        return null;
    }

    if (unit === 'turn') {
        return formatNumber(number * 360);
    }

    if (unit === 'grad') {
        return formatNumber(number * 0.9);
    }

    if (unit === 'rad') {
        return formatNumber((number * 180) / Math.PI);
    }

    return formatNumber(number);
}

function formatAlpha(value: string): string | null {
    const percent = parsePercent(value);

    if (percent != null) {
        return formatNumber(clamp(percent / 100, 0, 1));
    }

    const number = parseNumber(value);

    return number == null ? null : formatNumber(clamp(number, 0, 1));
}

function parseNumber(value: string): number | null {
    const trimmed = value.trim();

    if (!NUMBER_RE.test(trimmed)) {
        return null;
    }

    const number = Number(trimmed);

    return Number.isFinite(number) ? number : null;
}

function parsePercent(value: string): number | null {
    const match = PERCENT_RE.exec(value.trim());

    if (!match) {
        return null;
    }

    const number = Number(match[1]);

    return Number.isFinite(number) ? number : null;
}

function parseReactColor(value: string): Color | null {
    try {
        const color = parseColor(value);

        return isUsableColor(color) ? color : null;
    } catch {
        return null;
    }
}

function isUsableColor(color: Color): boolean {
    return Object.values(color).every(value => typeof value !== 'number' || Number.isFinite(value));
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number): string {
    const normalized = Object.is(value, -0) ? 0 : value;

    return String(Number(normalized.toFixed(4)));
}
