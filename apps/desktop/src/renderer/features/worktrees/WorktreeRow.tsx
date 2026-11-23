import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Folder, More, NewChat, Version } from '@clowdy/icons/14';
import { useId } from 'react';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { Unavailable } from '../../shared/Unavailable';
import { worktreeLabel } from '../agents/workspaceChoice';
import styles from './ManageWorktrees.module.css';
import { WorktreeMenu } from './WorktreeMenu';
import { changesLabel, lockTip, mergedMark } from './worktreeView';

import type { FolderWorktrees, ProjectFolder, ProjectId, WorktreeChat, WorktreeInfo } from '@clowdy/protocol';

/** What a row asks its dialog to do: the dialog closes itself for the ones that leave it. */
export interface WorktreeRowActions {
    /** A new-chat draft in the worktree, or in the folder's own checkout for the first row of a group. */
    onNewChat: (folder: ProjectFolder, worktree: WorktreeInfo) => void;
    onOpenChat: (chat: WorktreeChat) => void;
    /** Remove: asks first, and what it asks follows the worktree. Never called for the folder's own checkout, or while the daemon gives a reason against it (`blocked`). */
    onRemove: (group: FolderWorktrees, worktree: WorktreeInfo) => void;
}

interface WorktreeRowProps extends WorktreeRowActions {
    projectId: ProjectId;
    group: FolderWorktrees;
    folder: ProjectFolder;
    worktree: WorktreeInfo;
}

/**
 * One worktree of a folder, as git lists it: its branch (or the commit it is on), the marks that matter (the folder's own checkout, locked, gone from the disk), how
 * many files are changed and whether its work is in the base, and the chats that work in it, archived ones too, each a button that opens it. At the end: a new
 * chat in it, and More (`WorktreeMenu`: the same new chat, the copy of the path, the programs that open it, and Remove, which the folder's own checkout does not have). A
 * worktree whose folder is gone has no chat to start in it.
 *
 * Sizes are the app's list row, as `ProjectRow` has it: the title is body (`md`) medium, the facts `sm` and dim, the marks `xs`; a bare `Text` would take the page's 16px,
 * which this window shows far larger than the lists around it. The branch is one line cut with an ellipsis, so it never pushes the actions. The path is not a line of the
 * row: it is the tooltip of the branch (in the home folder's `~` form), and the reason a Remove is off (`removeHint`) is the line under it in the menu.
 */
export function WorktreeRow({ projectId, group, folder, worktree, onNewChat, onOpenChat, onRemove }: WorktreeRowProps) {
    const label = worktreeLabel(worktree);
    const merged = mergedMark(worktree);
    const newChat = worktree.main ? 'New chat in this folder' : 'New chat in this worktree';

    return (
        <li className={ styles.row } data-worktree-path={ worktree.path } data-main={ worktree.main || undefined } data-missing={ worktree.missing || undefined }>
            <span className={ styles.icon }>{ worktree.main ? <Folder aria-hidden="true" /> : <Version aria-hidden="true" /> }</span>
            <span className={ styles.text }>
                <span className={ styles.title }>
                    <Tooltip content={ tildePath(worktree.path, homeFolder.path) } placement="top start" wrapTrigger>
                        <Text variant="md" weight="medium" truncate>{ label }</Text>
                    </Tooltip>
                    { worktree.main && <Badge size="xs" textValue="Project checkout" tooltip="The folder itself, where a chat works without a worktree">Project checkout</Badge> }
                    { worktree.locked !== undefined && <Badge size="xs" textValue="Locked" tooltip={ lockTip(worktree.locked) }>Locked</Badge> }
                    { worktree.missing && <Badge size="xs" color="warning" textValue="Missing on disk" tooltip="Git lists it, but its folder is gone">Missing on disk</Badge> }
                </span>
                <span className={ styles.facts }>
                    { !worktree.missing && <Text variant="sm" color={ worktree.changes === 0 ? 'secondary' : 'default' }>{ changesLabel(worktree.changes) }</Text> }
                    { merged && <Badge size="xs" color={ merged.color } textValue={ merged.label } tooltip={ merged.tip }>{ merged.label }</Badge> }
                </span>
                { worktree.chats.length > 0 && (
                    <span className={ styles.chats } role="group" aria-label="Chats">
                        <For each={ worktree.chats }>
                            {chat => (
                                <Button key={ chat.id } variant="filling" color="secondary" size="xs" truncate className={ styles.chat } onPress={ () => onOpenChat(chat) }>
                                    <span className={ styles.chatTitle }>{ chat.title }</span>
                                    { chat.archived && <span className={ styles.archived }>Archived</span> }
                                </Button>
                            )}
                        </For>
                    </span>
                ) }
            </span>
            <span className={ styles.actions }>
                <Unavailable label={ `${ newChat }: ${ label }` } hint={ worktree.missing ? 'Its folder is gone from the disk' : undefined } placement="top">
                    <Button variant="filling" color="secondary" size="sm" iconOnly aria-label={ `${ newChat }: ${ label }` } tooltip={ worktree.missing ? undefined : newChat } isDisabled={ worktree.missing } onPress={ () => onNewChat(folder, worktree) }>
                        <NewChat />
                    </Button>
                </Unavailable>
                <MenuTrigger>
                    <Button variant="filling" color="secondary" size="sm" iconOnly aria-label={ `More for ${ label }` } tooltip="More">
                        <More />
                    </Button>
                    <Popover placement="bottom end" spacing="xs" width={ 260 }>
                        <WorktreeMenu projectId={ projectId } group={ group } folder={ folder } worktree={ worktree } onNewChat={ onNewChat } onRemove={ onRemove } />
                    </Popover>
                </MenuTrigger>
            </span>
        </li>
    );
}

/** One folder of the project: its name, and its worktrees in a card, the folder's own checkout first. */
export function WorktreeGroup({ projectId, group, folder, ...actions }: Omit<WorktreeRowProps, 'worktree'>) {
    const headingId = useId();

    return (
        <section className={ styles.group } aria-labelledby={ headingId } data-folder-id={ group.folderId }>
            <Text as="h3" id={ headingId } variant="heading-5" truncate title={ group.name }>{ group.name }</Text>
            <ul className={ styles.card }>
                <For each={ group.worktrees }>
                    {worktree => <WorktreeRow key={ worktree.path } projectId={ projectId } group={ group } folder={ folder } worktree={ worktree } { ...actions } />}
                </For>
            </ul>
        </section>
    );
}
