import { existsSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
    branchNameProblem,
    branchPrefixOf,
    branchPrefixProblem,
    folderNames,
    MAX_BRANCH_NAME_LENGTH,
    mainFolder,
    STOPPED_TOOL,
} from '@clowdy/protocol';

import { getChat, listChats } from '../db/chats';
import { getProject } from '../db/projects';
import { getRunWork } from '../db/runs';
import {
    chatsOfWorkspace,
    deleteWorkspace,
    getWorkspace,
    insertWorkspace,
    listWorkspacesOfProject,
    renameWorkspaceBase,
    toChatWorkspace,
    updateWorkspace,
} from '../db/workspaces';
import { conflict, errorMessage, invalid, notFound } from '../errors';
import { isBelow } from '../fs/paths';
import { baseOf, parseWorktrees, workingTreeRoot } from '../git/state';
import { newId } from '../ids';
import { inheritedEnv } from '../process/env';
import { git, gitLine, gitOutput, gitRead } from './git';
import { appendItem, updateItem } from './items';
import { runLines } from './lines';
import { runSetup } from './workspaceSetup';

import type {
    Chat,
    ChatWorkspace,
    ChatWorkspaceChoice,
    ChatWorktreeChoice,
    CreatedWorktree,
    Project,
    ProjectFolder,
    StreamItemBody,
} from '@clowdy/protocol';
import type { Config } from '../config';
import type { ListedWorktree } from '../git/state';
import type { Store } from '../store';

/** The name of the tool item `Prepare workspace` writes to the stream of the turn that makes (or checks) a chat's worktree. */
export const WORKSPACE_TOOL = 'workspace';

/** A `git fetch` that takes longer than this is given up: the remote may be asking for a sign-in nobody can answer, or not answering at all. */
const FETCH_TIMEOUT_MS = 120_000;

/** A checkout of a large repository may take minutes; this only ends one that has hung. */
const ADD_TIMEOUT_MS = 10 * 60_000;

/** A `worktree remove` of a record whose folder is gone does no checking out. */
const FORGET_TIMEOUT_MS = 60_000;

/** The longest project slug in a worktree's path: paths on Windows are short, and the ids in them stay short for the same reason. */
const MAX_SLUG_LENGTH = 32;

/** Names Windows does not allow for a folder, whatever the extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** What `Prepare workspace` keeps of git's lines in the tool item: the item is rewritten as lines arrive, so it is bounded. */
const MAX_LOG_LINES = 200;

/** How much of a line the log keeps: every write of the item is an event with the whole log in it, and a setup command may print for ten minutes. */
const MAX_LOG_LINE_LENGTH = 400;

/** How often the log of the step may be written to the stream while lines arrive. */
const LOG_THROTTLE_MS = 100;

/** A step that has run this long is a long one (a setup command, not a checkout): its log is written `SLOW_LOG_THROTTLE_MS` apart. */
const SLOW_STEP_MS = 5000;
const SLOW_LOG_THROTTLE_MS = 1000;

/** A refusal or a failure of making a chat's worktree, in words the person reads; the turn fails with it and the next message tries again. */
export class WorkspaceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceError';
    }
}

/* ---------------------------------- Paths --------------------------------- */

/** A path as a key for comparing it with another: resolved, and where the file system ignores the case of names (Windows) lower-cased. */
export function pathKey(path: string): string {
    const resolved = resolve(path);

    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The real place of a path, for two paths to be compared (a link, `/var` and `/private/var`, a drive letter's case, git writing `C:/work` for `C:\work`): the
 * real path of what is there, and for a path that is not there yet the real path of the nearest folder that is with the rest of the path after it.
 */
export function placeOf(path: string): string {
    const full = resolve(path);

    try {
        return realpathSync.native(full);
    } catch {
        const parent = dirname(full);

        return parent === full ? full : join(placeOf(parent), basename(full));
    }
}

/** Whether two paths are the same place. */
export const samePlace = (a: string, b: string): boolean => pathKey(placeOf(a)) === pathKey(placeOf(b));

/** A removal reserves its exact path and the stopped chats it will dispose of during Git's asynchronous mutation. */
const removalReservations = new WeakMap<Store, Set<{ projectId: string; path: string; chats: ReadonlySet<string> }>>();
const pendingChatChanges = new WeakMap<Store, Set<{ chatId: string }>>();

/** Whether the reserved folder `root` is the place of `path` or holds it. */
const reserves = (root: string, path: string) => isBelow(root, placeOf(path), { allowSelf: true });

/** Fork and edit wait outside their transaction. Do not remove underneath such a pending operation. */
export function beginChatChange(store: Store, chatId: string): () => void {
    assertChatAvailable(store, chatId);
    const pending = pendingChatChanges.get(store) ?? new Set();
    const change = { chatId };
    pending.add(change);
    pendingChatChanges.set(store, pending);
    return () => pending.delete(change);
}

export function assertProjectChatsAvailable(store: Store, projectId: string): void {
    const reservations = removalReservations.get(store);
    if (!reservations?.size) return;
    if ([...reservations].some(reservation => reservation.projectId === projectId)) {
        throw conflict('A worktree of this space is being removed');
    }
    for (const chat of listChats(store.db, projectId)) assertChatAvailable(store, chat.id);
}

export function reserveRemoval(store: Store, projectId: string, path: string, chats: ReadonlySet<string>): () => void {
    const reservations = removalReservations.get(store) ?? new Set();
    const reservation = { projectId, path: placeOf(path), chats };
    assertWorkspaceAvailable(store, path);
    for (const id of chats) assertChatAvailable(store, id);
    for (const change of pendingChatChanges.get(store) ?? []) {
        const chat = getChat(store.db, change.chatId);
        const cwd = chat?.orchestratorRunId && getRunWork(store.db, chat.orchestratorRunId).cwd;
        if (
            chats.has(change.chatId) ||
            (chat?.workspace && reserves(reservation.path, chat.workspace.path)) ||
            (cwd !== undefined && reserves(reservation.path, cwd))
        ) {
            throw conflict('A chat linked to this worktree is being edited or forked');
        }
    }
    reservations.add(reservation);
    removalReservations.set(store, reservations);

    return () => reservations.delete(reservation);
}

export function assertWorkspaceAvailable(store: Store, path: string): void {
    if ([...(removalReservations.get(store) ?? [])].some(reservation => reserves(reservation.path, path))) {
        throw conflict('The worktree is being removed');
    }
}

export function chatRemovalReserved(store: Store, chatId: string): boolean {
    const reservations = removalReservations.get(store);
    if (!reservations?.size) return false;
    const chat = getChat(store.db, chatId);
    const cwd = chat?.orchestratorRunId && getRunWork(store.db, chat.orchestratorRunId).cwd;
    return [...reservations].some(
        reservation =>
            reservation.chats.has(chatId) ||
            (chat?.workspace !== undefined && reserves(reservation.path, chat.workspace.path)) ||
            (cwd !== undefined && reserves(reservation.path, cwd))
    );
}

export function assertChatAvailable(store: Store, chatId: string): void {
    if (chatRemovalReserved(store, chatId))
        throw conflict('The chat is being removed or its worktree is being removed');
}

/**
 * Whether something is there on the disk at the path, a folder, a file or a link (a dangling one included). Only "no such file" and "a parent is no folder" say it
 * is not: a path that cannot be looked at (no permission, a stale network disk) may well be there, and is a failure, not a place to make a worktree in.
 */
async function isThere(path: string): Promise<boolean> {
    try {
        await lstat(path);

        return true;
    } catch (error) {
        const { code } = error as { code?: string };

        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return false;
        }

        throw new WorkspaceError(
            `Couldn't look at ${path}: ${code ?? (error instanceof Error ? error.message : String(error))}`
        );
    }
}

/* --------------------------------- Layout --------------------------------- */

/** The project's name as a folder name: lower-case letters and digits with dashes, cut short; the project's id for a name that has none (and not a name Windows reserves). */
export function projectSlug(project: Pick<Project, 'id' | 'name'>): string {
    const slug = project.name
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/, '');

    if (!slug) {
        return project.id;
    }

    return RESERVED_NAMES.test(slug) ? `${slug}-project` : slug;
}

