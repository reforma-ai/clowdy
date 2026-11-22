import { FileManagerView } from '@clowdy/file-manager/react';

import { useProjectState, useProjectUi } from '../../stores';
import { currentFolder } from '../sidePanel/currentFolder';
import styles from './FilesTab.module.css';
import { useTreeLayout } from './treeLayout';
import { useFilesStore } from './useFilesStore';

/**
 * The side panel's Files tab: the editor with the files that are open in tabs, and at its right the tree of the folder the window is working in (the same
 * folder the Info tab names). Each folder keeps its own tabs, so the tree and the tabs change with the folder, and come back with it.
 */
export default function FilesTab() {
    const project = useProjectState();
    const ui = useProjectUi();
    const files = useFilesStore();
    const tree = useTreeLayout();
    const folder = currentFolder(project, ui);

    return (
        <FileManagerView
            className={ styles.view }
            key={ `${ project.project.id }/${ folder.id }` }
            manager={ files.managerOf(project.project.id, folder.id) }
            sidebarOpen={ tree.open }
            sidebarWidth={ tree.width }
            onSidebarWidthChange={ width => tree.setWidth(width) }
            onSidebarRequest={ () => tree.show() }
        />
    );
}
