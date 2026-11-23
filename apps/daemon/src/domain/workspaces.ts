import { folderNames, mainFolder, STOPPED_TOOL } from '@clowdy/protocol';
import { existsSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { getChat } from '../db/chats';
import { getProject } from '../db/projects';
import { chatsOfWorkspace, getWorkspace, insertWorkspace, listWorkspacesOfProject, toChatWorkspace, updateWorkspace } from '../db/workspaces';
import { invalid, notFound } from '../errors';
import { parseBranches, parseWorktrees, pickDefaultBranch } from '../git/state';
import { newId } from '../ids';
import { git, gitOutput, gitRead } from './git';
import { appendItem, updateItem } from './items';
import { runLines } from './lines';

import type { ChatWorkspace, ChatWorkspaceChoice, Project, ProjectFolder, StreamItemBody } from '@clowdy/protocol';
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

/** The reads `chat.create` makes of the repository hold up the whole daemon while they run, inside a transaction: a git that takes longer than this is `unavailable`. */
const SYNC_READ_TIMEOUT_MS = 10_000;

/** A synchronous read of git for `chat.create`, with the time it may take. */
const readGit = (cwd: string, args: string[]) => git(cwd, args, SYNC_READ_TIMEOUT_MS);

/** The longest project slug in a worktree's path: paths on Windows are short, and the ids in them stay short for the same reason. */
const MAX_SLUG_LENGTH = 32;

/** Names Windows does not allow for a folder, whatever the extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** What `Prepare workspace` keeps of git's lines in the tool item: the item is rewritten as lines arrive, so it is bounded. */
const MAX_LOG_LINES = 200;

/** How often the log of the step may be written to the stream while lines arrive. */
const LOG_THROTTLE_MS = 100;

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
    }
    catch {
        const parent = dirname(full);

        return parent === full ? full : join(placeOf(parent), basename(full));
    }
}

/** Whether two paths are the same place. */
export const samePlace = (a: string, b: string): boolean => pathKey(placeOf(a)) === pathKey(placeOf(b));

/**
 * Whether something is there on the disk at the path, a folder, a file or a link (a dangling one included). Only "no such file" and "a parent is no folder" say it
 * is not: a path that cannot be looked at (no permission, a stale network disk) may well be there, and is a failure, not a place to make a worktree in.
 */
async function isThere(path: string): Promise<boolean> {
    try {
        await lstat(path);

        return true;
    }
    catch (error) {
        const { code } = error as { code?: string };

        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return false;
        }

        throw new WorkspaceError(`Couldn't look at ${ path }: ${ code ?? (error instanceof Error ? error.message : String(error)) }`);
    }
}

/* --------------------------------- Layout --------------------------------- */

/** The project's name as a folder name: lower-case letters and digits with dashes, cut short; the project's id for a name that has none (and not a name Windows reserves). */
export function projectSlug(project: Pick<Project, 'id' | 'name'>): string {
    const slug = project.name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');

    if (!slug) {
        return project.id;
    }

    return RESERVED_NAMES.test(slug) ? `${ slug }-project` : slug;
}

/** The random end of a chat's id (the front of a ULID is the time), which names its worktree and its branch: the last 8 characters. */
export const chatKey = (chatId: string): string => chatId.slice(-8);

