import { listBoxItemDataShow, RowControls } from '@clowdy/components/List';
import { FoldButton } from '@clowdy/components/Panel';

import styles from './RowFold.module.css';

import type { ReactNode } from 'react';

/**
 * The icon of a row that has lines below it (threads, sub-agents, a worktree's chats): on hover the chevron that folds them takes its place, in the same room.
 * `revealOnFocus` also shows the chevron while the row has the focus (a worktree's heading).
 */
export function RowFold({
    label,
    isExpanded,
    icon,
    onToggle,
    revealOnFocus = false,
}: {
    label: string;
    isExpanded: boolean;
    icon: ReactNode;
    onToggle: () => void;
    revealOnFocus?: boolean;
}) {
    return (
        <span className={styles.foldIcon} data-reveal-on-focus={revealOnFocus || undefined}>
            <span className={styles.restIcon} data-show={listBoxItemDataShow.itemRest}>
                {icon}
            </span>
            <RowControls className={styles.fold} data-show={listBoxItemDataShow.itemHover}>
                <FoldButton tabIndex={-1} label={label} isExpanded={isExpanded} onToggle={onToggle} />
            </RowControls>
        </span>
    );
}
