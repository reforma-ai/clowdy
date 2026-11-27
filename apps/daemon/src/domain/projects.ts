import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { mainFolder } from '@clowdy/protocol';

import { chatCountsByFolder, clearChatFolders } from '../db/chats';
import {
    deleteProjectRow,
    getPersonalProject,
    getProject,
    getProjectByFolders,
    hasUnfinishedRuns,
    insertStatus,
    listProjects,
    listStatuses,
    nextPosition,
    projectCounts,
    upsertProject,
} from '../db/projects';
import { deleteViewedOutsideFolders } from '../db/viewed';
import { listWorkspaceUses } from '../db/workspaces';
import { conflict, invalid, notFound, unavailable } from '../errors';
import { folderHead } from '../git/state';
import { newId } from '../ids';
import { mergeFolderSettings } from './folderSettings';
import { git, gitLine } from './git';

import type {
    Project,
    ProjectFolder,
    ProjectFolderInfo,
    ProjectInfo,
    ProjectSettings,
    ProjectWorkspaceInfo,
    TaskStatus,
    TaskStatusCategory,
} from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
import type { Config } from '../config';
import type { WorkspaceUse } from '../db/workspaces';
import type { SkillsService } from '../skills/service';
import type { Store } from '../store';
import type { FolderSettingsPatch } from './folderSettings';

/** The folder of the personal space inside the daemon's data folder. */
const PERSONAL_NAME = 'Personal';

const DEFAULT_STATUSES: { name: string; category: TaskStatusCategory }[] = [
    { name: 'To do', category: 'todo' },
    { name: 'In progress', category: 'active' },
    { name: 'Review', category: 'review' },
    { name: 'Done', category: 'done' },
    { name: 'Canceled', category: 'canceled' },
];

export function requireProject(store: Store, projectId: string): Project {
    const project = getProject(store.db, projectId);

    if (!project) {
        throw notFound('Space', projectId);
    }

    return project;
}

/** `Car Rental` gives `CAR`: the first three letters or digits of the name. */
function deriveTaskPrefix(name: string): string {
    const letters =
        name
            .match(/[\p{L}\p{N}]/gu)
            ?.slice(0, 3)
            .join('') ?? '';

    return letters ? letters.toUpperCase() : 'PRJ';
}

function kebabCase(name: string): string {
    return (
        name
            .normalize('NFKD')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-+|-+$/g, '') || 'project'
    );
}

function cleanName(name: string): string {
    const trimmed = name.trim();

    if (!trimmed) {
        throw invalid('The space name cannot be empty');
    }

    return trimmed;
}

function publishProject(store: Store, project: Project): void {
    store.emit(project.id, { type: 'project.upserted', project, statuses: listStatuses(store.db, project.id) });
}

function insertProject(store: Store, input: { name: string; folders: readonly string[]; personal?: boolean }): Project {
    return store.tx(() => {
        const project: Project = {
            id: newId('prj'),
            name: input.name,
            folders: input.folders.map(path => ({ id: newId('fld'), path })),
            taskPrefix: deriveTaskPrefix(input.name),
            settings: {},
            createdAt: Date.now(),
            // The personal space stays above every project, so it takes no place in their line.
            position: input.personal ? 0 : nextPosition(store.db),
            ...(input.personal && { personal: true }),
        };

        upsertProject(store.db, project);
        DEFAULT_STATUSES.forEach((status, position) =>
            insertStatus(store.db, project.id, { id: newId('sts'), ...status }, position)
        );
        publishProject(store, project);

        return project;
    });
}

function realDirectory(path: string): string {
    if (!isAbsolute(path)) {
        throw invalid(`The path must be absolute: ${path}`);
    }

    if (!existsSync(path)) {
        throw invalid(`${path} does not exist`);
    }

    if (!statSync(path).isDirectory()) {
        throw invalid(`${path} is not a folder`);
    }

    return realpathSync.native(path);
}

/**
 * Refuses a list (of `realDirectory` paths) where a folder repeats or lies inside another: the agent would get the same files twice, and a
 * change in one would show up in both.
 */
function requireSeparateFolders(paths: readonly string[]): void {
    paths.forEach((path, index) => {
        for (const other of paths.slice(index + 1)) {
            if (path === other) {
                throw invalid(`${path} is listed twice`);
            }

            const [outer, inner] = path.length < other.length ? [path, other] : [other, path];

            if (inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)) {
                throw invalid(`${inner} is inside ${outer}, which the space has already`);
            }
        }
    });
}

