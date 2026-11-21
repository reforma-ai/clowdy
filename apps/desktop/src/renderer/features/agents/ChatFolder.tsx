import { Menu, MenuHeader, MenuItem, MenuSection, MenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Folder } from '@clowdy/icons/14';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { AppIcon, canOpenFolders, chosenApp, openFolderIn, openWithPreferences, useOpenApps } from '../openWith';
import styles from './ChatFolder.module.css';
import { FolderTrigger } from './DraftFolderSelect';

export interface ChatFolderProps {
    name: string;
    path: string;
    /** The folder is gone from the disk. */
    missing: boolean;
}

/**
 * The folder a chat works in, in the place the new-chat page's select (`DraftFolderSelect`) had it, and the same size and name. In the desktop app it is the
 * same pill, and a press opens a menu to open the folder in the file manager and in the editor (the ones Settings > Files names, else the first the computer
 * has; no editor, no item), each with the program's own icon, and the pill tells the path on hover, or that the folder is gone from the disk, when both
 * items are off. Anywhere else, a page in a browser, it is read only: no plate and no chevron, since the folder of a chat never changes and there is
 * nothing to open it in.
 */
export function ChatFolder({ name, path, missing }: ChatFolderProps) {
    const title = missing ? 'This folder no longer exists' : tildePath(path, homeFolder.path);

    if (!canOpenFolders()) {
        return (
            <div role="group" aria-label="Folder" className={ styles.folder } data-missing={ missing || undefined } title={ title }>
                <Folder aria-hidden="true" />
                <Text truncate>{ name }</Text>
            </div>
        );
    }

    return <FolderMenu name={ name } path={ path } missing={ missing } title={ title } />;
}

function FolderMenu({ name, path, missing, title }: ChatFolderProps & { title: string }) {
    const apps = useOpenApps();
    const fileManager = chosenApp(apps.fileManagers, openWithPreferences.fileManager);
    const editor = chosenApp(apps.editors, openWithPreferences.editor);

    return (
        <MenuTrigger>
            <FolderTrigger name={ name } tooltip={ title } missing={ missing } />
            <Popover placement="bottom start" spacing="xs">
                <PopoverScroll>
                    <Menu
                        aria-label="Open folder"
                        size="sm"
                        onAction={ (key) => {
                            if (key === 'fileManager' && fileManager) void openFolderIn(path, 'fileManager', fileManager);
                            else if (key === 'editor' && editor) void openFolderIn(path, 'editor', editor);
                        } }
                    >
                        <MenuSection aria-label="Open in">
                            { missing && <MenuHeader>This folder no longer exists</MenuHeader> }
                            { fileManager && <MenuItem id="fileManager" icon={ <AppIcon app={ fileManager } kind="fileManager" /> } textValue={ `Open in ${ fileManager.name }` } isDisabled={ missing }>{ `Open in ${ fileManager.name }` }</MenuItem> }
                            { editor && <MenuItem id="editor" icon={ <AppIcon app={ editor } kind="editor" /> } textValue={ `Open in ${ editor.name }` } isDisabled={ missing }>{ `Open in ${ editor.name }` }</MenuItem> }
                        </MenuSection>
                    </Menu>
                </PopoverScroll>
            </Popover>
        </MenuTrigger>
    );
}
