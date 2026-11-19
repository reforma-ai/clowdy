import { FileIcon } from '@clowdy/components/FileIcon';

import { DOCS_FOLDER } from './composerMentions';
import { mentionIcon } from './MentionChip';

import type { RichInputTriggerItem } from '@clowdy/components/RichInput';
import type { DocNode, SkillEntry, Task } from '@clowdy/protocol';

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

/** Documents whose path has every word typed, in the order the tree lists them. */
export function docItems(paths: readonly string[], query: string): RichInputTriggerItem[] {
    const words = wordsOf(query);

    return paths
        .filter(path => hasAll(words, path.toLowerCase()))
        .slice(0, DOCS_SHOWN)
        .map((path) => {
            const data = { path: `${ DOCS_FOLDER }/${ path }` };

            return {
                value: `doc:${ path }`,
                label: baseName(path),
                description: folderOf(path) || undefined,
                icon: mentionIcon({ kind: 'doc', data }, 14),
                section: 'Documents',
                kind: 'doc',
                displayText: baseName(path),
                data,
            };
        });
}

/** The files the daemon found, as it ranked them. */
export function fileItems(paths: readonly string[]): RichInputTriggerItem[] {
    return paths.map((path) => {
        const data = { path };

        return {
            value: `file:${ path }`,
            label: baseName(path),
            description: folderOf(path) || undefined,
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
