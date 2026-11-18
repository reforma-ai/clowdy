import { existsSync } from 'node:fs';

import { unavailable } from '../errors';
import { listProjectFiles } from './list';
import { searchPaths } from './rank';

import type { Project } from '@clowdy/protocol';

/** A person types a few letters at a time; listing the folder for each would be a git run per key. */
const LIST_TTL_MS = 5000;

/** The files of a project that can be mentioned in a message, found by name. */
export class FilesService {
    private lists = new Map<string, { at: number; paths: Promise<string[]> }>();

    /** The paths below the project folder that contain every word of `query`, best match first, at most `limit`. */
    async search(project: Project, query: string, limit: number): Promise<string[]> {
        if (!existsSync(project.path)) {
            throw unavailable(`The project folder ${ project.path } is missing`);
        }

        return searchPaths(await this.list(project.path), query, limit);
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
