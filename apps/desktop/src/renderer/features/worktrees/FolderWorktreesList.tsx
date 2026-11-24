import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { useModalContext } from '@clowdy/components/Modal';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';
import { reaction, runInAction } from 'mobx';
import { useEffect, useMemo } from 'react';

import { useRootStore } from '../../stores';
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

export function FolderWorktreesList({
    projectId,
    folderId,
    pendingChanges,
}: {
    projectId: ProjectId;
    folderId: FolderId;
    pendingChanges: boolean;
}) {
    const root = useRootStore();
    const { modal } = useModalContext();
    const { folders, failed, reload } = useProjectWorktrees(projectId);
    const project = root.projects.find(candidate => candidate.id === projectId);
    const groups = useMemo(
        () => (folders && project ? repositoryGroups(folders, project.folders) : undefined),
        [folders, project]
    );

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
        <div className={styles.groups}>
            <Text variant="heading-4">Worktrees</Text>
            {pendingChanges && (
                <Text variant="sm" color="secondary">
                    Save folder settings before creating a worktree
                </Text>
            )}

            {failed && (
                <Alert color={groups ? 'warning' : 'danger'} role={groups ? 'status' : 'alert'}>
                    <AlertIcon>
                        <AttentionCircle />
                    </AlertIcon>
                    <AlertDescription>
                        {groups ? "Couldn't refresh the list" : "Couldn't load the worktrees"}
                    </AlertDescription>
                    <AlertAction>
                        <Button size="xs" onPress={() => void reload()}>
                            Try again
                        </Button>
                    </AlertAction>
                </Alert>
            )}

            <div className={styles.groups}>
                {groups === undefined && !failed && <WorktreesSkeleton />}
                {groups && !groups.some(item => item.group.folderId === folderId) && (
                    <Text color="secondary" className={styles.message}>
                        This folder is not a git repository
                    </Text>
                )}
                <For each={(groups ?? []).filter(item => item.group.folderId === folderId)}>
                    {({ group, folder }) => (
                        <WorktreeGroup
                            key={group.folderId}
                            projectId={projectId}
                            group={group}
                            folder={folder}
                            createDisabled={pendingChanges}
                            onCreate={() => openCreateWorktree({ root, projectId, folderId: group.folderId, reload })}
                            {...actions}
                        />
                    )}
                </For>
            </div>
        </div>
    );
}
