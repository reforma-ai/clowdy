import { Button } from '@clowdy/components/Button';
import { GridListItem, RowControls } from '@clowdy/components/List';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';

import styles from './AgentList.module.css';

import type { ComponentProps, ReactNode } from 'react';

type Props = Omit<ComponentProps<typeof GridListItem>, 'children'> & {
    name: ReactNode;
    icon: ReactNode;
    collapsed: boolean;
    onToggle: () => void;
};

export function GroupHeader({ name, icon, collapsed, onToggle, text, className, onContextMenu, ...props }: Props) {
    return (
        <GridListItem
            {...props}
            text={text}
            className={className ? `${styles.group} ${className}` : styles.group}
            plateless
            onContextMenu={onContextMenu}
        >
            <RowControls className={styles.groupTitle} onContextMenu={onContextMenu}>
                <Button
                    variant="filling"
                    color="inherit"
                    size="xs"
                    className={styles.groupToggle}
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${text}`}
                    aria-expanded={!collapsed}
                    onPress={onToggle}
                >
                    <span className={styles.groupIcon}>{icon}</span>
                    <span className={styles.groupChevron}>
                        {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                    </span>
                </Button>
                {name}
            </RowControls>
        </GridListItem>
    );
}
