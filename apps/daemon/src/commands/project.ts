import { createProject, deleteProject, openProject, reorderProjects, updateProject } from '../domain/projects';

import type { Handlers } from './context';

export const projectHandlers: Pick<Handlers, 'project.open' | 'project.create' | 'project.update' | 'project.delete' | 'project.reorder'> = {
    'project.open': ({ store }, command) => ({ project: openProject(store, command) }),

    'project.create': ({ store, config }, command) => ({ project: createProject(store, config, command) }),

    'project.update': ({ store, runs, docs, skills }, command) => {
        const project = updateProject(store, command.projectId, command, { docs, skills });

        // A changed parallel-run limit may free slots.
        store.afterCommit(() => runs.tick());

        return { project };
    },

    'project.delete': ({ store, attachments, docs, skills }, command) => {
        deleteProject(store, command.projectId, { attachments, docs, skills });

        return { projectId: command.projectId };
    },

    'project.reorder': ({ store }, command) => ({ projects: reorderProjects(store, command.projectIds) }),
};
