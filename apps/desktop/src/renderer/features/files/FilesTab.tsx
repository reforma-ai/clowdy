import { FileManagerView } from '@clowdy/file-manager/react';
import { useEffect } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { useAddToChat } from '../chats/useAddToChat';
import { chosenPrograms, useFolderGit, useOpenApps } from '../openWith';
import { currentPlace, isPlaceReady, placeKey, type Place } from '../sidePanel/currentPlace';
import { PlaceWaiting } from '../sidePanel/PlaceWaiting';
import { openInTerminal } from '../terminal/openInTerminal';
import { docsScopeOf } from './docsScope';
import { FILES_SCOPE, filesCommands } from './filesCommands';
import styles from './FilesTab.module.css';
import { openInMenuItems } from './openInMenuItems';
import { treeLayout } from './treeLayout';
import { useFilesStore } from './useFilesStore';

/** The tab's view over one place that is ready: its file manager, its tree and its tabs. */
function PlaceFiles({ place, variant }: { place: Place; variant: 'files' | 'docs' }) {
    const root = useRootStore();
    const project = useProjectState();
    const files = useFilesStore();
    const manager = files.managerOf(project.project.id, place, variant);
    const apps = useOpenApps();
    const git = useFolderGit(project.id, place.folder.id, place.workspace);
    // Add to chat over words selected in the open file's source; the file is read when the words are quoted, since the one editor shows every tab.
    const addToChat = useAddToChat(() => manager.tabs.active?.path);

    // The tree of every place follows the one choice of the window; a place that was not on show when it changed catches up here.
    useEffect(() => manager.tree.setShowHidden(treeLayout.showHidden), [manager, treeLayout.showHidden]);

    useHotkeyScope(FILES_SCOPE);
    useCommands(FILES_SCOPE, filesCommands({ toggleHidden: () => treeLayout.setShowHidden(!treeLayout.showHidden) }));

    return (
        <FileManagerView
            className={ styles.view }
            key={ `${ project.project.id }/${ placeKey(place) }/${ variant }` }
            manager={ manager }
            scope={ variant === 'docs' ? docsScopeOf(manager) : undefined }
            filterPlaceholder={ variant === 'docs' ? 'Filter documents' : undefined }
            emptyText={ variant === 'docs' ? 'No documents found' : 'No files found' }
            editorExtensions={ addToChat }
            menuItems={ openInMenuItems({ projectId: project.id, place, programs: chosenPrograms(apps), git, inTerminal: relative => void openInTerminal(root, project.id, place, relative) }) }
            sidebarOpen={ treeLayout.open }
            sidebarWidth={ treeLayout.width }
            onSidebarToggle={ () => treeLayout.toggle() }
            onSidebarWidthChange={ width => treeLayout.setWidth(width) }
        />
    );
}

/**
 * The side panel's Files tab: the editor with the files that are open in tabs, and at its right the tree of the place the window is working in: the folder, or the worktree
 * of the open chat when it works in one (the same place the Info and Terminal tabs name). Each place keeps its own tabs, so the tree and the tabs change with the place, and come
 * back with it; two chats in one worktree share them. A chat whose worktree is not made yet gets a note in place of the view. A row's menu has, after its own items,
 * Open in Terminal (a folder), Copy path (absolute or relative) and Open in… (the editor, the file manager, the terminal program, GitHub).
 *
 * The Docs tab is this same view over a file manager of its own for the place: the tabs, the editor and the buffers are the Docs tab's, so the documents open there
 * are not the files open in the Files tab, and the tree at the right draws the place's document sources (`docsScopeOf`: Briefback, `.clowdy/docs`, Spec Kit, OpenSpec, Kiro) in place of every file. The component stays mounted when
 * the panel moves between the two tabs, and the view is made again for the manager of the one that comes on show.
 */
export default function FilesTab({ variant = 'files' }: { variant?: 'files' | 'docs' }) {
    const project = useProjectState();
    const ui = useProjectUi();
    const place = currentPlace(project, ui);

    return isPlaceReady(place) ? <PlaceFiles place={ place } variant={ variant } /> : <PlaceWaiting />;
}
