import { Button } from '@clowdy/components/Button';
import { GridListItem, RowControls } from '@clowdy/components/List';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';

import styles from './AgentList.module.css';

import type { ComponentProps, ReactNode } from 'react';

type Props = Omit<ComponentProps<typeof GridListItem>, 'children'> & {
    name: ReactNode;
    collapsed: boolean;
    onToggle: () => void;
};

export function GroupHeader({ name, collapsed, onToggle, text, className, ...props }: Props) {
    return (
        <GridListItem
            {...props}
            text={text}
            className={className ? `${styles.group} ${className}` : styles.group}
            plateless
        >
            <RowControls className={styles.groupTitle}>
                <Button
                    variant="filling"
                    color="inherit"
                    size="xs"
                    truncate
                    className={styles.groupToggle}
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${text}`}
                    aria-expanded={!collapsed}
                    onPress={onToggle}
                >
                    {name}
                    {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                </Button>
            </RowControls>
        </GridListItem>
    );
}
