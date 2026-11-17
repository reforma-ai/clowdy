/** Standard UI easing (cubic bezier) — Motion, collapsible panels, chat blocks. */
export const MOTION_EASE_UI = [0.32, 0.72, 0, 1] as const;

/** Default transition for collapsible `motion.div` content (Exploring, Reasoning, Sources). */
export const MOTION_TRANSITION_COLLAPSE = {
    duration: 0.2,
    ease: MOTION_EASE_UI,
} as const;
