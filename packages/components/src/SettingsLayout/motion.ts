import { MOTION_EASE_UI } from '@clowdy/constants';

/*
 * How the settings window's nested pages come and go: a page opened over another slides in from the right while the one under it steps back to
 * the left and fades out. The sections of the page's own list switch without any move.
 */

/** The length of the enter, the exit and the step back of a pane. */
const PANE_DURATION_S = 0.35;
/** How far a pane opened over another one starts to the right of its place, in px. */
export const SLIDE_IN = 32;
/** How far the view under a pane steps back to the left, in px. */
const SLIDE_OUT = -12;

/** The transition of a view that moves because a pane opened over it or went away. */
export function paneTransition(reducedMotion: boolean | null) {
    return { duration: reducedMotion ? 0 : PANE_DURATION_S, ease: MOTION_EASE_UI };
}

/** Where a view rests: in place, or, once a pane is open over it, stepped back and gone. */
export function layerRest(covered: boolean, reducedMotion: boolean | null) {
    return {
        opacity: covered ? 0 : 1,
        x: (covered && !reducedMotion) ? SLIDE_OUT : 0,
        y: 0,
    };
}
