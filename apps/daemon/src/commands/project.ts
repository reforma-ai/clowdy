import { createProject, openProject, updateProject } from '../domain/projects';

import type { Handlers } from './context';

export const projectHandlers: Pick<Handlers, 'project.open' | 'project.create' | 'project.update'> = {
    'project.open': ({ store }, command) => ({ project: openProject(store, command) }),

    'project.create': ({ store, config }, command) => ({ project: createProject(store, config, command) }),

    'project.update': ({ store, runs }, command) => {
        const project = updateProject(store, command.projectId, command);

        // A changed parallel-run limit may free slots.
        store.afterCommit(() => runs.tick());

        return { project };
    },
};
