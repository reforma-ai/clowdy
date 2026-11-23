import { Menu, MenuItem, MenuSeparator } from '@clowdy/components/List';
import { PopoverScroll } from '@clowdy/components/Popover';
import { Archive, EditPen, Trash } from '@clowdy/icons/14';

export interface ChatMenuProps {
    /** Why the chat can be neither archived nor deleted now (its agents, or the agents of its threads, are working); absent when it can. */
    busy?: string;
    /** Closes the popover the menu is in. Called before the action runs. */
    onClose: () => void;
    onRename: () => void;
    onArchive: () => void;
    onDelete: () => void;
}

/** What can be done to a chat in the list: the content of its `⋯` popover and of its right-click menu. */
export function ChatMenu({ busy, onClose, onRename, onArchive, onDelete }: ChatMenuProps) {
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
                }}
            >
                <MenuItem id="rename" icon={<EditPen />} textValue="Rename">
                    Rename
                </MenuItem>
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
