import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { GridList, GridListItem, listBoxItemDataShow, Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator, useCellEditMode } from '@clowdy/components/List';
import { Panel, PanelContent } from '@clowdy/components/Panel';
import { Popover, PopoverScroll, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Archive, Check, More, Plus } from '@clowdy/icons/14';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';

import { CommandHotkey, useCommands, useHotkeyScope } from '../../hotkeys';
import { SidebarHeading } from '../../shared';
import { NEW_CHAT_COMMAND } from '../../shell/shellCommands';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { archiveChat } from '../chats/archiveChat';
import { ChatMenu } from '../chats/ChatMenu';
import { isRunActive } from '../chats/chatRun';
import { perform } from '../chats/commands';
import { deleteChat } from '../chats/deleteChat';
import { threadsAtWork } from '../chats/runningAgentRows';
import { agentCommands, AGENTS_SCOPE } from './agentCommands';
import styles from './AgentList.module.css';
import { agentRows, ancestorChats, isActiveThread, orchestratorOf, type AgentRow, type AgentSelection } from './agentTree';
import { ArchiveButton } from './ArchiveButton';
import { ChatIcon } from './ChatIcon';

import type { Chat, ChatId } from '@clowdy/protocol';

/** The id of the first row, the one that starts a chat. Chat ids never look like it. */
export const NEW_CHAT_ROW = '@new-chat';

/** A row's `⋯` button and the right-click menu are the same actions; a rename is a rename of the row it started on. */
interface ChatActions {
    rename: (chat: Chat) => void;
    archive: (chat: Chat) => void;
    remove: (chat: Chat) => void;
    /** Why the chat can be neither archived nor deleted now; absent when it can. */
    busy: (chat: Chat) => string | undefined;
}