/** The random end of a chat's id (the front of a ULID is the time), which names its worktree and its branch: the last 8 characters. */
export const chatKey = (chatId: string): string => chatId.slice(-8);

/** A folder's name for a path: `folderNames` gives it, and a character a file system does not take in a name is turned into a dash. */
function folderSegment(name: string): string {
    const clean = [...name.replace(/[<>:"/\\|?*]/g, '-')]
        .map(character => (character.charCodeAt(0) < 32 ? '-' : character))
        .join('')
        .replace(/[. ]+$/, '');

    if (clean === '' || clean === '.' || clean === '..') {
        return 'folder';
    }

    return RESERVED_NAMES.test(clean.toLowerCase()) ? `${clean}-folder` : clean;
}

/**
 * Where a chat's new worktree goes and what its branch is called: `<workspacesDir>/<project-slug>/<chat-id8>/<folder-name>` on `<prefix>/<branch name>`, the prefix
 * being `clowdy` unless the person chose one (`branchPrefixOf`; `createNewWorkspace` checks it), and the name the chat's id8 unless one was given (a thread's, made of its
 * title). The folder is named by the id8 alone, and is never renamed: an agent keeps its sessions by folder. The folder's own name is the last part, so a shell prompt and a
 * window title read as the project does. Nothing is made.
 */
export function workspaceLayout(
    config: Pick<Config, 'workspacesDir'>,
    project: Project,
    folder: ProjectFolder,
    chatId: string,
    branchPrefix?: string,
    branchName?: string
): { path: string; branch: string } {
    const name =
        folderNames(project.folders.map(({ path }) => ({ path })))[
            project.folders.findIndex(candidate => candidate.id === folder.id)
        ] ?? basename(folder.path);

    return {
        path: join(config.workspacesDir, projectSlug(project), chatKey(chatId), folderSegment(name)),
        branch: `${branchPrefixOf(branchPrefix)}/${branchName ?? chatKey(chatId)}`,
    };
}

/**
 * Whether a worktree was made for this very chat: Clowdy made it (`managed`) and it stands in the folder named by the chat's id8 (`<project-slug>/<chat-id8>/<folder-name>`, which
 * `workspaceLayout` makes and nothing renames), whatever its branch is called. A thread that shares its parent's worktree stands in one with the parent's id8, and a worktree that
 * was found is not managed.
 */
export const ownsWorktree = (chat: { id: string }, workspace: Pick<ChatWorkspace, 'managed' | 'path'>): boolean =>
    workspace.managed && basename(dirname(workspace.path)) === chatKey(chat.id);

/** Standalone worktrees use their own ID in the layout, so their lifetime does not depend on a chat. */
export const isStandaloneWorktree = (workspace: Pick<ChatWorkspace, 'id' | 'managed' | 'path'>): boolean =>
    workspace.managed && basename(dirname(workspace.path)) === chatKey(workspace.id);

/* --------------------------- Reading a repository -------------------------- */

/** Where a checkout's HEAD is: its branch, or on a detached HEAD the short hash and the full one. */
export interface Head {
    branch: string;
    detached?: true;
    commit: string;
}

/**
 * What a chat's worktree is checked against in the repository of a folder, read before the transaction that writes its row, so that no git runs inside it
 * (`readRepository`: `chat.create` and a thread's spawn read it so). A read that fails reads as nothing: not a root, no HEAD, no branch, no worktree, which the
 * checks refuse. A git that does not answer while the base is read is `unavailable` instead (`baseOf`).
 */
export interface RepositoryFacts {
    /** The folder that was read. */
    path: string;
    /** Whether the folder is the root of a working tree: a worktree is made of the whole repository, so a folder inside one has none of its own. */
    root: boolean;
    head?: Head;
    /** The branches by ref, local (`refs/heads/…`) and the remotes' (`refs/remotes/…`). */
    refs: ReadonlySet<string>;
    /** The base of a worktree whose choice names none, as `baseOf` says it. */
    base?: string;
    /** The worktrees `git worktree list` names: an existing one a chat picks has to be one of them. */
    worktrees: readonly ListedWorktree[];
}

const REFS_FORMAT = ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'];
const WORKTREES_LIST = ['worktree', 'list', '--porcelain'];

/** The refs `REFS_FORMAT` lists. */
const parseRefs = (output: string): Set<string> => new Set(output.split('\n').filter(ref => ref !== ''));

/** Where the checkout at `path` has HEAD, read with the async git: nothing when it has no commit or git does not answer. */
async function readHead(path: string): Promise<Head | undefined> {
    const [commit, branch, short] = await Promise.all([
        gitLine(path, ['rev-parse', 'HEAD']),
        gitLine(path, ['branch', '--show-current']),
        gitLine(path, ['rev-parse', '--short', 'HEAD']),
    ]);

    if (commit === undefined) {
        return undefined;
    }

    return branch !== undefined
        ? { branch, commit }
        : short !== undefined
          ? { branch: short, detached: true, commit }
          : undefined;
}

/** Reads `RepositoryFacts` of the folder with the async git. */
export async function readRepository(folder: ProjectFolder): Promise<RepositoryFacts> {
    const [top, head, refs, base, worktrees] = await Promise.all([
        gitLine(folder.path, ['rev-parse', '--show-toplevel']),
        readHead(folder.path),
        gitOutput(folder.path, REFS_FORMAT),
        baseOf(folder),
        gitOutput(folder.path, WORKTREES_LIST),
    ]);

    return {
        path: folder.path,
        root: top !== undefined && samePlace(top, folder.path),
        ...(head && { head }),
        refs: parseRefs(refs ?? ''),
        ...(base !== undefined && { base }),
        worktrees: parseWorktrees(worktrees ?? ''),
    };
}

/** Where the worktree at `path` has HEAD, when it is there and the root of a checkout: what a thread of a chat that works in it starts from (`threadBase`). */
export async function readWorktreeHead(path: string): Promise<Head | undefined> {
    if (!existsSync(path)) {
        return undefined;
    }

    const [top, head] = await Promise.all([gitLine(path, ['rev-parse', '--show-toplevel']), readHead(path)]);

    return top !== undefined && samePlace(top, path) ? head : undefined;
}

/*
 * `workspace.open` is still a synchronous command, so it reads what it checks with the sync `git` (a few local reads, no network) inside its transaction.
 */

/** Whether the folder is the root of a working tree, read synchronously. */
function isRepositoryRoot(folder: string): boolean {
    const top = git(folder, ['rev-parse', '--show-toplevel']);

    return top.ok && top.stdout !== '' && samePlace(top.stdout, folder);
}

/** The worktrees `git worktree list` of the folder names, read synchronously. */
function worktreesOf(folder: string): ListedWorktree[] {
    const listed = git(folder, WORKTREES_LIST);

    return parseWorktrees(listed.ok ? listed.stdout : '');
}

/** The refs a base may be, in the order they are tried: a local branch, then a remote's (`origin/main`). Never the bare name: a tag called `main` would make it ambiguous. */
const baseRefs = (base: string): [ref: string, remote: boolean][] => [
    [`refs/heads/${base}`, false],
    [`refs/remotes/${base}`, true],
];

/** A base that is a commit's hash (the short one a detached HEAD gives). */
const isHash = (text: string): boolean => /^[0-9a-f]{7,40}$/i.test(text);

/** What a base names: the commit, and whether it is a remote's branch (which a worktree fetches first). */
interface ResolvedBase {
    commit: string;
    remote: boolean;
}

/** Whether a new chat's worktree can start from `base` in the repository: a branch of it, or a hash of the commit the folder has checked out on a detached HEAD. */
function hasBase(repository: RepositoryFacts, base: string): boolean {
    const { head } = repository;

    return (
        baseRefs(base).some(([ref]) => repository.refs.has(ref)) ||
        (isHash(base) && head?.detached === true && head.commit.startsWith(base.toLowerCase()))
    );
}

/** A base resolved in the repository when the worktree is made. A hash is any commit of it: it was checked when the chat was made. */
async function resolveBase(folder: string, base: string): Promise<ResolvedBase | undefined> {
    for (const [ref, remote] of baseRefs(base)) {
        const found = (await gitOutput(folder, ['show-ref', '--verify', '--hash', ref]))?.trim();

        if (found) {
            return { commit: found, remote };
        }
    }

    const commit = isHash(base)
        ? (await gitOutput(folder, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]))?.trim()
        : undefined;

    return commit ? { commit, remote: false } : undefined;
}

/** The remote a remote-tracking base belongs to, and the branch on it: `origin/feature/x` is `origin` and `feature/x` (a remote's name may hold a slash, so the longest one that starts it wins). */
function remoteOf(base: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
    const remote = remotes.filter(name => base.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];

    return remote === undefined ? undefined : { remote, branch: base.slice(remote.length + 1) };
}

/* ------------------------------ A chat's workspace ----------------------------- */

/** What a new chat asks of `createWorkspace`: the project, the id the chat is going to have (the worktree and its branch are named after it), its folder and the choice. */
export interface WorkspaceRequest {
    project: Project;
    chatId: string;
    /** The folder the chat works in; the project's main folder when absent. */
    folderId?: string;
    choice: ChatWorktreeChoice;
    /** What was read of the folder's repository before the transaction (`readRepository`). */
    repository: RepositoryFacts;
}

/** Checks out and applies the folder's setup before returning a new standalone worktree. */
export async function createStandaloneWorktree(
    store: Store,
    config: Pick<Config, 'workspacesDir' | 'timings'>,
    project: Project,
    request: { folderId: string; branchName: string; branchPrefix?: string }
): Promise<CreatedWorktree> {
    const problem = branchPrefixProblem(request.branchPrefix) ?? branchNameProblem(request.branchName);

    if (problem) throw invalid(problem);

    const folder = project.folders.find(candidate => candidate.id === request.folderId);

    if (!folder) throw invalid(`Folder ${request.folderId} does not belong to space ${project.id}`);

    const root = await workingTreeRoot(folder.path);

    if (!root) throw invalid('A worktree needs the root of a git repository, and this folder is not one');

    const id = newId('wks');
    const planned = workspaceLayout(config, project, folder, id, request.branchPrefix, request.branchName);
    const { branch } = planned;
    const path = placeOf(planned.path);
    const layout = { path, branch };
    const log = () => undefined;

    return exclusive(store, pathKey(path), undefined, async () => {
        const gitWarning = await exclusive(store, `repository:${pathKey(root)}`, undefined, async () => {
            const base = await baseOf(folder);
            const start = base && (await resolveBase(root, base));

            if (!base || !start) throw invalid('The repository has no commit to start a worktree from');
            if (await isThere(path)) throw conflict(`${path} already exists`);

            assertWorkspaceAvailable(store, path);

            // A daemon stopped before checkout may have left a reservation with no worktree on disk.
            const prior = listWorkspacesOfProject(store.db, project.id).find(
                row => row.folderId === folder.id && row.branch === branch && !row.ready && isStandaloneWorktree(row)
            );
            if (prior && !(await isThere(prior.path))) {
                const listed = await listWorktrees(root);

                if (
                    !listed.some(entry => samePlace(entry.path, prior.path)) &&
                    chatsOfWorkspace(store.db, prior.id).length === 0
                ) {
                    store.tx(() => deleteWorkspace(store.db, prior.id));
                }
            }

            const refs = parseRefs((await gitOutput(root, REFS_FORMAT)) ?? '');

            if (branchTaken(store, project, folder, refs, branch)) throw conflict(`The branch name ${branch} is taken`);

            // A chat that picks the worktree during setup must share its pending row and wait on the path lock.
            store.tx(() =>
                insertWorkspace(store.db, {
                    id,
                    projectId: project.id,
                    folderId: folder.id,
                    ...layout,
                    base,
                    managed: true,
                    ready: false,
                    createdAt: Date.now(),
                })
            );

            try {
                await mustGit(
                    root,
                    ['-c', 'core.longpaths=true', 'worktree', 'add', '-b', branch, '--', path, start.commit],
                    { log },
                    ADD_TIMEOUT_MS,
                    'create the worktree'
                );
            } catch (error) {
                // A post-checkout hook may fail after Git successfully made the worktree.
                const listed = await listWorktrees(root).catch(() => []);
                const completed = listed.some(
                    entry =>
                        !entry.bare &&
                        !entry.prunable &&
                        entry.locked !== 'initializing' &&
                        entry.branch === branch &&
                        entry.head === start.commit &&
                        samePlace(entry.path, path)
                );

                if (completed && error instanceof WorkspaceError) return error.message;

                store.tx(() => {
                    if (chatsOfWorkspace(store.db, id).length === 0) deleteWorkspace(store.db, id);
                });

                throw error instanceof WorkspaceError ? conflict(error.message) : error;
            }

            return undefined;
        });

        if (folder.settings?.setup) {
            try {
                await runSetup({
                    root,
                    workspace: path,
                    branch,
                    setup: folder.settings.setup,
                    timeoutMs: config.timings.setupMs,
                    log,
                });
            } catch (error) {
                // Keep the checkout and the pending row so the next chat turn can retry the setup.
                const warning = [gitWarning, errorMessage(error)].filter(Boolean).join('. ');

                return { ...layout, warning };
            }
        }

        markReady(store, id);

        return gitWarning ? { ...layout, warning: gitWarning } : layout;
    });
}

/**
 * Makes the row of the worktree a new chat works in, and nothing on the disk: a new worktree is made by the chat's first turn (`prepareWorkspace`), an existing
 * one is there already. Refuses (`invalid`) a folder that is not the root of a repository, a base that is not a branch of it (a local one, or a remote's as
 * `origin/main`), and a path that `git worktree list` of the folder does not name or that is the folder itself. A new worktree is `managed` (Clowdy made it
 * and may remove it) and not `ready`; one that was found is the reverse, and the row of a worktree that has one already is the one shared (`chatsOfWorkspace`
 * tells who uses it). Call it inside a transaction: it is the first part of making the chat.
 */
export function createWorkspace(
    store: Store,
    config: Pick<Config, 'workspacesDir'>,
    request: WorkspaceRequest
): ChatWorkspace {
    const { project, chatId, choice, repository } = request;
    const folder = repositoryFolder(project, request.folderId, repository);

    return choice.mode === 'new'
        ? createNewWorkspace(store, config, project, folder, repository, chatId, choice)
        : openExistingWorkspace(store, project, folder, choice.path, repository.worktrees);
}

/**
 * The folder a worktree is made from: the given folder of the project, else its main one, and it has to be on the disk and the root of a repository (`invalid` otherwise).
 * `repository` is what was read of it before (`readRepository`), a `conflict` when it is another folder's; without it the root is read synchronously.
 */
function repositoryFolder(project: Project, folderId: string | undefined, repository?: RepositoryFacts): ProjectFolder {
    const folder =
        folderId === undefined ? mainFolder(project) : project.folders.find(candidate => candidate.id === folderId);

    if (!folder) {
        throw invalid(`Folder ${folderId} does not belong to space ${project.id}`);
    }

    if (!existsSync(folder.path)) {
        throw invalid(`The folder ${folder.path} is missing`);
    }

    if (repository !== undefined && repository.path !== folder.path) {
        throw conflict('The folder changed while its repository was read: try again');
    }

    if (!(repository?.root ?? isRepositoryRoot(folder.path))) {
        throw invalid('A worktree needs the root of a git repository, and this folder is not one');
    }

    return folder;
}

/** How long a row that no chat points at is kept by `openWorkspace`: a draft that chose the worktree is open for minutes, a day is generous. */
export const IDLE_WORKSPACE_MS = 24 * 60 * 60_000;

/**
 * The row of a worktree that exists already (one `git worktree list` of the folder names, not the folder itself), made if there is none and otherwise the one every
 * chat that works there shares, so a chat made later with `{ mode: 'existing', path }` gets the same id (`workspace.open`: the new-chat page asks for the row before the chat
 * exists, to show the worktree's files and shells in its places). The same refusals as `chat.create` with that choice. Rows that no chat points at (a page that asked and
 * was left) would stay for good, since a row goes only with its last chat: the ones that Clowdy did not make and that are older than `IDLE_WORKSPACE_MS` are dropped first.
 * Call it inside a transaction.
 */
export function openWorkspace(
    store: Store,
    project: Project,
    folderId: string | undefined,
    path: string,
    now = Date.now()
): ChatWorkspace {
    const folder = repositoryFolder(project, folderId);

    dropIdleWorkspaces(store, project.id, now);

    return openExistingWorkspace(store, project, folder, path);
}

/** Drops the project's rows that nobody uses and Clowdy did not make: the worktree on the disk is not touched, and a managed one is kept for whoever removes it. */
function dropIdleWorkspaces(store: Store, projectId: string, now: number): void {
    for (const record of listWorkspacesOfProject(store.db, projectId)) {
        if (
            !record.managed &&
            now - record.createdAt > IDLE_WORKSPACE_MS &&
            chatsOfWorkspace(store.db, record.id).length === 0
        ) {
            deleteWorkspace(store.db, record.id);
        }
    }
}

function createNewWorkspace(
    store: Store,
    config: Pick<Config, 'workspacesDir'>,
    project: Project,
    folder: ProjectFolder,
    repository: RepositoryFacts,
    chatId: string,
    choice: Extract<ChatWorkspaceChoice, { mode: 'new' }>
): ChatWorkspace {
    const problem =
        branchPrefixProblem(choice.branchPrefix) ??
        (choice.branchName === undefined ? undefined : branchNameProblem(choice.branchName));

    if (problem) {
        throw invalid(problem);
    }

    const base = choice.base ?? repository.base;

    if (!base) {
        throw invalid('The repository has no commit to start a worktree from');
    }

    if (!hasBase(repository, base)) {
        throw invalid(`${base} is not a branch of this repository`);
    }

    const layout = workspaceLayout(config, project, folder, chatId, choice.branchPrefix, choice.branchName);
    assertWorkspaceAvailable(store, layout.path);
    const clash = branchInTheWay(repository.refs, layout.branch);

    if (clash) {
        throw invalid(
            `This repository has a branch called ${clash}, so ${choice.branchName === undefined ? `the branch prefix cannot be ${branchPrefixOf(choice.branchPrefix)}` : `the branch ${layout.branch} cannot be made`}`
        );
    }

    // The id8 is unique by itself; a name someone chose is not, and is taken by a branch of the repository or by a worktree another chat is still to make.
    if (choice.branchName !== undefined && branchTaken(store, project, folder, repository.refs, layout.branch)) {
        throw invalid(
            `The branch name ${layout.branch} is taken, by a branch of the repository, one below it, or a worktree still to be made: name this one differently`
        );
    }

    const record = {
        id: newId('wks'),
        projectId: project.id,
        folderId: folder.id,
        ...layout,
        base,
        managed: true,
        ready: false,
        createdAt: Date.now(),
    };

    insertWorkspace(store.db, record);

    return toChatWorkspace(record);
}

/**
 * Whether `branch` cannot be made as a new branch: the repository has it, or has branches below it (`clowdy/fix` and `clowdy/fix/login` cannot both be, git keeps a branch as
 * a file), or a worktree row of the project that is not made yet is to have it or one below or above it. (`branchInTheWay` is the branches above it, in the repository.)
 */
function branchTaken(
    store: Store,
    project: Project,
    folder: ProjectFolder,
    refs: RepositoryFacts['refs'],
    branch: string
): boolean {
    return (
        refs.has(`refs/heads/${branch}`) ||
        [...refs].some(ref => ref.startsWith(`refs/heads/${branch}/`)) ||
        listWorkspacesOfProject(store.db, project.id).some(
            record =>
                record.folderId === folder.id &&
                record.branch !== undefined &&
                (record.branch === branch ||
                    record.branch.startsWith(`${branch}/`) ||
                    branch.startsWith(`${record.branch}/`))
        )
    );
}

/** The words of a text as a branch name: ASCII, lower case, joined with dashes, cut at a word to leave room for `-xxxx`; empty for a text with no letter or digit in ASCII. */
function branchSlug(text: string): string {
    const words = text
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const kept: string[] = [];

    for (const word of words) {
        if ([...kept, word].join('-').length > MAX_BRANCH_NAME_LENGTH - 5) break;

        kept.push(word);
    }

    return kept.join('-');
}

/** The slug, or the slug with the end of the chat's id when the slug is taken (or is a name Windows keeps for a device); `undefined` when neither can be a new branch. */
function freeBranchName(
    store: Store,
    project: Project,
    folder: ProjectFolder,
    refs: RepositoryFacts['refs'],
    prefix: string,
    slug: string,
    chatId: string
): string | undefined {
    const candidates = [
        ...(RESERVED_NAMES.test(slug) ? [] : [slug]),
        `${slug}-${chatKey(chatId).slice(-4).toLowerCase()}`,
    ];

    return candidates.find(
        name =>
            !branchTaken(store, project, folder, refs, `${prefix}/${name}`) &&
            branchInTheWay(refs, `${prefix}/${name}`) === undefined
    );
}

/**
 * What a worktree's branch may be called when it is made for a piece of work with a title: the title's words (`branchSlug`), with the end of the chat's id8 added when a
 * branch of that name is there already. `undefined` for a title that has no letter or digit in ASCII (a name in another script), so the branch keeps the id8 for a name.
 * Call it inside a transaction: the rows it reads are the ones the chat's own is written with. `repository` is what was read of the folder before it (`readRepository`).
 */
export function branchNameFor(
    store: Store,
    project: Project,
    folderId: string | undefined,
    repository: RepositoryFacts,
    chatId: string,
    branchPrefix: string | undefined,
    title: string
): string | undefined {
    const slug = branchSlug(title);

    return slug
        ? freeBranchName(
              store,
              project,
              repositoryFolder(project, folderId, repository),
              repository.refs,
              branchPrefixOf(branchPrefix),
              slug,
              chatId
          )
        : undefined;
}

/**
 * Whether a chat can still give its worktree a name of its own: it is a chat the person started (a thread's branch is told to its parent when it is spawned), Clowdy made
 * the worktree for it (`ownsWorktree`), and the branch still has the id8 for a name, as a new worktree has it. A chat whose branch was named is done with it.
 */
export function canNameBranch(chat: Pick<Chat, 'id' | 'parentChatId' | 'workspace'>): boolean {
    const { workspace } = chat;

    return (
        chat.parentChatId === undefined &&
        workspace !== undefined &&
        workspace.ready &&
        ownsWorktree(chat, workspace) &&
        workspace.branch?.endsWith(`/${chatKey(chat.id)}`) === true
    );
}

/**
 * Gives a chat's worktree a branch name of its words (`clowdy worktree name fix login redirect`): the branch it was made with is renamed in place (`git branch -m`, which
 * moves no folder: the agent's `cwd`, its session and its rights are the same, and the worktree's HEAD follows), the row is written and every chat that points at it is
 * published. The prefix stays. The name is the words as `branchSlug` reads them, with the end of the chat's id added when it is taken. `invalid` (with a reason the agent can
 * act on) for a chat that cannot (`canNameBranch`), words with no ASCII letter in them, a worktree that is on another branch than the one it was made with, and a branch
 * that has an upstream (it was pushed: a new name would leave the remote's behind).
 */
export function nameWorkspaceBranch(
    store: Store,
    project: Project,
    chat: Chat,
    words: string
): { branch: string; previous: string } {
    const { workspace } = chat;

    if (!workspace) {
        throw invalid('You work in the folder itself, so there is no worktree of yours to name');
    }

    if (!canNameBranch(chat) || workspace.branch === undefined) {
        throw invalid(
            chat.parentChatId === undefined && ownsWorktree(chat, workspace) && workspace.branch !== undefined
                ? `Your branch ${workspace.branch} has a name already`
                : "This worktree is not made for this chat alone, or its branch is not one of the daemon's to rename"
        );
    }

    const folder = project.folders.find(candidate => candidate.id === workspace.folderId);

    if (!folder) {
        throw invalid('The folder of your worktree is no longer part of the space');
    }

    const slug = branchSlug(words);

    if (!slug) {
        throw invalid(
            `Give the name as words in English: letters a-z and digits, short words, such as fix login redirect (the name is ${MAX_BRANCH_NAME_LENGTH - 5} characters at most)`
        );
    }

    if (!existsSync(workspace.path)) {
        throw invalid(`Your worktree folder ${workspace.path} is gone from the disk`);
    }

    const previous = workspace.branch;
    const live = git(workspace.path, ['branch', '--show-current']);

    if (!live.ok || live.stdout !== previous) {
        throw invalid(
            `Your worktree is on ${live.ok && live.stdout ? live.stdout : 'a detached HEAD'}, not on ${previous}, the branch it was made with: rename a branch you made yourself with git`
        );
    }

    const upstream = git(folder.path, ['config', '--get', `branch.${previous}.remote`]);

    if (upstream.ok && upstream.stdout !== '') {
        throw invalid(
            `Your branch ${previous} has an upstream (${upstream.stdout}), so a new name would leave the remote's branch behind: keep it`
        );
    }

    // Pushed without `-u` there is no upstream, but a branch of that name is on the remote as last fetched, or was pushed and its remote-tracking ref is made by the push.
    const remotes = git(folder.path, ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes']);

    if (remotes.ok && remotes.stdout.split('\n').includes(previous)) {
        throw invalid(`A remote has a branch called ${previous}, so a new name would leave it behind: keep it`);
    }

    const prefix = previous.slice(0, previous.lastIndexOf('/'));
    const listed = git(folder.path, REFS_FORMAT);
    const name = freeBranchName(
        store,
        project,
        folder,
        parseRefs(listed.ok ? listed.stdout : ''),
        prefix,
        slug,
        chat.id
    );

    if (name === undefined) {
        throw invalid(
            `The name ${prefix}/${slug} is taken, and so is the same with the end of your id: give other words`
        );
    }

    const branch = `${prefix}/${name}`;
    const renamed = git(workspace.path, ['branch', '-m', previous, branch]);

    if (!renamed.ok) {
        // Git renames the ref first and its settings after: a `config.lock` held by another git leaves the branch renamed and the command failed. The branch is what counts.
        const now = git(workspace.path, ['branch', '--show-current']);

        if (!now.ok || now.stdout !== branch) {
            throw invalid(`git could not rename the branch: ${renamed.stderr || renamed.stdout}`);
        }

        git(folder.path, ['config', '--rename-section', `branch.${previous}`, `branch.${branch}`]);
    }

    store.tx(() => {
        updateWorkspace(store.db, workspace.id, { branch });
        // A worktree made from this branch (a thread's own) has it for its base, and a base that is gone is a worktree that cannot be made, merged into or removed.
        renameWorkspaceBase(store.db, project.id, workspace.folderId, previous, branch);

        for (const chatId of chatsOfWorkspace(store.db, workspace.id)) {
            const sharing = getChat(store.db, chatId);

            if (sharing) {
                store.emit(sharing.projectId, { type: 'chat.upserted', chat: sharing });
            }
        }
    });

    return { branch, previous };
}

/** The branch of the repository that stands in the way of `branch`, if any: `max` for `max/ab12cd34`, since git keeps a branch as a file and cannot make a folder of it. */
function branchInTheWay(refs: RepositoryFacts['refs'], branch: string): string | undefined {
    const parents = branch.split('/').slice(0, -1);

    return parents
        .map((_, index) => parents.slice(0, index + 1).join('/'))
        .find(name => refs.has(`refs/heads/${name}`));
}

/** `worktrees` is what `git worktree list` of the folder said before the transaction (`RepositoryFacts`); without it the list is read synchronously. */
function openExistingWorkspace(
    store: Store,
    project: Project,
    folder: ProjectFolder,
    path: string,
    worktrees?: readonly ListedWorktree[]
): ChatWorkspace {
    if (!isAbsolute(path)) {
        throw invalid('The path of a worktree must be absolute');
    }

    assertWorkspaceAvailable(store, path);
    const entry = (worktrees ?? worktreesOf(folder.path)).find(
        candidate => !candidate.bare && samePlace(candidate.path, path)
    );

    if (!entry) {
        throw invalid(`${path} is not a worktree of this repository`);
    }

    if (samePlace(entry.path, folder.path)) {
        throw invalid('That is the folder itself, not a worktree of it');
    }

    if (entry.prunable || !existsSync(entry.path)) {
        throw invalid(`The worktree ${path} is gone from the disk`);
    }

    // Chats that pick the same worktree share its row, so whoever asks who uses it gets them all, and a worktree Clowdy made stays its own.
    const shared = listWorkspacesOfProject(store.db, project.id).find(
        record => record.folderId === folder.id && samePlace(record.path, entry.path)
    );

    if (shared) {
        return toChatWorkspace(shared);
    }

    const record = {
        id: newId('wks'),
        projectId: project.id,
        folderId: folder.id,
        path: resolve(entry.path),
        ...(entry.branch !== undefined && { branch: entry.branch }),
        managed: false,
        ready: true,
        createdAt: Date.now(),
    };

    insertWorkspace(store.db, record);

    return toChatWorkspace(record);
}

/**
 * The worktree a thread or a fork takes from its parent: the same row, not a copy, so the chats that share it are all known. It has to belong to the project
 * and to the folder the new chat works in (`invalid` otherwise, `not_found` for a row that is gone).
 */
export function inheritWorkspace(
    store: Store,
    project: Project,
    workspaceId: string,
    folderId: string | undefined
): ChatWorkspace {
    const record = getWorkspace(store.db, workspaceId);

    if (!record) {
        throw notFound('Workspace', workspaceId);
    }

    if (record.projectId !== project.id || (folderId !== undefined && record.folderId !== folderId)) {
        throw invalid(`Workspace ${workspaceId} is not a worktree of the folder the chat works in`);
    }

    assertWorkspaceAvailable(store, record.path);

    return toChatWorkspace(record);
}

/**
 * The base of a thread's own worktree when its parent works in `workspace`: the branch the parent's worktree has checked out now (an agent may have switched
 * since the row recorded one, and the work is on the branch it is on), read as an exact local ref (every worktree of a repository shares its branches), so the
 * thread starts from what the parent has committed there. When the parent's worktree is not there to ask, the recorded branch stands in. A parent whose worktree
 * is not made yet has no branch: it will be made from its own base and nothing is committed in it, so that base is the same commit. Anything else (a detached
 * HEAD, a branch the repository no longer has) is `invalid` with nothing made, since a thread started from some other commit would work on a tree without the
 * parent's work. `repository` is what was read of the worktree's folder, and `head` of the worktree itself (`readWorktreeHead`), before the transaction.
 */
export function threadBase(
    store: Store,
    project: Project,
    workspace: ChatWorkspace,
    repository: RepositoryFacts,
    head: Head | undefined
): string {
    const folder = project.folders.find(candidate => candidate.id === workspace.folderId);

    if (!folder) {
        throw invalid('The folder of your worktree is no longer part of the space');
    }

    if (repository.path !== folder.path) {
        throw conflict('The folder changed while its repository was read: try again');
    }

    if (head?.detached || (head === undefined && workspace.branch === undefined)) {
        throw invalid(
            'Your worktree is on a detached HEAD, so there is no branch of yours to start the thread from: name the branch to start it from with base'
        );
    }

    const branch = head?.branch ?? workspace.branch;

    if (branch !== undefined && repository.refs.has(`refs/heads/${branch}`)) {
        return branch;
    }

    const base = getWorkspace(store.db, workspace.id)?.base;

    if (!workspace.ready && base !== undefined) {
        return base;
    }

    throw invalid(
        `Your branch ${branch} is not in the repository any more, so there is nothing to start the thread from`
    );
}

/**
 * The branch a folder's own checkout has now, which a thread made for a parent that works there starts from: what the parent has committed on it, and not the repository's
 * default branch. `undefined` for a checkout on a detached HEAD or with no commit, whose base is the folder's own (`createWorkspace` picks it). `invalid` for a folder that is no
 * repository's root, as `createWorkspace` would. `repository` is what was read of the folder before (`readRepository`).
 */
export function checkoutBranch(
    project: Project,
    folderId: string | undefined,
    repository: RepositoryFacts
): string | undefined {
    repositoryFolder(project, folderId, repository);

    const { head } = repository;

    return head && !head.detached ? head.branch : undefined;
}

/** Whether a chat's first turn (or a later one) has to run `Prepare workspace`: the worktree is not set up yet, or Clowdy made it and it is gone from the disk. */
export function needsPreparing(workspace: Pick<ChatWorkspace, 'path' | 'managed' | 'ready'>): boolean {
    return !workspace.ready || (workspace.managed && !existsSync(workspace.path));
}

/* ------------------------------ Making a worktree ----------------------------- */

/** What a git run printed, and how it ended. */
interface GitRun {
    ok: boolean;
    /** Why it failed, in the words git said it in: its first `fatal:` or `error:` line, else its last line that is no hint. Empty when it printed nothing. */
    reason: string;
    aborted: boolean;
    timedOut: boolean;
}

interface Step {
    log(line: string): void;
    signal?: AbortSignal;
}

/** The reason in what git printed, as a person reads it: its first `fatal:` or `error:` line (a later `hint:` or `use … to override` is advice for someone at a terminal), with no prefix and no closing period. */
function reasonOf(lines: readonly string[]): string {
    const line =
        lines.find(candidate => /^(fatal|error): /.test(candidate)) ??
        lines.filter(candidate => !candidate.startsWith('hint:')).at(-1) ??
        '';

    return line
        .replace(/^(fatal|error): /, '')
        .trim()
        .replace(/\.+$/, '');
}

async function runGit(cwd: string, args: string[], step: Step, timeoutMs: number): Promise<GitRun> {
    const lines: string[] = [];

    try {
        const result = await runLines(['git', ...args], {
            cwd,
            // git does not stop to ask anything: a fetch that needs a password fails instead of waiting for it.
            env: { ...inheritedEnv(), GIT_TERMINAL_PROMPT: '0' },
            signal: step.signal,
            timeoutMs,
            onLine(line) {
                if (line.trim() !== '') {
                    lines.push(line);
                    step.log(line);
                }
            },
        });

        return { ok: result.code === 0, reason: reasonOf(lines), aborted: result.aborted, timedOut: result.timedOut };
    } catch (error) {
        // A program that is not there; anything else (the stream's own write failing, say) is not a reason to blame git.
        throw (error as { code?: unknown } | undefined)?.code === 'ENOENT'
            ? new WorkspaceError('git is not installed or not on the PATH')
            : error;
    }
}

/** A git run that has to succeed, `what` being what it does (`make the worktree`): a stop, the time and git's own no each say so in the reason. */
export async function mustGit(cwd: string, args: string[], step: Step, timeoutMs: number, what: string): Promise<void> {
    const result = await runGit(cwd, args, step, timeoutMs);

    if (result.aborted) {
        throw new WorkspaceError(STOPPED_TOOL);
    }

    if (result.timedOut) {
        throw new WorkspaceError(`Couldn't ${what}: it took too long`);
    }

    if (!result.ok) {
        throw new WorkspaceError(`Couldn't ${what}: ${result.reason || 'git gave no reason'}`);
    }
}

async function listWorktrees(folder: string): Promise<ListedWorktree[]> {
    const read = await gitRead(folder, ['worktree', 'list', '--porcelain']);

    if (!read.ok) {
        throw new WorkspaceError(
            read.reason === 'unavailable' ? 'git did not answer' : `${folder} is not a git repository`
        );
    }

    return parseWorktrees(read.stdout);
}

/** What `ensureWorktree` is asked to make sure of. */
export interface EnsureWorktreeOptions extends Step {
    /** The folder of the project the worktree is a checkout of: the repository's own checkout, or any worktree of it. */
    folder: string;
    path: string;
    /** The branch the worktree is on: made from `base` when the repository does not have it, checked out as it is when it has. */
    branch?: string;
    base?: string;
    /** Clowdy made it, so Clowdy may make it again when it is gone; a worktree it merely found is never made. */
    managed: boolean;
    /**
     * Runs the part that changes the repository's worktrees, one at a time per repository: git fails a `worktree add` that runs while another is half done in
     * the same repository (`failed to read .git/worktrees/<name>/commondir`), which many threads started together do. Without it the part runs at once.
     */
    serialize?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Makes sure the worktree is at its path, and says whether it had to make it. It never touches a tree that is there:
 *
 * - a path that `git worktree list` names as a worktree of the folder's repository is left exactly as it is, whatever branch it is on and whatever is changed in
 *   it: no checkout, reset, clean or stash, and no `--force` anywhere;
 * - a path that is there and is not such a worktree is a refusal, and is left alone;
 * - a branch that another worktree has checked out is a refusal, not a takeover.
 *
 * Only a path that is not there is made, and only for a worktree Clowdy made: from the branch when the repository has it (as it is, with the work it holds), else
 * a new branch from the base, fetched first when the base is a remote's (a failed fetch is a log line when the ref was fetched before, a failure when not). The
 * record git keeps of a worktree of this path that was deleted by hand is forgotten first (`git worktree remove` of the missing path, which touches nothing else
 * and refuses a locked one), since git will not check the branch out while it thinks another worktree has it. Failures are `WorkspaceError`s.
 */
export async function ensureWorktree(options: EnsureWorktreeOptions): Promise<'there' | 'made'> {
    const { folder, path, branch, base, managed } = options;
    const listed = await listWorktrees(folder);
    const entry = listed.find(candidate => !candidate.bare && samePlace(candidate.path, path));

    if (await isThere(path)) {
        if (entry && !entry.prunable) {
            // Git locks a worktree while it makes it, and a crash leaves the lock: what is in the folder may be a checkout that stopped half way.
            if (entry.locked === 'initializing') {
                throw new WorkspaceError(
                    `A previous attempt to make the worktree ${path} was cut off, and git still has it locked, so it was left alone`
                );
            }

            options.log(`The worktree ${path} is there already, left as it is`);

            return 'there';
        }

        throw new WorkspaceError(`${path} exists and is not a worktree of ${folder}, so it was left alone`);
    }

    if (!managed) {
        throw new WorkspaceError(`The worktree ${path} no longer exists`);
    }

    if (!branch) {
        throw new WorkspaceError(`The worktree ${path} has no branch to make it from`);
    }

    const holder = listed.find(candidate => candidate !== entry && !candidate.bare && candidate.branch === branch);

    if (holder) {
        throw new WorkspaceError(`The branch ${branch} is already checked out in ${resolve(holder.path)}`);
    }

    const exists = await gitRead(folder, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);

    if (!exists.ok && exists.reason === 'unavailable') {
        throw new WorkspaceError('git did not answer');
    }

    const commit = exists.ok ? undefined : await baseCommit(folder, base, options);

    return (options.serialize ?? (work => work()))(async () => {
        // The fetch above may have taken minutes: whatever was put at the path meanwhile is somebody's, and neither the record's removal (which deletes a tree that is
        // there and clean, ignored files included) nor the checkout is run over it.
        if (await isThere(path)) {
            throw new WorkspaceError(`${path} appeared while the worktree was being made, so it was left alone`);
        }

        if (entry) {
            options.log(`Forgetting the record of the worktree ${path}, which is gone from the disk`);
            await mustGit(
                folder,
                ['worktree', 'remove', entry.path],
                options,
                FORGET_TIMEOUT_MS,
                'forget the missing worktree'
            );
        }

        // The branch stays as it is when the repository has it; a new one starts at the commit the base had a moment ago.
        await mustGit(
            folder,
            [
                '-c',
                'core.longpaths=true',
                'worktree',
                'add',
                ...(commit ? ['-b', branch, path, commit] : [path, branch]),
            ],
            options,
            ADD_TIMEOUT_MS,
            'make the worktree'
        );

        return 'made' as const;
    });
}

/**
 * The commit a new branch starts at: the base's, fetched first when it is a remote's. A fetch that fails is a line of the log when the ref was fetched before
 * (the last one is used), and a failure when there is none to use.
 */
async function baseCommit(folder: string, base: string | undefined, step: Step): Promise<string> {
    if (!base) {
        throw new WorkspaceError('The branch is gone and there is no base to make it again from');
    }

    const before = await resolveBase(folder, base);

    // A remote's branch: the one the repository has as such, or one it has none of yet (the ref was pruned, or the chat was made before the first fetch).
    if (before === undefined || before.remote) {
        const remotes =
            (await gitOutput(folder, ['remote']))
                ?.split('\n')
                .map(name => name.trim())
                .filter(Boolean) ?? [];
        const target = remoteOf(base, remotes);

        if (target) {
            step.log(`Fetching ${base}`);

            const fetched = await runGit(folder, ['fetch', '--', target.remote, target.branch], step, FETCH_TIMEOUT_MS);

            if (fetched.aborted) {
                throw new WorkspaceError(STOPPED_TOOL);
            }

            if (!fetched.ok) {
                if (!before) {
                    throw new WorkspaceError(
                        `Couldn't fetch ${base}: ${fetched.timedOut ? 'it took too long' : fetched.reason || 'git gave no reason'}`
                    );
                }

                step.log(`Could not fetch, using the last fetched ${base}`);
            }
        }
    }

    const after = await resolveBase(folder, base);

    if (!after) {
        throw new WorkspaceError(`${base} is not a branch of this repository any more`);
    }

    return after.commit;
}

/* ------------------------------- Prepare workspace ------------------------------ */

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

/**
 * The tool item of `Prepare workspace`: written running when the step starts, rewritten with git's lines as they arrive (a few times a second at most) and a last
 * time with the state it ended in.
 */
class StepItem {
    private lines: string[] = [];
    private seq: number;
    private body: ToolBody;
    private timer?: ReturnType<typeof setTimeout>;
    private writtenAt = 0;
    private startedAt = Date.now();

    constructor(
        private store: Store,
        private runId: string,
        workspaceId: string,
        input: unknown
    ) {
        this.body = {
            kind: 'tool',
            toolCallId: `workspace:${workspaceId}`,
            name: WORKSPACE_TOOL,
            input,
            state: 'running',
        };
        this.seq = appendItem(store, runId, this.body).seq;
        this.writtenAt = Date.now();
    }

    log(line: string): void {
        this.lines.push(line.length > MAX_LOG_LINE_LENGTH ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}…` : line);

        if (this.lines.length > MAX_LOG_LINES) {
            this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
        }

        if (this.timer) {
            return;
        }

        const wait =
            this.writtenAt +
            (Date.now() - this.startedAt > SLOW_STEP_MS ? SLOW_LOG_THROTTLE_MS : LOG_THROTTLE_MS) -
            Date.now();

        if (wait <= 0) {
            this.write();
        } else {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                this.write();
            }, wait);
        }
    }

    /** Ends the step: its last lines are written with the state, and a failure says why. */
    end(failure?: string): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.write(failure === undefined ? { state: 'done' } : { state: 'error', error: failure });
    }

    /** A stream that is gone (its run was deleted meanwhile) has nobody to show the log to: the step goes on without it, since it is the worktree that matters. */
    private write(end?: { state: 'done' } | { state: 'error'; error: string }): void {
        const output = this.lines.join('\n');
        const { error: _, ...rest } = this.body;

        this.body = { ...rest, ...(end ?? {}), ...(output !== '' && { output }) };
        this.writtenAt = Date.now();

        try {
            updateItem(this.store, this.runId, this.seq, this.body);
        } catch (error) {
            console.warn(
                `[clowdy] the log of the workspace step could not be written: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

/** The workspaces being prepared, by place: two chats that come to one worktree together wait for each other, so it is made once. */
const preparing = new WeakMap<Store, Map<string, Promise<unknown>>>();

/** Resolves when the promise does, or rejects with the signal's reason when it aborts first. */
export function until<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);

        if (signal.aborted) {
            abort();

            return;
        }

        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/**
 * Runs `work` once nothing else holds `key`, one after another in the order they asked. A caller whose `signal` aborts while it waits leaves the line without
 * running, and the ones behind it still wait for whoever it was waiting for.
 */
export async function exclusive<T>(
    store: Store,
    key: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>
): Promise<T> {
    const queue = preparing.get(store) ?? new Map<string, Promise<unknown>>();
    const before = (queue.get(key) ?? Promise.resolve()).catch(() => undefined);
    const run = until(before, signal).then(work);
    const tail = Promise.all([before, run.catch(() => undefined)]).then(() => undefined);

    preparing.set(store, queue);
    queue.set(key, tail);

    try {
        return await run;
    } finally {
        void tail.then(() => {
            if (queue.get(key) === tail) {
                queue.delete(key);
            }
        });
    }
}

/** Marks the worktree set up and publishes every chat that works in it, which now say so. */
function markReady(store: Store, workspaceId: string, ready = true): void {
    store.tx(() => {
        updateWorkspace(store.db, workspaceId, { ready });

        for (const chatId of chatsOfWorkspace(store.db, workspaceId)) {
            const chat = getChat(store.db, chatId);

            if (chat) {
                store.emit(chat.projectId, { type: 'chat.upserted', chat });
            }
        }
    });
}

/** What `prepareWorkspace` writes into and listens to: the stream of the run whose turn it is, and what stops it. */
export interface PrepareOptions {
    runId: string;
    /** A Stop of the run or of the daemon: git and the setup command are killed and the step ends as stopped. */
    signal?: AbortSignal;
    /** How long the folder's setup command may run (`Timings.setupMs`); ten minutes when absent. */
    setupTimeoutMs?: number;
}

/**
 * The first step of a turn whose chat works in a worktree that is not set up (`needsPreparing`): makes sure the worktree is there (`ensureWorktree`), sets it up
 * (`runSetup`, when the folder has a setup and Clowdy made the worktree), marks it `ready` and publishes the chats that use it. It writes a `tool` item named
 * `workspace` into the run's stream, running while it works, with git's lines and the setup's as its output as they arrive, and done or error at the end. A failure
 * ends the item as an error and throws a `WorkspaceError` with the reason, which fails the turn; the next message tries again. Two chats that need the same worktree
 * at once do not race: the second waits, finds it set up and writes nothing.
 */
export async function prepareWorkspace(store: Store, workspaceId: string, options: PrepareOptions): Promise<void> {
    const first = getWorkspace(store.db, workspaceId);

    if (!first) {
        throw new WorkspaceError(`The workspace ${workspaceId} is gone`);
    }

    await exclusive(store, pathKey(first.path), options.signal, async () => {
        const record = getWorkspace(store.db, workspaceId);

        // Another chat made it while this one waited.
        if (!record || !needsPreparing(record)) {
            return;
        }

        const folder = getProject(store.db, record.projectId)?.folders.find(
            candidate => candidate.id === record.folderId
        );
        const item = new StepItem(store, options.runId, record.id, {
            path: record.path,
            ...(record.branch !== undefined && { branch: record.branch }),
            ...(record.base !== undefined && { base: record.base }),
        });

        try {
            if (!folder) {
                throw new WorkspaceError('The folder of this worktree is no longer part of the space');
            }

            if (!existsSync(folder.path)) {
                throw new WorkspaceError(`The folder ${folder.path} no longer exists`);
            }

            // The worktrees of one repository are added one at a time: the key is the folder's real place, whichever project holds it.
            const serialize = <T>(work: () => Promise<T>) =>
                exclusive(store, `repository:${pathKey(placeOf(folder.path))}`, options.signal, work);

            const made = await ensureWorktree({
                folder: folder.path,
                path: record.path,
                branch: record.branch,
                base: record.base,
                managed: record.managed,
                log: line => item.log(line),
                signal: options.signal,
                serialize,
            });

            // The folder's setup, for a worktree Clowdy made that is not set up yet: a step that failed here comes back with the worktree there and `ready` still false, so
            // only this part runs again (a copy never overwrites). A worktree that is ready and still there is never set up again, and one that was found never is. One that was
            // made again (it went from the disk, with its ignored files: `.env`, the dependencies) is a new tree and is set up again; it stops being ready first, so a setup
            // that fails is run again by the next turn and not forgotten.
            const again = record.ready && made === 'made';

            if (record.managed && folder.settings?.setup && (!record.ready || again)) {
                if (again) {
                    markReady(store, record.id, false);
                }

                await runSetup({
                    root: folder.path,
                    workspace: record.path,
                    branch: record.branch,
                    setup: folder.settings.setup,
                    log: line => item.log(line),
                    signal: options.signal,
                    timeoutMs: options.setupTimeoutMs,
                });
            }

            markReady(store, record.id);
            item.end();
        } catch (error) {
            const reason =
                error instanceof WorkspaceError
                    ? error.message
                    : error instanceof Error
                      ? error.message
                      : String(error);

            item.end(reason);
            throw error instanceof WorkspaceError ? error : new WorkspaceError(reason);
        }
    });
}
