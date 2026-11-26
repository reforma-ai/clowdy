import { addProject, deleteProject, reorderProjects, updateProject, updateProjectFolder } from '../domain/projects';
import { assertProjectChatsAvailable, assertWorkspaceAvailable } from '../domain/workspaces';

import type { Handlers } from './context';

export const projectHandlers: Pick<
    Handlers,
    'project.add' | 'project.update' | 'project.updateFolder' | 'project.delete' | 'project.reorder'
> = {
    'project.add': ({ store, config }, command) => {
        for (const path of command.folders ?? []) assertWorkspaceAvailable(store, path);
        const { project, existing } = addProject(store, config, command);

        return { project, ...(existing && { existing: true }) };
    },

    'project.update': ({ store, runs, skills }, command) => {
        if (command.folders) {
            assertProjectChatsAvailable(store, command.projectId);
            for (const folder of command.folders) if ('path' in folder) assertWorkspaceAvailable(store, folder.path);
        }
        const project = updateProject(store, command.projectId, command, { skills });

        // A changed parallel-run limit may free slots.
        store.afterCommit(() => runs.tick());

        return { project };
    },

    'project.updateFolder': ({ store }, command) => {
        if (command.settings.baseBranch !== undefined) assertProjectChatsAvailable(store, command.projectId);
        return { project: updateProjectFolder(store, command.projectId, command.folderId, command.settings) };
    },

    'project.delete': ({ store, attachments, skills }, command) => {
        assertProjectChatsAvailable(store, command.projectId);
        deleteProject(store, command.projectId, { attachments, skills });

        return { projectId: command.projectId };
    },

    'project.reorder': ({ store }, command) => ({ projects: reorderProjects(store, command.projectIds) }),
};
