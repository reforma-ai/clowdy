import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';

import styles from './SidebarHeading.module.css';
import { SCREEN_TITLE } from './screenTitle';

import type { ReactNode, Ref } from 'react';

export interface SidebarHeadingProps {
    /** The title's words, set as a screen's title is, or a control that is the title (the project select). */
    title: ReactNode;
    /** Buttons at the right edge. */
    children?: ReactNode;
    /** The column's own padding goes here, so the heading lines up with what is below it. */
    className?: string;
    /** The heading's own element, for a popover that is as wide as the column. */
    ref?: Ref<HTMLDivElement>;
}

/** The title of a screen's left column (the project select above the chats), with its buttons at the right edge: the title of Tasks' header, without the toolbar. */
export function SidebarHeading({ title, children, className, ref }: SidebarHeadingProps) {
    return (
        <div ref={ref} className={cn(styles.heading, className)}>
            {typeof title === 'string' ? <Text variant={SCREEN_TITLE}>{title}</Text> : title}
            {children && <div className={styles.actions}>{children}</div>}
        </div>
    );
}
