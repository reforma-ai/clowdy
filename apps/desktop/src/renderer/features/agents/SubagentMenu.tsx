import { Menu, MenuItem } from '@clowdy/components/List';
import { PopoverScroll } from '@clowdy/components/Popover';
import { Archive } from '@clowdy/icons/14';

export interface SubagentMenuProps {
    /** Closes the popover the menu is in. Called before the action runs. */
    onClose: () => void;
    onArchive: () => void;
}

/** What can be done to a sub-agent that is over, in the list: the content of its right-click menu. A chat's other actions (rename, move, delete) mean nothing to it. */
export function SubagentMenu({ onClose, onArchive }: SubagentMenuProps) {
    return (
        <PopoverScroll>
            <Menu
                aria-label="Sub-agent actions"
                size="sm"
                onAction={key => {
                    onClose();

                    if (key === 'archive') onArchive();
                }}
            >
                <MenuItem id="archive" icon={<Archive />} textValue="Archive">
                    Archive
                </MenuItem>
            </Menu>
        </PopoverScroll>
    );
}
