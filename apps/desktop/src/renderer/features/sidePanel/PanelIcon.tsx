import { cn } from '@clowdy/lib';

import styles from './PanelIcon.module.css';

import type { CSSProperties } from 'react';

/** The side panel's sizes: not shown, beside the chat, and expanded into the chat's place. */
export type PanelIconState = 'none' | 'small' | 'large';

/**
 * Where the panel sits inside the frame in each state, in the icon's 14px box (the geometry of `NoPanel`, `SmallPanel` and `LargePanel` of the 14 pack, which this icon
 * stands for in one): the right edge stays at 11, the left one moves, and the radius follows the width.
 */
const PANEL: Record<PanelIconState, { x: number; width: number; rx: number }> = {
    none: { x: 10, width: 1, rx: 0.5 },
    small: { x: 7, width: 4, rx: 1 },
    large: { x: 4, width: 7, rx: 1 },
};

/** The frame of the three icons. */
const FRAME = 'M11.0002 1C12.1047 1.00013 13.0002 1.89551 13.0002 3V11C13.0001 12.1044 12.1046 12.9999 11.0002 13H3.00024C1.89576 13 1.00038 12.1045 1.00024 11V3C1.00024 1.89543 1.89567 1 3.00024 1H11.0002ZM3.00024 2C2.44796 2 2.00024 2.44772 2.00024 3V11C2.00038 11.5522 2.44804 12 3.00024 12H11.0002C11.5523 11.9999 12.0001 11.5521 12.0002 11V3C12.0002 2.4478 11.5524 2.00013 11.0002 2H3.00024Z';

export interface PanelIconProps {
    /** What the panel is now: the icon draws it so. */
    state: PanelIconState;
    className?: string;
}

/**
 * One icon for the three sizes of the side panel, in the place of a different icon for each: a frame with the panel inside it, drawn as the panel is, which glides to the new
 * size when the state changes. The geometry comes from here and the motion from the stylesheet, so the icon is the same size and colour as the rest of the 14 pack (`currentColor`).
 */
export function PanelIcon({ state, className }: PanelIconProps) {
    const { x, width, rx } = PANEL[state];
    const vars = {
        '--x': `${ x }px`,
        '--width': `${ width }px`,
        '--rx': `${ rx }px`,
    } as CSSProperties;

    return (
        <svg
            className={ cn('clowdy-icon', styles.icon, className) }
            width={ 14 }
            height={ 14 }
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            data-state={ state }
            style={ vars }
        >
            <path d={ FRAME } fill="currentColor" />
            <rect className={ styles.panel } y={ 3 } height={ 8 } opacity={ 0.85 } fill="currentColor" />
        </svg>
    );
}
