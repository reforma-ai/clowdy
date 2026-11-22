import { Button } from '@clowdy/components/Button';
import { GridList, GridListItem, listBoxItemDataShow, Menu, MenuItem, MenuSeparator } from '@clowdy/components/List';
import { Popover, PopoverScroll, PopoverTrigger } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Archive, More, Trash } from '@clowdy/icons/14';
import { History } from '@clowdy/icons/16';
import { useState, type RefObject } from 'react';

import { formatElapsed } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { openChat, unarchiveChat } from '../chats/archiveChat';
import { deleteChat } from '../chats/deleteChat';
import { archivedChats } from './agentTree';
import styles from './ArchiveButton.module.css';
import { ChatIcon } from './ChatIcon';

import type { Chat, ChatId } from '@clowdy/protocol';

/**
 * The archive, in the heading beside the filters: a button (the history mark) that drops down the chats that were put away, the last one first, each with how long
 * ago and a `⋯` with Unarchive and Delete. Picking a row brings the chat back into the list and opens it, so a chat is either in the list or here,
 * never both. Threads put away with their parent are part of its entry and have none of their own (`archivedChats`); a thread put away alone has one.
 * The list opens under the `anchor`, the heading, and is as wide as it, so it stays inside the column and is as close to the button as the filters' menu is.
 */
export function ArchiveButton({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [isOpen, setIsOpen] = useState(false);
    // The chat whose `⋯` menu is open: its row keeps the hover plate while the pointer is in the menu.
    const [menuOpenId, setMenuOpenId] = useState<ChatId | null>(null);
    const archived = archivedChats(project.chatList);
    const now = Date.now();

    return (
        <PopoverTrigger isOpen={ isOpen } onOpenChange={ setIsOpen }>
            <Button variant="filling" color="secondary" size="sm" iconOnly aria-label="History" tooltip="History">
                <History />
            </Button>
            <Popover triggerRef={ anchor } placement="bottom start" spacing="xs" width="trigger">
                { archived.length === 0
                    ? <Text variant="sm" color="secondary" className={ styles.empty }>No archived chats</Text>
                    : (
                        <PopoverScroll maxHeight={ 360 }>
                            <GridList
                                aria-label="Archived chats"
                                size="sm"
                                onAction={ (key) => {
                                    setIsOpen(false);
                                    void openChat(root, project, ui, String(key));
                                } }
                            >
                                { archived.map(chat => (
                                    <GridListItem
                                        key={ chat.id }
                                        id={ chat.id }
                                        text={ chat.title }
                                        data-open={ menuOpenId === chat.id || undefined }
                                        icon={ <ChatIcon chat={ chat } run={ chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined } /> }
                                        endAffix={ (
                                            <ArchivedEnd
                                                chat={ chat }
                                                isOpen={ menuOpenId === chat.id }
                                                onOpenChange={ open => setMenuOpenId(open ? chat.id : null) }
                                                ago={ formatElapsed(now - chat.archivedAt) }
                                                onUnarchive={ () => void unarchiveChat(root, chat) }
                                                onDelete={ () => {
                                                    // A chat that ran asks first, saying how many threads go with it, and the dialog should not open over the list.
                                                    setIsOpen(false);
                                                    deleteChat(root, chat, chat.orchestratorRunId !== undefined && project.runs.has(chat.orchestratorRunId), project.threadsBelow(chat.id).length);
                                                } }
                                            />
                                        ) }
                                    >
                                        <span className={ styles.title }>{ chat.title }</span>
                                    </GridListItem>
                                )) }
                            </GridList>
                        </PopoverScroll>
                    ) }
            </Popover>
        </PopoverTrigger>
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

/** The end of an archived chat's row: how long ago it was put away, and the `⋯` menu, on hover, with what can be done to it. */
function ArchivedEnd({ chat, isOpen, onOpenChange, ago, onUnarchive, onDelete }: ArchivedEndProps) {
    return (
        // The button and its popover are React children of the row, so their clicks and keys would reach the row through the tree.
        <span
            className={ styles.end }
            onClick={ event => event.stopPropagation() }
            onDoubleClick={ event => event.stopPropagation() }
            onPointerDown={ event => event.stopPropagation() }
            onKeyDown={ event => event.stopPropagation() }
            onContextMenu={ event => event.stopPropagation() }
        >
            <Text variant="xs" color="secondary">{ ago }</Text>
            <PopoverTrigger isOpen={ isOpen } onOpenChange={ onOpenChange }>
                <Button
                    variant="filling"
                    color="secondary"
                    size="xs"
                    iconOnly
                    aria-label={ `Actions of ${ chat.title }` }
                    preventFocusOnPress
                    // Kept while the menu is open, though the pointer has left the row.
                    data-show={ isOpen ? undefined : listBoxItemDataShow.itemBoth }
                >
                    <More />
                </Button>
                <Popover placement="bottom end" spacing="xs">
                    <PopoverScroll>
                        <Menu
                            aria-label="Archived chat actions"
                            size="sm"
                            onAction={ (key) => {
                                onOpenChange(false);

                                if (key === 'unarchive') onUnarchive();
                                else if (key === 'delete') onDelete();
                            } }
                        >
                            <MenuItem id="unarchive" icon={ <Archive /> } textValue="Unarchive">Unarchive</MenuItem>
                            <MenuSeparator />
                            <MenuItem id="delete" icon={ <Trash /> } textValue="Delete" isDanger>Delete</MenuItem>
                        </Menu>
                    </PopoverScroll>
                </Popover>
            </PopoverTrigger>
        </span>
    );
}
