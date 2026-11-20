import { describe, expect, test } from 'bun:test';

import { MAX_DEADLINE_MS, TIMED_TOOLS, timingOf } from '../src/engine/acp/timed';

/** The result texts of the real tools (Claude Code 2.1.312, read through claude-agent-acp 0.107.0). */
const MONITOR_RESULT = 'Monitor started (task b8ryzofob, expires in 40s unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event.';
const WAKEUP_RESULT = 'Next wakeup scheduled for 11:15:00 (in 96s). If you owe the user a status update this tick, write it now as ordinary response text; then end the turn.';
const CRON_RESULT = 'Scheduled one-shot task 1d51d840 (7 11 20 11 *). Next run: Nov 20 11:07am. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.';

const now = new Date(2026, 10, 20, 11, 5, 40);

describe('what holds a session until a time', () => {
    test('is a call of Monitor, ScheduleWakeup or CronCreate and nothing else', () => {
        expect([...TIMED_TOOLS].sort()).toEqual(['CronCreate', 'Monitor', 'ScheduleWakeup']);
        expect(timingOf('Bash', { command: 'sleep 1' }, 'done', now)).toBeUndefined();
        expect(timingOf('TaskStop', { task_id: 'b8ryzofob' }, 'stopped', now)).toBeUndefined();
    });

    describe('a Monitor', () => {
        test('runs for the `timeout_ms` the call gave, and is named by its description', () => {
            expect(timingOf('Monitor', { command: 'for i in 1 2 3; do echo tick; done', description: 'Tick  monitor\nprobe', timeout_ms: 40_000 }, MONITOR_RESULT, now)).toEqual({ label: 'Monitor', what: 'Tick monitor probe', ms: 40_000 });
        });

        test('with no `timeout_ms` runs for the five minutes the tool defaults to, and is named by its command when it has no description', () => {
            expect(timingOf('Monitor', { command: 'tail -f build.log' }, MONITOR_RESULT, now)).toEqual({ label: 'Monitor', what: 'tail -f build.log', ms: 300_000 });
            expect(timingOf('Monitor', {}, MONITOR_RESULT, now)).toEqual({ label: 'Monitor', what: '', ms: 300_000 });
        });

        test('is held for no longer than the tool allows, and a number that makes no sense is the default', () => {
            expect(timingOf('Monitor', { description: 'x', timeout_ms: 3_600_000 }, MONITOR_RESULT, now)?.ms).toBe(1_800_000);
            expect(timingOf('Monitor', { description: 'x', timeout_ms: 'soon' }, MONITOR_RESULT, now)?.ms).toBe(300_000);
            expect(timingOf('Monitor', { description: 'x', timeout_ms: -5 }, MONITOR_RESULT, now)?.ms).toBe(300_000);
            expect(timingOf('Monitor', { description: 'x', timeout_ms: Number.NaN }, MONITOR_RESULT, now)?.ms).toBe(300_000);
        });

        test('that runs for the life of the session names no end, so it holds nothing', () => {
            expect(timingOf('Monitor', { command: 'tail -f build.log', description: 'build', persistent: true, timeout_ms: 60_000 }, MONITOR_RESULT, now)).toBeUndefined();
        });
    });

    describe('a ScheduleWakeup', () => {
        test('is due when its result says (the delay rounded up to the next whole minute, so more than the delay asked for)', () => {
            expect(timingOf('ScheduleWakeup', { delaySeconds: 60, prompt: 'wake-probe: reply WOKE', reason: 'Wake probe', noop: false }, WAKEUP_RESULT, now)).toEqual({ label: 'Wakeup', what: 'Wake probe', ms: 96_000 });
        });

        test('is named by its reason without the full stop it ends with, else by its prompt', () => {
            expect(timingOf('ScheduleWakeup', { delaySeconds: 60, reason: 'Requested 60-second wakeup to run the wake1 step.' }, WAKEUP_RESULT, now)?.what).toBe('Requested 60-second wakeup to run the wake1 step');

            expect(timingOf('ScheduleWakeup', { delaySeconds: 60, prompt: '/loop check the deploy' }, WAKEUP_RESULT, now)?.what).toBe('/loop check the deploy');
            expect(timingOf('ScheduleWakeup', { delaySeconds: 60 }, WAKEUP_RESULT, now)?.what).toBe('');
        });

        test('with a result that says nothing of when, is due after the delay it asked for and the minute it may be rounded up by', () => {
            expect(timingOf('ScheduleWakeup', { delaySeconds: 120, prompt: 'p' }, 'Scheduled.', now)?.ms).toBe(180_000);
            expect(timingOf('ScheduleWakeup', { delaySeconds: 120, prompt: 'p' }, undefined, now)?.ms).toBe(180_000);
        });

        test('that the agent marks as a no-op, or that gives no delay, holds nothing when its result does not say when', () => {
            expect(timingOf('ScheduleWakeup', { delaySeconds: 60, noop: true }, 'Scheduled.', now)).toBeUndefined();
            expect(timingOf('ScheduleWakeup', { prompt: 'p' }, 'Scheduled.', now)).toBeUndefined();
            expect(timingOf('ScheduleWakeup', { delaySeconds: -1, prompt: 'p' }, 'Scheduled.', now)).toBeUndefined();
        });

        test('further away than a timer can wait is not held', () => {
            expect(timingOf('ScheduleWakeup', { delaySeconds: 3600 }, 'Next wakeup scheduled for 12:00:00 (in 3600s).', now)?.ms).toBe(3_600_000);
            expect(timingOf('ScheduleWakeup', { delaySeconds: 3600 }, `Next wakeup scheduled (in ${ Math.ceil(MAX_DEADLINE_MS / 1000) + 5 }s).`, now)).toBeUndefined();
        });
    });

    describe('a one-shot CronCreate', () => {
        test('is due at the next time of its cron (minute, hour, day, month, in local time), and held through the minute it names', () => {
            // 11:05:40 now, the job at 11:07: 80 s to the start of its minute, and the minute itself.
            expect(timingOf('CronCreate', { cron: '7 11 20 11 *', prompt: 'cron-probe: reply CRONFIRED', recurring: false }, CRON_RESULT, now)).toEqual({ label: 'Wakeup', what: 'cron-probe: reply CRONFIRED', ms: 80_000 + 60_000 });
        });

        test('whose date is across the new year is the next year\'s, and one whose time just passed is a year away and not held', () => {
            const eve = new Date(2026, 11, 31, 23, 50);

            expect(timingOf('CronCreate', { prompt: 'p' }, 'Scheduled one-shot task 1d51d840 (5 0 1 1 *). Next run: Jan 1 12:05am.', eve)?.ms).toBe(15 * 60_000 + 60_000);
            expect(timingOf('CronCreate', { prompt: 'p' }, CRON_RESULT, new Date(2026, 10, 20, 11, 7, 30))).toBeUndefined();
        });

        test('one that repeats holds nothing: the agent says so, or its result is not the one-shot\'s', () => {
            expect(timingOf('CronCreate', { cron: '*/5 * * * *', prompt: 'p', recurring: true }, CRON_RESULT, now)).toBeUndefined();
            expect(timingOf('CronCreate', { cron: '*/5 * * * *', prompt: 'p' }, 'Scheduled recurring task 8f2a1c3d (*/5 * * * *). Next run: Nov 20 11:10am. Recurring tasks expire after 7 days.', now)).toBeUndefined();
        });

        test('with a time that cannot be read, a date that does not exist, or one too far ahead holds nothing', () => {
            expect(timingOf('CronCreate', { prompt: 'p' }, 'Scheduled one-shot task 1d51d840 (*/7 11 20 11 *). Next run: later', now)).toBeUndefined();
            expect(timingOf('CronCreate', { prompt: 'p' }, 'Scheduled one-shot task 1d51d840 (7 11 30 2 *). Next run: never', now)).toBeUndefined();
            expect(timingOf('CronCreate', { prompt: 'p' }, 'Scheduled one-shot task 1d51d840 (7 11 20 5 *). Next run: May 20 11:07am', now)).toBeUndefined();
            expect(timingOf('CronCreate', { prompt: 'p' }, undefined, now)).toBeUndefined();
        });

        test('with a date or a time the calendar does not have holds nothing, even when what it rolls over to is near', () => {
            const oneShot = (fields: string) => `Scheduled one-shot task 1d51d840 (${ fields } *). Next run: never`;

            // The 31st of April is the 1st of May, the 30th of February the 2nd of March, hour 24 the next day, minute 60 the next hour: none is the job's time.
            expect(timingOf('CronCreate', { prompt: 'p' }, oneShot('0 12 31 4'), new Date(2026, 3, 25, 9, 0))).toBeUndefined();
            expect(timingOf('CronCreate', { prompt: 'p' }, oneShot('0 12 30 2'), new Date(2026, 1, 20, 9, 0))).toBeUndefined();
            expect(timingOf('CronCreate', { prompt: 'p' }, oneShot('7 24 20 11'), now)).toBeUndefined();
            expect(timingOf('CronCreate', { prompt: 'p' }, oneShot('60 11 20 11'), now)).toBeUndefined();
            // The same job on a day that exists is held.
            expect(timingOf('CronCreate', { prompt: 'p' }, oneShot('0 12 30 4'), new Date(2026, 3, 25, 9, 0))?.ms).toBeGreaterThan(0);
        });
    });
});