const nameOf = (path: string) => basename(path) || path;

/** What `project.add` answers: the project, and whether it was there already. */
export interface AddedProject {
    project: Project;
    existing: boolean;
}

/**
 * Adds a project of `folders`, the first being the main one: any existing folders, repositories or not, never changed. Without folders a new
 * folder is made for it (`newFolderProject`). The same set of folders as a project already has, in any order, answers that project.
 */
export function addProject(
    store: Store,
    config: Config,
    input: { name?: string; folders?: readonly string[] }
): AddedProject {
    if (!input.folders?.length) {
        return newFolderProject(store, config, input.name);
    }

    const paths = input.folders.map(realDirectory);

    requireSeparateFolders(paths);

    const existing = getProjectByFolders(store.db, paths);

    if (existing) {
        return { project: existing, existing: true };
    }

    const name = input.name === undefined ? nameOf(paths[0] as string) : cleanName(input.name);

    return { project: insertProject(store, { name, folders: paths }), existing: false };
}

/**
 * A project in a new folder `<projectsDir>/<kebab-name>`, made a repository (`git init -b main` plus an empty first commit) so worktrees work.
 * An existing empty folder is reused; a non-empty one is never touched.
 */
function newFolderProject(store: Store, config: Config, name: string | undefined): AddedProject {
    if (name === undefined) {
        throw invalid('A space without folders needs a name: its new folder is named after it');
    }

    const clean = cleanName(name);
    const target = join(config.projectsDir, kebabCase(clean));

    if (existsSync(target)) {
        if (!statSync(target).isDirectory() || readdirSync(target).length > 0) {
            throw conflict(`${target} already exists and is not an empty folder`);
        }
    } else {
        mkdirSync(target, { recursive: true });
    }

    const path = realpathSync.native(target);
    const existing = getProjectByFolders(store.db, [path]);

    if (existing) {
        return { project: existing, existing: true };
    }

    initRepository(path);

    return { project: insertProject(store, { name: clean, folders: [path] }), existing: false };
}

/** `git init -b main` plus an empty first commit, so worktrees work. */
function initRepository(folder: string): void {
    const init = git(folder, ['init', '-b', 'main']);

    if (!init.ok) {
        throw unavailable(`git init failed: ${init.stderr}`);
    }

    const hasIdentity = ['user.name', 'user.email'].every(key => git(folder, ['config', key]).stdout !== '');
    const identity = hasIdentity ? [] : ['-c', 'user.name=Clowdy', '-c', 'user.email=clowdy@localhost'];
    const commit = git(folder, [
        ...identity,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'Initial commit',
    ]);

    if (!commit.ok) {
        throw unavailable(`The initial commit failed: ${commit.stderr}`);
    }
}

/**
 * Makes the personal folder usable: it exists, and it is a repository of its own (worktrees need one). Never throws, so a start
 * is not lost to a full disk or a missing git: without a repository chats still work, only worktrees do not. Returns whether the folder exists.
 */
function prepareFolder(folder: string): boolean {
    try {
        mkdirSync(folder, { recursive: true });
    } catch (error) {
        console.warn(`[clowdy] the personal space folder ${folder} cannot be made:`, error);

        return false;
    }

    try {
        const top = git(folder, ['rev-parse', '--show-toplevel']);

        // A folder inside someone else's repository is not a repository of its own.
        if (!top.ok || realpathSync.native(top.stdout) !== realpathSync.native(folder)) {
            initRepository(folder);
        }
    } catch (error) {
        console.warn(`[clowdy] the personal space folder ${folder} is not a git repository:`, error);
    }

    return true;
}

/**
 * The person's own space: a project flagged `personal` in `personalDir` (`~/Clowdy/Personal`), for chats that belong to no repository. Called
 * at every start, so it makes the project the first time and afterwards only makes sure its folder is there (it may have been deleted) and
 * that the project still points at it: the person cannot choose this folder, so a new `personalDir` takes the project with it, and the old
 * folder stays where it was. Never throws.
 */
