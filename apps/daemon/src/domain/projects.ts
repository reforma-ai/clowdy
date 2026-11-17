import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { getProject, getProjectByPath, insertStatus, listStatuses, upsertProject } from '../db/projects';
import { conflict, invalid, notFound, unavailable } from '../errors';
import { newId } from '../ids';
import { git } from './git';

import type { Project, TaskStatus, TaskStatusCategory } from '@clowdy/protocol';
import type { Config } from '../config';
import type { Store } from '../store';

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

function insertProject(store: Store, input: { name: string; path: string }): Project {
    return store.tx(() => {
        const project: Project = {
            id: newId('prj'),
            name: input.name,
            path: input.path,
            taskPrefix: deriveTaskPrefix(input.name),
            settings: {},
            createdAt: Date.now(),
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

/** Opens an existing repository as a project. Opening the same folder again returns the same project. */
export function openProject(store: Store, input: { path: string; name?: string }): Project {
    const path = realDirectory(input.path);
    const existing = getProjectByPath(store.db, path);

    if (existing) {
        return existing;
    }

    const top = git(path, ['rev-parse', '--show-toplevel']);

    if (!top.ok) {
        throw invalid(`${ path } is not a git repository`);
    }

    if (realpathSync.native(top.stdout) !== path) {
        throw invalid(`${ path } is inside the repository ${ top.stdout }; open the repository root`);
    }

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

    const init = git(target, ['init', '-b', 'main']);

    if (!init.ok) {
        throw unavailable(`git init failed: ${ init.stderr }`);
    }

    const hasIdentity = ['user.name', 'user.email'].every(key => git(target, ['config', key]).stdout !== '');
    const identity = hasIdentity ? [] : ['-c', 'user.name=Clowdy', '-c', 'user.email=clowdy@localhost'];
    const commit = git(target, [...identity, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial commit']);

    if (!commit.ok) {
        throw unavailable(`The initial commit failed: ${ commit.stderr }`);
    }

    return insertProject(store, { name, path: realpathSync.native(target) });
}

export interface ProjectPatch {
    name?: string;
    settings?: Project['settings'];
}

export function updateProject(store: Store, projectId: string, patch: ProjectPatch): Project {
    return store.tx(() => {
        const current = requireProject(store, projectId);
        const next: Project = { ...current, name: patch.name === undefined ? current.name : cleanName(patch.name), settings: { ...current.settings, ...patch.settings } };

        upsertProject(store.db, next);
        publishProject(store, next);

        return next;
    });
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
