import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Loader } from '@clowdy/components/Loader';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { mainFolder } from '@clowdy/protocol';
import { reaction } from 'mobx';
import { useEffect, useMemo, useRef } from 'react';

import { RootStoreProvider, useRootStore } from '../../stores';
import { openChat } from '../chats/archiveChat';
import styles from './ManageWorktrees.module.css';
import { useProjectWorktrees } from './useProjectWorktrees';
import { WorktreeGroup, type WorktreeRowActions } from './WorktreeRow';
import { repositoryGroups } from './worktreeView';

import type { FolderId, FolderWorktrees, ProjectId, WorktreeChat, WorktreeInfo } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export interface ManageWorktreesProps {
    root: RootStore;
    projectId: ProjectId;
    /** The folder whose group is scrolled into view when the list arrives: where the dialog was opened from. */
    folderId?: FolderId;
    /**
     * What a row's Remove does with the group and the worktree, and the dialog's `reload` for after it. The seam of Stage 5 of `.briefback/worktree-followups/plan.md`: without
     * it every Remove is drawn and cannot be pressed, and `openManageWorktrees` gives none yet.
     */
    onRemove?: (group: FolderWorktrees, worktree: WorktreeInfo, reload: () => Promise<void>) => void;
}

/**
 * "Manage worktrees": the worktrees of every git folder of a project in one window, wherever the person met one (the Files tab, the sidebar's folder menu, Info, the new-chat
 * page). One group per folder with the folder's own checkout first, then a row for every worktree git lists (`WorktreeRow`), found ones included; a folder that is no
 * repository has no group. The window shows only what changes nothing: the programs a worktree opens in, and a new chat in it (the dialog closes and the new-chat page is
 * shown there), or a click on a chat that works in it. No `title` option: the heading is drawn in the dialog, and the window's own close button floats at the corner.
 * The dialog hosts its own React root, so it brings the store to its tree.
 */
export function openManageWorktrees({ root, ...props }: ManageWorktreesProps): void {
    Modal.create({
        width: 720,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        component: <RootStoreProvider value={ root }><ManageWorktrees { ...props } /></RootStoreProvider>,
    });
}

function ManageWorktrees({ projectId, folderId, onRemove }: Omit<ManageWorktreesProps, 'root'>) {
    const root = useRootStore();
    const { modal } = useModalContext();
    const { folders, failed, reload } = useProjectWorktrees(projectId);
    const project = root.projects.find(candidate => candidate.id === projectId);
    const groups = useMemo(() => (folders && project ? repositoryGroups(folders, project.folders) : undefined), [folders, project]);
    const list = useRef<HTMLDivElement>(null);
    const scrolled = useRef(false);

    // The window belongs to one project: when the person is elsewhere (another project is shown, or this one was removed) there is nothing here to manage, and the menus
    // of the rows read the selected project.
    useEffect(() => reaction(
        () => root.selectedProjectId === projectId && root.projects.some(candidate => candidate.id === projectId),
        (isHere) => {
            if (!isHere) modal.cancel();
        },
        { fireImmediately: true }
    ), [root, projectId, modal]);

    // Once, when the list first arrives: the folder the dialog was opened for comes into view. A later read does not move the person's scroll.
    useEffect(() => {
        if (scrolled.current || !groups || folderId === undefined) return;

        scrolled.current = true;
        [...list.current?.querySelectorAll<HTMLElement>('[data-folder-id]') ?? []].find(section => section.dataset.folderId === folderId)?.scrollIntoView?.({ block: 'start' });
    }, [groups, folderId]);

    if (!project) return null;

    const close = () => void modal.cancel();

    const actions: WorktreeRowActions = {
        onNewChat: (folder, worktree) => {
            // The main folder's chat has no folder of its own: it follows the main folder, as the sidebar's New chat does. The folder's own checkout is no worktree to choose.
            root.ui.forProject(projectId).openDraft([], folder.id === mainFolder(project).id ? null : folder.id, worktree.main ? null : { mode: 'existing', path: worktree.path });
            close();
        },
        onOpenChat: (chat: WorktreeChat) => {
            const state = root.projectState(projectId);

            if (state) void openChat(root, state, root.ui.forProject(projectId), chat.id);

            close();
        },
        ...(onRemove && { onRemove: (group: FolderWorktrees, worktree: WorktreeInfo) => onRemove(group, worktree, reload) }),
    };

    return (
        <div className={ styles.dialog }>
            <div className={ styles.heading }>
                <Text variant="heading-3" truncate>Manage worktrees</Text>
                <Text color="secondary">Every worktree of the project's folders, and the chats that work in each</Text>
            </div>

            { failed && groups && <Text variant="sm" color="warning" role="status">Couldn't refresh the list</Text> }

            <div ref={ list } className={ styles.groups }>
                { groups === undefined && !failed && (
                    <div className={ styles.loading }>
                        <Loader size="xs" />
                        <Text color="secondary">Loading worktrees…</Text>
                    </div>
                ) }
                { groups === undefined && failed && (
                    <div className={ styles.message }>
                        <Text color="danger" role="alert">Couldn't read the worktrees</Text>
                        <Button size="sm" onPress={ () => void reload() }>Try again</Button>
                    </div>
                ) }
                { groups?.length === 0 && <Text color="secondary" className={ styles.message }>None of the project's folders is a git repository</Text> }
                <For each={ groups ?? [] }>
                    {({ group, folder }) => <WorktreeGroup key={ group.folderId } projectId={ projectId } group={ group } folder={ folder } { ...actions } />}
                </For>
            </div>
        </div>
    );
}
