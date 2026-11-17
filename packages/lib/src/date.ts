/**
 * Calendar-day label for chat day separators.
 *
 * - Same day as `now`: "Today"
 * - Previous calendar day: "Yesterday"
 * - Same year: "Mon, Jul 21"
 * - Other year: "Jul 21, 2025"
 */
export function formatChatDayLabel(
    date: Date | string | number,
    now: Date = new Date()
): string | null {
    const resolved = toDate(date);

    if (!resolved) {
        return null;
    }

    const dayDiff = calendarDayDiff(resolved, now);

    if (dayDiff === 0) {
        return 'Today';
    }

    if (dayDiff === 1) {
        return 'Yesterday';
    }

    if (resolved.getFullYear() === now.getFullYear()) {
        return resolved.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        });
    }

    return resolved.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

/**
 * Formats a date as a human-readable relative string.
 *
 * - < 1 min: "Just now"
 * - < 1 hour: "5m ago"
 * - < 1 day: "3h ago"
 * - < 7 days: "2d ago"
 * - same year: "Mar 15"
 * - older: "Jun 10, 2024"
 */
export function formatRelativeDate(date: Date | string): string {
    const now = Date.now();
    const then = new Date(date).getTime();
    const diff = now - then;

    const minutes = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);

    if (minutes < 1) {
        return 'Just now';
    }

    if (minutes < 60) {
        return `${ minutes }m ago`;
    }

    if (hours < 24) {
        return `${ hours }h ago`;
    }

    if (days < 7) {
        return `${ days }d ago`;
    }

    return new Date(date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: days > 365 ? 'numeric' : undefined,
    });
}

export const DEFAULT_DATETIME_MASK = 'MMM d, yyyy h:mm a';

const DATE_MASK_TOKEN_RE = /'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|a/g;

type DateParts = {
    year: number;
    month: number;
    monthLong: string;
    monthShort: string;
    day: number;
    hours24: number;
    hours12: number;
    minutes: number;
    seconds: number;
    dayPeriod: string;
};

/**
 * Parse a date-like value. `null` if missing or invalid.
 */
export function toDate(value: Date | string | number | null | undefined): Date | null {
    if (value == null) {
        return null;
    }

    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value : null;
    }

    const parsed = typeof value === 'number' ? value : Date.parse(value);

    return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** Calendar-day distance from `now`. `0` is today, `1` is yesterday, negative is future. */
export function calendarDayDiff(date: Date, now: Date = new Date()): number {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfThat = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

    return Math.round((startOfToday - startOfThat) / 86_400_000);
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

function getDateParts(date: Date, locale?: Intl.LocalesArgument): DateParts {
    const hours24 = date.getHours();
    const dayPeriod = new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        hour12: true,
    }).formatToParts(date).find(part => part.type === 'dayPeriod')?.value ?? '';

    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        monthLong: new Intl.DateTimeFormat(locale, { month: 'long' }).format(date),
        monthShort: new Intl.DateTimeFormat(locale, { month: 'short' }).format(date),
        day: date.getDate(),
        hours24,
        hours12: hours24 % 12 || 12,
        minutes: date.getMinutes(),
        seconds: date.getSeconds(),
        dayPeriod,
    };
}

function formatDateMaskToken(token: string, parts: DateParts): string {
    switch (token) {
        case 'yyyy':
            return String(parts.year);
        case 'yy':
            return pad2(parts.year % 100);
        case 'MMMM':
            return parts.monthLong;
        case 'MMM':
            return parts.monthShort;
        case 'MM':
            return pad2(parts.month);
        case 'M':
            return String(parts.month);
        case 'dd':
            return pad2(parts.day);
        case 'd':
            return String(parts.day);
        case 'HH':
            return pad2(parts.hours24);
        case 'H':
            return String(parts.hours24);
        case 'hh':
            return pad2(parts.hours12);
        case 'h':
            return String(parts.hours12);
        case 'mm':
            return pad2(parts.minutes);
        case 'm':
            return String(parts.minutes);
        case 'ss':
            return pad2(parts.seconds);
        case 's':
            return String(parts.seconds);
        case 'a':
            return parts.dayPeriod;

        default:
            return token;
    }
}

function formatDateWithMask(date: Date, mask: string, locale?: Intl.LocalesArgument): string {
    const parts = getDateParts(date, locale);

    return mask.replace(DATE_MASK_TOKEN_RE, (match, literal: string | undefined) => {
        if (literal != null) {
            return literal;
        }

        return formatDateMaskToken(match, parts);
    });
}

/**
 * Format a date with a mask string. Literals are wrapped in single quotes.
 *
 * Tokens: `yyyy`, `yy`, `MMMM`, `MMM`, `MM`, `M`, `dd`, `d`, `HH`, `H`, `hh`, `h`, `mm`, `m`, `ss`, `s`, `a`.
 *
 * @example formatDate(date, "MMMM d, yyyy 'at' h:mm a", 'en-US') → "June 17, 2026 at 10:00 AM"
 */
export function formatDate(
    date: Date | string | number | null | undefined,
    mask: string = DEFAULT_DATETIME_MASK,
    locale?: Intl.LocalesArgument
): string | null {
    const resolved = toDate(date);

    return resolved ? formatDateWithMask(resolved, mask, locale) : null;
}

/**
 * Converts time string (e.g., "7d", "5h", "30m") to milliseconds
 */
export function convertToMilliseconds(timeStr: `${ number }${ 'd' | 'h' | 'm' | 's' | 'ms' }`): number {
    const match = timeStr.match(/^(\d+)([dhms]*)$/);

    if (!match) {
        return 0;
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
        case 'd':
            return value * 24 * 60 * 60 * 1000; // days to milliseconds
        case 'h':
            return value * 60 * 60 * 1000; // hours to milliseconds
        case 'm':
            return value * 60 * 1000; // minutes to milliseconds
        case 's':
            return value * 1000; // seconds to milliseconds

        default:
            return value;
    }
}
