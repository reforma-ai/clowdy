import { Button } from '@clowdy/components/Button';
import { GridListItem } from '@clowdy/components/List';
import { Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, More, Split } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { StatusDot } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { OpenWithMenu, useFolderGit } from '../openWith';
import { worktreeMenuExtras } from '../worktrees/worktreeMenuExtras';
import styles from './AgentList.module.css';
import { samePath, worktreeLabel } from './workspaceChoice';

import type { DragEvent, SyntheticEvent } from 'react';
import type { ThreadsActivity } from './agentTree';
import type { WorktreeCard } from './worktreeCards';

interface MoveActions {
    onMoveUp?: () => void;
    onMoveDown?: () => void;
}

export function WorktreeCardHeader({
    card,
    collapsed,
    activity,
    showFolder,
    onToggle,
    onDragStart,
    move,
}: {
    card: WorktreeCard;
    collapsed: boolean;
    activity?: ThreadsActivity;
    showFolder: boolean;
    onToggle: () => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    move: MoveActions;
}) {
    const title = [showFolder ? card.folderName : undefined, worktreeLabel(card)].filter(Boolean).join(', ');
    const tooltip = [
        card.path,
        card.pending ? 'Worktree not prepared yet' : card.missing ? 'Worktree no longer exists' : undefined,
        card.used && card.roots.length === 0 ? 'Chats are listed under their parent' : undefined,
    ]
        .filter(Boolean)
        .join('\n');
    const stop = (event: SyntheticEvent) => event.stopPropagation();
    return (
        <GridListItem
            id={card.key}
            text={title}
            icon={<Split />}
            className={styles.worktreeHeader}
            plateless
            data-missing={card.missing || undefined}
            data-pending={card.pending || undefined}
            endAffix={
                <span className={styles.worktreeActions} onClick={stop} onPointerDown={stop} onKeyDown={stop}>
                    {activity && (
                        <span role="img" aria-label={activity === 'asking' ? 'Chats waiting for you' : 'Chats working'}>
                            <StatusDot tone={activity === 'asking' ? 'accent' : 'success'} />
                        </span>
                    )}
                    <PopoverTrigger>
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
                            <WorktreeCardMenu card={card} move={move} />
                        </Popover>
                    </PopoverTrigger>
                </span>
            }
        >
            <span className={styles.worktreeTitle}>
                <span className={styles.title} draggable onDragStart={onDragStart} title={tooltip}>
                    {title}
                </span>
                {card.roots.length > 0 && (
                    <span onPointerDown={stop} onKeyDown={stop} onClick={stop}>
                        <Button
                            variant="filling"
                            color="secondary"
                            iconOnly
                            size="xs"
                            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
                            aria-expanded={!collapsed}
                            preventFocusOnPress
                            onPress={onToggle}
                        >
                            {collapsed ? <ChevronRight /> : <ChevronDown />}
                        </Button>
                    </span>
                )}
            </span>
        </GridListItem>
    );
}

/** Shared path menu with card-specific ordering and guarded worktree actions. */
function WorktreeCardMenu({ card, move }: { card: WorktreeCard; move: MoveActions }) {
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
            onNewChat={() =>
                ui.openDraft([], card.folder.id === mainFolder(project.project).id ? null : card.folder.id, {
                    mode: 'existing',
                    path: card.path,
                })
            }
            extra={[
                ...(move.onMoveUp ? [{ id: 'move-up', label: 'Move up', icon: <ArrowUp />, run: move.onMoveUp }] : []),
                ...(move.onMoveDown
                    ? [{ id: 'move-down', label: 'Move down', icon: <ArrowDown />, run: move.onMoveDown }]
                    : []),
                ...(!card.pending
                    ? worktreeMenuExtras(
                          {
                              root,
                              projectId: project.id,
                              folderId: card.folder.id,
                              path: card.path,
                              workspaceId: card.actual?.workspaceId ?? card.workspace?.id,
                          },
                          card.used
                      )
                    : []),
            ]}
            aria-label="Worktree actions"
        />
    );
}
