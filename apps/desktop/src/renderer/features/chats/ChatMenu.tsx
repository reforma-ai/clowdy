import { Menu, MenuItem, MenuSeparator } from '@clowdy/components/List';
import { PopoverScroll } from '@clowdy/components/Popover';
import { Archive, ArrowDown, ArrowUp, EditPen, Trash } from '@clowdy/icons/14';

export interface ChatMenuProps {
    /** Why the chat can be neither archived nor deleted now (its agents, or the agents of its threads, are working); absent when it can. */
    busy?: string;
    /** Closes the popover the menu is in. Called before the action runs. */
    onClose: () => void;
    onRename: () => void;
    onArchive: () => void;
    onDelete: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
}

/** What can be done to a chat in the list: the content of its `⋯` popover and of its right-click menu. */
export function ChatMenu({ busy, onClose, onRename, onArchive, onDelete, onMoveUp, onMoveDown }: ChatMenuProps) {
    return (
        <PopoverScroll>
            <Menu
                aria-label="Chat actions"
                size="sm"
                onAction={key => {
                    onClose();

                    if (key === 'rename') onRename();
                    else if (key === 'archive') onArchive();
                    else if (key === 'delete') onDelete();
                    else if (key === 'move-up') onMoveUp?.();
                    else if (key === 'move-down') onMoveDown?.();
                }}
            >
                <MenuItem id="rename" icon={<EditPen />} textValue="Rename">
                    Rename
                </MenuItem>
                {onMoveUp && (
                    <MenuItem id="move-up" icon={<ArrowUp />} textValue="Move up">
                        Move up
                    </MenuItem>
                )}
                {onMoveDown && (
                    <MenuItem id="move-down" icon={<ArrowDown />} textValue="Move down">
                        Move down
                    </MenuItem>
                )}
                <MenuItem
                    id="archive"
                    icon={<Archive />}
                    textValue="Archive"
                    isDisabled={busy !== undefined}
                    description={busy}
                >
                    Archive
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                    id="delete"
                    icon={<Trash />}
                    textValue="Delete"
                    isDanger
                    isDisabled={busy !== undefined}
                    description={busy}
                >
                    Delete
                </MenuItem>
            </Menu>
        </PopoverScroll>
    );
}
