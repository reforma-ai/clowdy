import { useEffect, useState } from 'react';

/**
 * The current time in milliseconds, read at every render, and a render every `intervalMs`: "resets in 28m" keeps counting
 * down while the page is open, and a reading that just arrived is not measured against a time read before it.
 */
export function useNow(intervalMs = 30_000): number {
    const [, tick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => tick(count => count + 1), intervalMs);

        return () => clearInterval(timer);
    }, [intervalMs]);

    return Date.now();
}
