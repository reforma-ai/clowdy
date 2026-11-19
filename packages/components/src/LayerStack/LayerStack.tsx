import { cn } from '@clowdy/lib';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { Scrollable } from '../Scrollable';
import styles from './LayerStack.module.css';
import { layerRest, paneTransition, SECTION_RISE, SECTION_START_OPACITY, sectionTransition, SLIDE_IN } from './motion';

import type { ReactNode } from 'react';

const MotionScrollable = motion.create(Scrollable);

export interface LayerStackLayer {
    /** Names the layer for as long as it is open. */
    id: string;
    content: ReactNode;
}

export interface LayerStackProps {
    /** The view under the layers. It rises into place as it mounts, which is how a section opens: give it a new `key` from outside to open it again. */
    children: ReactNode;
    /** Views opened from the one below, deepest last. A layer slides in from the right, and the one under it steps back and is covered, scroll kept, until this one goes. */
    layers?: readonly LayerStackLayer[];
    /** The room the layers share. */
    className?: string;
    /** Every layer, the view under them too: the scroll container, which is as big as the stack. */
    layerClassName?: string;
    /** The content element of every layer's scroll container. */
    contentClassName?: string;
}

/**
 * Views that stack, each in a scroll container of its own: the one that is open and the ones it was opened from, which stay mounted
 * under it, inert, with their scroll position, so going back finds them as they were. Fill a flex column with it (it grows to take
 * what its parent leaves). A view opened from another one comes in from the right and the one under it steps back, a section that
 * opens rises into place, and a person who asks the system for reduced motion gets the same moves in no time. The numbers are in `./motion`.
 */
export function LayerStack({ children, layers = [], className, layerClassName, contentClassName }: LayerStackProps) {
    const reducedMotion = useReducedMotion();
    const covered = layers.length > 0;

    return (
        <div className={ cn(styles.stack, className) }>
            <MotionScrollable
                className={ cn(styles.layer, layerClassName) }
                contentClass={ contentClassName }
                // A stack that opens with layers already over its base has no rise to play.
                initial={ (reducedMotion || covered) ? false : { opacity: SECTION_START_OPACITY, y: SECTION_RISE } }
                animate={ layerRest(covered, reducedMotion) }
                transition={ covered ? paneTransition(reducedMotion) : sectionTransition(reducedMotion) }
                inert={ covered }
            >
                { children }
            </MotionScrollable>

            <AnimatePresence initial={ false }>
                { layers.map((layer, index) => (
                    <MotionScrollable
                        key={ layer.id }
                        className={ cn(styles.layer, layerClassName) }
                        contentClass={ contentClassName }
                        initial={ reducedMotion ? false : { opacity: 0, x: SLIDE_IN } }
                        animate={ layerRest(index < layers.length - 1, reducedMotion) }
                        exit={ reducedMotion ? undefined : { opacity: 0, x: SLIDE_IN, pointerEvents: 'none' } }
                        transition={ paneTransition(reducedMotion) }
                        inert={ index < layers.length - 1 }
                    >
                        { layer.content }
                    </MotionScrollable>
                )) }
            </AnimatePresence>
        </div>
    );
}
