import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Folder, Merge, MergeCancel, More, NewChat, Plus, Version } from '@clowdy/icons/14';
import { useId, useState } from 'react';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { Unavailable } from '../../shared/Unavailable';
import { worktreeLabel } from '../agents/workspaceChoice';
import styles from './ManageWorktrees.module.css';
import { WorktreeMenu } from './WorktreeMenu';
import { changesLabel, worktreeMark } from './worktreeView';

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

function WorktreeChats({ chats, onOpenChat }: { chats: WorktreeChat[]; onOpenChat: (chat: WorktreeChat) => void }) {
    const count = chats.length;

    return (
        <MenuTrigger>
            <Button variant="inline" className={styles.chatCount}>
                {`${count} ${count === 1 ? 'chat' : 'chats'}`}
            </Button>
            <Popover placement="bottom start" spacing="xs" width={280}>
                <PopoverScroll maxHeight={280}>
                    <Menu aria-label="Chats in this worktree" size="sm">
                        <For each={chats}>
                            {chat => (
                                <MenuItem
                                    key={chat.id}
                                    id={chat.id}
                                    textValue={chat.title}
                                    description={chat.archived ? 'Archived' : undefined}
                                    stacked={chat.archived}
                                    onAction={() => onOpenChat(chat)}
                                >
                                    {chat.title}
                                </MenuItem>
                            )}
                        </For>
                    </Menu>
                </PopoverScroll>
            </Popover>
        </MenuTrigger>
    );
}

/** Shared branch, status and facts for the folder settings list and the cleanup preview. */
export function WorktreeRowSummary({
    worktree,
    onOpenChat,
    tidy = false,
}: {
    worktree: WorktreeInfo;
    onOpenChat?: (chat: WorktreeChat) => void;
    tidy?: boolean;
}) {
    const label = worktreeLabel(worktree);
    const mark = worktreeMark(worktree);
    const path = tildePath(worktree.path, homeFolder.path);
    const title = (
        <Text variant="md" weight="medium" truncate title={onOpenChat ? undefined : path}>
            {label}
        </Text>
    );

    const MarkIcon = worktree.merged ? Merge : MergeCancel;
    const badge = mark && (
        <Badge
            size="xs"
            color={tidy && mark.label === 'Merged' ? 'accent' : mark.color}
            textValue={mark.label}
            tooltip={tidy ? undefined : mark.tip}
            icon={tidy ? <MarkIcon className={styles.tidyMarkIcon} aria-hidden="true" /> : undefined}
        >
            {mark.label}
        </Badge>
    );

    return (
        <>
            {!tidy && (
                <span className={styles.icon}>
                    {worktree.main ? <Folder aria-hidden="true" /> : <Version aria-hidden="true" />}
                </span>
            )}
            <span className={styles.text}>
                <span className={styles.title}>
                    {onOpenChat ? (
                        <Tooltip content={path} placement="top start" wrapTrigger>
                            {title}
                        </Tooltip>
                    ) : (
                        title
                    )}
                    {!tidy && badge}
                </span>
                {(!tidy || worktree.changes > 0 || worktree.chats.length > 0) && (
                    <span className={styles.facts}>
                        {!worktree.missing && (!tidy || worktree.changes > 0) && (
                            <Text variant="sm" color="secondary">
                                {changesLabel(worktree.changes)}
                            </Text>
                        )}
                        {worktree.chats.length > 0 && (
                            <Text as="span" variant="sm" color="secondary" className={styles.chatFact}>
                                {onOpenChat ? (
                                    <WorktreeChats chats={worktree.chats} onOpenChat={onOpenChat} />
                                ) : (
                                    `${worktree.chats.length} ${worktree.chats.length === 1 ? 'chat' : 'chats'}`
                                )}
                            </Text>
                        )}
                    </span>
                )}
            </span>
            {tidy && <span className={styles.tidyMark}>{badge}</span>}
        </>
    );
}

