import { FileManagerView } from '@clowdy/file-manager/react';
import { useEffect } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { chosenPrograms, useFolderGit, useOpenApps } from '../openWith';
import { currentFolder } from '../sidePanel/currentFolder';
import { openInTerminal } from '../terminal/openInTerminal';
import { DOCS_SCOPE } from './docsScope';
import { FILES_SCOPE, filesCommands } from './filesCommands';
import styles from './FilesTab.module.css';
import { openInMenuItems } from './openInMenuItems';
import { treeLayout } from './treeLayout';
import { useFilesStore } from './useFilesStore';

/**
 * The side panel's Files tab: the editor with the files that are open in tabs, and at its right the tree of the folder the window is working in (the same
 * folder the Info tab names). Each folder keeps its own tabs, so the tree and the tabs change with the folder, and come back with it. A row's menu has, after its own items,
 * Open in Terminal (a folder), Copy path (absolute or relative) and Open in… (the editor, the file manager, the terminal program, GitHub).
 *
 * The Docs tab is this same view over a file manager of its own for the folder: the tabs, the editor and the buffers are the Docs tab's, so the documents open there
 * are not the files open in the Files tab, and the tree at the right draws the folder's documents (`DOCS_SCOPE`) in place of every file. The component stays mounted when
 * the panel moves between the two tabs, and the view is made again for the manager of the one that comes on show.
 */
export default function FilesTab({ variant = 'files' }: { variant?: 'files' | 'docs' }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const files = useFilesStore();
    const folder = currentFolder(project, ui);
    const manager = files.managerOf(project.project.id, folder.id, variant);
    const apps = useOpenApps();
    const git = useFolderGit(project.id, folder.id);

    // The tree of every folder follows the one choice of the window; a folder that was not on show when it changed catches up here.
    useEffect(() => manager.tree.setShowHidden(treeLayout.showHidden), [manager, treeLayout.showHidden]);

    useHotkeyScope(FILES_SCOPE);
    useCommands(FILES_SCOPE, filesCommands({ toggleHidden: () => treeLayout.setShowHidden(!treeLayout.showHidden) }));

    return (
        <FileManagerView
            className={ styles.view }
            key={ `${ project.project.id }/${ folder.id }/${ variant }` }
            manager={ manager }
            scope={ variant === 'docs' ? DOCS_SCOPE : undefined }
            filterPlaceholder={ variant === 'docs' ? 'Filter documents' : undefined }
            emptyText={ variant === 'docs' ? 'No documents yet' : undefined }
            menuItems={ openInMenuItems({ projectId: project.id, folder, programs: chosenPrograms(apps), git, inTerminal: relative => void openInTerminal(root, project.id, folder, relative) }) }
            sidebarOpen={ treeLayout.open }
            sidebarWidth={ treeLayout.width }
            onSidebarToggle={ () => treeLayout.toggle() }
            onSidebarWidthChange={ width => treeLayout.setWidth(width) }
        />
    );
}
