import { Button } from '@clowdy/components/Button';
import { GridListItem, listBoxItemDataShow } from '@clowdy/components/List';
import { Popover, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { toast } from '@clowdy/components/Toast';
import { ChevronDown, ChevronRight, More, NewChat, Split, Version } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { StatusDot } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { BranchPicker } from '../changes/BranchPicker';
import { gitFactsOf } from '../changes/gitFacts';
import { OpenWithMenu, useFolderGit } from '../openWith';
import { worktreeMenuExtras } from '../worktrees/worktreeMenuExtras';
import styles from './AgentList.module.css';
import { samePath, worktreeLabel } from './workspaceChoice';

import type { ChatWorkspace } from '@clowdy/protocol';
import type { DragEvent, SyntheticEvent } from 'react';
import type { ThreadsActivity } from './agentTree';
import type { WorktreeCard } from './worktreeCards';

let previewGeneration = 0;

export function WorktreeCardHeader({
    card,
    collapsed,
    activity,
    showFolder,
    onToggle,
    onDragStart,
    hasDraft = false,
}: {
    card: WorktreeCard;
    collapsed: boolean;
    activity?: ThreadsActivity;
    showFolder: boolean;
    onToggle: () => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    hasDraft?: boolean;
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
    const title = [showFolder ? card.folderName : undefined, card.main ? 'Main worktree' : worktreeLabel(card)]
        .filter(Boolean)
        .join(', ');
    const tooltip = card.pending ? 'Worktree not prepared yet' : card.missing ? 'Worktree no longer exists' : undefined;
    const icon = card.main ? <Version /> : <Split />;
    const stop = (event: SyntheticEvent) => event.stopPropagation();
    return (
        <GridListItem
            id={card.key}
            text={title}
            icon={
                card.roots.length > 0 || hasDraft ? (
                    <span className={styles.foldIcon}>
                        <span className={styles.restIcon} data-show={listBoxItemDataShow.itemRest}>
                            {icon}
                        </span>
                        <span
                            className={styles.fold}
                            data-show={listBoxItemDataShow.itemHover}
                            onClick={stop}
                            onPointerDown={stop}
                            onKeyDown={stop}
                        >
                            <Button
                                variant="filling"
                                color="secondary"
                                size="xs"
                                iconOnly
                                tabIndex={-1}
                                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
                                aria-expanded={!collapsed}
                                preventFocusOnPress
                                onPress={onToggle}
                            >
                                {collapsed ? <ChevronRight /> : <ChevronDown />}
                            </Button>
                        </span>
                    </span>
                ) : (
                    icon
                )
            }
            className={styles.worktreeHeader}
            plateless
            data-missing={card.missing || undefined}
            data-pending={card.pending || undefined}
            data-open={menuOpen || contextMenu.isOpen || undefined}
            onContextMenu={event => {
                event.stopPropagation();
                openingPicker.current = false;
                previewGeneration++;
                closePicker();
                contextMenu.areaProps.onContextMenu(event);
            }}
            endAffix={
                <span className={styles.worktreeActions} onClick={stop} onPointerDown={stop} onKeyDown={stop}>
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
                    <span className={styles.worktreeActionButtons}>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="xs"
                            iconOnly
                            aria-label={`New chat in ${title}`}
                            tooltip={`New chat in ${title}`}
                            isDisabled={card.missing || card.pending || card.workspace?.ready === false}
                            preventFocusOnPress
                            onPress={newChat}
                        >
                            <NewChat />
                        </Button>
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
                            <Button
                                variant="filling"
                                color="secondary"
                                size="xs"
                                iconOnly
                                aria-label={`Worktree actions: ${title}`}
                                preventFocusOnPress
                            >
                                <More />
                            </Button>
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
                </span>
            }
        >
            <span className={styles.worktreeTitle}>
                <span className={styles.title} draggable onDragStart={onDragStart} title={tooltip}>
                    {title}
                </span>
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
            </span>
        </GridListItem>
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
