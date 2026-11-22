import { MAX_GIT_BRANCHES } from '@clowdy/protocol';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { gitLine, gitOutput, gitRead } from '../domain/git';
import { CommandError, invalid, notFound, unavailable } from '../errors';

import type { FolderGit, GitBranch, GitWorktree, Project, ProjectFolderInfo } from '@clowdy/protocol';

/** How much of a commit's hash a worktree's `head` keeps. */
const SHORT_HASH_LENGTH = 7;

/** One entry of `git worktree list --porcelain`, as git wrote it. */
export interface ListedWorktree {
    path: string;
    /** The commit the worktree is on, in full; empty when git did not say. */
    head: string;
    /** The branch it has checked out, without `refs/heads/`; absent on a detached HEAD. */
    branch?: string;
    /** The entry is a bare repository, which has no files to work in. */
    bare: boolean;
    /** The worktree's folder is gone, and `git worktree prune` would forget it. */
    prunable: boolean;
}

/** `git worktree list --porcelain`: one block per worktree, `worktree <path>` first, then `HEAD`, `branch` or `detached`, and optional `bare`, `locked`, `prunable` lines. */
export function parseWorktrees(output: string): ListedWorktree[] {
    const found: ListedWorktree[] = [];
    let current: ListedWorktree | undefined;

    for (const line of output.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
            current = { path: line.slice('worktree '.length), head: '', bare: false, prunable: false };
            found.push(current);
        }
        else if (current && line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
        }
        else if (current && line.startsWith('branch ')) {
            const ref = line.slice('branch '.length);

            current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
        }
        else if (current && line === 'bare') {
            current.bare = true;
        }
        else if (current && (line === 'prunable' || line.startsWith('prunable '))) {
            current.prunable = true;
        }
    }

    return found;
}

/** The real place of a path, for two paths to be compared (a link, a drive letter's case, `/var` and `/private/var`); nothing when it is not there. */
async function placeOf(path: string): Promise<string | undefined> {
    try {
        return await realpath(path);
    }
    catch {
        return undefined;
    }
}

/**
 * Where a folder's HEAD is: the branch it has checked out, or on a detached HEAD the short hash of the commit, with `detached`. Nothing outside a repository
 * (git fails), and nothing in one whose HEAD points at no commit and no branch.
 */
export async function folderHead(folder: string): Promise<Pick<ProjectFolderInfo, 'branch' | 'detached'> | undefined> {
    const branch = await gitLine(folder, ['branch', '--show-current']);

    if (branch) return { branch };

    const commit = await gitLine(folder, ['rev-parse', '--short', 'HEAD']);

    return commit ? { branch: commit, detached: true } : undefined;
}

