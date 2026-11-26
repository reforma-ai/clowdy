import { Button } from '@clowdy/components/Button';
import { GridListItem, listBoxItemDataShow } from '@clowdy/components/List';
import { Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { ChevronDown, ChevronRight, More, NewChat, Split } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';
import { useState } from 'react';

import { StatusDot } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { OpenWithMenu, useFolderGit } from '../openWith';
import { worktreeMenuExtras } from '../worktrees/worktreeMenuExtras';
import styles from './AgentList.module.css';
import { samePath, worktreeLabel } from './workspaceChoice';

import type { DragEvent, SyntheticEvent } from 'react';
import type { ThreadsActivity } from './agentTree';
import type { WorktreeCard } from './worktreeCards';

export function WorktreeCardHeader({
    card,
    collapsed,
    activity,
    showFolder,
    onToggle,
    onDragStart,
}: {
    card: WorktreeCard;
    collapsed: boolean;
    activity?: ThreadsActivity;
    showFolder: boolean;
    onToggle: () => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
}) {
    const project = useProjectState();
    const ui = useProjectUi();
    const [menuOpen, setMenuOpen] = useState(false);
    const newChat = () =>
        ui.openDraft([], card.folder.id === mainFolder(project.project).id ? null : card.folder.id, {
            mode: 'existing',
            path: card.path,
        });
    const title = [showFolder ? card.folderName : undefined, worktreeLabel(card)].filter(Boolean).join(', ');
    const tooltip = card.pending ? 'Worktree not prepared yet' : card.missing ? 'Worktree no longer exists' : undefined;
    const stop = (event: SyntheticEvent) => event.stopPropagation();
    return (
        <GridListItem
            id={card.key}
            text={title}
            icon={
                card.roots.length > 0 ? (
                    <span className={styles.foldIcon}>
                        <span className={styles.restIcon} data-show={listBoxItemDataShow.itemRest}>
                            <Split />
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
                    <Split />
                )
            }
            className={styles.worktreeHeader}
            plateless
            data-missing={card.missing || undefined}
            data-pending={card.pending || undefined}
            data-open={menuOpen || undefined}
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
                        <PopoverTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
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
                            <Popover placement="bottom end" spacing="xs">
                                <WorktreeCardMenu card={card} onNewChat={newChat} />
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
            </span>
        </GridListItem>
    );
}

/** Shared path menu with guarded worktree actions. */
function WorktreeCardMenu({ card, onNewChat }: { card: WorktreeCard; onNewChat: () => void }) {
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
                workspace,
            }}
            missing={card.missing || card.pending}
            git={git}
            onNewChat={onNewChat}
            extra={[
                ...(!card.pending
                    ? worktreeMenuExtras({
                          root,
                          projectId: project.id,
                          folderId: card.folder.id,
                          path: card.path,
                          workspaceId: card.actual?.workspaceId ?? card.workspace?.id,
                      })
                    : []),
            ]}
            aria-label="Worktree actions"
        />
    );
}
