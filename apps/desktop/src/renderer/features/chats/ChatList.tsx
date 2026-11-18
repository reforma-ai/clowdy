import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { GridList, GridListItem, listBoxItemDataShow, useCellEditMode } from '@clowdy/components/List';
import { Panel, PanelContent, PanelEmptyRow, PanelHeader } from '@clowdy/components/Panel';
import { Popover, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Message, More, Plus } from '@clowdy/icons/14';
import { useRef, useState, type MouseEvent } from 'react';

import { useCommands, useHotkeyScope } from '../../hotkeys';
import { StatusDot } from '../../shared';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { chatCommands, CHATS_SCOPE } from './chatCommands';
import styles from './ChatList.module.css';
import { ChatMenu } from './ChatMenu';
import { isRunActive } from './chatRun';
import { perform } from './commands';
import { deleteChat } from './deleteChat';
import { useStartChat } from './useStartChat';

import type { Chat, ChatId } from '@clowdy/protocol';

/** A row's `⋯` button and the right-click menu are the same actions; a rename is a rename of the row it started on. */
interface ChatActions {
    rename: (chat: Chat) => void;
    remove: (chat: Chat) => void;
}

/** The project's chats, newest activity first, the header button that starts another one, and a menu on each row. */
export function ChatList({ selectedId }: { selectedId: ChatId | undefined }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const { start, isCreating } = useStartChat();
    const [renamingId, setRenamingId] = useState<ChatId | null>(null);
    const [menuChat, setMenuChat] = useState<Chat | null>(null);
    const list = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const runOf = (chat: Chat) => (chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined);
    const actions: ChatActions = {
        // The popover hands focus back to its trigger as it closes: starting at once would have that blur end the rename.
        rename: chat => void setTimeout(() => setRenamingId(chat.id), 150),
        remove: chat => deleteChat(root, chat, runOf(chat) !== undefined),
    };

    useHotkeyScope(CHATS_SCOPE);
    useCommands(CHATS_SCOPE, chatCommands({
        list: () => list.current,
        ids: () => project.chatList.map(chat => chat.id),
        openId: () => selectedId,
    }));

    // Right-click anywhere on a row: the rows are the list's own elements, so the click is found by its row's key.
    const openContextMenu = (event: MouseEvent) => {
        const key = (event.target as Element).closest('[role="row"]')?.getAttribute('data-key');
        const chat = key ? project.chats.get(key) : undefined;

        if (!chat) return;

        setMenuChat(chat);
        contextMenu.areaProps.onContextMenu(event);
    };

    return (
        <Panel side="left" className={ styles.panel }>
            <PanelHeader>
                <span>Chats</span>
                <PanelHeader.Actions>
                    <Button variant="ghost" size="sm" isPending={ isCreating } onPress={ () => void start() }>
                        <Plus />
                        New chat
                    </Button>
                </PanelHeader.Actions>
            </PanelHeader>

            <PanelContent contentClass={ styles.content }>
                { project.chatList.length === 0
                    ? <PanelEmptyRow>No chats yet</PanelEmptyRow>
                    : (
                        <div ref={ list } onContextMenu={ openContextMenu }>
                            <GridList
                                aria-label="Chats"
                                size="md"
                                selectionMode="single"
                                disallowEmptySelection
                                selectedKeys={ selectedId }
                                onSelectionChange={ (keys) => {
                                    const [id] = keys === 'all' ? [] : keys;

                                    if (id !== undefined) ui.openChat(String(id));
                                } }
                            >
                                { project.chatList.map(chat => (
                                    <GridListItem
                                        key={ chat.id }
                                        id={ chat.id }
                                        text={ chat.title }
                                        icon={ <Message /> }
                                        endAffix={ renamingId === chat.id ? undefined : <RowEnd chat={ chat } actions={ actions } /> }
                                    >
                                        { renamingId === chat.id
                                            ? <RenameField chat={ chat } onDone={ () => setRenamingId(null) } />
                                            : <span className={ styles.title } onDoubleClick={ () => setRenamingId(chat.id) }>{ chat.title }</span> }
                                    </GridListItem>
                                )) }
                            </GridList>
                        </div>
                    ) }
            </PanelContent>

            <Show when={ contextMenu.isOpen ? menuChat : null }>
                { chat => (
                    <Popover { ...contextMenu.popoverProps } placement="bottom start" spacing="xs">
                        <ChatMenu
                            isBusy={ isRunActive(runOf(chat)) }
                            onClose={ contextMenu.close }
                            onRename={ () => actions.rename(chat) }
                            onDelete={ () => actions.remove(chat) }
                        />
                    </Popover>
                ) }
            </Show>
        </Panel>
    );
}

/** A dot while the chat's orchestrator is busy, and the `⋯` menu button on hover. */
function RowEnd({ chat, actions }: { chat: Chat; actions: ChatActions }) {
    const project = useProjectState();
    const [isOpen, setIsOpen] = useState(false);
    const run = chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined;
    const close = () => setIsOpen(false);

    return (
        <span className={ styles.end }>
            { isRunActive(run) && <StatusDot status={ run.status } /> }
            {/* The popover is a React child of the row, so its clicks and keys would reach the row through the tree. */}
            <span
                onClick={ event => event.stopPropagation() }
                onDoubleClick={ event => event.stopPropagation() }
                onPointerDown={ event => event.stopPropagation() }
                onKeyDown={ event => event.stopPropagation() }
                onContextMenu={ event => event.stopPropagation() }
            >
                <PopoverTrigger isOpen={ isOpen } onOpenChange={ setIsOpen }>
                    <Button
                        variant="filling"
                        color="secondary"
                        size="xs"
                        iconOnly
                        aria-label="Chat actions"
                        preventFocusOnPress
                        // Kept while the menu is open, though the pointer has left the row.
                        data-show={ isOpen ? undefined : listBoxItemDataShow.itemBoth }
                    >
                        <More />
                    </Button>
                    <Popover placement="bottom end" spacing="xs">
                        <ChatMenu
                            isBusy={ isRunActive(run) }
                            onClose={ close }
                            onRename={ () => actions.rename(chat) }
                            onDelete={ () => actions.remove(chat) }
                        />
                    </Popover>
                </PopoverTrigger>
            </span>
        </span>
    );
}

/** The title as a field in the title's own place: Enter or leaving it renames, Escape keeps the old name. */
function RenameField({ chat, onDone }: { chat: Chat; onDone: () => void }) {
    const root = useRootStore();
    const edit = useCellEditMode();
    const [title, setTitle] = useState(chat.title);

    const commit = () => {
        const next = title.trim();

        onDone();

        if (next && next !== chat.title) void perform(root, { type: 'chat.rename', chatId: chat.id, title: next });
    };

    return (
        <Input
            type="text"
            variant="inline"
            aria-label="Chat title"
            autoFocus
            autoSelect
            value={ title }
            onChange={ setTitle }
            onFocus={ edit.onFocus }
            onBlur={ (event) => {
                edit.onBlur(event);
                commit();
            } }
            onKeyDown={ (event) => {
                if (event.key === 'Enter') commit();
                else if (event.key === 'Escape') onDone();
            } }
        />
    );
}
