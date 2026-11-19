import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { sectionTransition } from '../LayerStack/motion';

import type { ReactNode } from 'react';

const FADE_DURATION_S = 0.2;

export interface FadeProps {
    /** What is shown. Nothing, `null`, `false` or an empty string is no element at all. */
    children?: ReactNode;
    className?: string;
}

/**
 * Gives what comes and goes a fade, for the part of a screen that is there on one view and gone on the next (the action of a page
 * that has none once a view is open over it). The element is drawn while there are children and for a moment after they go; what
 * is there when it first renders does not fade in. Reduced motion asked for: no fade.
 */
export function Fade({ children, className }: FadeProps) {
    const reducedMotion = useReducedMotion();

    return (
        <AnimatePresence initial={ false }>
            { children
                ? (
                    <motion.div
                        key="fade"
                        className={ className }
                        initial={ reducedMotion ? false : { opacity: 0 } }
                        animate={ { opacity: 1 } }
                        exit={ reducedMotion ? undefined : { opacity: 0 } }
                        transition={ { ...sectionTransition(reducedMotion), duration: reducedMotion ? 0 : FADE_DURATION_S } }
                    >
                        { children }
                    </motion.div>
                )
                : null }
        </AnimatePresence>
    );
}
