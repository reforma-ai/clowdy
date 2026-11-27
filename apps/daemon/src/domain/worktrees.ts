import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { folderNames } from '@clowdy/protocol';

import { getChat } from '../db/chats';
import { getRunWork, listActiveRuns } from '../db/runs';
import { chatsOfWorkspace, listWorkspacesOfProject } from '../db/workspaces';
import { unavailable } from '../errors';
import { isBelow } from '../fs/paths';
import {
    baseOf,
    changedFiles,
    commitOf,
    hasCheckedOutSubmodules,
    isMerged,
    isOnDisk,
    parseWorktrees,
    placeOf,
    shortHash,
    workingTreeRoot,
} from '../git/state';
import { gitLine, gitRead } from './git';
import { pathKey, placeOf as realPlace } from './workspaces';

import type {
    FolderWorktrees,
    Project,
    ProjectFolder,
    WorktreeBlock,
    WorktreeChat,
    WorktreeInfo,
} from '@clowdy/protocol';
import type { WorkspaceRecord } from '../db/workspaces';
import type { ListedWorktree } from '../git/state';
import type { Store } from '../store';

/** How many worktrees of one folder are inspected at once: each inspection starts a few gits, and a repository may have dozens of worktrees. */
const INSPECTIONS = 4;

/** What an inspection of a folder's worktrees shares: where git runs for the refs, and the commit of each base ref it is asked about. */
export interface WorktreeContext {
    /** The folder's own checkout, where git reads the refs (a worktree shares them) and the ancestor checks run. */
    folder: string;
    /** The ref new worktrees of the folder start from (`baseOf`), for a worktree whose record keeps none; absent in a repository with no commit. */
    defaultBase?: string;
    /** The commit a base ref names as last fetched (`refs/heads/<name>`, then `refs/remotes/<name>`, no network); nothing when the repository has no such branch or git did not say. */
    commitOfBase: (name: string) => Promise<string | undefined>;
}

/** The worktree's own facts that the database and the folder give: whether it is the folder's checkout, the record Clowdy keeps of it, and the chats that work in it. */
export interface WorktreeOwner {
    /** The folder's own checkout. */
    main: boolean;
    /** The repository's primary working tree, which git itself never removes (the folder's own checkout is it, unless the folder is a linked worktree). */
    primary?: boolean;
    /** Another folder of the project: a place the project works in, which a removal refuses even when it is a worktree of this folder's repository. */
    sibling?: boolean;
    active?: boolean;
    record?: WorkspaceRecord;
    chats?: WorktreeChat[];
}

/** Whether a folder is there: a file in its place (a folder replaced by a file) is no folder, and git cannot be run in it. */
const isFolder = (path: string): Promise<boolean> =>
    stat(path).then(
        entry => entry.isDirectory(),
        () => false
    );

/**
 * A path as a key to compare it with another, as `samePlace` reads paths: its real place, and for a worktree whose folder is gone the real place of the nearest folder that is
 * there with the rest of the path after it. A link in the way (`/var` and `/private/var` on a Mac, a drive letter's case) must not part a gone worktree from its record and chats:
 * git writes the real path, and the record keeps the path as it was configured.
 */
async function keyOf(path: string): Promise<string> {
    const full = resolve(path);
    const place = await placeOf(full);
    const parent = dirname(full);

    return pathKey(place ?? (parent === full ? full : join(await keyOf(parent), basename(full))));
}

/** The commit of a base ref, read once per name: `refs/heads/<name>`, then `refs/remotes/<name>`. */
function baseCommits(folder: string): WorktreeContext['commitOfBase'] {
    const known = new Map<string, Promise<string | undefined>>();

    return name => {
        let commit = known.get(name);

        if (!commit) {
            commit = (async () =>
                (await commitOf(folder, `refs/heads/${name}`)) ??
                (await commitOf(folder, `refs/remotes/${name}`)) ??
                undefined)();
            known.set(name, commit);
        }

        return commit;
    };
}

/**
 * Whether what the worktree has is in the base: the commit it is on, and its branch when it has one that the repository still names (a detached HEAD has none). Nothing when
 * git cannot say: no commit to look at (a branch with none yet), or a ref that could not be asked. The checks run in the folder's checkout, which shares the refs and the objects
 * with every worktree, so a worktree whose folder is gone is checked the same.
 */
async function isInBase(folder: string, entry: ListedWorktree, base: string): Promise<boolean | undefined> {
    if (/^0*$/.test(entry.head)) {
        return undefined;
    }

    if (!(await isMerged(folder, entry.head, base))) {
        return false;
    }

    if (entry.branch === undefined) {
        return true;
    }

    const branch = await commitOf(folder, `refs/heads/${entry.branch}`);

    if (branch === undefined) {
        return undefined;
    }

    return branch === null || branch === entry.head || (await isMerged(folder, branch, base));
}

/**
 * Why Remove is not offered, the first that holds: the folder's own checkout, another folder of the project and the repository's primary working tree (the last git never removes), a
 * lock, and unarchived chats that work in the worktree. `workspace.remove` refuses the same worktrees for the same reasons.
 */
