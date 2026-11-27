/*
 * Every test runs as a person who asked the system for reduced motion: a view moves to its place at once, and no animation is left
 * running when a test ends and its DOM goes (happy-dom cancels it, and the cancel is an unhandled `AbortError` that fails the run).
 * Only the query for reduced motion is answered; any other goes to the window's own `matchMedia`.
 */
if (typeof window !== 'undefined') {
    // happy-dom's Response lacks the standard bytes() method used by Shiki to load its compressed WebAssembly.
    if (typeof Response.prototype.bytes !== 'function') {
        Response.prototype.bytes = async function bytes() {
            return new Uint8Array(await this.arrayBuffer());
        };
    }

    const original = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined;

    window.matchMedia = (query: string): MediaQueryList => {
        if (!query.includes('prefers-reduced-motion')) {
            return original
                ? original(query)
                : {
                      matches: false,
                      media: query,
                      onchange: null,
                      addEventListener() {},
                      removeEventListener() {},
                      addListener() {},
                      removeListener() {},
                      dispatchEvent: () => false,
                  };
        }

        return {
            matches: true,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
        };
    };
}

/*
 * Makes happy-dom's `Animation` match browsers when an animation is cancelled: the Web Animations spec rejects the `finished` promise of a cancelled animation and marks it as handled, so
 * a browser reports no unhandled rejection when nobody awaits it (a dialog that closes cancels the animations of its content). happy-dom rejects it without the mark, and Vitest fails the
 * run on the unhandled `AbortError`. The design system's own tests do the same (`packages/components/src/vitest.setup.ts`). Only DOM tests have an `Animation`.
 */
if (typeof Animation === 'function') {
    const cancel = Animation.prototype.cancel;

    Animation.prototype.cancel = function cancelAndMarkFinishedHandled(this: Animation) {
        this.finished.catch(() => undefined);
        cancel.call(this);
    };
}
