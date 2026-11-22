import { Tooltip } from '@clowdy/components/Tooltip';
import { cn } from '@clowdy/lib';

import styles from './RailItem.module.css';

import type { ComponentProps, ComponentType, ReactNode, SVGProps } from 'react';

export interface RailItemProps {
    label: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    /** The icon is drawn at its own size: the 16 pack where it has the glyph, else the 14 pack, never scaled. */
    size: number;
    /** The item is the page the rail shows now (`aria-current`). */
    current: boolean;
    disabled?: boolean;
    /** What a tooltip says (the label is on the button already, so it is for the key that does the same); none, no tooltip. */
    tooltip?: ReactNode;
    /** Beside which edge of the item the tooltip opens: away from the rail's own edge of the window. */
    tooltipPlacement?: ComponentProps<typeof Tooltip>['placement'];
    className?: string;
    onPress: () => void;
}

/** An item of a rail, the column of a glyph tile and a label under it: the window's left rail and the side panel's right one are made of these. */
export function RailItem({ label, icon: Icon, size, current, disabled, tooltip, tooltipPlacement = 'right', className, onPress }: RailItemProps) {
    return (
        <Tooltip content={ tooltip } placement={ tooltipPlacement }>
            <button
                type="button"
                className={ cn(styles.item, className) }
                disabled={ disabled }
                aria-current={ current ? 'page' : undefined }
                onClick={ onPress }
            >
                <span className={ styles.glyph }>
                    <Icon width={ size } height={ size } aria-hidden />
                </span>
                <span className={ styles.label }>{ label }</span>
            </button>
        </Tooltip>
    );
}
