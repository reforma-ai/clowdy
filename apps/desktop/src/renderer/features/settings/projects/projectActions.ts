import { openConfirmModal } from '@clowdy/components/modals';
import { toast } from '@clowdy/components/Toast';
import { mainFolder } from '@clowdy/protocol';
import { runInAction } from 'mobx';

import { pickFolder } from '../../../shell/projectDialogs';
import { perform } from '../../chats/commands';
import { removalMessage } from './projectView';

import type { Project, ProjectInfo, ProjectSettings } from '@clowdy/protocol';
import type { RootStore } from '../../../stores';

/** Shows the project in the window, with Settings closed: one step for back and forward, not two. */
export function openProject(root: RootStore, project: Project): void {
    runInAction(() => {
        root.selectProject(project.id);
        root.ui.closeSettings();
    });
}

export async function renameProject(root: RootStore, project: Project, name: string): Promise<boolean> {
    return (await perform(root, { type: 'project.update', projectId: project.id, name })).ok;
}

/** `null` in a field clears it, so the project follows the daemon's own choice again. */
export async function setProjectDefaults(root: RootStore, project: Project, settings: { [K in keyof ProjectSettings]?: ProjectSettings[K] | null }): Promise<boolean> {
    return (await perform(root, { type: 'project.update', projectId: project.id, settings })).ok;
}

/** Saves the order the person dragged the projects to; the list goes back to the daemon's order when it refuses. */
export async function reorderProjects(root: RootStore, projects: readonly Project[]): Promise<void> {
    const result = await root.reorderProjects(projects.map(project => project.id));

    if (!result.ok) toast.error({ message: result.error.message });
}

/**
 * Points the project at another folder: where it moved to on disk. Nothing is copied or moved. The daemon checks the folder
 * and refuses while agents of the project are working; its reason is shown in the dialog.
 */
export async function changeFolder(root: RootStore, project: Project): Promise<void> {
    const path = await pickFolder();

    if (!path || path === mainFolder(project).path) return;

    openConfirmModal({
        title: 'Use another folder?',
        message: `${ project.name } will work in ${ path } from now on. Nothing is moved or copied. An agent that worked in the old folder starts a new conversation there, so what it remembered may not carry over.`,
        confirmLabel: 'Use this folder',
        onConfirm: async () => {
            // The new folder takes the main one's place; the others stay.
            const folders = [{ path }, ...project.folders.slice(1).map(folder => ({ id: folder.id }))];
            const result = await root.command({ type: 'project.update', projectId: project.id, folders });

            // The dialog shows a thrown message as an error and stays open.
            if (!result.ok) throw new Error(result.error.message);
        },
    });
}

/** Asks, then removes the project from Clowdy. Its folder is never touched. */
export function removeProject(root: RootStore, project: Project, info: ProjectInfo | undefined): void {
    openConfirmModal({
        title: `Remove ${ project.name }?`,
        message: removalMessage(project.name, mainFolder(project).path, info),
        confirmLabel: 'Remove project',
        destructive: true,
        onConfirm: async () => {
            const result = await root.command({ type: 'project.delete', projectId: project.id });

            if (!result.ok) throw new Error(result.error.message);
        },
    });
}
