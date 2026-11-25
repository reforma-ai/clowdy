import { openConfirmModal } from '@clowdy/components/modals';
import { toast } from '@clowdy/components/Toast';
import { folderNames, mainFolder, NO_PROJECT_ICON } from '@clowdy/protocol';
import { runInAction } from 'mobx';

import { perform } from '../../chats/commands';
import { newMainMessage, removalMessage, removedFolderMessage } from './projectView';
import { MAX_ICON_SOURCE_BYTES, squareIcon } from './squareIcon';

import type { Project, ProjectFolder, ProjectInfo, ProjectSettings } from '@clowdy/protocol';
import type { CommandInput } from '../../../daemon/transport';
import type { RootStore } from '../../../stores';

/** What `project.updateFolder` changes: a field left out stays, `null` clears it. */
export type FolderSettingsPatch = Extract<CommandInput, { type: 'project.updateFolder' }>['settings'];

/** Shows the project in the window, with Settings closed: one step for back and forward, not two. */
export function openProject(root: Pick<RootStore, 'selectProject' | 'ui'>, project: Project): void {
    runInAction(() => {
        root.selectProject(project.id);
        root.ui.closeSettings();
    });
}

export async function renameProject(root: RootStore, project: Project, name: string): Promise<boolean> {
    return (await perform(root, { type: 'project.update', projectId: project.id, name })).ok;
}

/** `null` in a field clears it, so the project follows the daemon's own choice again. */
export async function setProjectDefaults(
    root: RootStore,
    project: Project,
    settings: { [K in keyof ProjectSettings]?: ProjectSettings[K] | null }
): Promise<boolean> {
    return (await perform(root, { type: 'project.update', projectId: project.id, settings })).ok;
}

/**
 * Makes the picture the project's icon, drawn small first (`squareIcon`) so the project carries it in its settings. A file over
 * `MAX_ICON_SOURCE_BYTES`, one that is not a picture, and the daemon's refusal are toasts. Resolves to whether the icon was saved.
 */
export async function uploadProjectIcon(root: RootStore, project: Project, file: File): Promise<boolean> {
    if (file.size > MAX_ICON_SOURCE_BYTES) {
        toast.error({ message: `${file.name} is over ${MAX_ICON_SOURCE_BYTES / 1024 / 1024} MB` });

        return false;
    }

    let icon: string;

    try {
        icon = await squareIcon(file);
    } catch {
        toast.error({ message: `Couldn't read ${file.name} as a picture` });

        return false;
    }

    return setProjectDefaults(root, project, { icon });
}

/** Clears an uploaded picture, so the main folder's favicon shows again, or the folder icon when it has none. */
export async function restoreFolderIcon(root: RootStore, project: Project): Promise<boolean> {
    return setProjectDefaults(root, project, { icon: null });
}

/** Hides the main folder's favicon, so the project shows the folder icon. */
export async function removeProjectIcon(root: RootStore, project: Project): Promise<boolean> {
    return setProjectDefaults(root, project, { icon: NO_PROJECT_ICON });
}

/** Saves the order the person dragged the projects to; the list goes back to the daemon's order when it refuses. */
export async function reorderProjects(root: RootStore, projects: readonly Project[]): Promise<void> {
    const result = await root.reorderProjects(projects.map(project => project.id));

    if (!result.ok) toast.error({ message: result.error.message });
}

/** A folder list as `project.update` takes it: the project's own folders by id, in this order, then new ones by path. */
function folderEntries(folders: readonly ProjectFolder[], added: readonly string[] = []) {
    return [...folders.map(folder => ({ id: folder.id })), ...added.map(path => ({ path }))];
}

/**
 * Adds the folders the person picked after the project's own, with no dialog: the main folder stays, so the agents go on where they are.
 * A folder the project has already is skipped. The daemon checks the rest, and a refusal is a toast.
 */
export async function addFolders(root: RootStore, project: Project, picked: readonly string[]): Promise<void> {
    // The picker stays open as long as the person likes: the list may have changed meanwhile, in this window or another one.
    const current = root.projects.find(candidate => candidate.id === project.id);

    if (!current) return;

    const known = new Set(current.folders.map(folder => folder.path));
    const added = [...new Set(picked)].filter(path => !known.has(path));

    if (added.length === 0) return;

    await perform(root, {
        type: 'project.update',
        projectId: current.id,
        folders: folderEntries(current.folders, added),
    });
}

/**
 * Asks before the project gets a new main folder, then sends what `change` makes of the project's folders as they are when the person
 * confirms: another window may change them while the dialog is open, and `project.update` replaces the whole list, so a list read when
 * the dialog opened would drop a folder added meanwhile. The daemon refuses while agents of the project are working, and its reason shows
 * while the dialog stays open. Resolves to whether the folders were saved once the dialog is gone.
 */
function confirmNewMain(
    root: RootStore,
    project: Project,
    change: (folders: readonly ProjectFolder[]) => ProjectFolder[],
    dialog: { title: string; message: string; confirmLabel: string }
): Promise<boolean> {
    return new Promise(resolve => {
        let saved = false;

        openConfirmModal(
            {
                ...dialog,
                onConfirm: async () => {
                    const { folders } = root.projects.find(candidate => candidate.id === project.id) ?? project;
                    const result = await root.command({
                        type: 'project.update',
                        projectId: project.id,
                        folders: folderEntries(change(folders)),
                    });

                    // The dialog shows a thrown message as an error and stays open.
                    if (!result.ok) throw new Error(result.error.message);

                    saved = true;
                },
            },
            { onClose: () => resolve(saved) }
        );
    });
}

