import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import {
    deleteProjectRow,
    getPersonalProject,
    getProject,
    getProjectByPath,
    hasUnfinishedRuns,
    insertStatus,
    listProjects,
    listStatuses,
    nextPosition,
    projectCounts,
    upsertProject,
} from '../db/projects';
import { conflict, invalid, notFound, unavailable } from '../errors';
import { newId } from '../ids';
import { git, gitLine } from './git';

import type { Project, ProjectInfo, ProjectSettings, TaskStatus, TaskStatusCategory } from '@clowdy/protocol';
import type { AttachmentsService } from '../attachments/service';
import type { Config } from '../config';
import type { DocsService } from '../docs/service';
import type { SkillsService } from '../skills/service';
import type { Store } from '../store';

/** The folder of the personal space inside the daemon's data folder. */
const PERSONAL_FOLDER = 'personal';
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
        throw notFound('Project', projectId);
    }

    return project;
}

/** `Car Rental` gives `CAR`: the first three letters or digits of the name. */
function deriveTaskPrefix(name: string): string {
    const letters = name.match(/[\p{L}\p{N}]/gu)?.slice(0, 3).join('') ?? '';

    return letters ? letters.toUpperCase() : 'PRJ';
}

function kebabCase(name: string): string {
    return name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'project';
}

function cleanName(name: string): string {
    const trimmed = name.trim();

    if (!trimmed) {
        throw invalid('The project name cannot be empty');
    }

    return trimmed;
}

function publishProject(store: Store, project: Project): void {
    store.emit(project.id, { type: 'project.upserted', project, statuses: listStatuses(store.db, project.id) });
}

function insertProject(store: Store, input: { name: string; path: string; personal?: boolean }): Project {
    return store.tx(() => {
        const project: Project = {
            id: newId('prj'),
            name: input.name,
            path: input.path,
            taskPrefix: deriveTaskPrefix(input.name),
            settings: {},
            createdAt: Date.now(),
            // The personal space stays above every project, so it takes no place in their line.
            position: input.personal ? 0 : nextPosition(store.db),
            ...(input.personal && { personal: true }),
        };

        upsertProject(store.db, project);
        DEFAULT_STATUSES.forEach((status, position) => insertStatus(store.db, project.id, { id: newId('sts'), ...status }, position));
        publishProject(store, project);

        return project;
    });
}

function realDirectory(path: string): string {
    if (!isAbsolute(path)) {
        throw invalid(`The path must be absolute: ${ path }`);
    }

    if (!existsSync(path)) {
        throw invalid(`${ path } does not exist`);
    }

    if (!statSync(path).isDirectory()) {
        throw invalid(`${ path } is not a folder`);
    }

    return realpathSync.native(path);
}

/** Refuses a folder (as `realDirectory` returned it) that is not the top of a git repository. */
function requireRepositoryRoot(path: string): void {
    const top = git(path, ['rev-parse', '--show-toplevel']);

    if (!top.ok) {
        throw invalid(`${ path } is not a git repository`);
    }

    if (realpathSync.native(top.stdout) !== path) {
        throw invalid(`${ path } is inside the repository ${ top.stdout }; open the repository root`);
    }
}

/** Opens an existing repository as a project. Opening the same folder again returns the same project. */
export function openProject(store: Store, input: { path: string; name?: string }): Project {
    const path = realDirectory(input.path);
    const existing = getProjectByPath(store.db, path);

    if (existing) {
        return existing;
    }

    requireRepositoryRoot(path);

    return insertProject(store, { name: input.name === undefined ? basename(path) : cleanName(input.name), path });
}

/**
 * Creates a repository (`git init -b main` plus an empty first commit so worktrees work) and opens it.
 * `path` is the project folder itself; without it the folder is `<projectsDir>/<kebab-name>`.
 * An existing empty folder is reused; a non-empty one is never touched.
 */