export function ensurePersonalProject(store: Store, config: Config): Project | undefined {
    try {
        const existing = getPersonalProject(store.db);
        const folder = config.personalDir;

        if (!prepareFolder(folder)) {
            return existing;
        }

        const path = realpathSync.native(folder);

        if (!existing) {
            return insertProject(store, { name: PERSONAL_NAME, folders: [path], personal: true });
        }

        const main = mainFolder(existing);

        if (main.path === path && existing.folders.length === 1) {
            return existing;
        }

        return store.tx(() => {
            const moved = { ...existing, folders: [{ ...main, path }] };

            upsertProject(store.db, moved);
            publishProject(store, moved);

            return moved;
        });
    } catch (error) {
        console.warn('[clowdy] the personal space cannot be set up:', error);

        return undefined;
    }
}

/** A settings field set to `null` is cleared. */
type SettingsPatch = { [K in keyof ProjectSettings]?: ProjectSettings[K] | null };

/** An entry of a project's new folder list: `{ id }` keeps a folder the project has, `{ path }` adds one, `{ id, path }` keeps the folder at another place. */
export type FolderEntry = { id: string } | { path: string } | { id: string; path: string };

export interface ProjectPatch {
    name?: string;
    /** The whole new list, in order. */
    folders?: readonly FolderEntry[];
    settings?: SettingsPatch;
}

/** What a project's removal or move must tell the services that watch its folder. */
export interface ProjectWatchers {
    skills: SkillsService;
}

function mergeSettings(current: ProjectSettings, patch: SettingsPatch = {}): ProjectSettings {
    const merged: Record<string, unknown> = { ...current };

    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete merged[key];
        } else if (value !== undefined) {
            merged[key] = value;
        }
    }

    return merged as ProjectSettings;
}

const stillWorking = () => conflict('The agents of this space are still working. Stop them first.');

/**
 * The folders `entries` describe: the project's own for an id (at the path it is given with the id, when it is moved: it keeps its id, and so its chats), a new folder
 * for a path (the one it has when it has that path already).
 */
function nextFolders(current: Project, entries: readonly FolderEntry[]): ProjectFolder[] {
    if (entries.length === 0) {
        throw invalid('A space needs at least one folder');
    }

    const folders = entries.map(entry => {
        if ('id' in entry) {
            const folder = current.folders.find(candidate => candidate.id === entry.id);

            if (!folder) {
                throw invalid(`Folder ${entry.id} is not one of the space's`);
            }

            // The folder is the same one at another place, so what it was given (its settings) stays with it.
            return 'path' in entry ? { ...folder, path: realDirectory(entry.path) } : folder;
        }

        const path = realDirectory(entry.path);

        return current.folders.find(candidate => candidate.path === path) ?? { id: newId('fld'), path };
    });

    requireSeparateFolders(folders.map(folder => folder.path));

    return folders;
}

const sameFolders = (a: readonly ProjectFolder[], b: readonly ProjectFolder[]) =>
    a.length === b.length && a.every((folder, index) => folder.id === b[index]?.id && folder.path === b[index]?.path);

/**
 * Renames the project, gives it another list of folders, or changes its settings. New folders, and a folder moved to another path, take the checks of `addProject`;
 * a new main folder, or the main folder moved, waits until no agent of the project is working, as the agents work in it. The personal space keeps its name and its one folder.
 */
