/*
 * Every test runs as a person who asked the system for reduced motion: a view moves to its place at once, and no animation is left
 * running when a test ends and its DOM goes (happy-dom cancels it, and the cancel is an unhandled `AbortError` that fails the run).
 * Only the query for reduced motion is answered; any other goes to the window's own `matchMedia`.
 */
if (typeof window !== 'undefined') {
    const original = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined;

    window.matchMedia = (query: string): MediaQueryList => {
        if (!query.includes('prefers-reduced-motion')) {
            return original ? original(query) : { matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
        }

        return { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false };
    };
}
