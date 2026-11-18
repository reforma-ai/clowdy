import { Menu, MenuItem, MenuSeparator } from '@clowdy/components/List';
import { PopoverScroll } from '@clowdy/components/Popover';
import { EditPen, Trash } from '@clowdy/icons/14';

export interface ChatMenuProps {
    /** A chat whose agents are working cannot be deleted. */
    isBusy: boolean;
    /** Closes the popover the menu is in. Called before the action runs. */
    onClose: () => void;
    onRename: () => void;
    onDelete: () => void;
}

/** What can be done to a chat: the content of its `⋯` popover and of its right-click menu. */
export function ChatMenu({ isBusy, onClose, onRename, onDelete }: ChatMenuProps) {
    return (
        <PopoverScroll>
            <Menu
                aria-label="Chat actions"
                size="sm"
                onAction={ (key) => {
                    onClose();

                    if (key === 'rename') onRename();
                    else if (key === 'delete') onDelete();
                } }
            >
                <MenuItem id="rename" icon={ <EditPen /> } textValue="Rename">Rename</MenuItem>
                <MenuSeparator />
                <MenuItem
                    id="delete"
                    icon={ <Trash /> }
                    textValue="Delete"
                    isDanger
                    isDisabled={ isBusy }
                    description={ isBusy ? 'Stop the chat first' : undefined }
                >
                    Delete
                </MenuItem>
            </Menu>
        </PopoverScroll>
    );
}
