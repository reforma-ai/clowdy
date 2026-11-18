import { describe, expect, it } from 'vitest';

import { formatDuration, formatRemaining, formatTime } from './time';

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
