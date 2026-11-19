import { folderNames, mainFolder } from '@clowdy/protocol';
import { existsSync } from 'node:fs';

import { unavailable } from '../errors';
import { listProjectFiles } from './list';
import { searchPaths } from './rank';

import type { Project, ProjectFileMatch } from '@clowdy/protocol';

/** A person types a few letters at a time; listing the folder for each would be a git run per key. */
const LIST_TTL_MS = 5000;

/** The files of a project that can be mentioned in a message, found by name. */
export class FilesService {
    private lists = new Map<string, { at: number; paths: Promise<string[]> }>();

    /**
     * The files of the project's folders whose path contains every word of `query`, best match first, at most `limit`. With several folders a
     * path is matched with the folder's name in front (`web/src/app.ts`), so typing the name finds its files. A missing folder other than the
     * main one is skipped.
     */
    async search(project: Project, query: string, limit: number): Promise<ProjectFileMatch[]> {
        const main = mainFolder(project);

        if (!existsSync(main.path)) {
            throw unavailable(`The project folder ${ main.path } is missing`);
        }

        if (project.folders.length === 1) {
            return searchPaths(await this.list(main.path), query, limit).map(path => ({ folderId: main.id, path }));
        }

        const names = folderNames(project.folders);
        const byKey = new Map<string, ProjectFileMatch>();

        await Promise.all(project.folders.map(async (folder, index) => {
            if (!existsSync(folder.path)) {
                return;
            }

            for (const path of await this.list(folder.path)) {
                byKey.set(`${ names[index] }/${ path }`, { folderId: folder.id, path });
            }
        }));

        return searchPaths([...byKey.keys()], query, limit).map(key => byKey.get(key) as ProjectFileMatch);
    }

    private list(root: string): Promise<string[]> {
        const now = Date.now();
        const known = this.lists.get(root);

        if (known && now - known.at < LIST_TTL_MS) {
            return known.paths;
        }

        for (const [path, { at }] of this.lists) {
            if (now - at >= LIST_TTL_MS) {
                this.lists.delete(path);
            }
        }

        const paths = listProjectFiles(root);

        this.lists.set(root, { at: now, paths });
        // A failed listing must not be served again for the next few seconds.
        paths.catch(() => this.lists.delete(root));

        return paths;
    }
}
