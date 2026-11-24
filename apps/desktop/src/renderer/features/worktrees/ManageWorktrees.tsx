import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { mainFolder } from '@clowdy/protocol';
import { reaction, runInAction } from 'mobx';
import { useEffect, useMemo, useRef } from 'react';

import { RootStoreProvider, useRootStore } from '../../stores';
import { openChat } from '../chats/archiveChat';
import { refreshFolderGit } from '../openWith';
import { openCreateWorktree } from './CreateWorktreeDialog';
import styles from './ManageWorktrees.module.css';
import { openRemoveWorktree } from './RemoveWorktreeDialog';
import { useProjectWorktrees } from './useProjectWorktrees';
import { WorktreeGroup, type WorktreeRowActions } from './WorktreeRow';
import { WorktreesSkeleton } from './WorktreesSkeleton';
import { repositoryGroups } from './worktreeView';

import type { FolderId, FolderWorktrees, ProjectId, WorktreeChat, WorktreeInfo } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

export interface ManageWorktreesProps {
    root: RootStore;
    projectId: ProjectId;
    /** The folder whose group is scrolled into view when the list arrives: where the dialog was opened from. */
    folderId?: FolderId;
}

/**
 * "Manage worktrees": the worktrees of every git folder of a project in one window, wherever the person met one (the Files tab, the sidebar's folder menu, Info, the new-chat
 * page). One group per folder with the folder's own checkout first, then a row for every worktree git lists (`WorktreeRow`), found ones included; a folder that is no
 * repository has no group. A row opens in the programs of the computer, starts a new chat in the worktree (the dialog closes and the new-chat page is shown there), lists the
 * chats that work in it (a click opens one), and removes it through a confirmation (`openRemoveWorktree`), after which the list is read again. No `title` option: the heading
 * is drawn in the dialog, and the window's own close button floats at the corner. While the first read is on its way it shows the table the list will be, in shimmering blocks
 * (`WorktreesSkeleton`), not a line of text. The dialog hosts its own React root, so it brings the store to its tree.
 */
export function openManageWorktrees({ root, ...props }: ManageWorktreesProps): void {
    Modal.create({
        // As wide as the content needs and no more: a row is a branch and a path on the left and three buttons on the right, both lines cut with an ellipsis. The settings dialogs are 460 to 480.
        width: 540,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        component: (
            <RootStoreProvider value={root}>
                <ManageWorktrees {...props} />
            </RootStoreProvider>
        ),
    });
}

function ManageWorktrees({ projectId, folderId }: Omit<ManageWorktreesProps, 'root'>) {
    const root = useRootStore();
    const { modal } = useModalContext();
    const { folders, failed, reload } = useProjectWorktrees(projectId);
    const project = root.projects.find(candidate => candidate.id === projectId);
    const groups = useMemo(
        () => (folders && project ? repositoryGroups(folders, project.folders) : undefined),
        [folders, project]
    );
    const list = useRef<HTMLDivElement>(null);
    const scrolled = useRef(false);

    // The window belongs to one project, which it can be opened for from Settings without the window showing it: it only closes when that project is removed, and there is
    // nothing here to manage then. Its rows read the project by its id, not the window's selected one.
    useEffect(
        () =>
            reaction(
                () => root.projects.some(candidate => candidate.id === projectId),
                isHere => {
                    if (!isHere) modal.cancel();
                },
                { fireImmediately: true }
            ),
        [root, projectId, modal]
    );

    // Once, when the list first arrives: the folder the dialog was opened for comes into view. A later read does not move the person's scroll.
    useEffect(() => {
        if (scrolled.current || !groups || folderId === undefined) return;

        scrolled.current = true;
        [...(list.current?.querySelectorAll<HTMLElement>('[data-folder-id]') ?? [])]
            .find(section => section.dataset.folderId === folderId)
            ?.scrollIntoView({ block: 'start' });
    }, [groups, folderId]);

    if (!project) return null;

    // The two actions that close the window take the person to a chat or to the new-chat page, whose message box takes the focus: the window must not hand it back, after its
    // closing animation, to the button that opened it.
    const leave = () => void modal.cancel({ restoreFocus: false });
    // Opened from Settings, the window may be for a project the app does not show: the person is taken to it first, with Settings shut, in one step of the history.
    const show = () =>
        runInAction(() => {
            root.selectProject(projectId);
            root.ui.closeSettings();
        });

    const actions: WorktreeRowActions = {
        onNewChat: (folder, worktree) => {
            show();
            if (!worktree.main) refreshFolderGit(projectId, folder.id);

            // The main folder's chat has no folder of its own: it follows the main folder, as the sidebar's New chat does. The folder's own checkout is no worktree to choose.
            root.ui
                .forProject(projectId)
                .openDraft(
                    [],
                    folder.id === mainFolder(project).id ? null : folder.id,
                    worktree.main ? null : { mode: 'existing', path: worktree.path }
                );
            leave();
        },
        onOpenChat: (chat: WorktreeChat) => {
            show();

            const state = root.projectState(projectId);

            if (state) void openChat(root, state, root.ui.forProject(projectId), chat.id);

            leave();
        },
        onRemove: (group: FolderWorktrees, worktree: WorktreeInfo) =>
            openRemoveWorktree({ root, projectId, group, worktree, reload }),
    };

    return (
        <div className={styles.dialog}>
            <div className={styles.heading}>
                <Text variant="heading-3" truncate>
                    Manage worktrees
                </Text>
                <Text variant="md" color="secondary">
                    Each folder's worktrees and the chats working in them
                </Text>
            </div>

            {failed && groups && (
                <div className={styles.notice}>
                    <Text variant="sm" color="warning" role="status">
                        Couldn't refresh the list
                    </Text>
                    <Button size="xs" onPress={() => void reload()}>
                        Try again
                    </Button>
                </div>
            )}

            <div ref={list} className={styles.groups}>
                {groups === undefined && !failed && <WorktreesSkeleton />}
                {groups === undefined && failed && (
                    <div className={styles.message}>
                        <Text color="danger" role="alert">
                            Couldn't load the worktrees
                        </Text>
                        <Button size="sm" onPress={() => void reload()}>
                            Try again
                        </Button>
                    </div>
                )}
                {groups?.length === 0 && (
                    <Text color="secondary" className={styles.message}>
                        No folder of this project is a git repository
                    </Text>
                )}
                <For each={groups ?? []}>
                    {({ group, folder }) => (
                        <WorktreeGroup
                            key={group.folderId}
                            projectId={projectId}
                            group={group}
                            folder={folder}
                            onCreate={() => openCreateWorktree({ root, projectId, folderId: group.folderId, reload })}
                            {...actions}
                        />
                    )}
                </For>
            </div>
        </div>
    );
}
