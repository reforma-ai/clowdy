import { isRecord } from './mapper-core';

/**
 * Claude Code's own timers: a `Monitor` (a script whose output lines wake the agent, and one notice at its end), a `ScheduleWakeup` (the session's next turn
 * after a delay) and a one-shot `CronCreate`. They live inside the agent's process, which the adapter (0.107.0) does not list as background work, so the
 * session would be closed at the end of the turn and nothing would ever wake the agent. The layer holds the session for them until the time the agent
 * itself named in the call, which this file reads from the call's input and result (an explicit marker, not a guess from silence).
 */

/** What a completed call to one of those tools says about when it is over. */
export interface Timing {
    /** Which tool: titles and notes say `Monitor` or `Wakeup` (a one-shot cron job is a wakeup at a given time). */
    label: 'Monitor' | 'Wakeup';
    /** What it is for, from the call: a monitor's description, a wakeup's reason or prompt. */
    what: string;
    /** How long from the call's end the session is held. */
    ms: number;
}

/** The tools whose completed calls are read for a time. */
export const TIMED_TOOLS: ReadonlySet<string> = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate']);

/** What a monitor with no `timeout_ms` runs for, and the longest it may (Claude Code caps `timeout_ms`; the call's own number is bounded by it). */
const MONITOR_DEFAULT_MS = 300_000;
const MONITOR_MAX_MS = 1_800_000;

/**
 * The longest a deadline can be: `setTimeout` takes a signed 32-bit number of milliseconds (about 24.8 days) and fires at once with more. A job further
 * away is not held, since the session would have to live that long.
 */
export const MAX_DEADLINE_MS = 2 ** 31 - 1;

/** How long a one-shot cron job is held past the start of its minute: it fires within it, and only while the agent is idle. */
const CRON_SLACK_MS = 60_000;

/** The result of a wakeup call: `Next wakeup scheduled for 11:15:00 (in 96s)`, the delay rounded up by the tool to the next whole minute. */
const WAKEUP_IN = /\(in (\d+)s\)/;

/** The result of a one-shot cron call: `Scheduled one-shot task 1d51d840 (7 11 20 11 *). Next run: Nov 20 11:07am` (minute, hour, day, month, any weekday). */
const CRON_ONE_SHOT = /^Scheduled one-shot task \S+ \((\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \*\)/;

/** A text on one line, or nothing when the input has none, without the full stop a sentence of the agent's ends with (the title is shown as a phrase). */
function lineOf(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().replace(/\.+$/, '') : '';
}

/** A number the agent gave, or nothing when it gave none that makes sense. */
function numberOf(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The next time the cron job `minute hour day month *` runs after `now`, in the machine's local time as Claude Code reads it; nothing for a date or time that does not exist. */
function nextRun(now: Date, [minute, hour, day, month]: number[]): Date | undefined {
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
        const at = new Date(year, month - 1, day, hour, minute);

        // A day or hour the calendar does not have (the 30th of February, an hour skipped by the clock) rolls over to another time.
        if (at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) {
            return undefined;
        }

        if (at.getTime() > now.getTime()) {
            return at;
        }
    }

    return undefined;
}

/**
 * When the completed call `name` with `input` and the result text `output` is over, or `undefined` when it holds nothing (another tool, a monitor that
 * runs for the life of the session and names no end, a wakeup the agent marks as a no-op, a job that repeats or whose time cannot be read, a time too far
 * ahead). `now` is when the call ended.
 */
export function timingOf(name: string, input: unknown, output: string | undefined, now: Date): Timing | undefined {
    const given = isRecord(input) ? input : {};
    const timing = ((): Timing | undefined => {
        if (name === 'Monitor') {
            // A persistent monitor runs until it is stopped: no end to hold the session for (the adapter that lists it knows when it ends).
            if (given.persistent === true) {
                return undefined;
            }

            const asked = numberOf(given.timeout_ms);

            return { label: 'Monitor', what: lineOf(given.description) || lineOf(given.command), ms: Math.min(asked !== undefined && asked >= 0 ? asked : MONITOR_DEFAULT_MS, MONITOR_MAX_MS) };
        }

        if (name === 'ScheduleWakeup') {
            const said = WAKEUP_IN.exec(output ?? '');
            const delay = numberOf(given.delaySeconds);

            // The tool says when it will wake the agent; when its text is not the one known, the delay asked for plus the minute it is rounded up by.
            if (said) {
                return { label: 'Wakeup', what: lineOf(given.reason) || lineOf(given.prompt), ms: Number(said[1]) * 1000 };
            }

            return given.noop === true || delay === undefined || delay < 0 ? undefined : { label: 'Wakeup', what: lineOf(given.reason) || lineOf(given.prompt), ms: (delay + 60) * 1000 };
        }

        if (name === 'CronCreate') {
            const found = CRON_ONE_SHOT.exec(output ?? '');
            const at = found && given.recurring !== true ? nextRun(now, found.slice(1).map(Number)) : undefined;

            return at && { label: 'Wakeup', what: lineOf(given.prompt), ms: at.getTime() - now.getTime() + CRON_SLACK_MS };
        }

        return undefined;
    })();

    return timing && timing.ms <= MAX_DEADLINE_MS ? timing : undefined;
}
