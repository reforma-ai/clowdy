import { Button } from '@clowdy/components/Button';
import { Checkbox } from '@clowdy/components/Checkbox';
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
import { worktreeLabel } from '../agents/workspaceChoice';
import { canRemove } from './confirmTidyWorktrees';
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

interface WorktreeSelection {
    isSelected: (row: WorktreeInfo) => boolean;
    onChange: (row: WorktreeInfo, checked: boolean) => void;
}

interface WorktreeRowProps extends WorktreeRowActions {
    selection?: WorktreeSelection;
    projectId: ProjectId;
    group: FolderWorktrees;
    folder: ProjectFolder;
    worktree: WorktreeInfo;
}

function chatCount(chats: WorktreeChat[]): string {
    const archived = chats.filter(chat => chat.archived).length;
    const active = chats.length - archived;
    return [
        active && `${active} ${active === 1 ? 'chat' : 'chats'}`,
        archived && `${archived} archived ${archived === 1 ? 'chat' : 'chats'}`,
    ]
        .filter(Boolean)
        .join(' + ');
}

function WorktreeChats({ chats, onOpenChat }: { chats: WorktreeChat[]; onOpenChat: (chat: WorktreeChat) => void }) {
    return (
        <MenuTrigger>
            <Button variant="inline" className={styles.chatCount}>
                {chatCount(chats)}
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

/** Branch and facts shared by both modes. */
function WorktreeRowSummary({
    worktree,
    onOpenChat,
}: {
    worktree: WorktreeInfo;
    onOpenChat: (chat: WorktreeChat) => void;
}) {
    const label = worktreeLabel(worktree);
    const path = tildePath(worktree.path, homeFolder.path);
    return (
        <span className={styles.text}>
            <span className={styles.title}>
                <Tooltip content={path} placement="top start" wrapTrigger>
                    <Text variant="md" weight="medium" truncate>
                        {label}
                    </Text>
                </Tooltip>
            </span>
            {(worktree.changes > 0 || worktree.chats.length > 0) && (
                <span className={styles.facts}>
                    {!worktree.missing && worktree.changes > 0 && (
                        <Text variant="sm" color="secondary">
                            {changesLabel(worktree.changes)}
                        </Text>
                    )}
                    {worktree.chats.length > 0 && (
                        <Text as="span" variant="sm" color="secondary" className={styles.chatFact}>
                            <WorktreeChats chats={worktree.chats} onOpenChat={onOpenChat} />
                        </Text>
                    )}
                </span>
            )}
        </span>
    );
}

function WorktreeStatus({ worktree }: { worktree: WorktreeInfo }) {
    const mark = worktreeMark(worktree);
    if (!mark) return null;
    const MarkIcon = worktree.merged ? Merge : MergeCancel;
    return (
        <Badge
            size="xs"
            color={mark.label === 'Merged' ? 'accent' : mark.color}
            textValue={mark.label}
            tooltip={mark.tip}
            icon={
                mark.label === 'Merged' || mark.label === 'Not merged' ? (
                    <MarkIcon className={styles.markIcon} aria-hidden="true" />
                ) : undefined
            }
        >
            {mark.label}
        </Badge>
    );
}

/** One stable row in either management or selection mode. */
export function WorktreeRow({
    projectId,
    group,
    folder,
    worktree,
    onNewChat,
    onOpenChat,
    onRemove,
    selection,
}: WorktreeRowProps) {
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
                data-tidy={selection ? true : undefined}
                {...contextMenu.areaProps}
            >
                <span className={styles.icon}>
                    {selection ? (
                        <Checkbox
                            size="sm"
                            isDisabled={!canRemove(worktree)}
                            isSelected={selection.isSelected(worktree)}
                            aria-label={`Remove ${label}: ${worktree.path}`}
                            onChange={checked => selection.onChange(worktree, checked)}
                        />
                    ) : worktree.main ? (
                        <Folder aria-hidden="true" />
                    ) : (
                        <Version aria-hidden="true" />
                    )}
                </span>
                <WorktreeRowSummary worktree={worktree} onOpenChat={onOpenChat} />
                <span className={styles.trailing}>
                    <span className={styles.mark}>
                        <WorktreeStatus worktree={worktree} />
                    </span>
                    <span className={styles.actions}>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="sm"
                            iconOnly
                            aria-label={`${newChat}: ${label}`}
                            tooltip={worktree.missing ? undefined : newChat}
                            isDisabled={worktree.missing}
                            disabledReason={worktree.missing ? 'Its folder is gone from the disk' : undefined}
                            onPress={() => onNewChat(folder, worktree)}
                        >
                            <NewChat />
                        </Button>
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
    selection,
    ...actions
}: Omit<WorktreeRowProps, 'worktree'> & { onCreate: () => void }) {
    const headingId = useId();

    return (
        <section className={styles.group} aria-labelledby={headingId} data-folder-id={group.folderId}>
            <Text as="h3" id={headingId} variant="heading-5" truncate title={group.name}>
                {group.name}
            </Text>
            {!group.isRepository ? (
                <Text variant="sm" color="secondary">
                    This folder is not a git repository
                </Text>
            ) : (
                <ul className={styles.card}>
                    <For each={group.worktrees}>
                        {worktree => (
                            <WorktreeRow
                                key={worktree.path}
                                projectId={projectId}
                                group={group}
                                folder={folder}
                                worktree={worktree}
                                selection={selection}
                                {...actions}
                            />
                        )}
                    </For>
                    <li>
                        <button type="button" className={styles.add} onClick={onCreate}>
                            <Plus aria-hidden="true" />
                            New worktree
                        </button>
                    </li>
                </ul>
            )}
        </section>
    );
}
