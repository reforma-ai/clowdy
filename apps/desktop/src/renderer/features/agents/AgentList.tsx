import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { GridList, GridListItem, listBoxItemDataShow, Menu, MenuHeader, MenuItem, MenuSection, useCellEditMode } from '@clowdy/components/List';
import { Panel, PanelContent } from '@clowdy/components/Panel';
import { Popover, PopoverScroll, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Archive, Check, Message, More, Plus } from '@clowdy/icons/14';
import { useRef, useState, type MouseEvent } from 'react';

import { CommandHotkey, useCommands, useHotkeyScope } from '../../hotkeys';
import { SidebarHeading } from '../../shared';
import { NEW_CHAT_COMMAND } from '../../shell/shellCommands';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { archiveChat } from '../chats/archiveChat';
import { ChatMenu } from '../chats/ChatMenu';
import { isRunActive } from '../chats/chatRun';
import { perform } from '../chats/commands';
import { deleteChat } from '../chats/deleteChat';
import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { PROVIDER_IDS } from '../settings/providers/providerView';
import { agentCommands, AGENTS_SCOPE } from './agentCommands';
import styles from './AgentList.module.css';
import { ArchiveButton } from './ArchiveButton';
import { ChatIcon } from './ChatIcon';

import type { Chat, ChatId } from '@clowdy/protocol';
import type { AgentSelection } from './agentTree';

/** The id of the first row, the one that starts a chat. Chat ids never look like it. */
export const NEW_CHAT_ROW = '@new-chat';

/** A row's `⋯` button and the right-click menu are the same actions; a rename is a rename of the row it started on. */
interface ChatActions {
    rename: (chat: Chat) => void;
    archive: (chat: Chat) => void;
    remove: (chat: Chat) => void;
}

/**
 * The project's agents: the row that starts a chat, then the chats in use, in the order the menu of the heading's `⋯` asks for.
 * Archived chats are not here, they are in the archive's list (the button in the heading, beside the filters).
 */
export function AgentList({ selection, chats }: { selection: AgentSelection; chats: readonly Chat[] }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [renamingId, setRenamingId] = useState<ChatId | null>(null);
    const [menuChat, setMenuChat] = useState<Chat | null>(null);
    // The chat whose `⋯` menu is open: its row keeps the hover plate while the pointer is in the menu.
    const [menuOpenId, setMenuOpenId] = useState<ChatId | null>(null);
    const list = useRef<HTMLDivElement>(null);
    const heading = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const runOf = (chat: Chat) => (chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined);
    const actions: ChatActions = {
        // The popover hands focus back to its trigger as it closes: starting at once would have that blur end the rename.
        rename: chat => void setTimeout(() => setRenamingId(chat.id), 150),
        archive: chat => void archiveChat(root, ui, chat, selection.chat?.id === chat.id),
        remove: chat => deleteChat(root, chat, runOf(chat) !== undefined),
    };

    // A native sub-agent has no row: its chat stays selected while its page is open. The new-chat page has none.
    const selectedId = selection.draft ? NEW_CHAT_ROW : selection.chat?.id;

    useHotkeyScope(AGENTS_SCOPE);
    useCommands(AGENTS_SCOPE, agentCommands({
        list: () => list.current,
        ids: () => [NEW_CHAT_ROW, ...chats.map(chat => chat.id)],
        openId: () => selectedId,
    }));

    // Right-click anywhere on a chat's row: the rows are the list's own elements, so the click is found by its row's key.
    const openContextMenu = (event: MouseEvent) => {
        const key = (event.target as Element).closest('[role="row"]')?.getAttribute('data-key');
        const chat = key ? project.chats.get(key) : undefined;

        if (!chat) return;

        setMenuChat(chat);
        contextMenu.areaProps.onContextMenu(event);
    };

    const select = (id: string) => {
        if (id === NEW_CHAT_ROW) ui.openDraft();
        else ui.openChat(id);
    };

    const renderChat = (chat: Chat) => (
        <GridListItem
            key={ chat.id }
            id={ chat.id }
            text={ chat.title }
            icon={ <ChatIcon chat={ chat } run={ runOf(chat) } /> }
            endAffix={ renamingId === chat.id ? undefined : <RowEnd chat={ chat } actions={ actions } isOpen={ menuOpenId === chat.id } onOpenChange={ open => setMenuOpenId(open ? chat.id : null) } /> }
            // The row of an open menu, from its button or the right click, stays as if hovered: the pointer is in the menu, not on the row.
            data-open={ menuOpenId === chat.id || (contextMenu.isOpen && menuChat?.id === chat.id) || undefined }
        >
            { renamingId === chat.id
                ? <RenameField chat={ chat } onDone={ () => setRenamingId(null) } />
                : <span className={ styles.title } onDoubleClick={ () => setRenamingId(chat.id) }>{ chat.title }</span> }
        </GridListItem>
    );

    return (
        <Panel side="left">
            <SidebarHeading ref={ heading } title="Agents" className={ styles.heading }>
                <ArchiveButton anchor={ heading } />
                <FilterMenu />
            </SidebarHeading>

            <PanelContent contentClass={ styles.content }>
                <div ref={ list } onContextMenu={ openContextMenu }>
                    <GridList
                        aria-label="Agents"
                        size="md"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={ selectedId }
                        onSelectionChange={ (keys) => {
                            const [id] = keys === 'all' ? [] : keys;

                            if (id !== undefined) select(String(id));
                        } }
                    >
                        <GridListItem
                            id={ NEW_CHAT_ROW }
                            text="New chat"
                            icon={ <Plus /> }
                            className={ styles.newChat }
                            // The shortcut is a hint for the pointer on its way to the row, not a label the row wears at rest.
                            endAffix={ (
                                <span className={ styles.end } data-show={ listBoxItemDataShow.itemHover }>
                                    <CommandHotkey id={ NEW_CHAT_COMMAND } size="xs" />
                                </span>
                            ) }
                        >
                            <span className={ styles.title }>New chat</span>
                        </GridListItem>
                        { chats.map(renderChat) }
                    </GridList>
                </div>
            </PanelContent>

            <Show when={ contextMenu.isOpen ? menuChat : null }>
                { chat => (
                    <Popover { ...contextMenu.popoverProps } placement="bottom start" spacing="xs">
                        <ChatMenu
                            isBusy={ isRunActive(runOf(chat)) }
                            onClose={ contextMenu.close }
                            onRename={ () => actions.rename(chat) }
                            onArchive={ () => actions.archive(chat) }
                            onDelete={ () => actions.remove(chat) }
                        />
                    </Popover>
                ) }
            </Show>
        </Panel>
    );
}

