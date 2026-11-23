import { rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { getChat, listChatDescendants } from '../db/chats';
import { getProject } from '../db/projects';
import { chatsOfWorkspace, getWorkspace, updateWorkspace } from '../db/workspaces';
import { conflict } from '../errors';
import { commitOf, hasCheckedOutSubmodules, isMerged, parseWorktrees } from '../git/state';
import { requireChat, stoppedSubtree } from './chats';
import { gitRead } from './git';
import { exclusive, mustGit, pathKey, samePlace, WorkspaceError } from './workspaces';

import type { Chat, ChatWorkspaceRemoval } from '@clowdy/protocol';
import type { Config } from '../config';
import type { WorkspaceRecord } from '../db/workspaces';
import type { Store } from '../store';

/** Removing a big tree (`node_modules`, build output) may take minutes; this only ends a removal that has hung. */
const REMOVE_TIMEOUT_MS = 5 * 60_000;

/** Deleting a branch is one ref. */
const BRANCH_TIMEOUT_MS = 60_000;

/** The worktree may be removed, with what the removal needs to know. */
interface Removable {
    removable: true;
    record: WorkspaceRecord;
    /** The folder of the project the worktree is a checkout of: git runs there, and it is never what is removed. */
    folder: string;
    /** The worktree's path as git writes it, which `worktree remove` is given. */
    listedPath: string;
    /** Whether the repository still has the branch the worktree was made with; one that was deleted by hand leaves nothing to delete. */
    hasBranch: boolean;
}

/** The worktree may not be removed, and why in the words the person reads (the reason of the `conflict` that refuses a delete). */
interface Refused {
    removable: false;
    reason: string;
    record?: WorkspaceRecord;
}

type Verdict = Removable | Refused;

const refused = (reason: string, record?: WorkspaceRecord): Refused => ({ removable: false, reason, ...(record && { record }) });

/** Whether something is there at the path. A path that cannot be looked at is not known to be there, and a worktree is not removed on a guess. */
const isOnDisk = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/**
 * Whether the chat's worktree may be removed together with the chat, and what in it says no. All of these hold, and each is checked against what is on the disk and in
 * git now, never against what the row remembers:
 *
 * - the chat has a worktree and Clowdy made it (`managed`): one that was found is never removed;
 * - no chat outside this chat and the threads below it (which go with it) works in it, an archived one included;
 * - it is on the disk and git lists it as a worktree of the folder, not locked, and not the folder's own checkout; its branch is not checked out in another one;
 * - nothing is uncommitted in it, a new file included (`git status --porcelain --untracked-files=normal --ignore-submodules=none`, which does not report what
 *   `.gitignore` hides: build output and `.env` files go with the tree, as `git worktree remove` takes them); a status that fails or does not answer in time says no;
 * - no submodule is checked out in it (`git worktree remove` refuses such a tree without `--force`, so the box would never work);
 * - what it has checked out and its branch are ancestors of the base it was made from, as that base was last fetched (`refs/heads/<base>`, then `refs/remotes/<base>`, no
 *   network): the work is merged, or there is none. A base that was merged on the remote and not fetched yet, or a squash merge, is not recognised.
 *
 * The reads are asynchronous and bounded, so a slow disk does not hold the daemon up; nothing is changed.
 */
async function checkRemoval(store: Store, chat: Chat): Promise<Verdict> {
    const record = chat.workspace && getWorkspace(store.db, chat.workspace.id);

    if (!record) {
        return refused('This chat has no worktree');
    }

    if (!record.managed) {
        return refused('Clowdy did not make this worktree', record);
    }

    const below = new Set([chat.id, ...listChatDescendants(store.db, chat.id).map(entry => entry.chat.id)]);
    const other = chatsOfWorkspace(store.db, record.id).find(id => !below.has(id));

    if (other !== undefined) {
        return refused(`The chat "${ getChat(store.db, other)?.title ?? other }" works in this worktree too`, record);
    }

    const folder = getProject(store.db, record.projectId)?.folders.find(candidate => candidate.id === record.folderId)?.path;

    if (folder === undefined || !await isOnDisk(folder)) {
        return refused('The folder of this worktree is gone', record);
    }

    if (!await isOnDisk(record.path)) {
        return refused('The worktree is gone from the disk', record);
    }

    const listed = await gitRead(folder, ['worktree', 'list', '--porcelain']);

    if (!listed.ok) {
        return refused('Git did not say which worktrees there are', record);
    }

    const entries = parseWorktrees(listed.stdout).filter(candidate => !candidate.bare);
    const entry = entries.find(candidate => samePlace(candidate.path, record.path));

    if (!entry || entry.prunable) {
        return refused('Git does not list it as a worktree of the folder', record);
    }

    if (samePlace(entry.path, folder)) {
        return refused('That is the folder\'s own checkout', record);
    }

    if (entry.locked !== undefined) {
        return refused('The worktree is locked', record);
    }

    if (record.branch !== undefined && entries.some(candidate => candidate !== entry && candidate.branch === record.branch)) {
        return refused(`The branch ${ record.branch } is checked out in another worktree`, record);
    }

    const status = await gitRead(record.path, ['-c', 'core.longpaths=true', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);

    if (!status.ok) {
        return refused('Git did not say what is changed in the worktree', record);
    }

    if (status.stdout !== '') {
        return refused('The worktree has changes that are not committed', record);
    }

    // An initialised submodule is `git worktree remove`'s own no (uninitialised ones are listed with a `-`): offering the box would end in a refusal.
    const submodules = await hasCheckedOutSubmodules(record.path);

    if (submodules === undefined) {
        return refused('Git did not say whether the worktree has submodules', record);
    }

    if (submodules) {
        return refused('The worktree has submodules checked out', record);
    }

    if (record.base === undefined) {
        return refused('The worktree has no base branch to compare its work with', record);
    }

    const base = (await commitOf(folder, `refs/heads/${ record.base }`)) ?? (await commitOf(folder, `refs/remotes/${ record.base }`));

    if (!base) {
        return refused(`The base ${ record.base } is not a branch of the repository`, record);
    }

    // The commit the tree is on counts as well as the branch it was made with: an agent may have moved the tree to another branch or to a detached HEAD, whose commits
    // would be left with nothing to find them by.
    if (!await isMerged(record.path, 'HEAD', base)) {
        return refused(`The worktree has commits that are not in ${ record.base }`, record);
    }

    const branch = record.branch === undefined ? null : await commitOf(folder, `refs/heads/${ record.branch }`);

    if (branch === undefined) {
        return refused('Git did not say where the branch is', record);
    }

    if (branch && !await isMerged(folder, branch, base)) {
        return refused(`The branch ${ record.branch } has commits that are not in ${ record.base }`, record);
    }

    return { removable: true, record, folder, listedPath: entry.path, hasBranch: branch !== null };
}

/** What `GET /v1/chats/:id/workspace` answers: whether the chat's worktree may go with the chat (`checkRemoval`), and the worktree's path and branch when the chat has one. */
export async function workspaceRemoval(store: Store, chatId: string): Promise<ChatWorkspaceRemoval> {
    const verdict = await checkRemoval(store, requireChat(store, chatId));
    const record = verdict.record;

    return { removable: verdict.removable, ...(record && { path: record.path, ...(record.branch !== undefined && { branch: record.branch }) }) };
}

/** Whether `path` is below `root`, by their names (a worktree's path is stored as it was made, under the folder the config named then). */
function isBelow(root: string, path: string): boolean {
    const way = relative(resolve(root), resolve(path));

    return way !== '' && !way.startsWith('..') && !isAbsolute(way);
}

/** Removes the folders a worktree leaves empty (`<project>/<chat>`), up to but not including the workspaces folder, and no folder that holds anything: `rmdir` refuses those. */
async function pruneEmptyParents(root: string, path: string): Promise<void> {
    for (let dir = dirname(path); isBelow(root, dir); dir = dirname(dir)) {
        try {
            await rmdir(dir);
        }
        catch {
            return;
        }
    }
}

/** The workspaces whose removal is running or waiting, with how many (two deletes of one chat may overlap): the driver's `Prepare workspace` step waits for them. */
const removing = new WeakMap<Store, Map<string, number>>();

/**
 * Whether the worktree is being removed with a chat (`removeChatWorkspace`). A turn that starts meanwhile goes through the same `exclusive` line as the removal before it
 * opens its session (`RunDriver.prepareWorkspace`), so it does not start inside a tree that is being deleted: it waits, finds the tree gone and makes it again.
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
    }
    else {
        counts.delete(workspaceId);
    }
}

/**
 * Says what `git worktree remove` failed with and what it left. Git deletes its own record of the worktree before it deletes the files, so a failure part way (a file an
 * editor or a virus scanner holds open, say) leaves the folder with a `.git` file that points nowhere and no worktree in `git worktree list`. The row is then marked not
 * `ready`, so the chat's next turn runs `Prepare workspace`, which refuses a folder that is no worktree and says so, instead of the agent starting in a dead tree; once the
 * folder is deleted by hand the turn makes the worktree again from the branch. The chat stays.
 */
async function failedRemoval(store: Store, verdict: Removable, reason: string): Promise<never> {
    const { record, folder } = verdict;
    const listed = await gitRead(folder, ['worktree', 'list', '--porcelain']);
    const forgotten = listed.ok && !parseWorktrees(listed.stdout).some(entry => !entry.bare && samePlace(entry.path, record.path));

    if (forgotten && await isOnDisk(record.path)) {
        store.tx(() => {
            updateWorkspace(store.db, record.id, { ready: false });

            for (const chatId of chatsOfWorkspace(store.db, record.id)) {
                const chat = getChat(store.db, chatId);

                if (chat) {
                    store.emit(chat.projectId, { type: 'chat.upserted', chat });
                }
            }
        });

        throw conflict(`${ reason }. Git no longer lists ${ record.path }, so what is left of the folder has to be deleted by hand`);
    }

    throw conflict(reason);
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
export async function removeChatWorkspace(store: Store, config: Pick<Config, 'workspacesDir'>, chatId: string): Promise<void> {
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

            const step = { log: () => undefined };

            try {
                // `core.longpaths` as the checkout has it: a deep `node_modules` made by the setup is still removable on Windows.
                await mustGit(verdict.folder, ['-c', 'core.longpaths=true', 'worktree', 'remove', verdict.listedPath], step, REMOVE_TIMEOUT_MS, 'remove the worktree');
            }
            catch (error) {
                if (error instanceof WorkspaceError) {
                    await failedRemoval(store, verdict, error.message);
                }

                throw error;
            }

            // The tree is gone and the branch is still named by the repository: a chat that stays after this has the branch it can make the worktree from again.
            if (verdict.hasBranch && verdict.record.branch !== undefined) {
                try {
                    await mustGit(verdict.folder, ['branch', '-D', '--', verdict.record.branch], step, BRANCH_TIMEOUT_MS, 'delete the branch');
                }
                catch (error) {
                    throw error instanceof WorkspaceError ? conflict(`The worktree was removed. ${ error.message }`) : error;
                }
            }

            await pruneEmptyParents(config.workspacesDir, verdict.record.path);
        });
    }
    finally {
        markRemoving(store, record.id, false);
    }
}
