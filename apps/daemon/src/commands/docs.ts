import { requireProject } from '../domain/projects';

import type { Handlers } from './context';

export const docsHandlers: Pick<Handlers, 'docs.write'> = {
    'docs.write': ({ store, docs }, command) => {
        const project = requireProject(store, command.projectId);
        const { folder, path, hash, change } = docs.write(project, command.folderId, command);

        // Every project that has the folder shares its documents, so each of them hears of the change.
        docs.announce(folder, path, change);

        return { path, hash };
    },
};
