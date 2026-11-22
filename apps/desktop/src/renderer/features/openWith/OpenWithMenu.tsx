import { For } from '@clowdy/components/For';
import { Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator } from '@clowdy/components/List';
import { PopoverScroll } from '@clowdy/components/Popover';
import { toast } from '@clowdy/components/Toast';
import { Copy, Folder } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { openInFiles } from '../files/openInFiles';
import { currentFolder } from '../sidePanel/currentFolder';
import { AppIcon } from './AppIcon';
import { chosenPrograms, openEffects, useOpenApps } from './openApps';
import { openActions, type FolderGit, type OpenAction, type OpenTarget } from './openTarget';

import type { ReactNode } from 'react';

export interface OpenWithMenuProps {
    target: OpenTarget;
    /** The folder is gone from the disk: what needs it is off, and the menu says so. */
    missing?: boolean;
    git: FolderGit | undefined;
    /** Called when an item is pressed, before it runs: a menu that is not in a `MenuTrigger` shuts itself here. */
    onClose?: () => void;
    'aria-label': string;
}

const iconOf = (action: OpenAction): ReactNode => {
    if (action.program) return <AppIcon app={ action.program.app } kind={ action.program.kind } />;

    return action.id === 'files' ? <Folder aria-hidden="true" /> : action.id === 'github' ? <Github size={ 14 } /> : <Copy aria-hidden="true" />;
};

/**
 * The menu of a file or a folder of the project, to go inside a `Popover`: Open in Files (when the window shows the target's folder), the editor, the file manager,
 * the terminal, GitHub, and the copies of the path. One list of items for every place the menu comes from (`openActions`).
 */
export function OpenWithMenu({ target, missing = false, git, onClose, 'aria-label': label }: OpenWithMenuProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const apps = useOpenApps();
    // The Files tab shows the folder the window works in, so a path in another folder of the project cannot be shown there.
    const isHere = currentFolder(project, ui).id === target.folder.id;
    const actions = openActions({
        target,
        programs: chosenPrograms(apps),
        git,
        missing,
        effects: openEffects,
        inFiles: isHere
            ? () => void openInFiles(root, target.projectId, target.folder, target.relative).then(opened => !opened && toast.error({ message: 'This file is not on the disk' }))
            : undefined,
    });
    const opening = actions.filter(action => action.group === 'open');
    const copying = actions.filter(action => action.group === 'copy');
    const item = (action: OpenAction) => (
        <MenuItem key={ action.id } id={ action.id } icon={ iconOf(action) } textValue={ action.label } isDisabled={ action.isDisabled }>{ action.label }</MenuItem>
    );

    return (
        <PopoverScroll>
            <Menu
                aria-label={ label }
                size="sm"
                onAction={ (key) => {
                    onClose?.();
                    actions.find(action => action.id === key)?.run();
                } }
            >
                <MenuSection aria-label="Open in">
                    { missing && <MenuHeader>This folder no longer exists</MenuHeader> }
                    <For each={ opening }>{ item }</For>
                </MenuSection>
                { opening.length > 0 && <MenuSeparator /> }
                <MenuSection aria-label="Copy">
                    <For each={ copying }>{ item }</For>
                </MenuSection>
            </Menu>
        </PopoverScroll>
    );
}
