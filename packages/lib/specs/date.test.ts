import { describe, expect, it } from 'vitest';

import { calendarDayDiff, DEFAULT_DATETIME_MASK, formatChatDayLabel, formatDate, toDate } from '../src/date';

describe('formatDate', () => {
    const date = new Date(2026, 5, 17, 10, 0, 0);

    it('formats with the default datetime mask', () => {
        expect(formatDate(date, DEFAULT_DATETIME_MASK, 'en-US')).toBe('Jun 17, 2026 10:00 AM');
    });

    it('uses the default mask when omitted', () => {
        expect(formatDate(date, undefined, 'en-US')).toBe('Jun 17, 2026 10:00 AM');
    });

    it('formats custom masks', () => {
        expect(formatDate(date, 'MMM d, yyyy', 'en-US')).toBe('Jun 17, 2026');
        expect(formatDate(date, 'yyyy-MM-dd HH:mm:ss', 'en-US')).toBe('2026-06-17 10:00:00');
    });

    it('parses ISO strings', () => {
        expect(formatDate('2026-06-17T10:00:00', DEFAULT_DATETIME_MASK, 'en-US')).toBe('Jun 17, 2026 10:00 AM');
    });

    it('returns null for invalid values', () => {
        expect(formatDate(undefined)).toBeNull();
        expect(formatDate('not-a-date')).toBeNull();
    });
});

describe('formatChatDayLabel', () => {
    const now = new Date(2026, 6, 22, 18, 0, 0);

    it('returns Today for the same calendar day', () => {
        expect(formatChatDayLabel(new Date(2026, 6, 22, 1, 0, 0), now)).toBe('Today');
    });

    it('returns Yesterday for the previous calendar day', () => {
        expect(formatChatDayLabel(new Date(2026, 6, 21, 23, 0, 0), now)).toBe('Yesterday');
    });

    it('returns weekday and date within the same year', () => {
        expect(formatChatDayLabel(new Date(2026, 6, 20, 12, 0, 0), now)).toBe('Mon, Jul 20');
    });

    it('includes the year for other years', () => {
        expect(formatChatDayLabel(new Date(2025, 6, 20, 12, 0, 0), now)).toBe('Jul 20, 2025');
    });

    it('returns null for invalid values', () => {
        expect(formatChatDayLabel('not-a-date')).toBeNull();
    });
});

describe('toDate', () => {
    it('returns null for missing or invalid values', () => {
        expect(toDate(undefined)).toBeNull();
        expect(toDate('not-a-date')).toBeNull();
    });

    it('keeps a valid Date', () => {
        const date = new Date(2026, 8, 2, 13, 22, 0);

        expect(toDate(date)).toBe(date);
    });
});

describe('calendarDayDiff', () => {
    const now = new Date(2026, 8, 2, 18, 0, 0);

    it('is 0 today, 1 yesterday, and greater for older days', () => {
        expect(calendarDayDiff(new Date(2026, 8, 2, 1, 0, 0), now)).toBe(0);
        expect(calendarDayDiff(new Date(2026, 8, 1, 23, 0, 0), now)).toBe(1);
        expect(calendarDayDiff(new Date(2026, 7, 18, 14, 0, 0), now)).toBeGreaterThan(1);
    });
});
