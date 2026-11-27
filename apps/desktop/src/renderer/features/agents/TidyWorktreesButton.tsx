import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Mop } from '@clowdy/icons/14';
import { folderNames } from '@clowdy/protocol';

import { useProjectState, useRootStore } from '../../stores';
import { openTidyWorktrees } from '../worktrees/TidyWorktreesDialog';

/** Keep worktree cleanup accessible from the chat list, regardless of its layout. */
export function TidyWorktreesButton() {
    const root = useRootStore();
    const project = useProjectState().project;
    const folders = project.folders;
    if (!folders.length) return null;

    const button = (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            iconOnly
            aria-label="Tidy up worktrees"
            tooltip="Tidy up worktrees"
        >
            <Mop />
        </Button>
    );
    const open = (folderId: (typeof folders)[number]['id']) =>
        void openTidyWorktrees({ root, projectId: project.id, folderId });

    if (folders.length === 1) {
        return (
            <Button
                variant="filling"
                color="secondary"
                size="sm"
                iconOnly
                aria-label="Tidy up worktrees"
                tooltip="Tidy up worktrees"
                onPress={() => open(folders[0]!.id)}
            >
                <Mop />
            </Button>
        );
    }

    const names = folderNames(folders);
    return (
        <MenuTrigger>
            {button}
            <Popover placement="bottom end" spacing="xs" width={240}>
                <Menu aria-label="Choose a folder to tidy up" size="sm" onAction={key => open(String(key))}>
                    {folders.map((folder, index) => (
                        <MenuItem key={folder.id} id={folder.id} text={names[index] ?? folder.path} />
                    ))}
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