/** The header's `⋯`: the order the chats come in (the checked one). */
function FilterMenu() {
    const ui = useProjectUi();
    const [isOpen, setIsOpen] = useState(false);
    return (
        <PopoverTrigger isOpen={ isOpen } onOpenChange={ setIsOpen }>
            <Button variant="filling" size="sm" iconOnly aria-label="Filters" tooltip="Filters">
                <More />
            </Button>
            <Popover placement="bottom end" spacing="xs" width={ 240 }>
                <PopoverScroll>
                    <Menu aria-label="Filters" size="sm">
                        <MenuSection
                            selectionMode="single"
                            disallowEmptySelection
                            selectedKeys={ [ui.chatSort] }
                            onSelectionChange={ (keys) => {
                                const [sort] = keys === 'all' ? [] : keys;

                                if (sort === 'activity' || sort === 'created') ui.setChatSort(sort);
                            } }
                        >
                            <MenuHeader>Sort by</MenuHeader>
                            <MenuItem id="activity" textValue="Last activity" endAffix={ ui.chatSort === 'activity' ? <Check /> : undefined }>Last activity</MenuItem>
                            <MenuItem id="created" textValue="Created" endAffix={ ui.chatSort === 'created' ? <Check /> : undefined }>Created</MenuItem>
                        </MenuSection>
                    </Menu>
                </PopoverScroll>
            </Popover>
        </PopoverTrigger>
    );
}

/** The end of a chat's row, on hover: Archive as a quick action, and the `⋯` menu button. */
function RowEnd({ chat, actions, isOpen, onOpenChange }: { chat: Chat; actions: ChatActions; isOpen: boolean; onOpenChange: (isOpen: boolean) => void }) {
    const project = useProjectState();
    const busy = isRunActive(chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined);
    const close = () => onOpenChange(false);

    return (
        // The buttons and the popover are React children of the row, so their clicks and keys would reach the row through the tree.
        <span
            className={ styles.end }
            onClick={ event => event.stopPropagation() }
            onDoubleClick={ event => event.stopPropagation() }
            onPointerDown={ event => event.stopPropagation() }
            onKeyDown={ event => event.stopPropagation() }
            onContextMenu={ event => event.stopPropagation() }
        >
            <Button
                variant="filling"
                color="secondary"
                size="xs"
                iconOnly
                aria-label="Archive"
                tooltip={ busy ? 'Stop the chat first' : 'Archive' }
                isDisabled={ busy }
                preventFocusOnPress
                data-show={ listBoxItemDataShow.itemBoth }
                onPress={ () => actions.archive(chat) }
            >
                <Archive />
            </Button>
            <PopoverTrigger isOpen={ isOpen } onOpenChange={ onOpenChange }>
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
                        isBusy={ busy }
                        onClose={ close }
                        onRename={ () => actions.rename(chat) }
                        onArchive={ () => actions.archive(chat) }
                        onDelete={ () => actions.remove(chat) }
                    />
                </Popover>
            </PopoverTrigger>
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
