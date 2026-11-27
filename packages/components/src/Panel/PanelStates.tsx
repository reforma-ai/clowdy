import { cn } from '@clowdy/lib';

import { Box } from '../Box';
import { Loader } from '../Loader';
import { Show } from '../Show';
import { Text } from '../Text';
import styles from './Panel.module.css';

import type { ReactNode } from 'react';

/** Centered note in place of an empty list or section. */
export function PanelEmptyRow({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <Box align="center" justify="center" className={cn(styles.emptyRow, className)}>
            <Text variant="label" color="secondary">
                {children}
            </Text>
        </Box>
    );
}

PanelEmptyRow.displayName = 'PanelEmptyRow';

/** Centered loader and a line on what is loading, in place of a list or a page that is still on its way. */
export function PanelLoadingState({ label = 'Loading', className }: { label?: ReactNode; className?: string }) {
    return (
        <Box direction="row" align="center" gap="md" padding="lg" role="status" className={cn('m-auto', className)}>
            <Loader size="xs" />
            <Text color="secondary">{label}</Text>
        </Box>
    );
}

PanelLoadingState.displayName = 'PanelLoadingState';

export interface PanelEmptyStateProps {
    /** Shown above the title. */
    icon?: ReactNode;
    /** The heading of a state with a description or an action. */
    title?: ReactNode;
    /** One quiet line, for a state that says only what is missing (`No tasks`). Use it in place of `title`. */
    label?: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    /** Grow to fill the panel body and centre in it (the default), or sit in the flow of a section. */
    fill?: boolean;
    className?: string;
}

/** Centered optional icon, a title or a one-line label, optional description, and optional action, in place of an empty panel, page or section. */
export function PanelEmptyState({
    icon,
    title,
    label,
    description,
    action,
    fill = true,
    className,
}: PanelEmptyStateProps) {
    return (
        <Box
            padding="lg"
            gap="md"
            grow={fill}
            fullHeight={fill}
            justify="center"
            align="center"
            className={cn(fill && 'm-auto', className)}
        >
            {icon}
            <Box gap="xs" align="center">
                <Show when={title}>
                    <Text variant="heading-4" align="center">
                        {title}
                    </Text>
                </Show>
                <Show when={label}>
                    <Text variant="md" color="secondary" align="center">
                        {label}
                    </Text>
                </Show>
                <Show when={description}>
                    <Text variant="md" color="secondary" align="center">
                        {description}
                    </Text>
                </Show>
            </Box>
            {action}
        </Box>
    );
}

PanelEmptyState.displayName = 'PanelEmptyState';
