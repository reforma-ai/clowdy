import { Menu, MenuItem } from '@clowdy/components/List';
import { Popover, PopoverScroll, type UseContextMenuResult } from '@clowdy/components/Popover';
import { Archive } from '@clowdy/icons/14';

import { archiveWording } from './archiveRules';

import type { Task } from '@clowdy/protocol';

export interface ArchiveMenuProps {
    /** The right-click menu's state (`useContextMenu`): the menu is drawn only while it is open. */
    contextMenu: UseContextMenuResult;
    /** The tasks the menu acts on: the selection when the one that was pressed is in it, else that task alone. */
    targets: readonly Task[];
    /** Whether any of them has open work, which the archive cancels first. */
    isOpen: boolean;
    onArchive: (tasks: readonly Task[]) => void;
}

/**
 * What can be done to a task from its card or row, in the menu a right-click or the keyboard's menu key opens: Archive, or Cancel and archive when there is open work to cancel,
 * with the count when it is a selection. Nothing else yet. The menu closes before the action runs, so the dialog that may follow does not open under it.
 */
export function ArchiveMenu({ contextMenu, targets, isOpen, onArchive }: ArchiveMenuProps) {
    if (!contextMenu.isOpen || targets.length === 0) return null;

    const { action } = archiveWording(targets, isOpen);

    return (
        <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
            <PopoverScroll>
                <Menu
                    aria-label="Task actions"
                    size="sm"
                    onAction={key => {
                        contextMenu.close();

                        if (key === 'archive') onArchive(targets);
                    }}
                >
                    <MenuItem id="archive" icon={<Archive />} textValue={action}>
                        {action}
                    </MenuItem>
                </Menu>
            </PopoverScroll>
        </Popover>
    );
}
