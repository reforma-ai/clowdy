import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DOC_SOURCES, docSourcesOf } from '@clowdy/protocol';

import { CommandError, unavailable } from '../errors';
import { isBelow } from '../fs/paths';
import { TtlCache } from '../lib/cache';
import { isDocFile } from './paths';

import type { Dirent } from 'node:fs';
import type { DocNode, DocsSource, DocsTree, Project } from '@clowdy/protocol';
import type { Place } from '../domain/places';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The most entries (files and folders) one source is listed with: a `.briefback` that holds a clone of a repository must not hold the daemon up on every key of the `@` menu. */
export const MAX_DOC_ENTRIES = 20_000;

/** Folders that are never listed: a tool's own store and dependencies, which no document is in, whatever is put in a source. */
const NEVER_LISTED = new Set(['.git', 'node_modules']);

/** The `@` menu and quick search ask for the tree on every key; a checkout's sources are read once in this long. */
const SOURCES_TTL_MS = 5000;

/** Whether a tree has a document in it, at any depth. */
const hasDocument = (nodes: readonly DocNode[]): boolean =>
    nodes.some(node => (node.kind === 'file' ? true : hasDocument(node.children ?? [])));

/**
 * The documents under `root`: Markdown files and folders only, folders first, names in natural order. Symbolic links are
 * not listed, a folder that cannot be read lists nothing, `.git` and `node_modules` are skipped, and past `MAX_DOC_ENTRIES` the rest of the source is left out.
 */
export async function readDocs(root: string, relative = '', budget = { left: MAX_DOC_ENTRIES }): Promise<DocNode[]> {
    const nodes: DocNode[] = [];
    const entries = await readdir(relative ? `${root}/${relative}` : root, { withFileTypes: true }).catch(
        (): Dirent[] => []
    );

    for (const entry of entries) {
        if (budget.left <= 0) break;

        const path = relative ? `${relative}/${entry.name}` : entry.name;

        if (entry.isDirectory() && !NEVER_LISTED.has(entry.name)) {
            budget.left--;
            nodes.push({ path, name: entry.name, kind: 'dir', children: await readDocs(root, path, budget) });
        } else if (entry.isFile() && isDocFile(entry.name)) {
            budget.left--;
            nodes.push({ path, name: entry.name, kind: 'file' });
        }
    }

    return nodes.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
}

const isFolderAt = (path: string): Promise<boolean> =>
    stat(path).then(
        info => info.isDirectory(),
        () => false
    );

/** Every path the registry asks about: the roots, and what a root requires beside it. */
const SOURCE_PATHS = [
    ...new Set(DOC_SOURCES.flatMap(source => [source.root, ...(source.requires ? [source.requires] : [])])),
];

/**
 * The document sources a checkout has, each with its Markdown tree: the roots of the registry (`DOC_SOURCES`) that are folders on the disk, in its order. A root that is a link
 * out of the checkout is left out (nothing is read through it, and it does not take the others down: a `specs` that is a link to a shared folder is no reason to list no
 * documents), and so is one with no Markdown file in it. Nothing here makes a folder.
 */
export async function readSources(checkout: string): Promise<DocsSource[]> {
    const folders = new Set(
        (
            await Promise.all(SOURCE_PATHS.map(async path => ((await isFolderAt(join(checkout, path))) ? [path] : [])))
        ).flat()
    );
    const base = await realpath(checkout).catch(() => undefined);
    const sources = await Promise.all(
        docSourcesOf(path => folders.has(path)).map(async (source): Promise<DocsSource[]> => {
            const root = base && (await realpath(join(checkout, source.root)).catch(() => undefined));

            // A root that is a link out of the checkout is not read through.
            if (!base || !root || !isBelow(base, root)) return [];

            const nodes = await readDocs(root);

            return hasDocument(nodes) ? [{ id: source.id, label: source.label, root: source.root, nodes }] : [];
        })
    );

    return sources.flat();
}

const kept = new TtlCache<DocsSource[]>({ limit: 64 });

/** `readSources`, kept for `SOURCES_TTL_MS` per checkout and read once however many ask meanwhile. */
const keptSources = (checkout: string): Promise<DocsSource[]> =>
    kept.get(checkout, async () => ({ value: await readSources(checkout), keepMs: SOURCES_TTL_MS }));

/**
 * The documents of a project, one entry per folder in the project's order, each with the sources it has, kept per checkout for `SOURCES_TTL_MS` (`read` is how a checkout's
 * sources are read: `readSources` for a fresh look). The main folder must be there, since the project cannot work without it: a missing main folder is `unavailable`. Another
 * folder that is missing is left out. A folder with no sources has an entry with none. Nothing here writes or watches: the files are the file system's, which the app opens
 * and edits through `fs`.
 *
 * With a `place` that is a worktree, the entry of its folder is the worktree's documents (a plan an agent wrote there is not in the main checkout), under the folder's own
 * id; the other folders are read as before.
 */
export async function readDocsTree(project: Project, place?: Place, read = keptSources): Promise<DocsTree> {
    const entries = await Promise.all(
        project.folders.map(async (folder, index): Promise<DocsTree> => {
            const checkout = place?.folder.id === folder.id ? place.path : folder.path;

            try {
                if (
                    !(await stat(checkout).then(
                        () => true,
                        () => false
                    ))
                ) {
                    throw unavailable(`The ${checkout === folder.path ? 'folder' : 'worktree'} ${checkout} is missing`);
                }

                return [{ folderId: folder.id, sources: await read(checkout) }];
            } catch (error) {
                if (index === 0 || !(error instanceof CommandError)) {
                    throw error;
                }

                return [];
            }
        })
    );

    return entries.flat();
}
