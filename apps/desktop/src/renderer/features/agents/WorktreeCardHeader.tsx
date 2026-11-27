import { RowActionButton, RowControls } from '@clowdy/components/List';
import { Popover, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { toast } from '@clowdy/components/Toast';
import { More, NewChat, Split, Version } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { StatusDot } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { BranchPicker } from '../changes/BranchPicker';
import { gitFactsOf } from '../changes/gitFacts';
import { OpenWithMenu, useFolderGit } from '../openWith';
import { worktreeMenuExtras } from '../worktrees/worktreeMenuExtras';
import styles from './AgentList.module.css';
import { GroupFolderName } from './GroupFolderName';
import { GroupHeader } from './GroupHeader';
import { samePath, worktreeLabel } from './workspaceChoice';

import type { ChatWorkspace } from '@clowdy/protocol';
import type { DragEvent, MouseEvent, ReactNode } from 'react';
import type { ThreadsActivity } from './agentTree';
import type { WorktreeCard } from './worktreeCards';

let previewGeneration = 0;

export function WorktreeCardHeader({
    card,
    pullRequestStatus,
    collapsed,
    activity,
    onToggle,
    onDragStart,
}: {
    card: WorktreeCard;
    pullRequestStatus?: ReactNode;
    collapsed: boolean;
    activity?: ThreadsActivity;
    onToggle: () => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
}) {
    const project = useProjectState();
    const ui = useProjectUi();
    const [menuOpen, setMenuOpen] = useState(false);
    const contextMenu = useContextMenu();
    useEffect(() => contextMenu.close, [contextMenu.close]);
    const [switchWorkspace, setSwitchWorkspace] = useState<ChatWorkspace>();
    const request = useRef(0);
    const openingPicker = useRef(false);
    const beginPreview = useCallback(() => {
        const current = ++previewGeneration;
        return () => current === previewGeneration;
    }, []);
    const closePicker = useCallback(() => {
        request.current++;
        setMenuOpen(false);
        setSwitchWorkspace(undefined);
    }, []);
    useEffect(
        () => () => {
            request.current++;
            previewGeneration++;
        },
        [card.path, card.folder.id, project.id]
    );
    const root = useRootStore();
    const switchBranch = async (fromContext = false) => {
        if (card.missing || card.pending || card.workspace?.ready === false) return;
        openingPicker.current = !fromContext;
        const current = ++request.current;
        const result = await root.command({
            type: 'workspace.open',
            projectId: project.id,
            folderId: card.folder.id,
            path: card.path,
        });
        if (current !== request.current) return;
        if (!result.ok) {
            toast.error({ message: result.error.message });
            return;
        }
        const { workspace } = result.data as { workspace: ChatWorkspace };
        if (!workspace?.ready) {
            toast.error({ message: 'Worktree not prepared yet' });
            return;
        }
        setSwitchWorkspace(workspace);
    };
    const newChat = () =>
        ui.openDraft(
            [],
            card.folder.id === mainFolder(project.project).id ? null : card.folder.id,
            card.main ? null : { mode: 'existing', path: card.path }
        );
    const title = card.main ? card.folderName : `${card.folderName}/${worktreeLabel(card)}`;
    const tooltip = card.pending ? 'Worktree not prepared yet' : card.missing ? 'Worktree no longer exists' : undefined;
    const openContextMenu = (event: MouseEvent) => {
        event.stopPropagation();
        openingPicker.current = false;
        previewGeneration++;
        closePicker();
        contextMenu.areaProps.onContextMenu(event);
    };
    return (
        <GroupHeader
            id={card.key}
            text={title}
            collapsed={collapsed}
            onToggle={onToggle}
            name={
                card.main ? (
                    <GroupFolderName name={title} folder={card.folder} missing={card.missing} onNewChat={newChat} />
                ) : (
                    <span
                        className={styles.worktreeTitle}
                        draggable
                        onDragStart={onDragStart}
                        onContextMenu={openContextMenu}
                        title={tooltip}
                    >
                        <Split aria-hidden="true" />
                        <span className={styles.title}>{title}</span>
                    </span>
                )
            }
            className={styles.worktreeHeader}
            data-missing={card.missing || undefined}
            data-pending={card.pending || undefined}
            data-open={menuOpen || contextMenu.isOpen || undefined}
            onContextMenu={openContextMenu}
            endAffix={
                <RowControls className={styles.worktreeActions}>
                    {contextMenu.isOpen && (
                        <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
                            <WorktreeCardMenu
                                card={card}
                                onClose={contextMenu.close}
                                onNewChat={newChat}
                                onSwitch={() => {
                                    setMenuOpen(true);
                                    void switchBranch(true);
                                }}
                            />
                        </Popover>
                    )}
                    {collapsed && activity && (
                        <span
                            className={styles.worktreeStatus}
                            role="img"
                            aria-label={activity === 'asking' ? 'Chats waiting for you' : 'Chats working'}
                        >
                            <StatusDot
                                className={styles.worktreeStatusDot}
                                tone={activity === 'asking' ? 'accent' : 'success'}
                            />
                        </span>
                    )}
                    {pullRequestStatus}
                    <span className={styles.worktreeActionButtons}>
                        <RowActionButton
                            icon={<NewChat />}
                            label={`New chat in ${title}`}
                            isDisabled={card.missing || card.pending || card.workspace?.ready === false}
                            onPress={newChat}
                        />
                        <PopoverTrigger
                            isOpen={menuOpen}
                            onOpenChange={open => {
                                if (open) {
                                    previewGeneration++;
                                    setMenuOpen(true);
                                } else if (openingPicker.current) {
                                    openingPicker.current = false;
                                } else closePicker();
                            }}
                        >
                            <RowActionButton icon={<More />} label={`Worktree actions: ${title}`} tooltip={null} />
                            <Popover
                                placement="bottom end"
                                spacing="xs"
                                width={switchWorkspace ? 288 : undefined}
                                shouldCloseOnInteractOutside={element => !element.closest('[data-branch-context-menu]')}
                            >
                                {switchWorkspace ? (
                                    <WorktreeBranchPicker
                                        projectId={project.id}
                                        workspace={switchWorkspace}
                                        label={title}
                                        onClose={closePicker}
                                        beginPreview={beginPreview}
                                    />
                                ) : (
                                    <WorktreeCardMenu
                                        card={card}
                                        onNewChat={newChat}
                                        onSwitch={() => void switchBranch()}
                                    />
                                )}
                            </Popover>
                        </PopoverTrigger>
                    </span>
                </RowControls>
            }
        />
    );
}

/** Shared path menu with guarded worktree actions. */
function WorktreeCardMenu({
    card,
    onNewChat,
    onSwitch,
    onClose,
}: {
    card: WorktreeCard;
    onNewChat: () => void;
    onSwitch: () => void;
    onClose?: () => void;
}) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const folderGit = useFolderGit(project.id, card.folder.id);
    // OpenWithMenu only offers in-app Files/Terminal when the target's workspace ID equals the current
    // place. A never-opened external tree has no record: the card key is only a nonmatching identity,
    // never a workspace ID sent to the daemon. A real draft row or recorded workspace can be opened here.
    const draft = ui.draftWorkspaceRow;
    const workspace = card.workspace ??
        (draft && draft.folderId === card.folder.id && samePath(draft.path, card.path) ? draft : undefined) ?? {
            id: card.actual?.workspaceId ?? card.key,
            folderId: card.folder.id,
            path: card.path,
            branch: card.branch,
            managed: card.actual?.managed ?? false,
            ready: !card.pending,
        };
    const git = { remoteUrl: folderGit?.remoteUrl, branch: card.branch, detached: card.branch === undefined };
    return (
        <OpenWithMenu
            target={{
                projectId: project.id,
                folder: card.folder,
                path: card.path,
                relative: '',
                kind: 'directory',
                workspace: card.main ? undefined : workspace,
            }}
            missing={card.missing}
            notReady={card.pending}
            git={git}
            onNewChat={onNewChat}
            onClose={onClose}
            extra={[
                ...(!card.main && !card.missing && !card.pending && card.workspace?.ready !== false
                    ? [
                          {
                              id: 'switch-branch',
                              label: 'Switch branch',
                              icon: <Version aria-hidden="true" />,
                              run: onSwitch,
                          },
                      ]
                    : []),
                ...(!card.main && !card.pending
                    ? worktreeMenuExtras({
                          root,
                          projectId: project.id,
                          folderId: card.folder.id,
                          path: card.path,
                          workspaceId: card.actual?.workspaceId ?? card.workspace?.id,
                          preview: card.actual,
                          previewLabel: card.branch,
                      })
                    : []),
            ]}
            aria-label="Worktree actions"
        />
    );
}

function WorktreeBranchPicker({
    projectId,
    workspace,
    label,
    onClose,
    beginPreview,
}: {
    projectId: string;
    workspace: ChatWorkspace;
    label: string;
    onClose: () => void;
    beginPreview: () => () => boolean;
}) {
    const { transport } = useRootStore();
    const store = gitFactsOf(transport);
    const key = { projectId, folderId: workspace.folderId, workspaceId: workspace.id };
    const facts = store.of(key);
    useEffect(() => store.observe(key), [store, projectId, workspace.folderId, workspace.id]);
    return <BranchPicker facts={facts} label={label} embeddedClose={onClose} beginPreview={beginPreview} />;
}