export function updateProject(
    store: Store,
    projectId: string,
    patch: ProjectPatch,
    { skills }: ProjectWatchers
): Project {
    return store.tx(() => {
        const current = requireProject(store, projectId);
        const name = patch.name === undefined ? current.name : cleanName(patch.name);
        const folders = patch.folders === undefined ? current.folders : nextFolders(current, patch.folders);
        const foldersChanged = !sameFolders(folders, current.folders);

        if (current.personal && (name !== current.name || foldersChanged)) {
            throw conflict('The personal space cannot be renamed or given other folders');
        }

        if (current.personal && patch.settings?.icon !== undefined) {
            throw conflict('The personal space has no icon of its own');
        }

        // `project.add` answers a set of folders with the project that has it, so two projects never share the whole set.
        const twin = foldersChanged
            ? getProjectByFolders(
                  store.db,
                  folders.map(folder => folder.path)
              )
            : undefined;

        if (twin && twin.id !== projectId) {
            throw conflict(`${twin.name} has these folders already`);
        }

        // A new main folder, and the main folder at another place: the agents work in it.
        const mainChanged =
            mainFolder({ folders }).id !== mainFolder(current).id ||
            mainFolder({ folders }).path !== mainFolder(current).path;

        if (mainChanged && hasUnfinishedRuns(store.db, projectId)) {
            throw stillWorking();
        }

        const next: Project = { ...current, name, folders, settings: mergeSettings(current.settings, patch.settings) };

        upsertProject(store.db, next);
        publishProject(store, next);

        if (foldersChanged) {
            // A chat that worked in a folder that left goes back to the main folder: its next turn starts a new conversation there.
            for (const chat of clearChatFolders(
                store.db,
                projectId,
                folders.map(folder => folder.id)
            )) {
                store.emit(projectId, { type: 'chat.upserted', chat });
            }

            // The marks of viewed files that were made in a folder that left, and in its worktrees, are of a place nobody reads any more.
            deleteViewedOutsideFolders(
                store.db,
                projectId,
                folders.map(folder => folder.id)
            );

            // The project's skills come from its folders, so a catalog read before is out of date.
            store.emit(projectId, { type: 'skills.changed' });
            // The skills watchers hold the old folders; the next request for skills watches the new ones.
            store.afterCommit(() => skills.forgetProject(current));
        }

        return next;
    });
}

/**
 * Changes the settings of one folder of the project (see `FolderSettings`; a field set to `null` is cleared). The settings belong to the project's row of the folder, so
 * the same path in another project is not touched. `conflict` for the personal space, `not_found` for a folder the project does not have, `invalid` for a branch or a
 * setup that is refused. The agents need not be stopped: a worktree reads the settings when it is made.
 */
export function updateProjectFolder(
    store: Store,
    projectId: string,
    folderId: string,
    patch: FolderSettingsPatch
): Project {
    return store.tx(() => {
        const current = requireProject(store, projectId);

        if (current.personal) {
            throw conflict('The personal space has no worktrees to set up');
        }

        const folder = current.folders.find(candidate => candidate.id === folderId);

        if (!folder) {
            throw notFound('Folder', folderId);
        }

        const { settings: _, ...bare } = folder;
        const settings = mergeFolderSettings(folder.settings, patch);
        const next: Project = {
            ...current,
            folders: current.folders.map(candidate =>
                candidate.id === folderId ? { ...bare, ...(settings && { settings }) } : candidate
            ),
        };

        upsertProject(store.db, next);
        publishProject(store, next);

        return next;
    });
}

/**
 * Removes the project with its chats, tasks, runs, streams, artifacts and attachments (the foreign keys carry the rows, the
 * attachment folders go once the transaction commits). Its own folder and files are never touched. The agents must have stopped,
 * and the personal space stays.
 */
export function deleteProject(
    store: Store,
    projectId: string,
    { attachments, skills }: ProjectWatchers & { attachments: AttachmentsService }
): void {
    store.tx(() => {
        const project = requireProject(store, projectId);

        if (project.personal) {
            throw conflict('The personal space cannot be removed');
        }

        if (hasUnfinishedRuns(store.db, projectId)) {
            throw stillWorking();
        }

        attachments.removeOfProject(projectId);
        deleteProjectRow(store.db, projectId);
        store.emit(projectId, { type: 'project.deleted' });
        store.afterCommit(() => skills.forgetProject(project));
    });
}

/**
 * Puts the listed projects first, in the order given, then the others as they were; positions become 1..n. The personal space is not
 * part of the line and a repeated id counts once. Only the projects whose place changed are published. Returns every project in list order.
 */
export function reorderProjects(store: Store, projectIds: readonly string[]): Project[] {
    return store.tx(() => {
        const all = listProjects(store.db);
        const known = new Set(all.map(project => project.id));
        const unknown = projectIds.find(id => !known.has(id));

        if (unknown !== undefined) {
            throw invalid(`Space ${unknown} does not exist`);
        }

        const line = all.filter(project => !project.personal);
        const byId = new Map(line.map(project => [project.id, project]));
        const listed = [...new Set(projectIds)].flatMap(id => byId.get(id) ?? []);
        const rest = line.filter(project => !listed.includes(project));

        [...listed, ...rest].forEach((project, index) => {
            if (project.position !== index + 1) {
                const next = { ...project, position: index + 1 };

                upsertProject(store.db, next);
                publishProject(store, next);
            }
        });

        return listProjects(store.db);
    });
}

