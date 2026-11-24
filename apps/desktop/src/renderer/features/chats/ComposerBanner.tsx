import { Button } from '@clowdy/components/Button';
import { CollapsibleContent } from '@clowdy/components/Collapsible';
import { GridList } from '@clowdy/components/List';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Text } from '@clowdy/components/Text';
import { ChevronDown } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import styles from './ComposerBanner.module.css';

import type { ButtonProps } from '@clowdy/components/Button';
import type { HTMLAttributes, ReactNode } from 'react';

/** The plate above the message box that status rows sit on (Reforma's `ComposerBanner`, dense form): one tight line per row, no rules between. */
export function ComposerBanner({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={cn(styles.root, className)} {...props}>
            {children}
        </div>
    );
}

/** The scroll area and list shared by the file and task disclosures. */
export function ComposerBannerList({
    label,
    onAction,
    children,
}: {
    label: string;
    onAction: (id: string) => void;
    children: ReactNode;
}) {
    return (
        <CollapsibleContent asChild>
            <Scrollable
                className={styles.listViewport}
                containerClass={styles.listScroll}
                contentClass={styles.listRows}
            >
                <GridList aria-label={label} size="sm" className={styles.list} onAction={key => onAction(String(key))}>
                    {children}
                </GridList>
            </Scrollable>
        </CollapsibleContent>
    );
}

export interface ComposerBannerStatusProps {
    children: ReactNode;
    icon?: ReactNode;
    /** Optional trailing status or progress, kept visible beside a truncated name. */
    detail?: ReactNode;
    progress?: ReactNode;
    /** The words of the row's button, such as `Stop`. No button without it. */
    action?: string;
    onAction?: () => void;
    /** A press anywhere on the row but the button. The button then shows on hover or focus. */
    onPress?: () => void;
    /** What a screen reader hears for the pressable row. */
    pressLabel?: string;
}

/** One row of the plate: an icon, a line of text, and a button at its end. */
export function ComposerBannerStatus({
    children,
    icon,
    detail,
    progress,
    action,
    onAction,
    onPress,
    pressLabel,
}: ComposerBannerStatusProps) {
    const message = (
        <>
            {icon && (
                <span className={styles.icon} aria-hidden>
                    {icon}
                </span>
            )}
            <Text variant="xs" className={styles.text}>
                {children}
            </Text>
            {(detail || progress) && (
                <span className={styles.details}>
                    {detail && (
                        <Text variant="xs" className={styles.detail}>
                            {detail}
                        </Text>
                    )}
                    {progress && (
                        <Text variant="xs" className={styles.progress}>
                            {progress}
                        </Text>
                    )}
                </span>
            )}
        </>
    );

    return (
        <div className={styles.status} data-pressable={onPress ? true : undefined}>
            {onPress ? (
                <button type="button" className={styles.press} aria-label={pressLabel} onClick={onPress}>
                    {message}
                </button>
            ) : (
                message
            )}
            {action && (
                <Button
                    size="xs"
                    variant="ghost"
                    color="secondary"
                    className={styles.action}
                    isDisabled={!onAction}
                    onPress={onAction}
                >
                    {action}
                </Button>
            )}
        </div>
    );
}

interface ComposerBannerHeaderProps extends ButtonProps {
    summary: ReactNode;
    expanded: boolean;
    /** A separate control, such as Stop all, that does not toggle the rows. */
    action?: ReactNode;
}

/** Full-width disclosure with a summary and a chevron at the end. */
export function ComposerBannerHeader({
    children,
    className,
    contentClassName,
    summary,
    expanded,
    action,
    ...props
}: ComposerBannerHeaderProps) {
    return (
        <div className={styles.header} data-has-action={action ? true : undefined}>
            <Button
                {...props}
                variant="filling"
                color="secondary"
                size="sm"
                className={cn(styles.disclosure, className)}
                contentClassName={cn(styles.headerContent, contentClassName)}
                aria-expanded={expanded}
            >
                <Text variant="xs" weight="medium" className={styles.headerTitle}>
                    {children}
                </Text>
                <span className={styles.summary}>
                    {summary}
                    <ChevronDown className="chevron next" aria-expanded={expanded} aria-hidden />
                </span>
            </Button>
            {action && <span className={styles.headerAction}>{action}</span>}
        </div>
    );
}
