/**
 * Set value in range between specified minimum and maximum boundaries.
 *
 * @param min - Minimum boundary
 * @param value - Current value
 * @param max - Maximum boundary
 */
export function clamp(min: number, value: number, max: number): number {
    return Math.max(min, Math.min(value, max));
}

/**
 * Linear interpolation of a number
 *
 * lerp(20, 80, 0.5) -> 40
 * @param a - First number
 * @param b - Second number
 * @param ratio - Ratio
 */
export const lerp = (a: number, b: number, ratio: number): number => a * (1 - ratio) + b * ratio;

/**
 * Returns the number of decimal places for a step value (e.g. 0.01 → 2, 1 → 0).
 */
export function getPrecision(step: number): number {
    if (step >= 1 || !Number.isFinite(step) || step <= 0) {
        return 0;
    }

    return Math.max(0, Math.ceil(-Math.log10(step)));
}

/**
 * Rounds value to the nearest multiple of step.
 * When base is given, rounds to step values offset by base (e.g. step 5, base 2 → 2, 7, 12...).
 */
export function roundNumber(value: number, step: number, base = 0): number {
    if (step <= 0 || !Number.isFinite(step)) {
        return value;
    }

    return base + Math.round((value - base) / step + Number.EPSILON) * step;
}

/**
 *  Normalize float
 */
export function normalizeFloat(number: string | number, precision: number, asString?: false): number;
export function normalizeFloat(number: string | number, precision: number, asString: true): string;
export function normalizeFloat(number: string | number, precision = 2, asString?: boolean): string | number {
    number = Number(number).toFixed(precision);

    if (asString) {
        return number;
    }

    return +number;
}

/**
 * Get random number between min and max (inclusive)
 * Similar to PHP's getRandomNumber(1,100)
 */
export const getRandomNumber = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1) + min);

/**
 * Returns a random ID
 *
 * @param num - Length of digits (default: 6)
 * @param exclude - Optional Array/Set of exclusions
 * @param prefix - Prefix
 * @param suffix - Suffix
 * @param radix - Number system (default: 10)
 */
export const getRandomId = (
    num = 6,
    {
        exclude,
        prefix = '',
        suffix = '',
        radix = 10,
    }: { exclude?: string[] | Set<string>; prefix?: string; suffix?: string; radix?: number } = {}
): string => {
    let id = '';

    if (Array.isArray(exclude)) {
        exclude = new Set(exclude);
    }

    for (let i = 0; i < num; i++) {
        const num = getRandomNumber(i === 0 ? 1 : 0, radix - 1);

        id += num.toString(radix).toUpperCase();
    }

    id = prefix + id + suffix;

    if (exclude?.has(id)) {
        return getRandomId(num, { exclude, prefix, suffix, radix });
    }

    return id;
};
