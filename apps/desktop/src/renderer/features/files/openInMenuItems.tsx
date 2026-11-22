import { Copy, Follow } from '@clowdy/icons/14';

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

/** What each copy of the path is called in the submenu that holds them, where the word Copy is already said by the submenu. */
const COPY_LABELS: Partial<Record<OpenAction['id'], string>> = { copyPath: 'Absolute path', copyRelative: 'Relative path' };

/**
 * What the Files tree's row menu gets besides its own items, at the end of them, before Delete: `Copy path`, a submenu with the choice of which path to copy
 * (absolute or relative), and `Open in…`, a submenu of the editor, the file manager (it shows a file), the terminal (a folder only) and GitHub. The items are those
 * of `openActions`, as the folder pill's menu has them, minus Open in Files: the tree is the built-in file manager. A selection of several rows gets none of them,
 * and `Open in…` is left out when nothing is left to open the row in.
 */
export function openInMenuItems({ projectId, folder, programs, git, effects = openEffects }: OpenInMenuInput): (targets: readonly FileEntry[]) => FileMenuItem[] {
    return (targets) => {
        const [entry] = targets;

        if (targets.length !== 1 || !entry) return [];

        const target: OpenTarget = { projectId, folder, path: absolutePath(folder.path, entry.path), relative: entry.path, kind: entry.kind };
        const items = (group: OpenAction['group']): FileMenuItem[] => openActions({ target, programs, git, effects })
            .filter(action => action.group === group)
            .map(action => ({ id: action.id, label: COPY_LABELS[action.id] ?? action.label, icon: group === 'open' ? actionIcon(action) : undefined, onAction: action.run }));
        const copying = items('copy');
        const opening = items('open');

        return [
            ...(copying.length > 0 ? [{ id: 'copy-path', label: 'Copy path', icon: <Copy aria-hidden="true" />, onAction: () => undefined, children: copying }] : []),
            ...(opening.length > 0 ? [{ id: 'open-in', label: 'Open in…', icon: <Follow aria-hidden="true" />, onAction: () => undefined, children: opening }] : []),
        ];
    };
}
