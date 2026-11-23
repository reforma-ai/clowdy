import { parseColorValue } from '../utils/colorValue';

import type { Color } from 'react-stately';

export type ColorInputFormat =
    | 'auto'
    | 'hex'
    | 'hexa'
    | 'rgb'
    | 'rgba'
    | 'hsl'
    | 'hwb'
    | 'lab'
    | 'lch'
    | 'oklab'
    | 'oklch'
    | 'color'
    | 'css'
    | 'raw';

export type ColorInputEditorFormat =
    | 'hex'
    | 'rgb'
    | 'hsl'
    | 'hwb'
    | 'lab'
    | 'lch'
    | 'oklab'
    | 'oklch'
    | 'color'
    | 'raw';

export type ColorObjectEditorFormat = Extract<ColorInputEditorFormat, 'rgb' | 'hsl'>;

export type CssColorChannelKey = 'r' | 'g' | 'b' | 'h' | 's' | 'l' | 'w' | 'blackness' | 'c' | 'a' | 'x' | 'y' | 'z';

export interface CssColorChannel {
    key: CssColorChannelKey;
    label: string;
    value: number;
    minValue?: number;
    maxValue?: number;
    step?: number;
    interactionStep?: number;
    roundTo?: number;
}

export interface ParsedCssColorChannels {
    format: Exclude<ColorInputEditorFormat, 'hex' | 'rgb' | 'hsl' | 'raw'>;
    channels: readonly CssColorChannel[];
    alpha: number;
    colorSpace?: string;
}

type DetectableColorValue = string | Color | null | undefined;

