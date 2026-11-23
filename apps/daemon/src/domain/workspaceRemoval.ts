import { rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { getChat, listChatDescendants } from '../db/chats';
import { getProject } from '../db/projects';
import {
    chatsOfWorkspace,
    deleteWorkspace,
    getWorkspace,
    listWorkspacesOfProject,
    updateWorkspace,
} from '../db/workspaces';
import { conflict, invalid } from '../errors';
import {
    commitOf,
    countChanges,
    hasCheckedOutSubmodules,
    isMerged,
    isOnDisk,
    parseWorktrees,
    workingTreeRoot,
} from '../git/state';
import { requireChat, stoppedSubtree } from './chats';
import { gitRead } from './git';
import { exclusive, mustGit, openWorkspace, pathKey, placeOf, samePlace, WorkspaceError } from './workspaces';

import type { Chat, ChatWorkspaceRemoval, Project } from '@clowdy/protocol';
import type { Config } from '../config';
import type { WorkspaceRecord } from '../db/workspaces';
import type { ListedWorktree } from '../git/state';
import type { Store } from '../store';

/** Removing a big tree (`node_modules`, build output) may take minutes; this only ends a removal that has hung. */
const REMOVE_TIMEOUT_MS = 5 * 60_000;

/** Deleting a branch is one ref. */
const BRANCH_TIMEOUT_MS = 60_000;

/** The worktree may be removed, with what the removal needs to know. */
interface Removable {
    removable: true;
    /** The row Clowdy keeps of the worktree; none for one no chat has worked in and the new-chat page never opened. */
    record?: WorkspaceRecord;
    /** The folder of the project the worktree is a checkout of: git runs there, and it is never what is removed. */
    folder: string;
    /** The worktree's path as it was asked for: the row's, or the one the person named. */
    path: string;
    /** The worktree's path as git writes it, which `worktree remove` is given. */
    listedPath: string;
    /** Git lists it but its folder is gone from the disk: there are no files to delete, and git forgets that one record. */
    missing: boolean;
    /** Something in the tree is changed and the person agreed to throw it away: `worktree remove` is given `--force`. */
    force: boolean;
    /** The branch that goes with the worktree, and the commit it is at; none when the branch stays, the worktree has none, or the repository no longer names it. */
    branch?: { name: string; commit: string };
}

/** The worktree may not be removed, and why in the words the person reads (the reason of the `conflict` that refuses a removal). */
interface Refused {
    removable: false;
    reason: string;
    record?: WorkspaceRecord;
}

type Verdict = Removable | Refused;

const refused = (reason: string, record?: WorkspaceRecord): Refused => ({
    removable: false,
    reason,
    ...(record && { record }),
});

/** The worktree a removal is asked for, and who may work in it. */
interface Target {
    /** The folder of the project the worktree is a checkout of: git runs there. */
    folder: string;
    /** The paths of the project's other folders: a worktree that is one of them is a place the project works in, and is never removed. */
    siblings: readonly string[];
    /** Where the worktree is: its row's path, or the one the person named. */
    path: string;
    record?: WorkspaceRecord;
    /** The chats that may work in it because they go with the removal (the chat being deleted and the threads below it). Any other chat, an archived one included, refuses it. */
    allowed: ReadonlySet<string>;
}

/** What the removal may do, which the chat delete and the removal by path choose differently. */
interface Choices {
    /** A worktree git lists whose folder is gone is not a refusal: git forgets its record, and there are no files to delete. */
    allowMissing: boolean;
    /** Something changed in the tree (a new file, an initialised submodule) is thrown away with it, as `--force` does; without it any such change is a refusal. */
    discard: boolean;
    /** The branch that goes with the worktree, from what git lists of it: the row's own for a chat's delete, the one checked out for a removal by path. Absent when the branch stays. */
    branch?: (listed: ListedWorktree) => string | undefined;
}

/** The chat outside the ones that go with the removal that works in the worktree, in the words that refuse it; nothing when there is none. Reads the database only. */
function busyChat(store: Store, target: Pick<Target, 'record' | 'allowed'>): string | undefined {
    const other = target.record && chatsOfWorkspace(store.db, target.record.id).find(id => !target.allowed.has(id));

    return other === undefined
        ? undefined
        : `The chat "${getChat(store.db, other)?.title ?? other}" works in this worktree${target.allowed.size > 0 ? ' too' : ''}`;
}

/**
 * What is in the tree that `git worktree remove` would refuse without `--force`, in the words that refuse it; nothing when the tree is clean. Anything uncommitted counts, a new
 * file included (`git status --porcelain --untracked-files=normal --ignore-submodules=none`, which does not report what `.gitignore` hides: build output and `.env` files go with
 * the tree, as `git worktree remove` takes them), and so does an initialised submodule (uninitialised ones are listed with a `-`). A status that fails or does not answer in time
 * counts as a change, and git not saying whether there are submodules is no answer either: the removal never takes a tree for clean on a guess.
 */
async function unsaved(path: string): Promise<string | undefined> {
    const changes = await countChanges(path);

    if (changes === undefined) {
        return "Couldn't tell what is changed in the worktree";
    }

    if (changes > 0) {
        return 'The worktree has changes that are not committed';
    }

    const submodules = await hasCheckedOutSubmodules(path);

    if (submodules === undefined) {
        return "Couldn't tell whether the worktree has submodules";
    }

    return submodules ? 'The worktree has submodules checked out' : undefined;
}

/**
 * Whether a worktree may be removed, and what in it says no. The rules both removals share, each checked against what is on the disk and in git now, never against what a row
 * remembers: no chat outside `target.allowed` works in it (an archived one included); the folder is on the disk, and git lists the worktree (with `allowMissing`, a prunable one
 * too, whose folder is gone) and it is not the folder's own checkout, another folder of the project, the repository's primary working tree (git never removes it) or locked, and no
 * other worktree or folder of the project is inside it (it would go with it, unasked); the branch that goes with it is not checked out in another worktree (`branch -D` would fail
 * after the tree was gone); and nothing in the tree is changed, a new file and an initialised submodule included, unless `discard` says it may be thrown away (`force` in the
 * answer). The branch that goes with it is the one `choices.branch` names when the repository still has it. The chat delete's own rules (Clowdy made it, its work is in the base)
 * are `checkRemoval`'s, on top of this.
 *
 * The reads are asynchronous and bounded, so a slow disk does not hold the daemon up; nothing is changed.
 */
async function checkWorkspaceRemoval(store: Store, target: Target, choices: Choices): Promise<Verdict> {
    const { folder, path, record } = target;
    const no = (reason: string) => refused(reason, record);
    const busy = busyChat(store, target);

    if (busy !== undefined) {
        return no(busy);
    }

    if (!(await isOnDisk(folder))) {
        return no('The folder of this worktree is gone');
    }

    const there = await isOnDisk(path);

    if (!there && !choices.allowMissing) {
        return no('The worktree is gone from the disk');
    }

    const listed = await gitRead(folder, ['worktree', 'list', '--porcelain']);

    if (!listed.ok) {
        return no("Couldn't read the list of worktrees from git");
    }

    const all = parseWorktrees(listed.stdout);
    const entries = all.filter(candidate => !candidate.bare);
    const entry = entries.find(candidate => samePlace(candidate.path, path));

    if (!entry || (entry.prunable && !choices.allowMissing)) {
        return no('Git does not list it as a worktree of the folder');
    }

    if (samePlace(entry.path, folder)) {
        return no("That is the folder's own checkout");
    }

    if (target.siblings.some(sibling => samePlace(entry.path, sibling))) {
        return no('That is another folder of the project');
    }

    // The first entry git prints is the repository's primary working tree, which the folder is when it is not a linked worktree.
    if (entry === all[0]) {
        return no("That is the repository's main working tree");
    }

    if (entry.locked !== undefined) {
        return no('The worktree is locked');
    }

    const missing = entry.prunable || !there;

    // Another worktree inside this one (Claude Code makes them under `.claude/worktrees`) is deleted with it when `.gitignore` hides it from the status, with its uncommitted work and
    // past its chats and its lock: the checks here are of this worktree alone, so the inner one has to go first.
    const inside = [
        ...entries.filter(candidate => candidate !== entry).map(candidate => candidate.path),
        ...target.siblings,
    ];

    if (!missing && inside.some(inner => isBelow(placeOf(entry.path), placeOf(inner)))) {
        return no('Another worktree or a folder of the project is inside this one');
    }

    const name = choices.branch?.(entry);

    if (name !== undefined && entries.some(candidate => candidate !== entry && candidate.branch === name)) {
        return no(`The branch ${name} is checked out in another worktree`);
    }

    const changed = missing ? undefined : await unsaved(path);

    if (changed !== undefined && !choices.discard) {
        return no(changed);
    }

    const commit = name === undefined ? null : await commitOf(folder, `refs/heads/${name}`);

    if (commit === undefined) {
        return no("Couldn't read the branch from git");
    }

    return {
        removable: true,
        ...(record && { record }),
        folder,
        path,
        listedPath: entry.path,
        missing,
        force: changed !== undefined,
        ...(name !== undefined && commit !== null && { branch: { name, commit } }),
    };
}

/**
 * Whether the chat's worktree may be removed together with the chat, and what in it says no: the rules of `checkWorkspaceRemoval` with none of them waived (a worktree that is gone,
 * a change, a submodule are refusals), and on top of them:
 *
 * - the chat has a worktree and Clowdy made it (`managed`): one that was found is never removed by a delete;
 * - the chat and the threads below it, which go with it, are the only ones that work in it;
 * - what it has checked out and the row's branch are ancestors of the base it was made from, as that base was last fetched (`refs/heads/<base>`, then `refs/remotes/<base>`, no
 *   network): the work is merged, or there is none. A base that was merged on the remote and not fetched yet, or a squash merge, is not recognised.
 */
async function checkRemoval(store: Store, chat: Chat): Promise<Verdict> {
    const record = chat.workspace && getWorkspace(store.db, chat.workspace.id);

    if (!record) {
        return refused('This chat has no worktree');
    }

    if (!record.managed) {
        return refused('Clowdy did not make this worktree', record);
    }

    const project = getProject(store.db, record.projectId);
    const folder = project?.folders.find(candidate => candidate.id === record.folderId)?.path;

    if (folder === undefined) {
        return refused('The folder of this worktree is gone', record);
    }

    const below = new Set([chat.id, ...listChatDescendants(store.db, chat.id).map(entry => entry.chat.id)]);
    const siblings =
        project?.folders.filter(candidate => candidate.path !== folder).map(candidate => candidate.path) ?? [];
    const verdict = await checkWorkspaceRemoval(
        store,
        { folder, siblings, path: record.path, record, allowed: below },
        { allowMissing: false, discard: false, branch: () => record.branch }
    );

    if (!verdict.removable) {
        return verdict;
    }

    if (record.base === undefined) {
        return refused('The worktree has no base branch to compare its work with', record);
    }

    const base =
        (await commitOf(folder, `refs/heads/${record.base}`)) ??
        (await commitOf(folder, `refs/remotes/${record.base}`));

    if (!base) {
        return refused(`The base ${record.base} is not a branch of the repository`, record);
    }

    // The commit the tree is on counts as well as the branch it was made with: an agent may have moved the tree to another branch or to a detached HEAD, whose commits
    // would be left with nothing to find them by.
    if (!(await isMerged(record.path, 'HEAD', base))) {
        return refused(`The worktree has commits that are not in ${record.base}`, record);
    }

    if (verdict.branch && !(await isMerged(folder, verdict.branch.commit, base))) {
        return refused(`The branch ${verdict.branch.name} has commits that are not in ${record.base}`, record);
    }

    return verdict;
}

/** What `GET /v1/chats/:id/workspace` answers: whether the chat's worktree may go with the chat (`checkRemoval`), and the worktree's path and branch when the chat has one. */
export async function workspaceRemoval(store: Store, chatId: string): Promise<ChatWorkspaceRemoval> {
    const verdict = await checkRemoval(store, requireChat(store, chatId));
    const record = verdict.record;

    return {
        removable: verdict.removable,
        ...(record && { path: record.path, ...(record.branch !== undefined && { branch: record.branch }) }),
    };
}

/** Whether `path` is below `root`, by their names. */
function isBelow(root: string, path: string): boolean {
    const way = relative(resolve(root), resolve(path));

    return way !== '' && !way.startsWith('..') && !isAbsolute(way);
}

/**
 * Removes the folders a worktree leaves empty (`<project>/<chat>`), up to but not including the workspaces folder, and no folder that holds anything: `rmdir` refuses those. The
 * path is the one git listed, the real place, so the workspaces folder is compared by its real place too: one written through a link (`/var` for `/private/var`) is the same folder.
 */
async function pruneEmptyParents(root: string, path: string): Promise<void> {
    const place = placeOf(root);

    for (let dir = dirname(path); isBelow(place, dir); dir = dirname(dir)) {
        try {
            await rmdir(dir);
        } catch {
            return;
        }
    }
}

/** The workspaces whose removal is running or waiting, with how many (two removals of one worktree may overlap): the driver's `Prepare workspace` step waits for them. */
const removing = new WeakMap<Store, Map<string, number>>();

/**
 * Whether the worktree is being removed, with a chat (`removeChatWorkspace`) or by its path (`removeWorktree`). A turn that starts meanwhile goes through the same `exclusive` line
 * as the removal before it opens its session (`RunDriver.prepareWorkspace`), so it does not start inside a tree that is being deleted: it waits, finds the tree gone and makes it
 * again (or fails, for a worktree Clowdy did not make).
 */
export function isBeingRemoved(store: Store, workspaceId: string): boolean {
    return (removing.get(store)?.get(workspaceId) ?? 0) > 0;
}

function markRemoving(store: Store, workspaceId: string, on: boolean): void {
    const counts = removing.get(store) ?? new Map<string, number>();
    const next = (counts.get(workspaceId) ?? 0) + (on ? 1 : -1);

    removing.set(store, counts);

    if (next > 0) {
        counts.set(workspaceId, next);
    } else {
        counts.delete(workspaceId);
    }
}

/**
 * Says what `git worktree remove` failed with and what it left. Git deletes its own record of the worktree before it deletes the files, so a failure part way (a file an
 * editor or a virus scanner holds open, say) leaves the folder with a `.git` file that points nowhere and no worktree in `git worktree list`. A row that chats still use is then
 * marked not `ready`, so the chat's next turn runs `Prepare workspace`, which refuses a folder that is no worktree and says so, instead of the agent starting in a dead tree; once the
 * folder is deleted by hand the turn makes the worktree again from the branch. The chat stays. A row that no chat uses (a removal by path) has nothing left to be a record of, and goes.
 */
async function failedRemoval(store: Store, verdict: Removable, reason: string): Promise<never> {
    const { record, folder, path } = verdict;
    const listed = await gitRead(folder, ['worktree', 'list', '--porcelain']);
    const forgotten =
        listed.ok && !parseWorktrees(listed.stdout).some(entry => !entry.bare && samePlace(entry.path, path));

    if (forgotten && (await isOnDisk(path))) {
        if (record) {
            store.tx(() => {
                const chats = chatsOfWorkspace(store.db, record.id);

                if (chats.length === 0) {
                    deleteWorkspace(store.db, record.id);

                    return;
                }

                updateWorkspace(store.db, record.id, { ready: false });

                for (const chatId of chats) {
                    const chat = getChat(store.db, chatId);

                    if (chat) {
                        store.emit(chat.projectId, { type: 'chat.upserted', chat });
                    }
                }
            });
        }

        throw conflict(
            `${reason}. Git no longer lists ${path}, so what is left of the folder has to be deleted by hand.`
        );
    }

    throw conflict(reason);
}

/**
 * Removes a worktree the checks said may go: the tree, then (`afterTree`) whatever the caller drops with it, then the folders it leaves empty, and the branch last. The worktree
 * goes first and a failure of it leaves the branch alone; a failure of the branch says the worktree was removed. `--force` only when the verdict says something is changed and the
 * person agreed (`force`): otherwise git itself still says no to a tree that changed since the check. A worktree whose folder is gone has git forget that one record
 * (`git worktree remove <path>`; `git worktree prune` would forget every stale record of the repository, which are not ours to touch).
 */
async function removeWorktreeAndBranch(
    store: Store,
    config: Pick<Config, 'workspacesDir'>,
    verdict: Removable,
    afterTree?: () => void
): Promise<void> {
    const step = { log: () => undefined };

    try {
        // `core.longpaths` as the checkout has it: a deep `node_modules` made by the setup is still removable on Windows.
        await mustGit(
            verdict.folder,
            [
                '-c',
                'core.longpaths=true',
                'worktree',
                'remove',
                ...(verdict.force ? ['--force'] : []),
                verdict.listedPath,
            ],
            step,
            REMOVE_TIMEOUT_MS,
            'remove the worktree'
        );
    } catch (error) {
        if (error instanceof WorkspaceError) {
            await failedRemoval(store, verdict, error.message);
        }

        throw error;
    }

    afterTree?.();
    await pruneEmptyParents(config.workspacesDir, verdict.listedPath);

    // The tree is gone and the branch is still named by the repository: a chat that stays after this has the branch it can make the worktree from again.
    if (verdict.branch) {
        try {
            await mustGit(
                verdict.folder,
                ['branch', '-D', '--', verdict.branch.name],
                step,
                BRANCH_TIMEOUT_MS,
                'delete the branch'
            );
        } catch (error) {
            throw error instanceof WorkspaceError ? conflict(`The worktree was removed. ${error.message}`) : error;
        }
    }
}

/**
 * Removes the chat's worktree and its branch, the first half of a delete that asks for it (`chat.delete` with `removeWorkspace`): the caller deletes the chat only when this
 * has returned. Refuses with a `conflict` that says why when any condition of `checkRemoval` fails now, and when the chat or a thread below it still works (the worktree
 * would be gone from under a delete that then fails). Nothing is forced: `git worktree remove` is run without `--force`, so git itself still says no to a tree that
 * changed since the check, and the branch is deleted with `branch -D` only after the check that it is contained in the base. The worktree goes first, the branch after it,
 * and a failure of the first leaves the second alone.
 *
 * It runs on the same `exclusive` line as the turn's own `Prepare workspace` for the path, and a turn that starts while it runs waits there (`isBeingRemoved`): the stopped
 * check is made once more on the line, right before git is run, so a turn that came while the removal waited its turn refuses it. A turn that comes after that finds the
 * tree gone when it gets its turn and makes the worktree again, as it does for any Clowdy-made worktree that is gone (its work was merged, so nothing is lost); the delete
 * itself is then refused, as the chat is busy.
 */
export async function removeChatWorkspace(
    store: Store,
    config: Pick<Config, 'workspacesDir'>,
    chatId: string
): Promise<void> {
    const chat = requireChat(store, chatId);

    stoppedSubtree(store, chat);

    const record = chat.workspace && getWorkspace(store.db, chat.workspace.id);

    if (!record) {
        throw conflict('This chat has no worktree to remove');
    }

    markRemoving(store, record.id, true);

    try {
        await exclusive(store, pathKey(record.path), undefined, async () => {
            const verdict = await checkRemoval(store, requireChat(store, chatId));

            if (!verdict.removable) {
                throw conflict(verdict.reason);
            }

            stoppedSubtree(store, requireChat(store, chatId));
            await removeWorktreeAndBranch(store, config, verdict);
        });
    } finally {
        markRemoving(store, record.id, false);
    }
}

/** What a removal by path asks for (`workspace.remove`). */
export interface WorktreeRemoval {
    /** The folder of the project whose repository lists the worktree. */
    folderId: string;
    path: string;
    /** Throw away what is changed in the tree (a new file, an initialised submodule too) with it; without this a changed tree is refused. */
    discard?: boolean;
    /** Delete the branch the worktree has checked out (`branch -D`, merged or not) once the worktree is gone; without this the branch stays and no commit is lost. */
    deleteBranch?: boolean;
}

/** What a removal by path did. */
export interface RemovedWorktree {
    path: string;
    /** The branch was deleted too. */
    branchDeleted: boolean;
}

/**
 * Removes a worktree git lists for a folder of the project, whoever made it (`workspace.remove`). Refused with a `conflict` that says why for: the folder's own checkout, another
 * folder of the project and the repository's primary working tree; a locked worktree; one a chat works in (an archived chat counts); a changed tree (a new file, an initialised
 * submodule) unless `discard` is true, which runs `git worktree remove --force`; a path git does not list for the folder; and, with `deleteBranch`, a branch that is checked out in
 * another worktree. `invalid` for a path that is not absolute, a folder the project does not have, gone from the disk or not the root of a repository. The branch is deleted only with
 * `deleteBranch`, merged or not, and whatever its name; a worktree removed with its branch kept loses no commit.
 *
 * A worktree whose folder is gone (git lists it as prunable) has its record removed alone, and the branch with it when asked; every other stale record of the repository stays.
 *
 * The removal goes through the same `exclusive` line as the turn's own `Prepare workspace` for the path, with the worktree's row marked as being removed (`isBeingRemoved`) for as
 * long as it waits and runs, so a turn of a chat that picked the worktree meanwhile does not open its session in a tree that is being deleted: it waits, finds the tree gone, and
 * fails as for any worktree that is gone. The checks are made on the line, and the chats once more right before git is run. A worktree no chat has worked in has no row yet: it
 * gets one (`openWorkspace`, the row the new-chat page would make) for the length of the removal, and it is deleted with the worktree, with the row of one that had it, unless a
 * chat points at it by then.
 */
export async function removeWorktree(
    store: Store,
    config: Pick<Config, 'workspacesDir'>,
    project: Project,
    request: WorktreeRemoval
): Promise<RemovedWorktree> {
    const folder = project.folders.find(candidate => candidate.id === request.folderId);

    if (!folder) {
        throw invalid(`Folder ${request.folderId} does not belong to project ${project.id}`);
    }

    if (!isAbsolute(request.path)) {
        throw invalid('The path of a worktree must be absolute');
    }

    const siblings = project.folders.filter(candidate => candidate.id !== folder.id).map(candidate => candidate.path);
    const recordOf = () =>
        listWorkspacesOfProject(store.db, project.id).find(
            candidate => candidate.folderId === folder.id && samePlace(candidate.path, request.path)
        );
    const choices: Choices = {
        allowMissing: true,
        discard: request.discard === true,
        ...(request.deleteBranch === true && { branch: (listed: ListedWorktree) => listed.branch }),
    };
    const target = (): Target => ({
        folder: folder.path,
        siblings,
        path: request.path,
        record: recordOf(),
        allowed: new Set(),
    });
    let marked: string | undefined;
    const mark = (workspaceId: string) => {
        if (marked === undefined) {
            marked = workspaceId;
            markRemoving(store, workspaceId, true);
        }
    };
    // A worktree some chat has used has its row already, and it is marked before anything is waited for, as a chat's removal marks its own.
    const first = recordOf();

    if (first) {
        mark(first.id);
    }

    try {
        if (!(await isOnDisk(folder.path))) {
            throw invalid(`The folder ${folder.path} is missing`);
        }

        if (!(await workingTreeRoot(folder.path))) {
            throw invalid('A worktree needs the root of a git repository, and this folder is not one');
        }

        return await exclusive(store, pathKey(first?.path ?? request.path), undefined, async () => {
            const verdict = await checkWorkspaceRemoval(store, target(), choices);

            if (!verdict.removable) {
                throw conflict(verdict.reason);
            }

            // Nothing is waited for from here to the start of git: a chat that picked the worktree while the checks ran is seen now, and one that comes later waits on the line.
            const current = target();
            const busy = busyChat(store, current);

            if (busy !== undefined) {
                throw conflict(busy);
            }

            const record =
                current.record ??
                (verdict.missing
                    ? undefined
                    : store.tx(() =>
                          getWorkspace(store.db, openWorkspace(store, project, folder.id, request.path).id)
                      ));

            if (record) {
                mark(record.id);
            }

            await removeWorktreeAndBranch(store, config, { ...verdict, ...(record && { record }) }, () => {
                // A chat that picked the worktree after the check keeps its row: the worktree is gone for it as for any chat whose worktree went from the disk.
                if (record) {
                    store.tx(() => {
                        if (chatsOfWorkspace(store.db, record.id).length === 0) {
                            deleteWorkspace(store.db, record.id);
                        }
                    });
                }
            });

            // Git prints `C:/work/app` on Windows; the app's paths are written as the machine writes them.
            return { path: resolve(verdict.listedPath), branchDeleted: verdict.branch !== undefined };
        });
    } finally {
        if (marked !== undefined) {
            markRemoving(store, marked, false);
        }
    }
}
