import { addProject, deleteProject, reorderProjects, updateProject } from '../domain/projects';

import type { Handlers } from './context';

export const projectHandlers: Pick<Handlers, 'project.add' | 'project.update' | 'project.delete' | 'project.reorder'> = {
    'project.add': ({ store, config }, command) => {
        const { project, existing } = addProject(store, config, command);

        return { project, ...(existing && { existing: true }) };
    },

    'project.update': ({ store, runs, skills }, command) => {
        const project = updateProject(store, command.projectId, command, { skills });

        // A changed parallel-run limit may free slots.
        store.afterCommit(() => runs.tick());

        return { project };
    },

    'project.delete': ({ store, attachments, skills }, command) => {
        deleteProject(store, command.projectId, { attachments, skills });

        return { projectId: command.projectId };
    },

    'project.reorder': ({ store }, command) => ({ projects: reorderProjects(store, command.projectIds) }),
};