async function isFolder(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/** How many worktrees of a project are read at once: a project whose chats each work in one has dozens, and each read starts a git. */
const WORKSPACE_READS = 4;

/**
 * Whether a worktree is there and what it has checked out, read like a folder's head (`folderHead`): not there while it is not made (`ready` false) or gone from the disk.
 * A row no chat points at (one a new-chat page opened) is reported only while its worktree is there: with no chat to call it gone, a missing one has nothing to tell. And only
 * while its folder is one the project has: the row a chat left when its folder was dropped (`clearChatFolders`) stays for good, and no page can choose a worktree of that folder.
 */
async function workspaceInfo(
    { record, inUse }: WorkspaceUse,
    folderIds: ReadonlySet<string>
): Promise<ProjectWorkspaceInfo | undefined> {
    if (!inUse && !folderIds.has(record.folderId)) return undefined;

    const exists = record.ready && (await isFolder(record.path));

    if (!exists && !inUse) return undefined;

    const head = exists ? await folderHead(record.path) : undefined;

    return { workspaceId: record.id, exists, ...head };
}

/**
 * What the page that manages projects shows besides the snapshot: whether each folder is there and its remote, what the project holds, and the head of each worktree
 * the project has a row of (`workspaces`: those its chats work in, and those a new-chat page opened that are still on the disk; absent when it has none). The page asks again every
 * few seconds, so nothing here may stop the daemon: the folders are read asynchronously, one project after another, and a project's worktrees a few at a time, so a long list never
 * starts a crowd of processes. With a `projectId` only that project is read (`notFound` when there is none), for a screen that wants one folder's git facts.
 */
export async function projectsInfo(store: Store, projectId?: string): Promise<ProjectInfo[]> {
    if (projectId !== undefined) requireProject(store, projectId);

    const { projects, counts, chatsIn, workspacesOf } = store.read(() => {
        const wanted = listProjects(store.db).filter(
            candidate => projectId === undefined || candidate.id === projectId
        );

        return {
            projects: wanted,
            counts: projectCounts(store.db),
            chatsIn: chatCountsByFolder(store.db),
            workspacesOf: new Map(wanted.map(project => [project.id, listWorkspaceUses(store.db, project.id)])),
        };
    });
    const info: ProjectInfo[] = [];

    for (const project of projects) {
        const folders: ProjectFolderInfo[] = [];

        for (const folder of project.folders) {
            const exists = await isFolder(folder.path);
            const remoteUrl = exists ? await gitLine(folder.path, ['remote', 'get-url', 'origin']) : undefined;
            const head = exists ? await folderHead(folder.path) : undefined;

            folders.push({
                folderId: folder.id,
                exists,
                ...(remoteUrl && { remoteUrl }),
                ...head,
                chats: chatsIn.get(folder.id) ?? 0,
            });
        }

        const workspaces: ProjectWorkspaceInfo[] = [];
        const records = workspacesOf.get(project.id) ?? [];
        const folderIds = new Set(project.folders.map(folder => folder.id));

        for (let start = 0; start < records.length; start += WORKSPACE_READS) {
            workspaces.push(
                ...(
                    await Promise.all(
                        records.slice(start, start + WORKSPACE_READS).map(use => workspaceInfo(use, folderIds))
                    )
                ).flatMap(entry => entry ?? [])
            );
        }

        info.push({
            projectId: project.id,
            folders,
            ...(counts.get(project.id) ?? { chats: 0, tasks: 0, activeRuns: 0 }),
            ...(workspaces.length > 0 && { workspaces }),
        });
    }

    return info;
}

export function requireStatus(store: Store, projectId: string, statusId: string): TaskStatus {
    const status = listStatuses(store.db, projectId).find(candidate => candidate.id === statusId);

    if (!status) {
        throw invalid(`Status ${statusId} does not belong to space ${projectId}`);
    }

    return status;
}

/** The project's first status of a category: where tasks land when logic, not a person, moves them. */
export function statusOfCategory(store: Store, projectId: string, category: TaskStatusCategory): TaskStatus {
    const status = listStatuses(store.db, projectId).find(candidate => candidate.category === category);

    if (!status) {
        throw invalid(`Space ${projectId} has no status in the ${category} category`);
    }

    return status;
}
