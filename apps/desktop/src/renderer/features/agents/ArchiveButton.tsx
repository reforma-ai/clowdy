import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import {
    GridList,
    GridListHeader,
    GridListItem,
    GridListSection,
    listBoxItemDataShow,
    Menu,
    MenuItem,
    MenuSeparator,
    RowActionButton,
    RowControls,
} from '@clowdy/components/List';
import { Popover, PopoverScroll, PopoverTrigger } from '@clowdy/components/Popover';
import { Separator } from '@clowdy/components/Separator';
import { Text } from '@clowdy/components/Text';
import { Archive, More, Search, Trash } from '@clowdy/icons/14';
import { History } from '@clowdy/icons/16';
import { type RefObject, useRef, useState } from 'react';

import { formatElapsed } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { bringBack, openChat, unarchiveChat } from '../chats/archiveChat';
import { deleteChat } from '../chats/deleteChat';
import styles from './ArchiveButton.module.css';
import { archivedChats, archiveGroups, orchestratorOf } from './agentTree';
import { ChatIcon } from './ChatIcon';

import type { Chat, ChatId } from '@clowdy/protocol';

/** The width of the list: the project menu's, wider than the column, where titles were cut short. */
const LIST_WIDTH = 280;

/**
 * The archive, in the heading beside the filters: a button (the history mark) that drops down the chats that were put away, the last one first, each with how long
 * ago and a `⋯` with Unarchive and Delete. Picking a row brings the chat back into the list and opens it, so a chat is either in the list or here,
 * never both. Threads put away with their parent are part of its entry and have none of their own (`archivedChats`); a thread put away alone has one.
 * The chats are in groups by the day they were put away (`archiveGroups`): today, yesterday, the last 7 days, older. The list opens under the `anchor`, the heading, as close
 * to the button as the filters' menu is, and is wider than the column: a title and a time in a row need more room than the column gives.
 */
