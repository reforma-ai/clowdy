import { FileManagerView } from '@clowdy/file-manager/react';
import { useEffect } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { useProjectState, useProjectUi } from '../../stores';
import { currentFolder } from '../sidePanel/currentFolder';
import { FILES_SCOPE, filesCommands } from './filesCommands';
import styles from './FilesTab.module.css';
import { treeLayout } from './treeLayout';
import { useFilesStore } from './useFilesStore';

/**
 * The side panel's Files tab: the editor with the files that are open in tabs, and at its right the tree of the folder the window is working in (the same
 * folder the Info tab names). Each folder keeps its own tabs, so the tree and the tabs change with the folder, and come back with it.
 */
export default function FilesTab() {
    const project = useProjectState();
    const ui = useProjectUi();
    const files = useFilesStore();
    const folder = currentFolder(project, ui);
    const manager = files.managerOf(project.project.id, folder.id);

    // The tree of every folder follows the one choice of the window; a folder that was not on show when it changed catches up here.
    useEffect(() => manager.tree.setShowHidden(treeLayout.showHidden), [manager, treeLayout.showHidden]);

    useHotkeyScope(FILES_SCOPE);
    useCommands(FILES_SCOPE, filesCommands({ toggleHidden: () => treeLayout.setShowHidden(!treeLayout.showHidden) }));

    return (
        <FileManagerView
            className={ styles.view }
            key={ `${ project.project.id }/${ folder.id }` }
            manager={ manager }
            sidebarOpen={ treeLayout.open }
            sidebarWidth={ treeLayout.width }
            onSidebarToggle={ () => treeLayout.toggle() }
            onSidebarWidthChange={ width => treeLayout.setWidth(width) }
            onSidebarRequest={ () => treeLayout.show() }
        />
    );
}
