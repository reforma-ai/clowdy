/*
 * Makes happy-dom's `Animation` match browsers when an animation is cancelled. The Web Animations spec rejects the `finished` promise of a
 * cancelled animation and marks it as handled, so a browser reports no unhandled rejection when nobody awaits it (motion cancels the
 * animations of an element that unmounts). happy-dom rejects it without the mark, and Vitest fails the run on the unhandled `AbortError`.
 * Only DOM tests have an `Animation`; in a node test this does nothing.
 */
if (typeof Animation === 'function') {
    const cancel = Animation.prototype.cancel;

    Animation.prototype.cancel = function cancelAndMarkFinishedHandled(this: Animation) {
        this.finished.catch(() => undefined);
        cancel.call(this);
    };
}
