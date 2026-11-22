import { Modal } from '@clowdy/components/Modal';
import { folderNames } from '@clowdy/protocol';

import { currentFolder } from '../sidePanel/currentFolder';
import { showQuickSearch } from './QuickSearch';
import { QuickSearchModel, type QuickSearchTab } from './QuickSearchModel';
import { quickSearchSource, selectedText } from './quickSearchSource';

import type { RootStore } from '../../stores';

/** The palette that is open: there is one at a time, and a key that asks for it again changes its tab. */
let current: QuickSearchModel | null = null;

/**
 * Opens the quick search palette on a tab, for the folder the window is working in (the one the side panel's Files tab shows). Where it is open already it goes
 * to that tab, and over another dialog it does not open. The text tab starts with what the open file has selected, when it has a line of it.
 */
export function openQuickSearch(root: RootStore, tab: QuickSearchTab = 'all'): void {
    if (current) {
        current.setTab(tab);

        return;
    }

    // Another dialog is open: the keys work over a dialog (the palette's own tabs are changed with them), and a palette over a form is not what they are for.
    if (Modal.visible.length > 0) return;

    const projectId = root.selectedProjectId;
    const project = root.selectedProject;

    if (!projectId || !project) return;

    const ui = root.ui.forProject(projectId);
    const folder = currentFolder(project, ui);
    const { folders } = project.project;
    const model = new QuickSearchModel(quickSearchSource(root, project, folder), tab);

    current = model;
    showQuickSearch(
        { model, folder: folders.length > 1 ? folderNames(folders)[folders.findIndex(({ id }) => id === folder.id)] : undefined },
        {
            // Asked for on cancel and again on close: the first one ends it.
            onClose: () => {
                if (current !== model) return;

                model.dispose();
                current = null;
            },
        }
    );

    if (tab === 'text') {
        void selectedText(root, projectId, folder).then((text) => {
            if (text && current === model && model.blank) model.setQuery(text);
        });
    }
}
