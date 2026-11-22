import { remoteLink } from '../settings/projects/projectView';

import type { ProjectFolder, ProjectId } from '@clowdy/protocol';
import type { OpenApp, OpenPathApp } from '../../../shared/bridge';

/**
 * What one menu opens: a file or a folder of a project's folder. `path` is where it is on the disk, `relative` where it is inside the project's folder (forward slashes,
 * empty for the folder itself).
 */
export interface OpenTarget {
    projectId: ProjectId;
    folder: ProjectFolder;
    path: string;
    relative: string;
    kind: 'file' | 'directory';
}

/** What git says about a folder: the `origin` address, and the branch (a short hash when HEAD is detached). */
export interface FolderGit {
    remoteUrl?: string;
    branch?: string;
    detached?: boolean;
}

/** The programs a person has chosen, each of which opens the target when its item is pressed. */
export interface OpenPrograms {
    fileManager?: OpenApp;
    editor?: OpenApp;
    terminal?: OpenApp;
}

export type OpenActionId = 'files' | 'editor' | 'fileManager' | 'terminal' | 'github' | 'copyPath' | 'copyRelative';

export interface OpenAction {
    id: OpenActionId;
    label: string;
    /** `open` goes first in the menu, `copy` after a separator. */
    group: 'open' | 'copy';
    /** The program the item opens the target in, whose own icon it has. */
    program?: { app: OpenApp; kind: OpenPathApp['kind'] };
    /** Gone from the disk: what needs the disk is off, and what does not (the link, the copies) stays. */
    isDisabled: boolean;
    run: () => void;
}

/** What an action does to the world, so the list can be built and tried without it. */
export interface OpenEffects {
    openPath: (path: string, kind: OpenPathApp['kind'], app: OpenApp) => void;
    openUrl: (url: string) => void;
    copy: (text: string) => void;
}

export interface OpenActionsInput {
    target: OpenTarget;
    programs: OpenPrograms;
    git?: FolderGit;
    /** The folder is gone from the disk. */
    missing?: boolean;
    /** Opens the target in the built-in file manager; without it there is no such item. */
    inFiles?: () => void;
    effects: OpenEffects;
}

/** Where a path is, as the folder's own separator writes it. */
export function absolutePath(folder: string, relative: string): string {
    if (relative === '') return folder;

    const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';

    return `${ folder.replace(/[\\/]+$/, '') }${ separator }${ relative.split('/').join(separator) }`;
}

/** Each part of a path or a branch name made safe for an address, the slashes between them kept. */
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * The page on GitHub of what the target is, when the folder's `origin` is a GitHub repository: the repository for the folder itself, `/tree/<branch>/<folder>` for
 * a folder in it, `/blob/<branch>/<file>` for a file. The branch is the one that is checked out (the short hash on a detached HEAD), whether or not it was pushed,
 * so the page may not be there. Nothing for another host, or when there is no branch to name.
 */
export function githubLink(git: FolderGit | undefined, target: Pick<OpenTarget, 'relative' | 'kind'>): string | undefined {
    const repository = remoteLink(git?.remoteUrl)?.href;

    if (!repository || new URL(repository).host !== 'github.com') return undefined;

    if (target.relative === '') return repository;

    if (!git?.branch) return undefined;

    return `${ repository }/${ target.kind === 'file' ? 'blob' : 'tree' }/${ encodePath(git.branch) }/${ encodePath(target.relative) }`;
}

/**
 * The items of the menu for a target, in their order: Open in Files, the editor, the file manager (shows a file, opens a folder), the terminal (a folder only),
 * GitHub, and the two copies of the path (the second not for the folder itself). A program that was not found has no item. What needs the disk is off while the
 * folder is gone.
 */
export function openActions({ target, programs, git, missing = false, inFiles, effects }: OpenActionsInput): OpenAction[] {
    const { path, relative, kind } = target;
    const actions: OpenAction[] = [];
    const open = (id: OpenActionId, label: string, run: () => void, program?: OpenAction['program'], isDisabled = missing) => actions.push({ id, label, group: 'open', program, isDisabled, run });

    if (inFiles) open('files', 'Open in Files', inFiles);

    if (programs.editor) open('editor', `Open in ${ programs.editor.name }`, () => effects.openPath(path, 'editor', programs.editor!), { app: programs.editor, kind: 'editor' });

    if (programs.fileManager) {
        const manager = programs.fileManager;

        open('fileManager', `${ kind === 'file' ? 'Show' : 'Open' } in ${ manager.name }`, () => effects.openPath(path, 'fileManager', manager), { app: manager, kind: 'fileManager' });
    }

    if (programs.terminal && kind === 'directory') open('terminal', `Open in ${ programs.terminal.name }`, () => effects.openPath(path, 'terminal', programs.terminal!), { app: programs.terminal, kind: 'terminal' });

    const link = githubLink(git, target);

    if (link) open('github', 'Open in GitHub', () => effects.openUrl(link), undefined, false);

    actions.push({ id: 'copyPath', label: 'Copy path', group: 'copy', isDisabled: false, run: () => effects.copy(path) });

    if (relative !== '') actions.push({ id: 'copyRelative', label: 'Copy relative path', group: 'copy', isDisabled: false, run: () => effects.copy(relative) });

    return actions;
}
