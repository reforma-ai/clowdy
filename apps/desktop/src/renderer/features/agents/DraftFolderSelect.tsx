import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Check, Folder } from '@clowdy/icons/14';
import { folderNames } from '@clowdy/protocol';

import { ChipTrigger } from './ChipTrigger';

import type { FolderId, ProjectFolder } from '@clowdy/protocol';

export interface DraftFolderSelectProps {
    /** The folders of the project in order: the first is the main one. */
    folders: readonly ProjectFolder[];
    /** The folder the new chat is for. */
    selectedId: FolderId;
    /** The folders that are gone from the disk: listed with the others, and not to be picked. */
    missing: ReadonlySet<FolderId>;
    onPick: (folder: ProjectFolder) => void;
}

/**
 * The select of the new-chat page that says which folder of the project the chat will work in, and changes it: a pill under the message box with the folder's
 * name, and a list of the project's folders by name, the chosen one ticked. It is only for a chat that is not made yet: once the first message is sent the page
 * is gone, and the chat draws the folder in the same place read only (`ChatFolder`). More controls of the start (a branch, where it runs) join it in the same row.
 */
export function DraftFolderSelect({ folders, selectedId, missing, onPick }: DraftFolderSelectProps) {
    const names = folderNames(folders);
    const selected = Math.max(0, folders.findIndex(folder => folder.id === selectedId));

    return (
        <MenuTrigger>
            <FolderTrigger name={ names[selected] ?? folders[selected]?.path ?? '' } />
            <Popover placement="bottom start" spacing="xs" width={ 240 }>
                <Menu
                    aria-label="Folders"
                    size="md"
                    selectionMode="single"
                    selectedKeys={ [folders[selected]?.id ?? ''] }
                    disallowEmptySelection
                    onSelectionChange={ (keys) => {
                        const folder = keys === 'all' ? undefined : folders.find(candidate => keys.has(candidate.id));

                        if (folder && !missing.has(folder.id)) onPick(folder);
                    } }
                >
                    { folders.map((folder, index) => (
                        <MenuItem
                            key={ folder.id }
                            id={ folder.id }
                            text={ names[index] ?? folder.path }
                            icon={ <Folder /> }
                            isDisabled={ missing.has(folder.id) }
                            endAffix={ folder.id === folders[selected]?.id ? <Check aria-hidden="true" /> : undefined }
                            // The name is all the list says, except why a folder cannot be picked.
                            { ...(missing.has(folder.id) && { description: 'This folder no longer exists', stacked: true, 'data-align': 'center' }) }
                        />
                    )) }
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}

/**
 * The pill that opens a menu for a folder, under the message box: the folder's name and a chevron, with the plate staying and the chevron turned over while the menu is open. The select
 * of a new chat uses it to pick the folder, and `ChatFolder` to open the folder of a chat that is made in another program, in the warning colour when the folder
 * is gone from the disk. It goes inside a `MenuTrigger`.
 */
export function FolderTrigger({ name, tooltip, missing = false }: { name: string; tooltip?: string; missing?: boolean }) {
    return <ChipTrigger icon={ <Folder aria-hidden="true" /> } label={ name } aria-label={ `Folder: ${ name }` } tooltip={ tooltip } missing={ missing } />;
}
