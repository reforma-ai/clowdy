import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { useModalContext } from '@clowdy/components/Modal';
import { DialogLayout } from '@clowdy/components/modals';
import { PanelEmptyState } from '@clowdy/components/Panel';
import { ArrowLeft, AttentionCircle, Broom } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';
import { reaction, runInAction } from 'mobx';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useRootStore } from '../../stores';
import { openChat } from '../chats/archiveChat';
import { refreshFolderGit } from '../openWith';
import { openCreateWorktree } from './CreateWorktreeDialog';
import { canRemove, confirmTidyWorktrees, eligible, keyOf } from './confirmTidyWorktrees';
import styles from './ManageWorktrees.module.css';
import { openRemoveWorktree } from './RemoveWorktreeDialog';
import { type ProjectWorktrees, useProjectWorktrees } from './useProjectWorktrees';
import { WorktreeGroup, type WorktreeRowActions } from './WorktreeRow';
import { WorktreesSkeleton } from './WorktreesSkeleton';
import { repositoryGroups } from './worktreeView';

import type { FolderWorktrees, ProjectId, WorktreeChat, WorktreeInfo } from '@clowdy/protocol';

export function FolderWorktreesList({
    projectId,
    initialTidy = false,
}: {
    projectId: ProjectId;
    initialTidy?: boolean;
}) {
    const [tidy, setTidy] = useState(initialTidy);
    const [selected, setSelected] = useState<ReadonlySet<string>>();
    const tidyButton = useRef<HTMLButtonElement>(null);
    const restoreTidyFocus = useRef(false);
    useEffect(() => {
        if (!tidy && restoreTidyFocus.current) {
            restoreTidyFocus.current = false;
            tidyButton.current?.focus();
        }
    }, [tidy]);
    const root = useRootStore();
    const { modal } = useModalContext();
    const read = useProjectWorktrees(projectId);
    const [cleanupRead, setCleanupRead] = useState<ProjectWorktrees>();
    // Hold the preview the person selected from. A background refresh must not replace a selected checkout.
    const { folders, snapshot, failed } = cleanupRead ?? read;
    const { reload } = read;
    useEffect(() => {
        if (tidy && !cleanupRead && read.folders && read.snapshot && !read.failed) setCleanupRead(read);
    }, [tidy, cleanupRead, read]);
    const project = root.projects.find(candidate => candidate.id === projectId);
    const groups = useMemo(
        () => (folders && project ? repositoryGroups(folders, project.folders) : undefined),
        [folders, project]
    );

    const defaults =
        groups && snapshot
            ? new Set(
                  groups.flatMap(({ group }) =>
                      group.worktrees
                          .filter(row => eligible(row, group.folderId, snapshot))
                          .map(row => keyOf(group.folderId, row.path))
                  )
              )
            : new Set<string>();
    const selection = selected ?? defaults;
    const choices = (groups ?? []).flatMap(({ group }) =>
        group.worktrees
            .filter(row => canRemove(row) && selection.has(keyOf(group.folderId, row.path)))
            .map(row => ({
                folderId: group.folderId,
                row,
                safe: !!snapshot && eligible(row, group.folderId, snapshot),
            }))
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

    // Individual worktree changes invalidate any selection made from the frozen cleanup preview.
    const reloadAfterIndividualAction = async () => {
        await reload();
        setTidy(false);
        setCleanupRead(undefined);
        setSelected(undefined);
    };

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
            void openRemoveWorktree({
                root,
                projectId,
                folderId: group.folderId,
                path: worktree.path,
                preview: worktree,
                reload: reloadAfterIndividualAction,
            }),
    };

    return (
        <DialogLayout title="Worktrees">
            <div className={styles.groups}>
                <div className={`${styles.groups} ${styles.worktreeRows}`}>
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
                        {groups && groups.length === 0 && (
                            <PanelEmptyState fill={false} label="No git repositories in this project" />
                        )}
                        <For each={groups ?? []}>
                            {({ group, folder }) => (
                                <WorktreeGroup
                                    key={group.folderId}
                                    projectId={projectId}
                                    group={group}
                                    folder={folder}
                                    onCreate={() =>
                                        openCreateWorktree({
                                            root,
                                            projectId,
                                            folderId: group.folderId,
                                            reload: reloadAfterIndividualAction,
                                        })
                                    }
                                    selection={
                                        tidy
                                            ? {
                                                  isSelected: row => selection.has(keyOf(group.folderId, row.path)),
                                                  onChange: (row, checked) => {
                                                      const next = new Set(selection);
                                                      const key = keyOf(group.folderId, row.path);
                                                      if (checked) next.add(key);
                                                      else next.delete(key);
                                                      setSelected(next);
                                                  },
                                              }
                                            : undefined
                                    }
                                    {...actions}
                                />
                            )}
                        </For>
                    </div>
                </div>
                <div className={styles.footer}>
                    {tidy ? (
                        <>
                            <Button
                                variant="bordered"
                                iconOnly
                                autoFocus
                                aria-label="Back to worktrees"
                                tooltip="Back"
                                onPress={() => {
                                    restoreTidyFocus.current = true;
                                    setTidy(false);
                                    setCleanupRead(undefined);
                                    setSelected(undefined);
                                }}
                            >
                                <ArrowLeft />
                            </Button>
                            <Button
                                color="danger"
                                fullWidth
                                isDisabled={!choices.length || !snapshot || failed}
                                onPress={() => {
                                    if (!snapshot) return;
                                    confirmTidyWorktrees({
                                        root,
                                        project,
                                        projectId,
                                        choices,
                                        snapshot,
                                        reload,
                                        onComplete: () => {
                                            setTidy(false);
                                            setCleanupRead(undefined);
                                            setSelected(undefined);
                                        },
                                    });
                                }}
                            >
                                Remove {choices.length} {choices.length === 1 ? 'worktree' : 'worktrees'}…
                            </Button>
                        </>
                    ) : (
                        <Button
                            ref={tidyButton}
                            color="primary"
                            fullWidth
                            isDisabled={!groups || !snapshot || failed}
                            onPress={() => {
                                setCleanupRead(read);
                                setSelected(defaults);
                                setTidy(true);
                            }}
                        >
                            <Broom />
                            Tidy up…
                        </Button>
                    )}
                </div>
            </div>
        </DialogLayout>
    );
}