function blockOf(owner: WorktreeOwner, locked: boolean, chats: readonly WorktreeChat[]): WorktreeBlock | undefined {
    if (owner.main || owner.primary || owner.sibling) return 'main';
    if (locked) return 'locked';

    return chats.some(chat => !chat.archived) ? 'chats' : undefined;
}

/**
 * What the Manage dialog shows of one worktree git lists: what is checked out, whether its folder is there, how many files are changed and whether a submodule is checked out
 * (read in the worktree itself, so only when it is there), whether its work is in the base, who works in it and why it cannot be removed. The base is the one the worktree was made
 * from (the record's), else the folder's own; the folder's own checkout has none, and a base the repository no longer has says nothing about merging. Every read is asynchronous,
 * bounded in time, and changes nothing.
 */
export async function inspectWorktree(
    context: WorktreeContext,
    entry: ListedWorktree,
    owner: WorktreeOwner
): Promise<WorktreeInfo> {
    const place = entry.prunable || entry.bare ? undefined : await placeOf(entry.path);
    const present = place !== undefined && (await isOnDisk(join(place, '.git'))) ? place : undefined;
    const base = owner.main ? undefined : (owner.record?.base ?? context.defaultBase);
    const counts =
        present === undefined
            ? ([0, undefined] as const)
            : await Promise.all([changedFiles(present), hasCheckedOutSubmodules(present)]);
    const baseCommit = base === undefined ? undefined : await context.commitOfBase(base);
    const merged = baseCommit === undefined ? undefined : await isInBase(context.folder, entry, baseCommit);
    const chats = owner.chats ?? [];
    const blocked = blockOf(owner, entry.locked !== undefined, chats);

    return {
        // Git prints `C:/work/app` on Windows; the app's paths are written as the machine writes them.
        path: resolve(entry.path),
        ...(entry.branch !== undefined && { branch: entry.branch }),
        head: shortHash(entry.head),
        ...(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.head) && { headOid: entry.head }),
        main: owner.main,
        missing: present === undefined,
        ...(entry.locked !== undefined && { locked: entry.locked }),
        changes: counts[0],
        // Unknown is not "yes": the red removal that follows a "yes" forces it, and git alone refuses a tree with submodules on a plain removal.
        submodules: counts[1] === true,
        ...(merged !== undefined && base !== undefined && { merged, base }),
        ...(owner.record && { workspaceId: owner.record.id }),
        managed: owner.record?.managed ?? false,
        ...(owner.active && { active: true }),
        chats,
        ...(blocked && { blocked }),
    };
}

/** What the database says of the project's worktrees: the records, and the chats that point at each (archived ones too, oldest first). */
function readWorkspaces(
    store: Store,
    projectId: string
): { records: WorkspaceRecord[]; chatsOf: Map<string, WorktreeChat[]> } {
    return store.read(() => {
        const records = listWorkspacesOfProject(store.db, projectId);
        const chatsOf = new Map(
            records.map(record => [
                record.id,
                chatsOfWorkspace(store.db, record.id).flatMap(id => {
                    const chat = getChat(store.db, id);

                    return chat ? [{ id: chat.id, title: chat.title, archived: chat.archivedAt !== undefined }] : [];
                }),
            ])
        );

        return { records, chatsOf };
    });
}

/**
 * Where a worktree stands in a folder's list, from the top: the folder's own checkout, then what is the person's own or ours (Clowdy made it, a chat works in it, archived ones too,
 * or it is the repository's primary working tree or another folder's checkout, which `blocked: 'main'` says), then the rest (an agent's own worktree, one made by hand or by another
 * program), and last one whose folder is gone, of which only the record is left.
 */
function rank({
    main,
    missing,
    managed,
    chats,
    blocked,
}: Pick<WorktreeInfo, 'main' | 'missing' | 'managed' | 'chats' | 'blocked'>): number {
    if (main) return 0;

    if (missing) return 3;

    return managed || chats.length > 0 || blocked === 'main' ? 1 : 2;
}

/** A folder's worktrees with ours above the others (`rank`), each kind in the order git lists them. */
export function orderWorktrees(worktrees: readonly WorktreeInfo[]): WorktreeInfo[] {
    return worktrees
        .map((worktree, index) => ({ worktree, index }))
        .sort((a, b) => rank(a.worktree) - rank(b.worktree) || a.index - b.index)
        .map(({ worktree }) => worktree);
}

/**
 * One folder's group: nothing for a folder gone from the disk (or replaced by a file) or that is no repository (a folder inside one has no worktree of its own), else the folder's own checkout first and
 * every worktree git lists after it, ours above the others (`orderWorktrees`), git's order within each kind. Git lists the folder's checkout by its real place, so the row carries the folder's path as the project holds it; when the
 * folder is itself a linked worktree, the repository's primary one is among the others, flagged because git never removes it, and so is the checkout of another folder of the
 * project (`siblings`), which the project works in. A git that does not answer is `unavailable` for the whole read, as for `GET /v1/projects/:id/git`.
 */