export function ArchiveButton({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
    const project = useProjectState();
    const [isOpen, setIsOpen] = useState(false);
    const archived = archivedChats(project.chatList);

    return (
        <PopoverTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
            <Button variant="filling" color="secondary" size="sm" iconOnly aria-label="History" tooltip="History">
                <History />
            </Button>
            <Popover triggerRef={anchor} placement="bottom start" spacing="xs" width={LIST_WIDTH}>
                <ArchiveList chats={archived} onClose={() => setIsOpen(false)} />
            </Popover>
        </PopoverTrigger>
    );
}

/** The worktree archive includes every archived thread, even when its parent is archived elsewhere. */
export function WorktreeArchiveButton({
    chats,
    label,
    isOpen,
    onOpenChange,
}: {
    chats: (Chat & { archivedAt: number })[];
    label: string;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const rowRef = useRef<HTMLElement | null>(null);

    return (
        <PopoverTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
            <Button
                ref={element => {
                    rowRef.current = element?.closest('[role="row"]') ?? null;
                }}
                variant="transparent"
                size="unset"
                className={styles.trigger}
                contentClassName={styles.triggerContent}
            >
                <span className={styles.triggerLabel}>{label}</span>
            </Button>
            <Popover triggerRef={rowRef} placement="bottom start" spacing="xs" width={LIST_WIDTH}>
                <ArchiveList chats={chats} onClose={() => onOpenChange(false)} showContext />
            </Popover>
        </PopoverTrigger>
    );
}

function ArchiveList({
    chats,
    onClose,
    showContext = false,
}: {
    chats: (Chat & { archivedAt: number })[];
    onClose: () => void;
    showContext?: boolean;
}) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [menuOpenId, setMenuOpenId] = useState<ChatId | null>(null);
    const [query, setQuery] = useState('');
    const now = Date.now();
    const filter = query.trim().toLocaleLowerCase();
    const matches = chats.filter(chat => {
        const parent = showContext && chat.parentChatId ? project.chats.get(chat.parentChatId) : undefined;
        return (
            chat.title.toLocaleLowerCase().includes(filter) ||
            (parent?.title.toLocaleLowerCase().includes(filter) ?? false)
        );
    });
    const groups = archiveGroups(matches, now);

    return (
        <>
            <Input
                type="text"
                size="sm"
                variant="inline"
                className={styles.search}
                aria-label="Search archived chats"
                placeholder="Search chats"
                value={query}
                onChange={setQuery}
            >
                <Search slot="prefix" aria-hidden size={14} />
            </Input>
            <Separator spacing="xs" />
            {chats.length === 0 ? (
                <Text variant="sm" color="secondary" className={styles.empty}>
                    No archived chats
                </Text>
            ) : matches.length === 0 ? (
                <Text variant="sm" color="secondary" className={styles.empty}>
                    No matching chats
                </Text>
            ) : (
                <PopoverScroll maxHeight={360}>
                    <GridList
                        aria-label="Archived chats"
                        size="sm"
                        onAction={key => {
                            onClose();
                            void openChat(root, project, ui, String(key));
                        }}
                    >
                        {groups.map(group => (
                            <GridListSection key={group.id} aria-label={group.title}>
                                <GridListHeader>{group.title}</GridListHeader>
                                {group.chats.map(chat => {
                                    const run = orchestratorOf(chat, project.runs);
                                    const parent = chat.parentChatId ? project.chats.get(chat.parentChatId) : undefined;
                                    const title =
                                        showContext && chat.parentChatId
                                            ? `${chat.title} — thread in ${parent?.title ?? 'another chat'}`
                                            : chat.title;

                                    return (
                                        <GridListItem
                                            key={chat.id}
                                            id={chat.id}
                                            text={title}
                                            data-open={menuOpenId === chat.id || undefined}
                                            icon={
                                                <ChatIcon chat={chat} run={run} unread={ui.hasUnreadCompletion(run)} />
                                            }
                                            endAffix={
                                                <ArchivedEnd
                                                    chat={chat}
                                                    isOpen={menuOpenId === chat.id}
                                                    onOpenChange={open => setMenuOpenId(open ? chat.id : null)}
                                                    ago={formatElapsed(now - chat.archivedAt)}
                                                    onUnarchive={() =>
                                                        void (showContext
                                                            ? bringBack(root, project, chat)
                                                            : unarchiveChat(root, chat))
                                                    }
                                                    onDelete={() => {
                                                        onClose();
                                                        deleteChat(
                                                            root,
                                                            chat,
                                                            run !== undefined,
                                                            project.threadsBelow(chat.id).length
                                                        );
                                                    }}
                                                />
                                            }
                                        >
                                            <span className={styles.title} title={title}>
                                                {title}
                                            </span>
                                        </GridListItem>
                                    );
                                })}
                            </GridListSection>
                        ))}
                    </GridList>
                </PopoverScroll>
            )}
        </>
    );
}

interface ArchivedEndProps {
    chat: Chat;
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    ago: string;
    onUnarchive: () => void;
    onDelete: () => void;
}

/**
 * The end of an archived chat's row: how long ago it was put away, and the `⋯` menu with what can be done to it. They share one room, the time at rest and
 * the button in its place when the row is hovered, focused or has its menu open, so the row has no gap where the button waits.
 */
function ArchivedEnd({ chat, isOpen, onOpenChange, ago, onUnarchive, onDelete }: ArchivedEndProps) {
    return (
        <RowControls className={styles.end}>
            <Text variant="xs" color="secondary" className={styles.time} data-show={listBoxItemDataShow.itemRest}>
                {ago}
            </Text>
            <PopoverTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
                <RowActionButton
                    icon={<More />}
                    label={`Actions of ${chat.title}`}
                    tooltip={null}
                    // Kept while the menu is open, though the pointer has left the row.
                    data-show={isOpen ? undefined : listBoxItemDataShow.itemBoth}
                />
                <Popover placement="bottom end" spacing="xs">
                    <PopoverScroll>
                        <Menu
                            aria-label="Archived chat actions"
                            size="sm"
                            onAction={key => {
                                onOpenChange(false);

                                if (key === 'unarchive') onUnarchive();
                                else if (key === 'delete') onDelete();
                            }}
                        >
                            <MenuItem id="unarchive" icon={<Archive />} textValue="Unarchive">
                                Unarchive
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem id="delete" icon={<Trash />} textValue="Delete" isDanger>
                                Delete
                            </MenuItem>
                        </Menu>
                    </PopoverScroll>
                </Popover>
            </PopoverTrigger>
        </RowControls>
    );
}