const CSS_FUNCTION_RE = /^([a-z-]+)\((.*)\)$/i;
const HEX_RE = /^#?[0-9a-f]{3,8}$/i;
const EDITOR_FORMATS: readonly ColorInputEditorFormat[] = [
    'hex',
    'rgb',
    'hsl',
    'hwb',
    'lab',
    'lch',
    'oklab',
    'oklch',
    'color',
    'raw',
];
const PARSED_COLOR_EDITOR_FORMATS = new Set<ColorInputEditorFormat>(['hex', 'rgb', 'hsl']);
const COLOR_OBJECT_EDITOR_FORMATS = new Set<ColorInputEditorFormat>(['rgb', 'hsl']);
const ADVANCED_FORMATS = new Set<ColorInputEditorFormat>(['hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);
const RGB_COLOR_SPACES = new Set([
    'srgb',
    'srgb-linear',
    'display-p3',
    'display-p3-linear',
    'a98-rgb',
    'prophoto-rgb',
    'rec2020',
]);
const XYZ_COLOR_SPACES = new Set(['xyz', 'xyz-d50', 'xyz-d65']);

export function resolveColorInputEditorFormat(
    value: DetectableColorValue,
    requestedFormat: ColorInputFormat
): ColorInputEditorFormat {
    if (requestedFormat === 'rgba') {
        return 'rgb';
    }

    if (isEditorFormat(requestedFormat) && requestedFormat !== 'raw') {
        return requestedFormat;
    }

    if (requestedFormat === 'raw') {
        return 'raw';
    }

    return detectColorInputEditorFormat(value);
}

export function detectColorInputEditorFormat(value: DetectableColorValue): ColorInputEditorFormat {
    if (!value) {
        return 'hex';
    }

    if (typeof value !== 'string') {
        return 'hex';
    }

    const trimmed = value.trim();

    if (!trimmed) {
        return 'hex';
    }

    if (HEX_RE.test(trimmed)) {
        return 'hex';
    }

    if (/^rgba?\(/i.test(trimmed)) {
        return 'rgb';
    }

    if (/^hsla?\(/i.test(trimmed)) {
        return 'hsl';
    }

    const channels = parseCssColorChannels(trimmed);

    if (channels) {
        return channels.format;
    }

    return parseColorValue(trimmed) ? 'hex' : 'raw';
}

export function canEditColorChannels(value: DetectableColorValue, editorFormat: ColorInputEditorFormat): boolean {
    if (!ADVANCED_FORMATS.has(editorFormat)) {
        return true;
    }

    return Boolean(parseCssColorChannels(typeof value === 'string' ? value : undefined, editorFormat));
}

export function isColorObjectEditorFormat(
    editorFormat: ColorInputEditorFormat
): editorFormat is ColorObjectEditorFormat {
    return COLOR_OBJECT_EDITOR_FORMATS.has(editorFormat);
}

export function isParsedColorEditorFormat(editorFormat: ColorInputEditorFormat): boolean {
    return PARSED_COLOR_EDITOR_FORMATS.has(editorFormat);
}

export function parseCssColorChannels(
    value: string | undefined,
    expectedFormat?: ColorInputEditorFormat
): ParsedCssColorChannels | null {
    const match = value?.trim().match(CSS_FUNCTION_RE);

    if (!match) {
        return null;
    }

    const functionName = normalizeColorFunctionName(match[1]);

    if (expectedFormat && functionName !== expectedFormat) {
        return null;
    }

    if (!ADVANCED_FORMATS.has(functionName)) {
        return null;
    }

    const body = splitAlpha(match[2]);
    const alpha = parseAlphaChannel(body.alpha ?? '1');

    if (alpha == null) {
        return null;
    }

    if (functionName === 'color') {
        return parseColorFunction(body.channels, alpha);
    }

    const tokens = splitCssWhitespaceList(body.channels);

    if (tokens.some(isUnsupportedEditableToken)) {
        return null;
    }

    switch (functionName) {
        case 'hwb':
            return parseHwbChannels(tokens, alpha);
        case 'lab':
            return parseLabChannels(tokens, alpha);
        case 'lch':
            return parseLchChannels(tokens, alpha);
        case 'oklab':
            return parseOklabChannels(tokens, alpha);
        case 'oklch':
            return parseOklchChannels(tokens, alpha);
        case 'hex':
        case 'rgb':
        case 'hsl':
        case 'raw':
            return null;
    }
}

export function serializeCssColorChannels(parsed: ParsedCssColorChannels): string {
    const alpha = serializeAlpha(parsed.alpha);

    if (parsed.format === 'color') {
        return `color(${parsed.colorSpace} ${parsed.channels.map(channel => formatNumber(channel.value)).join(' ')}${alpha})`;
    }

    if (parsed.format === 'hwb') {
        const [hue, whiteness, blackness] = parsed.channels;

        return `hwb(${formatNumber(hue.value)} ${formatNumber(whiteness.value)}% ${formatNumber(blackness.value)}%${alpha})`;
    }

    if (parsed.format === 'lab' || parsed.format === 'oklab') {
        const [lightness, a, b] = parsed.channels;

        return `${parsed.format}(${formatNumber(lightness.value)}% ${formatNumber(a.value)} ${formatNumber(b.value)}${alpha})`;
    }

    const [lightness, chroma, hue] = parsed.channels;

    return `${parsed.format}(${formatNumber(lightness.value)}% ${formatNumber(chroma.value)} ${formatNumber(hue.value)}${alpha})`;
}

export function serializeColorObject(
    color: Color,
    alpha: number,
    requestedFormat: ColorInputFormat,
    editorFormat: ColorInputEditorFormat
): string {
    if (requestedFormat === 'hex') {
        return color.toString('hex');
    }

    if (requestedFormat === 'hexa' || (requestedFormat === 'css' && editorFormat === 'hex')) {
        return serializeHexWithOptionalAlpha(color, alpha);
    }

    if (requestedFormat === 'rgba') {
        return color.withChannelValue('alpha', normalizeAlpha(alpha) / 100).toString('rgba');
    }

    if (requestedFormat === 'hsl' || editorFormat === 'hsl') {
        return serializeHslColor(color, alpha);
    }

    if (requestedFormat === 'rgb' || editorFormat === 'rgb') {
        return serializeRgbColor(color, alpha);
    }

    return serializeHexWithOptionalAlpha(color, alpha);
}

function serializeHexWithOptionalAlpha(color: Color, alpha: number): string {
    return normalizeAlpha(alpha) < 100
        ? color.withChannelValue('alpha', normalizeAlpha(alpha) / 100).toString('hexa')
        : color.toString('hex');
}

export function normalizeAlpha(value: number): number {
    if (!Number.isFinite(value)) {
        return 100;
    }

    return Math.min(100, Math.max(0, Math.round(value)));
}

export function formatNumber(value: number, precision = 4): string {
    const normalized = Object.is(value, -0) ? 0 : value;

    return String(Number(normalized.toFixed(precision)));
}

function normalizeColorFunctionName(value: string): ColorInputEditorFormat {
    const name = value.toLowerCase();

    if (name === 'rgba') {
        return 'rgb';
    }

    if (name === 'hsla') {
        return 'hsl';
    }

    return isEditorFormat(name) ? name : 'raw';
}

function isEditorFormat(value: string): value is ColorInputEditorFormat {
    return (EDITOR_FORMATS as readonly string[]).includes(value);
}

function parseHwbChannels(tokens: string[], alpha: number): ParsedCssColorChannels | null {
    if (tokens.length !== 3) {
        return null;
    }

    const hue = parseHueChannel(tokens[0]);
    const whiteness = parsePercentLikeChannel(tokens[1]);
    const blackness = parsePercentLikeChannel(tokens[2]);

    if (hue == null || whiteness == null || blackness == null) {
        return null;
    }

    return {
        format: 'hwb',
        alpha,
        channels: [
            hueChannel('h', 'H', hue),
            percentChannel('w', 'W', whiteness),
            percentChannel('blackness', 'B', blackness),
        ],
    };
}

function parseLabChannels(tokens: string[], alpha: number): ParsedCssColorChannels | null {
    if (tokens.length !== 3) {
        return null;
    }

    const lightness = parsePercentLikeChannel(tokens[0]);
    const a = parseNumberChannel(tokens[1]);
    const b = parseNumberChannel(tokens[2]);

    if (lightness == null || a == null || b == null) {
        return null;
    }

    return {
        format: 'lab',
        alpha,
        channels: [percentChannel('l', 'L', lightness), signedChannel('a', 'A', a), signedChannel('b', 'B', b)],
    };
}

function parseLchChannels(tokens: string[], alpha: number): ParsedCssColorChannels | null {
    if (tokens.length !== 3) {
        return null;
    }

    const lightness = parsePercentLikeChannel(tokens[0]);
    const chroma = parseNumberChannel(tokens[1]);
    const hue = parseHueChannel(tokens[2]);

    if (lightness == null || chroma == null || hue == null) {
        return null;
    }

    return {
        format: 'lch',
        alpha,
        channels: [percentChannel('l', 'L', lightness), numberChannel('c', 'C', chroma), hueChannel('h', 'H', hue)],
    };
}

function parseOklabChannels(tokens: string[], alpha: number): ParsedCssColorChannels | null {
    const parsed = parseLabChannels(tokens, alpha);

    return parsed ? scaleOkLightness(parsed, tokens[0], 'oklab') : null;
}

function parseOklchChannels(tokens: string[], alpha: number): ParsedCssColorChannels | null {
    const parsed = parseLchChannels(tokens, alpha);

    return parsed ? scaleOkLightness(parsed, tokens[0], 'oklch') : null;
}

function scaleOkLightness(
    parsed: ParsedCssColorChannels,
    lightnessToken: string,
    format: 'oklab' | 'oklch'
): ParsedCssColorChannels {
    const [lightness, ...rest] = parsed.channels;
    const value = lightnessToken.trim().endsWith('%') ? lightness.value : lightness.value * 100;

    return {
        ...parsed,
        format,
        channels: [{ ...lightness, value }, ...rest],
    };
}

function parseColorFunction(channelsBody: string, alpha: number): ParsedCssColorChannels | null {
    const tokens = splitCssWhitespaceList(channelsBody);
    const [colorSpace, ...channels] = tokens;

    if (
        !colorSpace ||
        isUnsupportedEditableToken(colorSpace) ||
        channels.length !== 3 ||
        channels.some(isUnsupportedEditableToken)
    ) {
        return null;
    }

    const values = channels.map(parseNumberChannel);

    if (values.some(value => value == null)) {
        return null;
    }

    const labels = XYZ_COLOR_SPACES.has(colorSpace) ? ['X', 'Y', 'Z'] : ['R', 'G', 'B'];
    const keys: CssColorChannelKey[] = XYZ_COLOR_SPACES.has(colorSpace) ? ['x', 'y', 'z'] : ['r', 'g', 'b'];

    if (!RGB_COLOR_SPACES.has(colorSpace) && !XYZ_COLOR_SPACES.has(colorSpace)) {
        return null;
    }

    return {
        format: 'color',
        alpha,
        colorSpace,
        channels: values.map((value, index) => ({
            key: keys[index],
            label: labels[index],
            value: value!,
            step: 0.0001,
            interactionStep: 0.01,
            roundTo: 0.0001,
        })),
    };
}

function percentChannel(key: CssColorChannelKey, label: string, value: number): CssColorChannel {
    return {
        key,
        label,
        value,
        minValue: 0,
        maxValue: 100,
        step: 0.0001,
        interactionStep: 0.1,
        roundTo: 0.0001,
    };
}

function hueChannel(key: CssColorChannelKey, label: string, value: number): CssColorChannel {
    return {
        key,
        label,
        value,
        minValue: 0,
        maxValue: 360,
        step: 0.0001,
        interactionStep: 1,
        roundTo: 0.0001,
    };
}

function numberChannel(key: CssColorChannelKey, label: string, value: number): CssColorChannel {
    return {
        key,
        label,
        value,
        step: 0.0001,
        interactionStep: 0.001,
        roundTo: 0.0001,
    };
}

function signedChannel(key: CssColorChannelKey, label: string, value: number): CssColorChannel {
    return {
        ...numberChannel(key, label, value),
        interactionStep: 0.1,
    };
}

function serializeRgbColor(color: Color, alpha: number): string {
    const rgb = color.toFormat('rgb');
    const rgbChannels = ['red', 'green', 'blue'] as const;
    const channelValues = rgbChannels.map(channel => Math.round(rgb.getChannelValue(channel)));

    return `rgb(${channelValues.join(' ')}${serializeAlpha(alpha)})`;
}

function serializeHslColor(color: Color, alpha: number): string {
    const hsl = color.toFormat('hsl');
    const hue = formatNumber(hsl.getChannelValue('hue'), 2);
    const saturation = formatNumber(hsl.getChannelValue('saturation'), 2);
    const lightness = formatNumber(hsl.getChannelValue('lightness'), 2);

    return `hsl(${hue} ${saturation}% ${lightness}%${serializeAlpha(alpha)})`;
}

function serializeAlpha(alpha: number): string {
    const normalized = normalizeAlpha(alpha);

    return normalized < 100 ? ` / ${formatNumber(normalized / 100)}` : '';
}

function parseAlphaChannel(value: string): number | null {
    const percent = parsePercentToken(value);

    if (percent != null) {
        return normalizeAlpha(percent);
    }

    const number = parseNumberChannel(value);

    return number == null ? null : normalizeAlpha(number * 100);
}

function parsePercentLikeChannel(value: string): number | null {
    const percent = parsePercentToken(value);

    if (percent != null) {
        return percent;
    }

    return parseNumberChannel(value);
}

function parsePercentToken(value: string): number | null {
    const trimmed = value.trim();

    if (!trimmed.endsWith('%')) {
        return null;
    }

    return parseNumberChannel(trimmed.slice(0, -1));
}

function parseHueChannel(value: string): number | null {
    const trimmed = value.trim().toLowerCase();
    const match = trimmed.match(/^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i);

    if (!match) {
        return null;
    }

    const number = Number(match[1]);
    const unit = match[2];

    if (!Number.isFinite(number)) {
        return null;
    }

    if (unit === 'turn') {
        return formatFiniteNumber(number * 360);
    }

    if (unit === 'grad') {
        return formatFiniteNumber(number * 0.9);
    }

    if (unit === 'rad') {
        return formatFiniteNumber((number * 180) / Math.PI);
    }

    return formatFiniteNumber(number);
}

function parseNumberChannel(value: string): number | null {
    const trimmed = value.trim();

    if (!/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
        return null;
    }

    const number = Number(trimmed);

    return Number.isFinite(number) ? number : null;
}

function formatFiniteNumber(value: number): number {
    return Number(formatNumber(value, 4));
}

function isUnsupportedEditableToken(value: string): boolean {
    return value.includes('(') || value.toLowerCase() === 'none';
}

function splitAlpha(value: string): { channels: string; alpha?: string } {
    const index = findTopLevelSlash(value);

    if (index < 0) {
        return { channels: value.trim() };
    }

    return {
        channels: value.slice(0, index).trim(),
        alpha: value.slice(index + 1).trim(),
    };
}

function findTopLevelSlash(value: string): number {
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;

    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];

        if (escaped) {
            escaped = false;

            continue;
        }

        if (char === '\\') {
            escaped = true;

            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = undefined;
            }

            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;

            continue;
        }

        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth = Math.max(0, depth - 1);
        } else if (char === '/' && depth === 0) {
            return index;
        }
    }

    return -1;
}

function splitCssWhitespaceList(value: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;

    const push = () => {
        const part = current.trim();

        if (part) {
            parts.push(part);
        }

        current = '';
    };

    for (const char of value.trim()) {
        if (escaped) {
            current += char;
            escaped = false;

            continue;
        }

        if (char === '\\') {
            current += char;
            escaped = true;

            continue;
        }

        if (quote) {
            current += char;

            if (char === quote) {
                quote = undefined;
            }

            continue;
        }

        if (char === '"' || char === "'") {
            current += char;
            quote = char;

            continue;
        }

        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth = Math.max(0, depth - 1);
        }

        if (/\s/.test(char) && depth === 0) {
            push();

            continue;
        }

        current += char;
    }

    push();

    return parts;
}