export function createProject(store: Store, config: Config, input: { name: string; path?: string }): Project {
    const name = cleanName(input.name);
    const wanted = input.path === undefined ? join(config.projectsDir, kebabCase(name)) : input.path;

    // A relative path would land wherever the daemon was started.
    if (!isAbsolute(wanted)) {
        throw invalid(`The path must be absolute: ${ wanted }`);
    }

    const target = resolve(wanted);

    if (existsSync(target)) {
        if (!statSync(target).isDirectory() || readdirSync(target).length > 0) {
            throw conflict(`${ target } already exists and is not an empty folder`);
        }
    }
    else {
        mkdirSync(target, { recursive: true });
    }

    initRepository(target);

    return insertProject(store, { name, path: realpathSync.native(target) });
}

/** `git init -b main` plus an empty first commit, so worktrees work. */
function initRepository(folder: string): void {
    const init = git(folder, ['init', '-b', 'main']);

    if (!init.ok) {
        throw unavailable(`git init failed: ${ init.stderr }`);
    }

    const hasIdentity = ['user.name', 'user.email'].every(key => git(folder, ['config', key]).stdout !== '');
    const identity = hasIdentity ? [] : ['-c', 'user.name=Clowdy', '-c', 'user.email=clowdy@localhost'];
    const commit = git(folder, [...identity, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial commit']);

    if (!commit.ok) {
        throw unavailable(`The initial commit failed: ${ commit.stderr }`);
    }
}

/**
 * Makes the personal folder usable: it exists, and it is a repository of its own (worktrees need one). Never throws, so a start
 * is not lost to a full disk or a missing git: without a repository chats still work, only worktrees do not. Returns whether the folder exists.
 */
function prepareFolder(folder: string): boolean {
    try {
        mkdirSync(folder, { recursive: true });
    }
    catch (error) {
        console.warn(`[clowdy] the personal space folder ${ folder } cannot be made:`, error);

        return false;
    }

    try {
        const top = git(folder, ['rev-parse', '--show-toplevel']);

        // A folder inside someone else's repository is not a repository of its own.
        if (!top.ok || realpathSync.native(top.stdout) !== realpathSync.native(folder)) {
            initRepository(folder);
        }
    }
    catch (error) {
        console.warn(`[clowdy] the personal space folder ${ folder } is not a git repository:`, error);
    }

    return true;
}

/**
 * The person's own space: a project flagged `personal` in `<dataDir>/personal`, for chats that belong to no repository. Called at every start, so
 * it makes the project the first time and afterwards only makes sure its folder is there (it may have been deleted) and that the project
 * still points at it: the person cannot choose this folder, so a data folder that moved takes the project with it. Never throws.
 */
export function ensurePersonalProject(store: Store, config: Config): Project | undefined {
    try {
        const existing = getPersonalProject(store.db);
        const folder = join(config.dataDir, PERSONAL_FOLDER);

        if (!prepareFolder(folder)) {
            return existing;
        }

        const path = realpathSync.native(folder);

        if (!existing) {
            return insertProject(store, { name: PERSONAL_NAME, path, personal: true });
        }

        if (existing.path === path) {
            return existing;
        }

        return store.tx(() => {
            const moved = { ...existing, path };

            upsertProject(store.db, moved);
            publishProject(store, moved);

            return moved;
        });
    }
    catch (error) {
        console.warn('[clowdy] the personal space cannot be set up:', error);

        return undefined;
    }
}

/** A settings field set to `null` is cleared. */
type SettingsPatch = { [K in keyof ProjectSettings]?: ProjectSettings[K] | null };

export interface ProjectPatch {
    name?: string;
    path?: string;
    settings?: SettingsPatch;
}

/** What a project's removal or move must tell the services that watch its folder. */
export interface ProjectWatchers {
    docs: DocsService;
    skills: SkillsService;
}

function mergeSettings(current: ProjectSettings, patch: SettingsPatch = {}): ProjectSettings {
    const merged: Record<string, unknown> = { ...current };

    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete merged[key];
        }
        else if (value !== undefined) {
            merged[key] = value;
        }
    }

    return merged as ProjectSettings;
}

