import { cn } from '@clowdy/lib';

import styles from './Scrollable.module.css';

export type ScrollChromeBarsProps = {
    vertical?: boolean;
    horizontal?: boolean;
    setScrollbarV?: (el: HTMLDivElement | null) => void;
    setScrollbarH?: (el: HTMLDivElement | null) => void;
    onPointerDown: (e: React.PointerEvent) => void;
};

export function ScrollChromeBars({
    vertical,
    horizontal,
    setScrollbarV,
    setScrollbarH,
    onPointerDown,
}: ScrollChromeBarsProps) {
    const isVerticalEnabled = vertical ?? true;
    const isHorizontalEnabled = horizontal ?? false;

    return (
        <>
            {isVerticalEnabled && (
                <div
                    ref={setScrollbarV}
                    className={cn(styles.scrollbar, styles.scrollbarV)}
                    onPointerDown={onPointerDown}
                />
            )}

            {isHorizontalEnabled && (
                <div
                    ref={setScrollbarH}
                    className={cn(styles.scrollbar, styles.scrollbarH)}
                    onPointerDown={onPointerDown}
                />
            )}
        </>
    );
}

ScrollChromeBars.displayName = 'ScrollChromeBars';
