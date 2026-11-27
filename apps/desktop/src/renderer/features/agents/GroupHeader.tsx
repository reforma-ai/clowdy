import { GridListItem, listBoxItemDataShow, RowControls } from '@clowdy/components/List';
import { FoldButton } from '@clowdy/components/Panel';

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
            <span className={styles.groupTitle}>
                <RowControls className={styles.groupNameBox}>{name}</RowControls>
                <RowControls className={styles.groupFold}>
                    <FoldButton
                        label={`${collapsed ? 'Expand' : 'Collapse'} ${text}`}
                        isExpanded={!collapsed}
                        data-show={collapsed ? undefined : listBoxItemDataShow.itemBoth}
                        onToggle={onToggle}
                    />
                </RowControls>
            </span>
        </GridListItem>
    );
}
