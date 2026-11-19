import { FileIcon } from '@clowdy/components/FileIcon';
import { folderNames } from '@clowdy/protocol';

import { DOCS_FOLDER } from './composerMentions';
import { mentionIcon } from './MentionChip';

import type { RichInputTriggerItem } from '@clowdy/components/RichInput';
import type { DocNode, DocsTree, ProjectFileMatch, ProjectFolder, SkillEntry, Task } from '@clowdy/protocol';

/** How many of each kind the `@` menu lists: it is a pick list, not a search page. */
export const TASKS_SHOWN = 6;
export const DOCS_SHOWN = 6;
export const FILES_SHOWN = 20;

const wordsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
const hasAll = (words: string[], text: string) => words.every(word => text.includes(word));

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Tasks whose key or title has every word typed, the newest first. */
export function taskItems(tasks: readonly Task[], query: string): RichInputTriggerItem[] {
    const words = wordsOf(query);

    return tasks
        .filter(task => hasAll(words, `${ task.key } ${ task.title }`.toLowerCase()))
        .toSorted((a, b) => b.number - a.number)
        .slice(0, TASKS_SHOWN)
        .map((task) => {
            const data = { key: task.key, title: task.title };

            return {
                value: `task:${ task.key }`,
                label: task.key,
                description: task.title,
                icon: mentionIcon({ kind: 'task', data }, 14),
                section: 'Tasks',
                kind: 'task',
                displayText: task.key,
                data,
            };
        });
}

/** The paths of a docs tree's files, relative to the docs folder. */
export function docPaths(nodes: readonly DocNode[]): string[] {
    return nodes.flatMap(node => (node.kind === 'dir' ? docPaths(node.children ?? []) : [node.path]));
}

/** `relative` (with `/`) below an absolute folder, with the folder's own separator, so a Windows path stays one. */
function underFolder(folder: string, relative: string): string {
    const windows = folder.includes('\\') && !folder.includes('/');
    const separator = windows ? '\\' : '/';

    return `${ folder.replace(/[\\/]+$/, '') }${ separator }${ windows ? relative.replaceAll('/', '\\') : relative }`;
}

/**
 * Documents whose path has every word typed, folder by folder in the order the tree lists them. A document of the main folder reaches the
 * agent as `.clowdy/docs/<path>`, relative to the folder it works in; another folder's by its absolute path, since the agent works in the main
 * folder. With several folders the suggestion names the folder, and the folder's name counts as part of the path when searching.
 */
export function docItems(tree: DocsTree, folders: readonly ProjectFolder[], query: string): RichInputTriggerItem[] {
    const words = wordsOf(query);
    const names = folderNames(folders);
    const several = tree.length > 1;
    const docs = tree.flatMap(({ folderId, nodes }) => {
        const index = folders.findIndex(folder => folder.id === folderId);
        const folder = folders[index];

        if (!folder) return [];

        const name = names[index] ?? '';

        return docPaths(nodes).map(path => ({ folderId, path, name, shown: several ? `${ name }/${ path }` : path, agentPath: index === 0 ? `${ DOCS_FOLDER }/${ path }` : underFolder(folder.path, `${ DOCS_FOLDER }/${ path }`) }));
    });

    return docs
        .filter(doc => hasAll(words, doc.shown.toLowerCase()))
        .slice(0, DOCS_SHOWN)
        .map(({ folderId, path, shown, agentPath }) => {
            const data = { path: agentPath };

            return {
                value: `doc:${ folderId }:${ path }`,
                label: baseName(path),
                description: folderOf(shown) || undefined,
                icon: mentionIcon({ kind: 'doc', data }, 14),
                section: 'Documents',
                kind: 'doc',
                displayText: baseName(path),
                data,
            };
        });
}

/**
 * The files the daemon found, as it ranked them. A file of the main folder reaches the agent by its path from there, the folder it works in;
 * another folder's by its absolute path. With several folders the suggestion names the folder (`<folder name>/<path>`).
 */
export function fileItems(matches: readonly ProjectFileMatch[], folders: readonly ProjectFolder[]): RichInputTriggerItem[] {
    const names = folderNames(folders);
    const several = folders.length > 1;

    return matches.flatMap(({ folderId, path }) => {
        const index = folders.findIndex(folder => folder.id === folderId);
        const folder = folders[index];

        // A folder the project no longer has: the answer was for its list before the change.
        if (!folder) return [];

        const shown = several ? `${ names[index] }/${ path }` : path;
        const data = { path: index === 0 ? path : underFolder(folder.path, path) };

        return {
            value: `file:${ folderId }:${ path }`,
            label: baseName(path),
            description: folderOf(shown) || undefined,
            icon: <FileIcon path={ path } kind="file" />,
            section: 'Files',
            kind: 'file',
            displayText: baseName(path),
            data,
        };
    });
}

/** A skill as an agent knows it: the catalog's `user:deploy` is the plugin name Clowdy gave a user skill, the folder is `deploy`. */
export const skillName = (entry: Pick<SkillEntry, 'name'>) => entry.name.replace(/^user:/, '');

/**
 * The skills a person may ask for: the user's and the project's that are on. The system ones belong to the orchestrator
 * and it starts from them by itself. A name both a user and a project skill have is listed once.
 */
export function skillItems(entries: readonly SkillEntry[], query: string): RichInputTriggerItem[] {
    const words = wordsOf(query);
    const seen = new Set<string>();
    const items: RichInputTriggerItem[] = [];

    for (const entry of entries) {
        const name = skillName(entry);

        if (entry.source === 'system' || !entry.enabled || seen.has(name) || !hasAll(words, `${ name } ${ entry.description }`.toLowerCase())) continue;

        seen.add(name);
        items.push({
            value: `skill:${ name }`,
            label: `/${ name }`,
            description: entry.description,
            kind: 'command',
            displayText: `/${ name }`,
            data: { name },
        });
    }

    return items;
}
