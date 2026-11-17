const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The time of day, `14:21`, in the person's time zone. */
export function formatTime(at: number): string {
    return clock.format(at);
}

/** How long something took: `45s`, `2m 14s`, `1h 05m`. */
export function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));

    if (seconds < 60) return `${ seconds }s`;

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) return `${ minutes }m ${ String(seconds % 60).padStart(2, '0') }s`;

    return `${ Math.floor(minutes / 60) }h ${ String(minutes % 60).padStart(2, '0') }m`;
}
