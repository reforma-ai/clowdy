import { remoteLink } from '../settings/projects/projectView';

import type { ChatWorkspace, ProjectFolder, ProjectId } from '@clowdy/protocol';
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
    /**
     * `path` is in this worktree of the folder, not in the folder's own checkout: the worktree a chat works in. The Files and Terminal tabs follow the open chat's worktree, so the
     * menu offers them for a target there while that chat is open, and not for the folder's own checkout then, nor for another chat's worktree.
     */
    workspace?: ChatWorkspace;
}

/** What git says about a folder, or about the worktree a chat works in: the `origin` address, and the branch (a short hash when HEAD is detached). */
export interface FolderGit {
    remoteUrl?: string;
    branch?: string;
    detached?: boolean;
    /** A chat's worktree that was made and is gone from the disk. */
    gone?: true;
}

/** The programs a person has chosen, each of which opens the target when its item is pressed. */
export interface OpenPrograms {
    fileManager?: OpenApp;
    editor?: OpenApp;
    terminal?: OpenApp;
}

export type OpenActionId =
    | 'files'
    | 'terminal'
    | 'copyPath'
    | 'copyRelative'
    | 'editor'
    | 'fileManager'
    | 'terminalApp'
    | 'github';

export interface OpenAction {
    id: OpenActionId;
    label: string;
    /**
     * `inside` is what the app does itself (the Files tab, the Terminal tab), `copy` the copies of the path, both at the top of the menu; `outside` is what leaves the
     * app (another program, the browser), kept in a submenu `Open in…` after a separator.
     */
    group: 'inside' | 'copy' | 'outside';
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
    /** A path outside every folder of the project has no folder and no project: only where it is on the disk, and whether it is a file or a folder. */
    target: Pick<OpenTarget, 'path' | 'relative' | 'kind'>;
    programs: OpenPrograms;
    git?: FolderGit;
    /** The folder is gone from the disk. */
    missing?: boolean;
    /** Opens the target in the built-in file manager; without it there is no such item. */
    inFiles?: () => void;
    /** Starts a shell of the built-in Terminal tab in the target (a folder only); without it there is no such item. */
    inTerminal?: () => void;
    effects: OpenEffects;
}

/** Where a path is, as the folder's own separator writes it. */
export function absolutePath(folder: string, relative: string): string {
    if (relative === '') return folder;

    const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';

    return `${folder.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`;
}

/** Each part of a path or a branch name made safe for an address, the slashes between them kept. */
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * The page on GitHub of what the target is, when the folder's `origin` is a GitHub repository: the repository for the folder itself, `/tree/<branch>/<folder>` for
 * a folder in it, `/blob/<branch>/<file>` for a file. The branch is the one that is checked out (the short hash on a detached HEAD), whether or not it was pushed,
 * so the page may not be there. Nothing for another host, or when there is no branch to name.
 */
export function githubLink(
    git: FolderGit | undefined,
    target: Pick<OpenTarget, 'relative' | 'kind'>
): string | undefined {
    const repository = remoteLink(git?.remoteUrl)?.href;

    if (!repository || new URL(repository).host !== 'github.com') return undefined;

    if (target.relative === '') return repository;

    if (!git?.branch) return undefined;

    return `${repository}/${target.kind === 'file' ? 'blob' : 'tree'}/${encodePath(git.branch)}/${encodePath(target.relative)}`;
}

/**
 * The page on GitHub that starts a pull request for a branch, which is what Create PR opens (as GitHub Desktop does): `<repository>/compare/<base>...<branch>?expand=1`, or
 * `<repository>/compare/<branch>?expand=1` without a base, where GitHub chooses the repository's own. It is built from the same parse of `origin` as `githubLink`, so the address never
 * has the credential a remote may carry (`https://user:token@github.com/o/r.git` gives `https://github.com/o/r/compare/...`), and each name is made safe for an address one part at
 * a time, the slashes inside a branch name kept. The page is GitHub's: `github.com`, and the host `enterpriseHost` names (a GitHub Enterprise server that the person's `gh` is signed in
 * to; a bare host is more likely GitLab, whose pull requests have another page). Nothing for another host, for a remote that is no web address, and for no remote.
 */
export function compareLink(
    git: FolderGit | undefined,
    { head, base }: { head: string; base?: string },
    enterpriseHost?: string
): string | undefined {
    const repository = remoteLink(git?.remoteUrl)?.href;

    if (!repository || head === '') return undefined;

    const url = new URL(repository);
    // GitHub's own ssh over port 443 is `ssh.github.com`, a name that has no website.
    const host = url.host === 'ssh.github.com' ? 'github.com' : url.host;

    if (host !== 'github.com' && host !== enterpriseHost?.toLowerCase()) return undefined;

    return `${url.protocol}//${host}${url.pathname}/compare/${base ? `${encodePath(base)}...` : ''}${encodePath(head)}?expand=1`;
}

/**
 * The items of the menu for a target, in the order the menu draws them: what the app does itself (Open in Files, Open in Terminal for a folder), the two copies of
 * the path (the second not for the folder itself), then what leaves the app, which the menu keeps in a submenu: the editor, the file manager (shows a file, opens
 * a folder), the terminal program (a folder only) and GitHub. A program that was not found has no item. What needs the disk is off while the folder is gone.
 */
export function openActions({
    target,
    programs,
    git,
    missing = false,
    inFiles,
    inTerminal,
    effects,
}: OpenActionsInput): OpenAction[] {
    const { path, relative, kind } = target;
    const actions: OpenAction[] = [];
    const add = (
        group: OpenAction['group'],
        id: OpenActionId,
        label: string,
        run: () => void,
        program?: OpenAction['program'],
        isDisabled = missing
    ) => actions.push({ id, label, group, program, isDisabled, run });

    if (inFiles) add('inside', 'files', 'Open in Files', inFiles);

    if (inTerminal && kind === 'directory') add('inside', 'terminal', 'Open in Terminal', inTerminal);

    add('copy', 'copyPath', 'Copy path', () => effects.copy(path), undefined, false);

    if (relative !== '')
        add('copy', 'copyRelative', 'Copy relative path', () => effects.copy(relative), undefined, false);

    if (programs.editor)
        add(
            'outside',
            'editor',
            `Open in ${programs.editor.name}`,
            () => effects.openPath(path, 'editor', programs.editor!),
            { app: programs.editor, kind: 'editor' }
        );

    if (programs.fileManager) {
        const manager = programs.fileManager;

        add(
            'outside',
            'fileManager',
            `${kind === 'file' ? 'Show' : 'Open'} in ${manager.name}`,
            () => effects.openPath(path, 'fileManager', manager),
            { app: manager, kind: 'fileManager' }
        );
    }

    if (programs.terminal && kind === 'directory')
        add(
            'outside',
            'terminalApp',
            `Open in ${programs.terminal.name}`,
            () => effects.openPath(path, 'terminal', programs.terminal!),
            { app: programs.terminal, kind: 'terminal' }
        );

    const link = githubLink(git, target);

    if (link) add('outside', 'github', 'Open in GitHub', () => effects.openUrl(link), undefined, false);

    return actions;
}
