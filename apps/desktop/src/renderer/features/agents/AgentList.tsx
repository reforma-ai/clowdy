import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { GridList, GridListItem, listBoxItemDataShow, Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator, useCellEditMode } from '@clowdy/components/List';
import { Panel, PanelContent } from '@clowdy/components/Panel';
import { Popover, PopoverScroll, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Archive, Check, Message, More, Plus } from '@clowdy/icons/14';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';

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
import { useProjectsInfo } from '../settings/projects/useProjectsInfo';
import { agentCommands, AGENTS_SCOPE } from './agentCommands';
import styles from './AgentList.module.css';
import { agentGroups, agentRows, ancestorChats, draftTarget, groupFolderOf, isActiveThread, orchestratorOf, type AgentGroup, type AgentRow, type AgentSelection } from './agentTree';
import { ArchiveButton } from './ArchiveButton';
import { ChatIcon } from './ChatIcon';

import type { Chat, ChatId, FolderId } from '@clowdy/protocol';

/** The id of the first row, the one that starts a chat. Chat ids never look like it. */
export const NEW_CHAT_ROW = '@new-chat';

/** The ids of the rows a grouped list adds: the heading of a folder's group, and the row of a group with no chat. Chat ids never look like them. */
const GROUP_PREFIX = '@folder:';
const EMPTY_PREFIX = '@empty:';
const groupKey = (folderId: FolderId) => `${ GROUP_PREFIX }${ folderId }`;

/** What a line of the list is: a chat (or a thread), the heading of a folder's group, or the note of a group that has no chat. */
type ListEntry =
    | { kind: 'chat'; row: AgentRow }
    | { kind: 'group'; group: AgentGroup; isCollapsed: boolean }
    | { kind: 'empty'; folderId: FolderId };

/** The key of a line's row in the grid list: a chat's id, or the id of a heading or a note. */
const entryKey = (entry: ListEntry) => (entry.kind === 'chat' ? entry.row.id : entry.kind === 'group' ? groupKey(entry.group.folder.id) : `${ EMPTY_PREFIX }${ entry.folderId }`);

