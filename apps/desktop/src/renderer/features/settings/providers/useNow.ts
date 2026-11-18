import { useEffect, useState } from 'react';

/** The current time in milliseconds, read again every `intervalMs`, so "resets in 28m" keeps counting down while the page is open. */
export function useNow(intervalMs = 30_000): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);

        return () => clearInterval(timer);
    }, [intervalMs]);

    return now;
}
