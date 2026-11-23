import { describe, expect, it } from 'vitest';

import {
    describeRemaining,
    formatDuration,
    formatElapsed,
    formatFullTime,
    formatMessageTime,
    formatRemaining,
    formatTime,
} from './time';

describe('formatTime', () => {
    it('shows a 24-hour clock with a leading zero', () => {
        expect(formatTime(new Date(2026, 10, 17, 14, 21).getTime())).toBe('14:21');
        expect(formatTime(new Date(2026, 10, 17, 9, 5).getTime())).toBe('09:05');
        expect(formatTime(new Date(2026, 10, 17, 0, 0).getTime())).toBe('00:00');
    });
});

describe('formatMessageTime', () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    const at = (year: number, month: number, day: number, hours: number, minutes: number) =>
        new Date(year, month, day, hours, minutes).getTime();

    it('shows the time alone for today', () => {
        expect(formatMessageTime(at(2026, 10, 20, 22, 54), now)).toBe('22:54');
        expect(formatMessageTime(at(2026, 10, 20, 0, 5), now)).toBe('00:05');
    });

    it('adds the day for another day of this year', () => {
        expect(formatMessageTime(at(2026, 10, 19, 22, 54), now)).toBe('19 Nov, 22:54');
        expect(formatMessageTime(at(2026, 0, 3, 9, 5), now)).toBe('3 Jan, 09:05');
    });

    it('adds the year for another year', () => {
        expect(formatMessageTime(at(2025, 10, 19, 22, 54), now)).toBe('19 Nov 2025, 22:54');
        expect(formatMessageTime(at(2025, 11, 31, 23, 59), now)).toBe('31 Dec 2025, 23:59');
    });

    it('takes the calendar day, not the last 24 hours', () => {
        const justAfterMidnight = at(2026, 10, 20, 0, 1);

        expect(formatMessageTime(at(2026, 10, 19, 23, 59), justAfterMidnight)).toBe('19 Nov, 23:59');
    });
});

describe('formatFullTime', () => {
    it('names the weekday, the date with the month in full, and the time', () => {
        expect(formatFullTime(new Date(2025, 10, 19, 22, 54).getTime())).toMatch(
            /^Wednesday,? 19 November 2025,? (at )?22:54$/
        );
    });
});

describe('formatDuration', () => {
    it('counts seconds, then minutes, then hours', () => {
        expect(formatDuration(0)).toBe('0s');
        expect(formatDuration(45_400)).toBe('45s');
        expect(formatDuration(134_000)).toBe('2m 14s');
        expect(formatDuration(3_900_000)).toBe('1h 05m');
    });

    it('never goes below zero', () => {
        expect(formatDuration(-5000)).toBe('0s');
    });
});

describe('formatRemaining', () => {
    const MINUTE = 60_000;

    it('counts minutes, then hours, then days, leaving out a unit that is zero', () => {
        expect(formatRemaining(30_000)).toBe('now');
        expect(formatRemaining(-5 * MINUTE)).toBe('now');
        expect(formatRemaining(4 * MINUTE)).toBe('4m');
        expect(formatRemaining(60 * MINUTE)).toBe('1h');
        expect(formatRemaining((4 * 60 + 45) * MINUTE)).toBe('4h 45m');
        expect(formatRemaining(24 * 60 * MINUTE)).toBe('1d');
        expect(formatRemaining((17 * 24 * 60 + 5 * 60 + 30) * MINUTE)).toBe('17d 5h');
    });

    it('rounds down', () => {
        expect(formatRemaining(28 * MINUTE + 59_000)).toBe('28m');
    });
});

describe('describeRemaining', () => {
    const MINUTE = 60_000;

    it('says what formatRemaining shows in words, leaving out a unit that is zero', () => {
        expect(describeRemaining(30_000)).toBe('less than a minute');
        expect(describeRemaining(-5 * MINUTE)).toBe('less than a minute');
        expect(describeRemaining(MINUTE)).toBe('1 minute');
        expect(describeRemaining(28 * MINUTE)).toBe('28 minutes');
        expect(describeRemaining(60 * MINUTE)).toBe('1 hour');
        expect(describeRemaining((60 + 32) * MINUTE)).toBe('1 hour 32 minutes');
        expect(describeRemaining((4 * 60 + 1) * MINUTE)).toBe('4 hours 1 minute');
        expect(describeRemaining(24 * 60 * MINUTE)).toBe('1 day');
        expect(describeRemaining((6 * 24 * 60 + 2 * 60 + 10) * MINUTE)).toBe('6 days 2 hours');
    });
});

describe('formatElapsed', () => {
    const MINUTE = 60_000;

    it('says now under a minute, then the shortest unit, rounded down', () => {
        expect(formatElapsed(59_000)).toBe('now');
        expect(formatElapsed(MINUTE)).toBe('1m');
        expect(formatElapsed(59 * MINUTE)).toBe('59m');
        expect(formatElapsed(60 * MINUTE)).toBe('1h');
        expect(formatElapsed(23 * 60 * MINUTE + 59 * MINUTE)).toBe('23h');
        expect(formatElapsed(24 * 60 * MINUTE)).toBe('1d');
        expect(formatElapsed(6 * 24 * 60 * MINUTE)).toBe('6d');
    });

    it('counts weeks, months and years for what is older', () => {
        expect(formatElapsed(7 * 24 * 60 * MINUTE)).toBe('1w');
        expect(formatElapsed(29 * 24 * 60 * MINUTE)).toBe('4w');
        expect(formatElapsed(30 * 24 * 60 * MINUTE)).toBe('1mo');
        expect(formatElapsed(364 * 24 * 60 * MINUTE)).toBe('12mo');
        expect(formatElapsed(365 * 24 * 60 * MINUTE)).toBe('1y');
    });
});