/**
 * The project's agents: the row that starts a chat, then the chats in use (in the order the menu of the heading's `⋯` asks for), each with the
 * threads its agents started below it, folded until the person opens them. Archived chats are not here, they are in the archive's list (the button
 * in the heading, beside the filters), and take their threads with them.
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
    const runOf = (chat: Chat) => orchestratorOf(chat, project.runs);
    const actions: ChatActions = {
        // The popover hands focus back to its trigger as it closes: starting at once would have that blur end the rename.
        rename: chat => void setTimeout(() => setRenamingId(chat.id), 150),
        archive: chat => void archiveChat(root, ui, chat, selection.chat?.id === chat.id),
        remove: chat => deleteChat(root, chat, runOf(chat) !== undefined, project.threadsBelow(chat.id).length),
        // The daemon refuses both while an agent of the chat works, or an agent of a thread that would go with it.
        busy: (chat) => {
            if (isRunActive(runOf(chat))) return 'Stop the chat first';

            return project.threadsBelow(chat.id).some(thread => isActiveThread(thread, project.runs)) ? 'Stop its threads first' : undefined;
        },
    };

    // A native sub-agent has no row: its chat stays selected while its page is open. The new-chat page has none.
    const openChatId = selection.draft ? undefined : selection.chat?.id;
    const selectedId = selection.draft ? NEW_CHAT_ROW : openChatId;
    const rows = agentRows({
        roots: chats,
        threadsOf: chatId => project.threadsOf(chatId),
        runs: project.runs,
        expanded: new Set(ui.expandedChats),
        showFinished: ui.showFinishedThreads,
        openChatId,
    });

    // A thread opened from elsewhere (a chip, a card, back and forward, the keyboard) may sit below a fold: open the folds above it. Only when the
    // open chat changes, so the person can still fold the chat it sits in.
    useEffect(() => {
        if (openChatId !== undefined) ui.expandChats(ancestorChats(project.chats, openChatId).map(chat => chat.id));
    }, [openChatId, project, ui]);

    useHotkeyScope(AGENTS_SCOPE);
    useCommands(AGENTS_SCOPE, agentCommands({
        list: () => list.current,
        ids: () => [NEW_CHAT_ROW, ...rows.map(row => row.id)],
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

    // The grid list keeps the arrows between rows; Right opens a fold and Left closes it. Read in the capture phase, because a row with buttons moves
    // the focus into them on these keys and stops the event there; one that toggles a fold does not reach the row.
    const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
        const { target } = event;

        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'row') return;

        const row = rows.find(candidate => candidate.id === target.dataset.key);

        if (!row || row.childCount === 0) return;

        if ((event.key === 'ArrowRight' && !row.isExpanded) || (event.key === 'ArrowLeft' && row.isExpanded)) {
            ui.toggleChatExpanded(row.id);
            event.preventDefault();
            event.stopPropagation();
        }
    };

    const select = (id: string) => {
        if (id === NEW_CHAT_ROW) ui.openDraft();
        else ui.openChat(id);
    };

    const renderRow = (row: AgentRow) => {
        const { chat } = row;
        // Only a row with threads below it has a chevron, and it takes no room: the icons stay where the list puts them.
        const fold = row.childCount > 0 ? <Fold row={ row } onToggle={ () => ui.toggleChatExpanded(chat.id) } /> : undefined;
        // The same threads the strip above its message box lists.
        const threadsWorking = threadsAtWork(project.threadsOf(chat.id), project.runs).length > 0;

        return (
            <GridListItem
                key={ chat.id }
                id={ chat.id }
                text={ chat.title }
                startAffix={ fold }
                icon={ <ChatIcon chat={ chat } run={ runOf(chat) } threadsWorking={ threadsWorking } /> }
                endAffix={ renamingId === chat.id ? undefined : <RowEnd chat={ chat } actions={ actions } isOpen={ menuOpenId === chat.id } onOpenChange={ open => setMenuOpenId(open ? chat.id : null) } /> }
                className={ row.depth > 0 ? styles.nested : undefined }
                style={ { '--depth': row.depth } as CSSProperties }
                // The row of an open menu, from its button or the right click, stays as if hovered: the pointer is in the menu, not on the row.
                data-open={ menuOpenId === chat.id || (contextMenu.isOpen && menuChat?.id === chat.id) || undefined }
                data-depth={ row.depth }
            >
                { renamingId === chat.id
                    ? <RenameField chat={ chat } onDone={ () => setRenamingId(null) } />
                    : <span className={ styles.title } onDoubleClick={ () => setRenamingId(chat.id) }>{ chat.title }</span> }
            </GridListItem>
        );
    };

    return (
        <Panel side="left">
            <SidebarHeading ref={ heading } title="Agents" className={ styles.heading }>
                <ArchiveButton anchor={ heading } />
                <FilterMenu />
            </SidebarHeading>

            <PanelContent contentClass={ styles.content }>
                <div ref={ list } onContextMenu={ openContextMenu } onKeyDownCapture={ onKeyDownCapture }>
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
                        { rows.map(renderRow) }
                    </GridList>
                </div>
            </PanelContent>

            <Show when={ contextMenu.isOpen ? menuChat : null }>
                { chat => (
                    <Popover { ...contextMenu.popoverProps } placement="bottom start" spacing="xs">
                        <ChatMenu
                            busy={ actions.busy(chat) }
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

/** The header's `⋯`: what the list shows (a checked entry is on) and the order the chats come in (the checked one). */
function FilterMenu() {
    const ui = useProjectUi();
    const [isOpen, setIsOpen] = useState(false);
    const shown = ui.showFinishedThreads ? ['finished'] : [];

    return (
        <PopoverTrigger isOpen={ isOpen } onOpenChange={ setIsOpen }>
            <Button variant="filling" size="sm" iconOnly aria-label="Filters" tooltip="Filters">
                <More />
            </Button>
            <Popover placement="bottom end" spacing="xs" width={ 240 }>
                <PopoverScroll>
                    <Menu aria-label="Filters" size="sm">
                        <MenuSection
                            selectionMode="multiple"
                            selectedKeys={ shown }
                            onSelectionChange={ keys => ui.setShowFinishedThreads(keys === 'all' || keys.has('finished')) }
                        >
                            <MenuHeader>Show</MenuHeader>
                            <MenuItem id="finished" textValue="Finished threads" endAffix={ ui.showFinishedThreads ? <Check /> : undefined }>Finished threads</MenuItem>
                        </MenuSection>
                        <MenuSeparator />
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

/** The chevron of a row that has threads below it, drawn in the row's left padding. */
function Fold({ row, onToggle }: { row: AgentRow; onToggle: () => void }) {
    return (
        // The button is a React child of the row, so its clicks and keys would reach the row through the tree.
        <span
            className={ styles.fold }
            onClick={ event => event.stopPropagation() }
            onDoubleClick={ event => event.stopPropagation() }
            onPointerDown={ event => event.stopPropagation() }
            onKeyDown={ event => event.stopPropagation() }
            onContextMenu={ event => event.stopPropagation() }
        >
            <button
                type="button"
                tabIndex={ -1 }
                className={ styles.chevron }
                aria-label={ row.isExpanded ? `Collapse ${ row.chat.title } threads` : `Expand ${ row.chat.title } threads` }
                aria-expanded={ row.isExpanded }
                onClick={ onToggle }
            >
                { row.isExpanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden /> }
            </button>
        </span>
    );
}

/** The end of a chat's row, on hover: Archive as a quick action, and the `⋯` menu button. */
function RowEnd({ chat, actions, isOpen, onOpenChange }: { chat: Chat; actions: ChatActions; isOpen: boolean; onOpenChange: (isOpen: boolean) => void }) {
    const busy = actions.busy(chat);
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
                tooltip={ busy ?? 'Archive' }
                isDisabled={ busy !== undefined }
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
                        busy={ busy }
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
