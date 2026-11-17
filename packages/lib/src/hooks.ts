import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query and returns whether it currently matches.
 * Re-renders the component when the match state changes.
 *
 * @param query - CSS media query string (e.g., '(min-width: 1200px)')
 * @returns `true` if the query matches, `false` otherwise
 *
 * @example
 *
 * const isDesktop = useMediaQuery('(min-width: 1200px)');
 *
 */
export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback((callback: () => void) => {
        const mql = window.matchMedia(query);

        mql.addEventListener('change', callback);

        return () => mql.removeEventListener('change', callback);
    }, [query]);

    const getSnapshot = () => window.matchMedia(query).matches;
    const getServerSnapshot = () => false;

    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
