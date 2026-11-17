import { requireProject } from '../domain/projects';

import type { Handlers } from './context';

export const docsHandlers: Pick<Handlers, 'docs.write'> = {
    'docs.write': ({ store, docs }, command) => {
        const project = requireProject(store, command.projectId);
        const { path, hash, change } = docs.write(project, command);

        store.emit(project.id, { type: 'docs.changed', path, change });

        return { path, hash };
    },
};
