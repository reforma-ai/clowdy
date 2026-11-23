import { Copy, Follow } from '@clowdy/icons/14';

import { absolutePath, actionIcon, openActions, openEffects, type FolderGit, type OpenAction, type OpenEffects, type OpenPrograms, type OpenTarget } from '../openWith';
import { placePath, type Place } from '../sidePanel/currentPlace';

import type { FileEntry } from '@clowdy/file-manager';
import type { FileMenuItem } from '@clowdy/file-manager/react';
import type { ProjectId } from '@clowdy/protocol';

export interface OpenInMenuInput {
    projectId: ProjectId;
    /** The place the tree shows, the folder or the worktree of the chat: its path is what a row's own path is inside. */
    place: Place;
    programs: OpenPrograms;
    git: FolderGit | undefined;
    effects?: OpenEffects;
    /** Starts a shell of the Terminal tab in a folder of the tree, given its path inside the folder the tree shows; without it the row menu has no such item. */
    inTerminal?: (relative: string) => void;
}

/** What each copy of the path is called in the submenu that holds them, where the word Copy is already said by the submenu. */
const COPY_LABELS: Partial<Record<OpenAction['id'], string>> = { copyPath: 'Absolute path', copyRelative: 'Relative path' };

/**
 * What the Files tree's row menu gets besides its own items, at the end of them, before Delete, as the folder pill's menu has them (`openActions`) minus Open in
 * Files, since the tree is the built-in file manager: `Open in Terminal` (a folder row, the Terminal tab), `Copy path`, a submenu with the choice of which path to
 * copy (absolute or relative), and `Open in…`, a submenu of what leaves the app: the editor, the file manager (it shows a file), the terminal program (a folder
 * only) and GitHub. A selection of several rows gets none of them, and `Open in…` is left out when nothing is left to open the row in.
 */
export function openInMenuItems({ projectId, place, programs, git, effects = openEffects, inTerminal }: OpenInMenuInput): (targets: readonly FileEntry[]) => FileMenuItem[] {
    return (targets) => {
        const [entry] = targets;

        if (targets.length !== 1 || !entry) return [];

        const target: OpenTarget = { projectId, folder: place.folder, ...(place.workspace && { workspace: place.workspace }), path: absolutePath(placePath(place), entry.path), relative: entry.path, kind: entry.kind };
        const items = (group: OpenAction['group']): FileMenuItem[] => openActions({ target, programs, git, effects, inTerminal: inTerminal && (() => inTerminal(entry.path)) })
            .filter(action => action.group === group)
            .map(action => ({ id: action.id, label: COPY_LABELS[action.id] ?? action.label, icon: group === 'copy' ? undefined : actionIcon(action), onAction: action.run }));
        const copying = items('copy');
        const outside = items('outside');

        return [
            ...items('inside'),
            ...(copying.length > 0 ? [{ id: 'copy-path', label: 'Copy path', icon: <Copy aria-hidden="true" />, onAction: () => undefined, children: copying }] : []),
            ...(outside.length > 0 ? [{ id: 'open-in', label: 'Open in…', icon: <Follow aria-hidden="true" />, onAction: () => undefined, children: outside }] : []),
        ];
    };
}
