import { absolutePath, actionIcon, openActions, openEffects, type FolderGit, type OpenAction, type OpenEffects, type OpenPrograms, type OpenTarget } from '../openWith';

import type { FileEntry } from '@clowdy/file-manager';
import type { FileMenuItem } from '@clowdy/file-manager/react';
import type { ProjectFolder, ProjectId } from '@clowdy/protocol';

export interface OpenInMenuInput {
    projectId: ProjectId;
    /** The folder the tree shows: its path is what a row's own path is inside. */
    folder: ProjectFolder;
    programs: OpenPrograms;
    git: FolderGit | undefined;
    effects?: OpenEffects;
}

/**
 * What the Files tree's row menu gets besides its own items: `Open in…`, a submenu of the editor, the file manager (it shows a file), the terminal (a folder only)
 * and GitHub, and then `Copy path` and `Copy relative path`. The items are those of `openActions`, as the folder pill's menu has them, minus Open in Files: the tree
 * is the built-in file manager. A selection of several rows gets none of them, and the submenu is left out when nothing is left to open the row in.
 */
export function openInMenuItems({ projectId, folder, programs, git, effects = openEffects }: OpenInMenuInput): (targets: readonly FileEntry[]) => FileMenuItem[] {
    return (targets) => {
        const [entry] = targets;

        if (targets.length !== 1 || !entry) return [];

        const target: OpenTarget = { projectId, folder, path: absolutePath(folder.path, entry.path), relative: entry.path, kind: entry.kind };
        const items = (group: OpenAction['group']): FileMenuItem[] => openActions({ target, programs, git, effects })
            .filter(action => action.group === group)
            .map(action => ({ id: action.id, label: action.label, icon: actionIcon(action), onAction: action.run }));
        const opening = items('open');

        return [...(opening.length > 0 ? [{ id: 'open-in', label: 'Open in…', onAction: () => undefined, children: opening }] : []), ...items('copy')];
    };
}