/**
 * One worktree of a folder, as git lists it: its branch (or the commit it is on), the one badge that matters most (`worktreeMark`: the folder's own checkout, gone from the disk, locked, or whether its work is in the base), how
 * many files are changed, and a count of chats with a menu for opening them. At the end: a new
 * chat in it, and More (`WorktreeMenu`: the same new chat, the copy of the path, the programs that open it, and Remove, which the folder's own checkout does not have). A
 * worktree whose folder is gone has no chat to start in it.
 *
 * Sizes are the app's list row, as `ProjectRow` has it: the title is body (`md`) medium, the facts `sm` and dim, the marks `xs`; a bare `Text` would take the page's 16px,
 * which this window shows far larger than the lists around it. The branch is one line cut with an ellipsis, so it never pushes the actions. The path is not a line of the
 * row: it is the tooltip of the branch (in the home folder's `~` form), and the reason a Remove is off (`removeHint`) is the line under it in the menu. A right-click anywhere on
 * the row opens the same menu at the pointer (and a long touch, which is a right-click to the app), so the strip is as good as the button. The buttons show on hover, on focus
 * inside the row and while its actions menu is open, and always on a touch screen.
 */
export function WorktreeRow({ projectId, group, folder, worktree, onNewChat, onOpenChat, onRemove }: WorktreeRowProps) {
    const label = worktreeLabel(worktree);
    const newChat = worktree.main ? 'New chat in this folder' : 'New chat in this worktree';
    const contextMenu = useContextMenu();
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    return (
        <>
            <li
                className={styles.row}
                data-worktree-path={worktree.path}
                data-main={worktree.main || undefined}
                data-missing={worktree.missing || undefined}
                data-open={isMenuOpen || contextMenu.isOpen || undefined}
                {...contextMenu.areaProps}
            >
                <WorktreeRowSummary worktree={worktree} onOpenChat={onOpenChat} />
                <span className={styles.actions}>
                    <Unavailable
                        label={`${newChat}: ${label}`}
                        hint={worktree.missing ? 'Its folder is gone from the disk' : undefined}
                        placement="top"
                    >
                        <Button
                            variant="filling"
                            color="secondary"
                            size="sm"
                            iconOnly
                            aria-label={`${newChat}: ${label}`}
                            tooltip={worktree.missing ? undefined : newChat}
                            isDisabled={worktree.missing}
                            onPress={() => onNewChat(folder, worktree)}
                        >
                            <NewChat />
                        </Button>
                    </Unavailable>
                    <MenuTrigger isOpen={isMenuOpen} onOpenChange={setIsMenuOpen}>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="sm"
                            iconOnly
                            aria-label={`More for ${label}`}
                            tooltip="More"
                        >
                            <More />
                        </Button>
                        <Popover placement="bottom end" spacing="xs" width={260}>
                            <WorktreeMenu
                                projectId={projectId}
                                group={group}
                                folder={folder}
                                worktree={worktree}
                                onNewChat={onNewChat}
                                onRemove={onRemove}
                            />
                        </Popover>
                    </MenuTrigger>
                </span>
            </li>
            <Show when={contextMenu.isOpen}>
                <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs" width={260}>
                    <WorktreeMenu
                        projectId={projectId}
                        group={group}
                        folder={folder}
                        worktree={worktree}
                        onNewChat={onNewChat}
                        onRemove={onRemove}
                        onClose={contextMenu.close}
                    />
                </Popover>
            </Show>
        </>
    );
}

/** One folder of the project: its name, and its worktrees in a card, the folder's own checkout first. */
export function WorktreeGroup({
    projectId,
    group,
    folder,
    onCreate,
    createDisabled = false,
    ...actions
}: Omit<WorktreeRowProps, 'worktree'> & { onCreate: () => void; createDisabled?: boolean }) {
    const headingId = useId();

    return (
        <section className={styles.group} aria-labelledby={headingId} data-folder-id={group.folderId}>
            <Text as="h3" id={headingId} variant="heading-5" truncate title={group.name}>
                {group.name}
            </Text>
            <ul className={styles.card}>
                <For each={group.worktrees}>
                    {worktree => (
                        <WorktreeRow
                            key={worktree.path}
                            projectId={projectId}
                            group={group}
                            folder={folder}
                            worktree={worktree}
                            {...actions}
                        />
                    )}
                </For>
                <li>
                    <button type="button" className={styles.add} onClick={onCreate} disabled={createDisabled}>
                        <Plus aria-hidden="true" />
                        New worktree
                    </button>
                </li>
            </ul>
        </section>
    );
}