async function folderWorktrees(
    folder: ProjectFolder,
    name: string,
    siblings: readonly string[],
    records: readonly WorkspaceRecord[],
    chatsOf: ReadonlyMap<string, WorktreeChat[]>,
    activePaths: readonly string[]
): Promise<FolderWorktrees> {
    const none: FolderWorktrees = { folderId: folder.id, name, isRepository: false, worktrees: [] };
    const root = (await isFolder(folder.path)) ? await workingTreeRoot(folder.path) : undefined;

    if (!root) {
        return none;
    }

    const read = await gitRead(folder.path, ['worktree', 'list', '--porcelain']);

    if (!read.ok && read.reason === 'unavailable') {
        throw unavailable('git did not answer');
    }

    const rootKey = pathKey(root);
    const all = parseWorktrees(read.ok ? read.stdout : '');
    // The first entry git prints is the repository's primary working tree, unless that is a bare repository, which has none.
    const primary = all[0]?.bare ? undefined : all[0];
    // A repository that keeps its git directory apart from the checkout (`git init --separate-git-dir`) has that directory named as the first entry: it is there, it holds no files
    // to work in, and it has no `.git` of its own. A primary tree whose folder is gone is a row, as any worktree whose folder is gone is.
    const apart =
        primary !== undefined && (await isOnDisk(primary.path)) && !(await isOnDisk(join(primary.path, '.git')));
    const listed = all.filter(entry => !entry.bare && !(apart && entry === primary));
    const keys = await Promise.all(listed.map(entry => keyOf(entry.path)));
    const ownIndex = keys.indexOf(rootKey);
    // The checkout of a repository that keeps its git directory apart is not in the list under its own name: it is made from what git says in the folder.
    const branch = ownIndex >= 0 ? undefined : await gitLine(folder.path, ['branch', '--show-current']);
    const own: ListedWorktree =
        ownIndex >= 0
            ? listed[ownIndex]
            : {
                  path: root,
                  head: (await gitLine(folder.path, ['rev-parse', 'HEAD'])) ?? '',
                  ...(branch !== undefined && { branch }),
                  bare: false,
                  prunable: false,
              };
    const defaultBase = await baseOf(folder);
    const context: WorktreeContext = {
        folder: folder.path,
        ...(defaultBase !== undefined && { defaultBase }),
        commitOfBase: baseCommits(folder.path),
    };
    const recordKeys = await Promise.all(
        records
            .filter(record => record.folderId === folder.id)
            .map(async record => [await keyOf(record.path), record] as const)
    );
    const recordAt = new Map(recordKeys);
    const siblingKeys = new Set(await Promise.all(siblings.map(keyOf)));
    const others = listed.flatMap((entry, index) =>
        index === ownIndex
            ? []
            : [{ entry, key: keys[index], primary: entry === primary, sibling: siblingKeys.has(keys[index]) }]
    );
    // The folder's own checkout is the first row, with no record and no chats: it is where chats work when they have no worktree.
    const worktrees: WorktreeInfo[] = [
        await inspectWorktree(context, { ...own, path: resolve(folder.path) }, { main: true }),
    ];

    for (let start = 0; start < others.length; start += INSPECTIONS) {
        worktrees.push(
            ...(await Promise.all(
                others.slice(start, start + INSPECTIONS).map(({ entry, key, primary, sibling }) => {
                    const record = recordAt.get(key);

                    return inspectWorktree(context, entry, {
                        main: false,
                        primary,
                        sibling,
                        // Use the already-resolved Git row key, not a synchronous realpath for every pair.
                        active: activePaths.some(cwd => isBelow(key, cwd, { allowSelf: true })),
                        ...(record && { record, chats: chatsOf.get(record.id) }),
                    });
                })
            ))
        );
    }

    return { ...none, isRepository: true, worktrees: orderWorktrees(worktrees) };
}

/**
 * What `GET /v1/projects/:id/worktrees` answers: a group per folder of the project in its order, the worktrees of each folder with who works in them and how far their work is from
 * the base. The database is read once, up front, and the folders after it one after another (a project has few, and each starts a handful of gits), so a project with many worktrees
 * never starts a crowd of processes; each git read gives up after its own timeout.
 */
export async function projectWorktrees(store: Store, project: Project): Promise<FolderWorktrees[]> {
    const { records, chatsOf } = readWorkspaces(store, project.id);
    const activePaths = store.read(() =>
        listActiveRuns(store.db).flatMap(run => {
            const { cwd } = getRunWork(store.db, run.id);
            return cwd === undefined ? [] : [realPlace(cwd)];
        })
    );
    const names = folderNames(project.folders);
    const groups: FolderWorktrees[] = [];

    for (const [index, folder] of project.folders.entries()) {
        groups.push(
            await folderWorktrees(
                folder,
                names[index],
                project.folders.filter(other => other.id !== folder.id).map(other => other.path),
                records,
                chatsOf,
                activePaths
            )
        );
    }

    return groups;
}
