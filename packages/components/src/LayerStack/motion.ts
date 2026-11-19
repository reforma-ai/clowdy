import { MOTION_EASE_UI } from '@clowdy/constants';

/*
 * How views come and go, as Reforma's settings window has them: a section fades up as it opens, and a view opened from another one
 * slides in from the right while the one under it steps back to the left and fades out. One set of numbers for all of them, so a
 * screen that animates a switch by hand uses these and moves like the rest.
 */

/** The length of every enter, exit and step back of a view. */
export const PANE_DURATION_S = 0.35;
/** How far a view opened from another one starts to the right of its place, in px. */
export const SLIDE_IN = 32;
/** How far the view under it steps back to the left, in px. */
export const SLIDE_OUT = -12;
/** Where a section starts as it opens: dimmed and a little low, in px. */
export const SECTION_RISE = 8;
export const SECTION_START_OPACITY = 0.6;

/** The transition of a view that moves because another one opened over it or went away. */
export function paneTransition(reducedMotion: boolean | null) {
    return { duration: reducedMotion ? 0 : PANE_DURATION_S, ease: MOTION_EASE_UI };
}

/** The transition of a section opening. */
export function sectionTransition(reducedMotion: boolean | null) {
    return { duration: reducedMotion ? 0 : PANE_DURATION_S, ease: 'easeOut' as const };
}

/** Where a view rests: in place, or, once another one is open over it, stepped back and gone. */
export function layerRest(covered: boolean, reducedMotion: boolean | null) {
    return {
        opacity: covered ? 0 : 1,
        x: (covered && !reducedMotion) ? SLIDE_OUT : 0,
        y: 0,
    };
}
