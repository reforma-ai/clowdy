import { cn } from '@clowdy/lib';
import { type ComponentProps, type HTMLAttributes, type ReactNode, type Ref } from 'react';

import { Button } from '../Button';
import { Scrollable } from '../Scrollable';
import styles from './Panel.module.css';

type PanelSide = 'left' | 'right';

interface PanelProps {
    children: ReactNode;
    className?: string;
    ref?: Ref<HTMLElement>;
    side: PanelSide;
    'data-collapsed'?: string;
}

export function Panel({ children, className, side, 'data-collapsed': dataCollapsed, ...rest }: PanelProps) {
    return (
        <aside
            className={cn(styles.panel, side === 'left' ? styles.panelLeft : styles.panelRight, className)}
            data-collapsed={dataCollapsed}
            {...rest}
        >
            {children}
        </aside>
    );
}

function PanelHeaderRoot({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={cn(styles.title, className)} {...props}>
            {children}
        </div>
    );
}

function PanelHeaderActions({ children }: { children: ReactNode }) {
    return <div className={styles.titleActions}>{children}</div>;
}

function PanelHeaderButton(props: ComponentProps<typeof Button>) {
    return <Button variant="filling" color="secondary" size="sm" iconOnly {...props} />;
}

/** 40px panel bar. Tabs or a title on the left, `PanelHeader.Actions` on the right. */
export const PanelHeader = Object.assign(PanelHeaderRoot, {
    Actions: PanelHeaderActions,
    Button: PanelHeaderButton,
});

/** Scrollable panel body that fills the space below the header. */
export function PanelContent({ className, ...props }: ComponentProps<typeof Scrollable>) {
    return <Scrollable className={cn(styles.body, className)} {...props} />;
}

/** The body of a tab: fills the space under the header. */
export function PanelTab({ children }: { children: ReactNode }) {
    return <div className={styles.tab}>{children}</div>;
}
