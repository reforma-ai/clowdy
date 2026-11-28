import { flushSync } from 'react-dom';

let running: ViewTransition | undefined;

/**
 * Shows a switch of project as a view transition: the plates and the list of chats stay, while what is on the chat's and
 * the side panel's plates fades out to nothing and the new project's fades in from nothing (the styles are in
 * `base.css`, under `html[data-space-switch]`). Whatever the new project shows there, another tab or none, comes
 * in the same way. At once when the browser cannot, or the person prefers less motion.
 */
export function spaceSwitch(apply: () => void): void {
    if (!('startViewTransition' in document) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        apply();
        return;
    }

    const html = document.documentElement;
    html.dataset.spaceSwitch = '';
    try {
        // The window is drawn for the new project before the transition captures it.
        const transition = document.startViewTransition(() => flushSync(apply));
        running = transition;
        const done = () => {
            if (running !== transition) return;
            running = undefined;
            delete html.dataset.spaceSwitch;
        };
        transition.finished.then(done, done);
    } catch {
        delete html.dataset.spaceSwitch;
        apply();
    }
}
