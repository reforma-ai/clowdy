import { cn } from '@clowdy/lib';

import styles from './Scrollable.module.css';

import type { ReactNode, Ref } from 'react';

export type ScrollContainerProps = {
    children: ReactNode;
    ref?: Ref<HTMLDivElement | null>;
    contentRef?: Ref<HTMLDivElement | null>;
    containerClass?: string;
    contentClass?: string;
    onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
};

export function ScrollContainer({
    children,
    ref: userRef,
    contentRef,
    containerClass,
    contentClass,
    onScroll,
}: ScrollContainerProps) {
    return (
        <div
            ref={ userRef }
            className={ cn(styles.container, containerClass) }
            onScroll={ onScroll }
            tabIndex={ -1 }
        >
            <div
                ref={ contentRef }
                className={ cn(styles.content, contentClass) }
            >
                { children }
            </div>
        </div>
    );
}

ScrollContainer.displayName = 'ScrollContainer';