/** A folder's name for a path: `folderNames` gives it, and a character a file system does not take in a name is turned into a dash. */
function folderSegment(name: string): string {
    const clean = [...name.replace(/[<>:"/\\|?*]/g, '-')].map(character => (character.charCodeAt(0) < 32 ? '-' : character)).join('').replace(/[. ]+$/, '');

    if (clean === '' || clean === '.' || clean === '..') {
        return 'folder';
    }

    return RESERVED_NAMES.test(clean.toLowerCase()) ? `${ clean }-folder` : clean;
}

/**
 * Where a chat's new worktree goes and what its branch is called: `<workspacesDir>/<project-slug>/<chat-id8>/<folder-name>` on `clowdy/<chat-id8>`. The folder's
 * own name is the last part, so a shell prompt and a window title read as the project does. Nothing is made.
 */
export function workspaceLayout(config: Pick<Config, 'workspacesDir'>, project: Project, folder: ProjectFolder, chatId: string): { path: string; branch: string } {
    const name = folderNames(project.folders)[project.folders.findIndex(candidate => candidate.id === folder.id)] ?? basename(folder.path);

    return { path: join(config.workspacesDir, projectSlug(project), chatKey(chatId), folderSegment(name)), branch: `clowdy/${ chatKey(chatId) }` };
}

/* --------------------------- Reading a repository -------------------------- */

/*
 * `chat.create` is a synchronous command, so what it checks of the repository is read with the sync `git` (a few local reads, no network). The turn that makes the
 * worktree reads with the async ones below it.
 */

/** Whether the folder is the root of a working tree: a worktree is made of the whole repository, so a folder inside one has none of its own. */
function isRepositoryRoot(folder: string): boolean {
    const top = readGit(folder, ['rev-parse', '--show-toplevel']);

    return top.ok && top.stdout !== '' && samePlace(top.stdout, folder);
}

/** Where the folder's HEAD is: its branch, or on a detached HEAD the short hash and the full one. */
function headOf(folder: string): { branch: string; detached?: true; commit: string } | undefined {
    const commit = readGit(folder, ['rev-parse', 'HEAD']);

    if (!commit.ok) {
        return undefined;
    }

    const branch = readGit(folder, ['branch', '--show-current']);

    if (branch.ok && branch.stdout) {
        return { branch: branch.stdout, commit: commit.stdout };
    }

    const short = readGit(folder, ['rev-parse', '--short', 'HEAD']);

    return short.ok ? { branch: short.stdout, detached: true, commit: commit.stdout } : undefined;
}

/** The folder's default base, as `defaultBranchOf` says it (`origin/HEAD`, `origin/main`, `main`… the branch checked out), read synchronously. */
function defaultBaseOf(folder: string): string | undefined {
    const remoteHead = readGit(folder, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const refs = readGit(folder, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    const head = headOf(folder);

    return pickDefaultBranch(remoteHead.ok && remoteHead.stdout ? remoteHead.stdout : undefined, parseBranches(refs.ok ? refs.stdout : ''), head && { branch: head.branch, ...(head.detached && { detached: true as const }) });
}

/** The refs a base may be, in the order they are tried: a local branch, then a remote's (`origin/main`). Never the bare name: a tag called `main` would make it ambiguous. */
const baseRefs = (base: string): [ref: string, remote: boolean][] => [[`refs/heads/${ base }`, false], [`refs/remotes/${ base }`, true]];

/** A base that is a commit's hash (the short one a detached HEAD gives). */
const isHash = (text: string): boolean => /^[0-9a-f]{7,40}$/i.test(text);

/** What a base names: the commit, and whether it is a remote's branch (which a worktree fetches first). */
interface ResolvedBase {
    commit: string;
    remote: boolean;
}

/** A base resolved in the folder's repository, read synchronously for `chat.create`; a hash counts only when it is the commit the folder has checked out on a detached HEAD. */
function resolveBaseSync(folder: string, base: string): ResolvedBase | undefined {
    for (const [ref, remote] of baseRefs(base)) {
        // `show-ref --verify` takes the ref exactly: `rev-parse` would also read `main~1` or `main@{1}` as a branch.
        const found = readGit(folder, ['show-ref', '--verify', '--hash', ref]);

        if (found.ok && found.stdout) {
            return { commit: found.stdout, remote };
        }
    }

    const head = headOf(folder);

    return isHash(base) && head?.detached && head.commit.startsWith(base.toLowerCase()) ? { commit: head.commit, remote: false } : undefined;
}

/** A base resolved in the repository when the worktree is made. A hash is any commit of it: it was checked when the chat was made. */
async function resolveBase(folder: string, base: string): Promise<ResolvedBase | undefined> {
    for (const [ref, remote] of baseRefs(base)) {
        const found = (await gitOutput(folder, ['show-ref', '--verify', '--hash', ref]))?.trim();

        if (found) {
            return { commit: found, remote };
        }
    }

    const commit = isHash(base) ? (await gitOutput(folder, ['rev-parse', '--verify', '--quiet', `${ base }^{commit}`]))?.trim() : undefined;

    return commit ? { commit, remote: false } : undefined;
}

/** The remote a remote-tracking base belongs to, and the branch on it: `origin/feature/x` is `origin` and `feature/x` (a remote's name may hold a slash, so the longest one that starts it wins). */
function remoteOf(base: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
    const remote = remotes.filter(name => base.startsWith(`${ name }/`)).sort((a, b) => b.length - a.length)[0];

    return remote === undefined ? undefined : { remote, branch: base.slice(remote.length + 1) };
}

/* ------------------------------ A chat's workspace ----------------------------- */

/** What a new chat asks of `createWorkspace`: the project, the id the chat is going to have (the worktree and its branch are named after it), its folder and the choice. */
export interface WorkspaceRequest {
    project: Project;
    chatId: string;
    /** The folder the chat works in; the project's main folder when absent. */
    folderId?: string;
    choice: ChatWorkspaceChoice;
}

/**
 * Makes the row of the worktree a new chat works in, and nothing on the disk: a new worktree is made by the chat's first turn (`prepareWorkspace`), an existing
 * one is there already. Refuses (`invalid`) a folder that is not the root of a repository, a base that is not a branch of it (a local one, or a remote's as
 * `origin/main`), and a path that `git worktree list` of the folder does not name or that is the folder itself. A new worktree is `managed` (Clowdy made it
 * and may remove it) and not `ready`; one that was found is the reverse, and the row of a worktree that has one already is the one shared (`chatsOfWorkspace`
 * tells who uses it). Call it inside a transaction: it is the first part of making the chat.
 */
export function createWorkspace(store: Store, config: Pick<Config, 'workspacesDir'>, request: WorkspaceRequest): ChatWorkspace {
    const { project, chatId, choice } = request;
    const folder = request.folderId === undefined ? mainFolder(project) : project.folders.find(candidate => candidate.id === request.folderId);

    if (!folder) {
        throw invalid(`Folder ${ request.folderId } does not belong to project ${ project.id }`);
    }

    if (!existsSync(folder.path)) {
        throw invalid(`The folder ${ folder.path } is missing`);
    }

    if (!isRepositoryRoot(folder.path)) {
        throw invalid('A worktree needs the root of a git repository, and this folder is not one');
    }

    return choice.mode === 'new' ? createNewWorkspace(store, config, project, folder, chatId, choice.base) : createExistingWorkspace(store, project, folder, choice.path);
}

function createNewWorkspace(store: Store, config: Pick<Config, 'workspacesDir'>, project: Project, folder: ProjectFolder, chatId: string, requested: string | undefined): ChatWorkspace {
    const base = requested ?? defaultBaseOf(folder.path);

    if (!base) {
        throw invalid('The repository has no commit to start a worktree from');
    }

    if (!resolveBaseSync(folder.path, base)) {
        throw invalid(`${ base } is not a branch of this repository`);
    }

    const record = { id: newId('wks'), projectId: project.id, folderId: folder.id, ...workspaceLayout(config, project, folder, chatId), base, managed: true, ready: false, createdAt: Date.now() };

    insertWorkspace(store.db, record);

    return toChatWorkspace(record);
}

function createExistingWorkspace(store: Store, project: Project, folder: ProjectFolder, path: string): ChatWorkspace {
    if (!isAbsolute(path)) {
        throw invalid('The path of a worktree must be absolute');
    }

    const listed = readGit(folder.path, ['worktree', 'list', '--porcelain']);
    const entry = parseWorktrees(listed.ok ? listed.stdout : '').find(candidate => !candidate.bare && samePlace(candidate.path, path));

    if (!entry) {
        throw invalid(`${ path } is not a worktree of this repository`);
    }

    if (samePlace(entry.path, folder.path)) {
        throw invalid('That is the folder itself, not a worktree of it');
    }

    if (entry.prunable || !existsSync(entry.path)) {
        throw invalid(`The worktree ${ path } is gone from the disk`);
    }

    // Chats that pick the same worktree share its row, so whoever asks who uses it gets them all, and a worktree Clowdy made stays its own.
    const shared = listWorkspacesOfProject(store.db, project.id).find(record => record.folderId === folder.id && samePlace(record.path, entry.path));

    if (shared) {
        return toChatWorkspace(shared);
    }

    const record = { id: newId('wks'), projectId: project.id, folderId: folder.id, path: resolve(entry.path), ...(entry.branch !== undefined && { branch: entry.branch }), managed: false, ready: true, createdAt: Date.now() };

    insertWorkspace(store.db, record);

    return toChatWorkspace(record);
}

/**
 * The worktree a thread or a fork takes from its parent: the same row, not a copy, so the chats that share it are all known. It has to belong to the project
 * and to the folder the new chat works in (`invalid` otherwise, `not_found` for a row that is gone).
 */
export function inheritWorkspace(store: Store, project: Project, workspaceId: string, folderId: string | undefined): ChatWorkspace {
    const record = getWorkspace(store.db, workspaceId);

    if (!record) {
        throw notFound('Workspace', workspaceId);
    }

    if (record.projectId !== project.id || (folderId !== undefined && record.folderId !== folderId)) {
        throw invalid(`Workspace ${ workspaceId } is not a worktree of the folder the chat works in`);
    }

    return toChatWorkspace(record);
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
    const line = lines.find(candidate => /^(fatal|error): /.test(candidate)) ?? lines.filter(candidate => !candidate.startsWith('hint:')).at(-1) ?? '';

    return line.replace(/^(fatal|error): /, '').trim().replace(/\.+$/, '');
}

async function runGit(cwd: string, args: string[], step: Step, timeoutMs: number): Promise<GitRun> {
    const lines: string[] = [];

    try {
        const result = await runLines(['git', ...args], {
            cwd,
            // git does not stop to ask anything: a fetch that needs a password fails instead of waiting for it.
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
    }
    catch (error) {
        // A program that is not there; anything else (the stream's own write failing, say) is not a reason to blame git.
        throw (error as { code?: unknown } | undefined)?.code === 'ENOENT' ? new WorkspaceError('git is not installed or not on the PATH') : error;
    }
}

/** A git run that has to succeed, `what` being what it does (`make the worktree`): a stop, the time and git's own no each say so in the reason. */
async function mustGit(cwd: string, args: string[], step: Step, timeoutMs: number, what: string): Promise<void> {
    const result = await runGit(cwd, args, step, timeoutMs);

    if (result.aborted) {
        throw new WorkspaceError(STOPPED_TOOL);
    }

    if (result.timedOut) {
        throw new WorkspaceError(`Couldn't ${ what }: it took too long`);
    }

    if (!result.ok) {
        throw new WorkspaceError(`Couldn't ${ what }: ${ result.reason || 'git gave no reason' }`);
    }
}

async function listWorktrees(folder: string): Promise<ListedWorktree[]> {
    const read = await gitRead(folder, ['worktree', 'list', '--porcelain']);

    if (!read.ok) {
        throw new WorkspaceError(read.reason === 'unavailable' ? 'git did not answer' : `${ folder } is not a git repository`);
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
                throw new WorkspaceError(`A previous attempt to make the worktree ${ path } was cut off, and git still has it locked, so it was left alone`);
            }

            options.log(`The worktree ${ path } is there already, left as it is`);

            return 'there';
        }

        throw new WorkspaceError(`${ path } exists and is not a worktree of ${ folder }, so it was left alone`);
    }

    if (!managed) {
        throw new WorkspaceError(`The worktree ${ path } no longer exists`);
    }

    if (!branch) {
        throw new WorkspaceError(`The worktree ${ path } has no branch to make it from`);
    }

    const holder = listed.find(candidate => candidate !== entry && !candidate.bare && candidate.branch === branch);

    if (holder) {
        throw new WorkspaceError(`The branch ${ branch } is already checked out in ${ resolve(holder.path) }`);
    }

    const exists = await gitRead(folder, ['rev-parse', '--verify', '--quiet', `refs/heads/${ branch }^{commit}`]);

    if (!exists.ok && exists.reason === 'unavailable') {
        throw new WorkspaceError('git did not answer');
    }

    const commit = exists.ok ? undefined : await baseCommit(folder, base, options);

    // The fetch above may have taken minutes: whatever was put at the path meanwhile is somebody's, and neither the record's removal (which deletes a tree that is
    // there and clean, ignored files included) nor the checkout is run over it.
    if (await isThere(path)) {
        throw new WorkspaceError(`${ path } appeared while the worktree was being made, so it was left alone`);
    }

    if (entry) {
        options.log(`Forgetting the record of the worktree ${ path }, which is gone from the disk`);
        await mustGit(folder, ['worktree', 'remove', entry.path], options, FORGET_TIMEOUT_MS, 'forget the missing worktree');
    }

    // The branch stays as it is when the repository has it; a new one starts at the commit the base had a moment ago.
    await mustGit(folder, ['-c', 'core.longpaths=true', 'worktree', 'add', ...(commit ? ['-b', branch, path, commit] : [path, branch])], options, ADD_TIMEOUT_MS, 'make the worktree');

    return 'made';
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
        const remotes = (await gitOutput(folder, ['remote']))?.split('\n').map(name => name.trim()).filter(Boolean) ?? [];
        const target = remoteOf(base, remotes);

        if (target) {
            step.log(`Fetching ${ base }`);

            const fetched = await runGit(folder, ['fetch', '--', target.remote, target.branch], step, FETCH_TIMEOUT_MS);

            if (fetched.aborted) {
                throw new WorkspaceError(STOPPED_TOOL);
            }

            if (!fetched.ok) {
                if (!before) {
                    throw new WorkspaceError(`Couldn't fetch ${ base }: ${ fetched.timedOut ? 'it took too long' : fetched.reason || 'git gave no reason' }`);
                }

                step.log(`Could not fetch, using the last fetched ${ base }`);
            }
        }
    }

    const after = await resolveBase(folder, base);

    if (!after) {
        throw new WorkspaceError(`${ base } is not a branch of this repository any more`);
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

    constructor(private store: Store, private runId: string, workspaceId: string, input: unknown) {
        this.body = { kind: 'tool', toolCallId: `workspace:${ workspaceId }`, name: WORKSPACE_TOOL, input, state: 'running' };
        this.seq = appendItem(store, runId, this.body).seq;
        this.writtenAt = Date.now();
    }

    log(line: string): void {
        this.lines.push(line);

        if (this.lines.length > MAX_LOG_LINES) {
            this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
        }

        if (this.timer) {
            return;
        }

        const wait = this.writtenAt + LOG_THROTTLE_MS - Date.now();

        if (wait <= 0) {
            this.write();
        }
        else {
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
        }
        catch (error) {
            console.warn(`[clowdy] the log of the workspace step could not be written: ${ error instanceof Error ? error.message : String(error) }`);
        }
    }
}

/** The workspaces being prepared, by place: two chats that come to one worktree together wait for each other, so it is made once. */
const preparing = new WeakMap<Store, Map<string, Promise<unknown>>>();

/** Resolves when the promise does, or rejects with the signal's reason when it aborts first. */
function until<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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
async function exclusive<T>(store: Store, key: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const queue = preparing.get(store) ?? new Map<string, Promise<unknown>>();
    const before = (queue.get(key) ?? Promise.resolve()).catch(() => undefined);
    const run = until(before, signal).then(work);
    const tail = Promise.all([before, run.catch(() => undefined)]).then(() => undefined);

    preparing.set(store, queue);
    queue.set(key, tail);

    try {
        return await run;
    }
    finally {
        void tail.then(() => {
            if (queue.get(key) === tail) {
                queue.delete(key);
            }
        });
    }
}

/** Marks the worktree set up and publishes every chat that works in it, which now say so. */
function markReady(store: Store, workspaceId: string): void {
    store.tx(() => {
        updateWorkspace(store.db, workspaceId, { ready: true });

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
    /** A Stop of the run or of the daemon: git is killed and the step ends as stopped. */
    signal?: AbortSignal;
}

/**
 * The first step of a turn whose chat works in a worktree that is not set up (`needsPreparing`): makes sure the worktree is there (`ensureWorktree`), marks it
 * `ready` and publishes the chats that use it. It writes a `tool` item named `workspace` into the run's stream, running while it works, with git's lines as
 * its output as they arrive, and done or error at the end. A failure ends the item as an error and throws a `WorkspaceError` with the reason, which fails the turn;
 * the next message tries again. Two chats that need the same worktree at once do not race: the second waits, finds it set up and writes nothing.
 */
export async function prepareWorkspace(store: Store, workspaceId: string, options: PrepareOptions): Promise<void> {
    const first = getWorkspace(store.db, workspaceId);

    if (!first) {
        throw new WorkspaceError(`The workspace ${ workspaceId } is gone`);
    }

    await exclusive(store, pathKey(first.path), options.signal, async () => {
        const record = getWorkspace(store.db, workspaceId);

        // Another chat made it while this one waited.
        if (!record || !needsPreparing(record)) {
            return;
        }

        const folder = getProject(store.db, record.projectId)?.folders.find(candidate => candidate.id === record.folderId);
        const item = new StepItem(store, options.runId, record.id, { path: record.path, ...(record.branch !== undefined && { branch: record.branch }), ...(record.base !== undefined && { base: record.base }) });

        try {
            if (!folder) {
                throw new WorkspaceError('The folder of this worktree is no longer part of the project');
            }

            if (!existsSync(folder.path)) {
                throw new WorkspaceError(`The folder ${ folder.path } no longer exists`);
            }

            await ensureWorktree({ folder: folder.path, path: record.path, branch: record.branch, base: record.base, managed: record.managed, log: line => item.log(line), signal: options.signal });
            markReady(store, record.id);
            item.end();
        }
        catch (error) {
            const reason = error instanceof WorkspaceError ? error.message : error instanceof Error ? error.message : String(error);

            item.end(reason);
            throw error instanceof WorkspaceError ? error : new WorkspaceError(reason);
        }
    });
}
