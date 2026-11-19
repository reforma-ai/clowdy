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

/**
 * How long until something: `now` under a minute, then `28m`, `4h 45m`, `6d`, `17d 5h`. The smaller unit is left out when
 * it is zero, and the time is rounded down, so a reset never shows later than it is.
 */
export function formatRemaining(milliseconds: number): string {
    const minutes = Math.floor(milliseconds / 60_000);

    if (minutes < 1) return 'now';

    if (minutes < 60) return `${ minutes }m`;

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return minutes % 60 === 0 ? `${ hours }h` : `${ hours }h ${ minutes % 60 }m`;

    const days = Math.floor(hours / 24);

    return hours % 24 === 0 ? `${ days }d` : `${ days }d ${ hours % 24 }h`;
}

/** How long ago, in the fewest characters: `now` under a minute, then `28m`, `3h`, `2d`, `5w`, `4mo`, `2y`. Rounded down. */
export function formatElapsed(milliseconds: number): string {
    const minutes = Math.floor(milliseconds / 60_000);

    if (minutes < 1) return 'now';

    if (minutes < 60) return `${ minutes }m`;

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return `${ hours }h`;

    const days = Math.floor(hours / 24);

    if (days < 7) return `${ days }d`;

    if (days < 30) return `${ Math.floor(days / 7) }w`;

    if (days < 365) return `${ Math.floor(days / 30) }mo`;

    return `${ Math.floor(days / 365) }y`;
}

const plural = (count: number, unit: string) => `${ count } ${ unit }${ count === 1 ? '' : 's' }`;

/** What `formatRemaining` says, in words for a screen reader: `less than a minute`, `28 minutes`, `1 hour 32 minutes`, `6 days 2 hours`. */
export function describeRemaining(milliseconds: number): string {
    const minutes = Math.floor(milliseconds / 60_000);

    if (minutes < 1) return 'less than a minute';

    if (minutes < 60) return plural(minutes, 'minute');

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return minutes % 60 === 0 ? plural(hours, 'hour') : `${ plural(hours, 'hour') } ${ plural(minutes % 60, 'minute') }`;

    const days = Math.floor(hours / 24);

    return hours % 24 === 0 ? plural(days, 'day') : `${ plural(days, 'day') } ${ plural(hours % 24, 'hour') }`;
}
