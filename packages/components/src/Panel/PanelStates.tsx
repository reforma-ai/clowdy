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
        <Box align="center" justify="center" className={ cn(styles.emptyRow, className) }>
            <Text variant="label" color="secondary">
                { children }
            </Text>
        </Box>
    );
}

PanelEmptyRow.displayName = 'PanelEmptyRow';

/** Centered loader and label in place of a list that is still on its way. */
export function PanelLoadingState() {
    return (
        <Box direction="row" align="center" gap="md" className="m-auto" padding="lg">
            <Loader size="xs" />
            <Text color="secondary">Loading</Text>
        </Box>
    );
}

/** Centered optional icon, title, optional description, and optional action that fill the panel body. */
export function PanelEmptyState({
    icon,
    title,
    description,
    action,
}: {
    /** Shown above the title. */
    icon?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <Box
            className="m-auto"
            padding="lg"
            gap="md"
            grow
            fullHeight
            justify="center"
            align="center"
        >
            { icon }
            <Box gap="xs" align="center">
                <Text variant="heading-4" align="center">
                    { title }
                </Text>
                <Show when={ description }>
                    <Text variant="md" color="secondary" align="center">
                        { description }
                    </Text>
                </Show>
            </Box>
            { action }
        </Box>
    );
}
