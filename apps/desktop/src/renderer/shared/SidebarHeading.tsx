import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';

import { SCREEN_TITLE } from './screenTitle';
import styles from './SidebarHeading.module.css';

import type { ReactNode, Ref } from 'react';

export interface SidebarHeadingProps {
    title: string;
    /** Buttons at the right edge. */
    children?: ReactNode;
    /** The column's own padding goes here, so the heading lines up with what is below it. */
    className?: string;
    /** The heading's own element, for a popover that is as wide as the column. */
    ref?: Ref<HTMLDivElement>;
}

/** The title of a screen's left column (Agents, Settings), with its buttons at the right edge: the title of Tasks' header, without the toolbar. */
export function SidebarHeading({ title, children, className, ref }: SidebarHeadingProps) {
    return (
        <div ref={ ref } className={ cn(styles.heading, className) }>
            <Text variant={ SCREEN_TITLE }>{ title }</Text>
            { children && <div className={ styles.actions }>{ children }</div> }
        </div>
    );
}