/** The events a row's own buttons must not pass up: they are React children of the row, so the row would take their clicks and keys as its own. */
const ownEvents = {
    onClick: (event: SyntheticEvent) => event.stopPropagation(),
    onDoubleClick: (event: SyntheticEvent) => event.stopPropagation(),
    onPointerDown: (event: SyntheticEvent) => event.stopPropagation(),
    onKeyDown: (event: SyntheticEvent) => event.stopPropagation(),
    onContextMenu: (event: SyntheticEvent) => event.stopPropagation(),
};

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
 * in the heading, beside the filters), and take their threads with them. With the menu's Group by folder on, in a project of several folders, the
 * chats stand in a group for the folder they work in, under a heading that folds the group and has a button for a chat in that folder.
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
    const { folders } = project.project;
    const grouped = ui.groupByFolder && folders.length > 1;
    // The new-chat page of another folder than the main one belongs to that folder's heading, not to the row at the top: the row stays free to be pressed.
    const draftFolder = selection.draft && grouped ? draftTarget(folders, ui.draftFolderId) : undefined;
    const draftElsewhere = draftFolder !== undefined && !draftFolder.isMain;
    const selectedId = selection.draft ? (draftElsewhere ? undefined : NEW_CHAT_ROW) : openChatId;
    // A group's folder is told missing from what the daemon last read, which is read once when grouping turns on and when the projects change.
    const { info } = useProjectsInfo({ enabled: grouped, poll: false });
    const missing = new Set(info.get(project.id)?.folders.filter(folder => !folder.exists).map(folder => folder.folderId));
    const rowsOf = (roots: readonly Chat[]) => agentRows({
        roots,
        threadsOf: chatId => project.threadsOf(chatId),
        runs: project.runs,
        expanded: new Set(ui.expandedChats),
        showFinished: ui.showFinishedThreads,
        openChatId,
    });
    const entries: ListEntry[] = grouped
        ? agentGroups(chats, folders).flatMap((group): ListEntry[] => {
            const isCollapsed = ui.collapsedFolders.includes(group.folder.id);
            const groupRows = isCollapsed ? [] : rowsOf(group.roots);
            const body: ListEntry[] = isCollapsed ? [] : groupRows.length > 0 ? groupRows.map(row => ({ kind: 'chat', row })) : [{ kind: 'empty', folderId: group.folder.id }];

            return [{ kind: 'group', group, isCollapsed }, ...body];
        })
        : rowsOf(chats).map(row => ({ kind: 'chat', row }));

    // A thread opened from elsewhere (a chip, a card, back and forward, the keyboard) may sit below a fold: open the folds above it, and the folded group
    // of the chat it belongs to. When the open chat changes, and when the list turns grouped; not on other changes, so the person can still fold the
    // chat or the group it sits in.
    useEffect(() => {
        if (openChatId === undefined) return;

        ui.expandChats(ancestorChats(project.chats, openChatId).map(chat => chat.id));

        const folderId = grouped ? groupFolderOf(project.chats, project.project.folders, openChatId) : undefined;

        if (folderId !== undefined) ui.expandFolder(folderId);
    }, [openChatId, grouped, project, ui]);

    useHotkeyScope(AGENTS_SCOPE);
    useCommands(AGENTS_SCOPE, agentCommands({
        list: () => list.current,
        // The headings are rows the arrows stop on, so they are in the order J and K step through; a group's note has no focus.
        ids: () => [NEW_CHAT_ROW, ...entries.filter(entry => entry.kind !== 'empty').map(entryKey)],
        openId: () => selectedId ?? (draftFolder && groupKey(draftFolder.folder.id)),
    }));

    // Right-click anywhere on a chat's row: the rows are the list's own elements, so the click is found by its row's key.
    const openContextMenu = (event: MouseEvent) => {
        const key = (event.target as Element).closest('[role="row"]')?.getAttribute('data-key');
        const chat = key ? project.chats.get(key) : undefined;

        if (!chat) return;

        setMenuChat(chat);
        contextMenu.areaProps.onContextMenu(event);
    };

    /** The fold a row has, if any: the threads of a chat, or the chats of a folder's group. */
    const foldOf = (key: string | undefined): { isExpanded: boolean; toggle: () => void } | undefined => {
        const entry = entries.find(candidate => entryKey(candidate) === key);

        if (entry?.kind === 'chat' && entry.row.childCount > 0) return { isExpanded: entry.row.isExpanded, toggle: () => ui.toggleChatExpanded(entry.row.id) };

        if (entry?.kind === 'group') return { isExpanded: !entry.isCollapsed, toggle: () => ui.toggleFolderCollapsed(entry.group.folder.id) };

        return undefined;
    };

    // The grid list keeps the arrows between rows; Right opens a fold and Left closes it. Read in the capture phase, because a row with buttons moves
    // the focus into them on these keys and stops the event there; one that toggles a fold does not reach the row.
    const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
        const { target } = event;

        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'row') return;

        const folded = foldOf(target.dataset.key);

        if (!folded) return;

        if ((event.key === 'ArrowRight' && !folded.isExpanded) || (event.key === 'ArrowLeft' && folded.isExpanded)) {
            folded.toggle();
            event.preventDefault();
            event.stopPropagation();
        }
    };

    const select = (id: string) => {
        if (id === NEW_CHAT_ROW) ui.openDraft();
        // A heading is not a page: a press folds or opens its group.
        else if (id.startsWith(GROUP_PREFIX)) ui.toggleFolderCollapsed(id.slice(GROUP_PREFIX.length));
        else ui.openChat(id);
    };

    const renderGroup = (group: AgentGroup, isCollapsed: boolean) => {
        const isMissing = missing.has(group.folder.id);

        return (
            <GridListItem
                key={ groupKey(group.folder.id) }
                id={ groupKey(group.folder.id) }
                text={ group.name }
                className={ styles.group }
                endAffix={ (
                    <span className={ styles.end } { ...ownEvents }>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="xs"
                            iconOnly
                            aria-label={ `New chat in ${ group.name }` }
                            tooltip={ isMissing ? 'This folder no longer exists' : `New chat in ${ group.name }` }
                            isDisabled={ isMissing }
                            preventFocusOnPress
                            data-show={ listBoxItemDataShow.itemBoth }
                            // The main folder's chat has no folder of its own: it follows the main folder, as every chat did before groups.
                            onPress={ () => ui.openDraft([], group.isMain ? null : group.folder.id) }
                        >
                            <Plus />
                        </Button>
                    </span>
                ) }
                // The heading of the folder the open new-chat page is for stays as if hovered, with its button, like the row of an open menu.
                data-open={ (draftElsewhere && draftFolder.folder.id === group.folder.id) || undefined }
                data-collapsed={ isCollapsed || undefined }
                data-missing={ isMissing || undefined }
            >
                <span className={ styles.groupTitle }>
                    <span className={ styles.title }>{ group.name }</span>
                    {/* Always there on a folded group, which says it is folded; an open one shows it as the pointer or the keyboard comes. */}
                    <span className={ styles.groupChevron } aria-hidden data-show={ isCollapsed ? undefined : listBoxItemDataShow.itemBoth }>
                        { isCollapsed ? <ChevronRight /> : <ChevronDown /> }
                    </span>
                </span>
            </GridListItem>
        );
    };

    const renderEntry = (entry: ListEntry) => {
        switch (entry.kind) {
            case 'chat':
                return renderRow(entry.row);
            case 'group':
                return renderGroup(entry.group, entry.isCollapsed);
            case 'empty':
                return (
                    <GridListItem key={ entryKey(entry) } id={ entryKey(entry) } text="No chats" icon={ <Message /> } className={ styles.empty } isDisabled>
                        <span className={ styles.title }>No chats</span>
                    </GridListItem>
                );
        }
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
                        { entries.map(renderEntry) }
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

/**
 * The header's `⋯`: what the list shows (a checked entry is on), whether its chats stand in a group for each folder of the project (offered only
 * when the project has several folders), and the order the chats come in (the checked one).
 */
function FilterMenu() {
    const ui = useProjectUi();
    const project = useProjectState();
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
                        { project.project.folders.length > 1 && (
                            <>
                                <MenuSection
                                    selectionMode="multiple"
                                    selectedKeys={ ui.groupByFolder ? ['folders'] : [] }
                                    onSelectionChange={ keys => ui.setGroupByFolder(keys === 'all' || keys.has('folders')) }
                                >
                                    <MenuHeader>Group</MenuHeader>
                                    <MenuItem id="folders" textValue="Group by folder" endAffix={ ui.groupByFolder ? <Check /> : undefined }>Group by folder</MenuItem>
                                </MenuSection>
                                <MenuSeparator />
                            </>
                        ) }
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
        <span className={ styles.fold } { ...ownEvents }>
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
        <span className={ styles.end } { ...ownEvents }>
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