/**
 * Saves the order the person dragged the folders to. A new main folder asks first, since the agents move to it; another order applies at
 * once. Resolves to whether it was saved: false when the person cancelled or the daemon refused.
 */
export async function reorderFolders(
    root: RootStore,
    project: Project,
    folders: readonly ProjectFolder[]
): Promise<boolean> {
    const [next] = folders;

    if (!next) return false;

    if (next.id === mainFolder(project).id)
        return (await perform(root, { type: 'project.update', projectId: project.id, folders: folderEntries(folders) }))
            .ok;

    const name = folderNames(folders)[0] ?? next.path;
    // A drag moves one folder: the one dragged to the top goes first, the others keep their order.
    const change = (current: readonly ProjectFolder[]) => [next, ...current.filter(folder => folder.id !== next.id)];

    return confirmNewMain(root, project, change, {
        title: `Make ${name} the main folder?`,
        message: newMainMessage(project.name, next.path),
        confirmLabel: 'Make main folder',
    });
}

/**
 * Takes a folder out of the project; the folder and its files stay on disk. Without the main folder the next one becomes main, which asks first;
 * another folder goes at once, unless chats work in it (`chats`, from the daemon's info): they go back to the main folder, which asks first too.
 * Resolves to whether it was removed.
 */
export async function removeFolder(
    root: RootStore,
    project: Project,
    folder: ProjectFolder,
    chats = 0
): Promise<boolean> {
    const folders = project.folders.filter(other => other.id !== folder.id);

    // A project has at least one folder: its last one is not offered for removal.
    if (folders.length === 0) return false;

    const names = folderNames(project.folders);
    const name = names[project.folders.findIndex(other => other.id === folder.id)] ?? folder.path;
    const change = (current: readonly ProjectFolder[]) => current.filter(other => other.id !== folder.id);
    const isMain = folder.id === mainFolder(project).id;

    if (!isMain && chats === 0)
        return (await perform(root, { type: 'project.update', projectId: project.id, folders: folderEntries(folders) }))
            .ok;

    const message = isMain
        ? newMainMessage(project.name, mainFolder({ folders }).path, folder.path)
        : removedFolderMessage(chats, name, names[0] ?? mainFolder(project).path);

    return confirmNewMain(root, project, change, { title: `Remove ${name}?`, message, confirmLabel: 'Remove folder' });
}

/**
 * Saves what the worktrees made from one folder of the project start from and need (the Workspace dialog); `null` in a field clears it. The daemon's refusal is a toast.
 * Resolves to whether it was saved.
 */
export async function setFolderSettings(
    root: RootStore,
    project: Pick<Project, 'id'>,
    folder: Pick<ProjectFolder, 'id'>,
    settings: FolderSettingsPatch
): Promise<boolean> {
    return (await perform(root, { type: 'project.updateFolder', projectId: project.id, folderId: folder.id, settings }))
        .ok;
}

/**
 * Puts a folder of the project at another place on the disk, for a folder that was moved or renamed outside Clowdy: the folder stays the same folder of the project, in
 * the same order, so the chats that work in it stay with it (an agent that worked there starts over from the record on its next turn). The daemon checks the path as
 * it does a new folder's, and the main folder waits for the agents; a refusal is a toast. Resolves to whether it was saved.
 */
export async function locateFolder(
    root: RootStore,
    project: Project,
    folder: ProjectFolder,
    path: string
): Promise<boolean> {
    // The list as it is now, since `project.update` replaces the whole of it and another window may have changed it.
    const current = root.projects.find(candidate => candidate.id === project.id) ?? project;
    const folders = current.folders.map(other => (other.id === folder.id ? { id: other.id, path } : { id: other.id }));

    return (await perform(root, { type: 'project.update', projectId: project.id, folders })).ok;
}

/**
 * Asks where the folder is now, with the desktop's folder dialog (it takes several; the first is the new place), and moves the folder there (`locateFolder`). Resolves
 * to whether it was moved: false when the person closed the dialog, the window has none (a page outside the desktop app), or the daemon refused.
 */
export async function locateFolderByDialog(root: RootStore, project: Project, folder: ProjectFolder): Promise<boolean> {
    const choose = window.desktop?.chooseDirectories;

    if (!choose) return false;

    const [path] = await choose();

    return path ? locateFolder(root, project, folder, path) : false;
}

/** Asks, then removes the project from Clowdy. Its folders are never touched. */
export function removeProject(root: RootStore, project: Project, info: ProjectInfo | undefined): void {
    openConfirmModal({
        title: `Remove ${project.name}?`,
        message: removalMessage(
            project.name,
            project.folders.map(folder => folder.path),
            info
        ),
        confirmLabel: 'Remove project',
        destructive: true,
        onConfirm: async () => {
            const result = await root.command({ type: 'project.delete', projectId: project.id });

            if (!result.ok) throw new Error(result.error.message);
        },
    });
}