const stillWorking = () => conflict('The agents of this project are still working. Stop them first.');

/**
 * Renames the project, moves it to another folder, or changes its settings. A move takes the checks of `openProject`, refuses a
 * folder another project has, and waits until no agent of the project is working in the old one. The personal space keeps its name and folder.
 */
export function updateProject(store: Store, projectId: string, patch: ProjectPatch, { docs, skills }: ProjectWatchers): Project {
    return store.tx(() => {
        const current = requireProject(store, projectId);
        const name = patch.name === undefined ? current.name : cleanName(patch.name);
        let path = current.path;

        if (current.personal && (name !== current.name || (patch.path !== undefined && patch.path !== current.path))) {
            throw conflict('The personal space cannot be renamed or moved');
        }

        if (patch.path !== undefined) {
            const target = realDirectory(patch.path);

            if (target !== current.path) {
                const other = getProjectByPath(store.db, target);

                if (other) {
                    throw conflict(`${ target } is already the folder of the project ${ other.name }`);
                }

                requireRepositoryRoot(target);

                if (hasUnfinishedRuns(store.db, projectId)) {
                    throw stillWorking();
                }

                path = target;
            }
        }

        const next: Project = { ...current, name, path, settings: mergeSettings(current.settings, patch.settings) };

        upsertProject(store.db, next);
        publishProject(store, next);

        if (path !== current.path) {
            // The watchers hold the old folder; the next request for docs or skills watches the new one.
            store.afterCommit(() => {
                docs.forget(projectId);
                skills.forgetProject(current);
            });
        }

        return next;
    });
}

/**
 * Removes the project with its chats, tasks, runs, streams, artifacts and attachments (the foreign keys carry the rows, the
 * attachment folders go once the transaction commits). Its own folder and files are never touched. The agents must have stopped,
 * and the personal space stays.
 */
export function deleteProject(store: Store, projectId: string, { attachments, docs, skills }: ProjectWatchers & { attachments: AttachmentsService }): void {
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
        store.afterCommit(() => {
            docs.forget(projectId);
            skills.forgetProject(project);
        });
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
            throw invalid(`Project ${ unknown } does not exist`);
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
    }
    catch {
        return false;
    }
}

/**
 * What the page that manages projects shows besides the snapshot: whether each folder is there, its remote, and what it holds.
 * The page asks again every few seconds, so nothing here may stop the daemon: the folders are read asynchronously, one project after
 * another, so a long list never starts a crowd of processes.
 */
export async function projectsInfo(store: Store): Promise<ProjectInfo[]> {
    const { projects, counts } = store.read(() => ({ projects: listProjects(store.db), counts: projectCounts(store.db) }));
    const info: ProjectInfo[] = [];

    for (const project of projects) {
        const folderExists = await isFolder(project.path);
        const remoteUrl = folderExists ? await gitLine(project.path, ['remote', 'get-url', 'origin']) : undefined;

        info.push({
            projectId: project.id,
            folderExists,
            ...(remoteUrl && { remoteUrl }),
            ...(counts.get(project.id) ?? { chats: 0, tasks: 0, activeRuns: 0 }),
        });
    }

    return info;
}

export function requireStatus(store: Store, projectId: string, statusId: string): TaskStatus {
    const status = listStatuses(store.db, projectId).find(candidate => candidate.id === statusId);

    if (!status) {
        throw invalid(`Status ${ statusId } does not belong to project ${ projectId }`);
    }

    return status;
}

/** The project's first status of a category: where tasks land when logic, not a person, moves them. */
export function statusOfCategory(store: Store, projectId: string, category: TaskStatusCategory): TaskStatus {
    const status = listStatuses(store.db, projectId).find(candidate => candidate.category === category);

    if (!status) {
        throw invalid(`Project ${ projectId } has no status in the ${ category } category`);
    }

    return status;
}
