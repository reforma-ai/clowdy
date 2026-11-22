/**
 * What a thought of the agent's is called in the stream: `Thinking…` while it goes on, then `Thought 3s` for the time it took (`Thought 1m 5s` past a
 * minute), and plain `Thought` when it took under a second or its time is unknown.
 */
export function thoughtLabel(done: boolean, durationMs?: number): string {
    if (!done) return 'Thinking…';

    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) return 'Thought';

    const seconds = Math.round(durationMs / 1000);

    if (seconds < 60) return `Thought ${ seconds }s`;

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) return seconds % 60 === 0 ? `Thought ${ minutes }m` : `Thought ${ minutes }m ${ seconds % 60 }s`;

    const hours = Math.floor(minutes / 60);

    return minutes % 60 === 0 ? `Thought ${ hours }h` : `Thought ${ hours }h ${ minutes % 60 }m`;
}