/** The branch `origin/HEAD` names (`origin/main`), when the clone or the last fetch left one. */
async function originHead(folder: string): Promise<string | undefined> {
    return gitLine(folder, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
}

/** The branches in the output of `git for-each-ref --format=%(refname) refs/heads refs/remotes`: the local ones and each remote's, without a remote's `HEAD`, in git's order. */
export function parseBranches(output: string): GitBranch[] {
    const branches: GitBranch[] = [];

    for (const ref of output.split('\n')) {
        if (ref.startsWith('refs/heads/')) {
            branches.push({ name: ref.slice('refs/heads/'.length), remote: false });
        }
        else if (ref.startsWith('refs/remotes/') && !/^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) {
            branches.push({ name: ref.slice('refs/remotes/'.length), remote: true });
        }
    }

    return branches;
}

/** Every branch of the repository, local ones first and then each remote's (without a remote's `HEAD`); none where git says no (outside a repository), `unavailable` where it does not answer. */
async function readBranches(folder: string): Promise<GitBranch[]> {
    const read = await gitRead(folder, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);

    if (!read.ok && read.reason === 'unavailable') throw unavailable('git did not answer');

    return parseBranches(read.ok ? read.stdout : '');
}

/**
 * The first of what `origin/HEAD` names, `origin/main`, `origin/master`, a local `main` and a local `master` that the repository has as a branch, else the branch that is
 * checked out (a short hash on a detached HEAD), which an unborn branch is not: it has nothing to start from. Nothing in a repository with no commit.
 */
export function pickDefaultBranch(remoteHead: string | undefined, branches: readonly GitBranch[], head: Awaited<ReturnType<typeof folderHead>>): string | undefined {
    const has = (name: string, remote: boolean) => branches.some(branch => branch.name === name && branch.remote === remote);
    const candidates: Array<[string | undefined, boolean]> = [[remoteHead, true], ['origin/main', true], ['origin/master', true], ['main', false], ['master', false]];

    for (const [name, remote] of candidates) {
        if (name && has(name, remote)) return name;
    }

    return head && (head.detached || has(head.branch ?? '', false)) ? head.branch : undefined;
}

/**
 * The ref a new worktree of the folder's repository starts from: the branch `origin/HEAD` names (`main`, `master`, `next`… as the remote has it), else `origin/main` or
 * `origin/master`, else a local `main` or `master`, else the branch that is checked out (a short hash on a detached HEAD). Nothing in a repository with no commit.
 * Only refs the repository already has are read: there is no fetch, so `origin/HEAD` is what the last clone or fetch left. The answer is a short name, not a ref git can
 * always take bare (a tag may be called `main` too): whoever starts a worktree from it spells it `refs/heads/<name>` or `refs/remotes/<name>`.
 */
export async function defaultBranchOf(folder: string): Promise<string | undefined> {
    const [remoteHead, branches, head] = await Promise.all([originHead(folder), readBranches(folder), folderHead(folder)]);

    return pickDefaultBranch(remoteHead, branches, head);
}

/** Whether something is there on the disk, a folder or a file. */
async function isThere(path: string): Promise<boolean> {
    try {
        await stat(path);

        return true;
    }
    catch {
        return false;
    }
}

/**
 * Whether a worktree has anything uncommitted, a new file or a changed submodule too, whatever the person's git configuration says of untracked files and of
 * submodules. A `status` that fails, is cut short or does not answer in time is "yes": the answer is a reason to keep a tree, so it errs that way.
 */
async function isDirty(path: string): Promise<boolean> {
    return await gitOutput(path, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']) !== '';
}

/**
 * The worktrees that can hold work, with the folder's own checkout flagged: the entries of `git worktree list` that are working trees (a bare repository, a folder that is
 * gone though git has not pruned it, and the git directory git names as the main entry when the repository keeps it apart from the checkout are left out; the folder's
 * own entry is then made from what git says in the folder).
 */
async function worktreesOf(folder: string, root: string, head: Awaited<ReturnType<typeof folderHead>>): Promise<GitWorktree[]> {
    const read = await gitRead(folder, ['worktree', 'list', '--porcelain']);

    // A git too old to list worktrees says no: the folder's own entry below is then the whole list.
    if (!read.ok && read.reason === 'unavailable') throw unavailable('git did not answer');

    const worktrees: GitWorktree[] = [];

    for (const entry of parseWorktrees(read.ok ? read.stdout : '')) {
        const place = entry.bare || entry.prunable ? undefined : await placeOf(entry.path);

        if (place && await isThere(join(place, '.git'))) {
            worktrees.push({
                // Git prints `C:/work/app` on Windows; the project's folders and the app's paths are written as the machine writes them.
                path: resolve(entry.path),
                ...(entry.branch !== undefined && { branch: entry.branch }),
                head: shortHash(entry.head),
                main: place === root,
                dirty: await isDirty(place),
            });
        }
    }

    if (!worktrees.some(entry => entry.main)) {
        const commit = await gitLine(folder, ['rev-parse', 'HEAD']) ?? '';

        worktrees.unshift({ path: root, ...(head && !head.detached && { branch: head.branch }), head: shortHash(commit), main: true, dirty: await isDirty(folder) });
    }

    return worktrees;
}

/** The first characters of a commit's hash; none for the all-zero hash git gives a branch with no commit yet. */
function shortHash(hash: string): string {
    return /^0*$/.test(hash) ? '' : hash.slice(0, SHORT_HASH_LENGTH);
}

/**
 * What git says about a folder (`GET /v1/projects/:id/git`). A folder counts as a repository only when it is the root of a working tree: a worktree is made of the whole
 * repository, so a folder inside one has none of its own. A git that does not answer (not there, too slow, too much to say) is `unavailable`, never an empty answer or "no
 * repository", which a caller would take for the truth. The reads of each worktree's status run one after another, so a repository with many worktrees does not start a crowd of processes.
 */
export async function folderGit(folder: string): Promise<FolderGit> {
    const root = await placeOf(folder);
    const top = await gitRead(folder, ['rev-parse', '--show-toplevel']);

    if (!top.ok && top.reason === 'unavailable') throw unavailable('git did not answer');

    if (!top.ok || !root || await placeOf(top.stdout.trim()) !== root) return { isRepository: false };

    const [head, remoteHead, all] = await Promise.all([folderHead(folder), originHead(folder), readBranches(folder)]);
    const defaultBranch = pickDefaultBranch(remoteHead, all, head);
    const worktrees = await worktreesOf(folder, root, head);

    return {
        isRepository: true,
        ...head,
        ...(defaultBranch !== undefined && { defaultBranch }),
        branches: all.slice(0, MAX_GIT_BRANCHES),
        ...(all.length > MAX_GIT_BRANCHES && { truncated: true as const }),
        worktrees,
    };
}

/** `folderGit` for one folder of a project, by its id: `invalid` for none, `not_found` for a folder the project does not have, `unavailable` for one gone from the disk. */
export async function projectFolderGit(project: Project, folderId: string): Promise<FolderGit> {
    if (!folderId) throw invalid('The folder is not given');

    const folder = project.folders.find(candidate => candidate.id === folderId);

    if (!folder) throw notFound('Folder', folderId);

    try {
        if ((await stat(folder.path)).isDirectory()) return await folderGit(folder.path);
    }
    catch (error) {
        // A git that did not answer is its own failure; the rest is a folder that is not there, or cannot be read.
        if (error instanceof CommandError) throw error;
    }

    throw unavailable(`The folder ${ folder.path } is missing`);
}
