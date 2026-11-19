import { describe, expect, it } from 'vitest';

import { describeRemaining, formatDuration, formatElapsed, formatRemaining, formatTime } from './time';

describe('formatTime', () => {
    it('shows a 24-hour clock with a leading zero', () => {
        expect(formatTime(new Date(2026, 10, 17, 14, 21).getTime())).toBe('14:21');
        expect(formatTime(new Date(2026, 10, 17, 9, 5).getTime())).toBe('09:05');
        expect(formatTime(new Date(2026, 10, 17, 0, 0).getTime())).toBe('00:00');
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
