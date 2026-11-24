import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import {
    GridList,
    GridListItem,
    listBoxItemDataShow,
    Menu,
    MenuItem,
    MenuSection,
    useCellEditMode,
} from '@clowdy/components/List';
import { Panel, PanelContent } from '@clowdy/components/Panel';
import { Popover, PopoverScroll, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Archive, Check, ChevronDown, ChevronRight, Message, More, NewChat, Version } from '@clowdy/icons/14';
import {
    type CSSProperties,
    type KeyboardEvent,
    type MouseEvent,
    type ReactNode,
    type SyntheticEvent,
    useEffect,
    useRef,
    useState,
} from 'react';

import { CommandHotkey, useCommands, useHotkeyScope } from '../../hotkeys';
import { SidebarHeading } from '../../shared';
import { ProjectSelect } from '../../shell/ProjectSelect';
import { NEW_CHAT_COMMAND } from '../../shell/shellCommands';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { archiveChat } from '../chats/archiveChat';
import { ChatMenu } from '../chats/ChatMenu';
import { isRunActive } from '../chats/chatRun';
import { perform } from '../chats/commands';
import { draftOf, messageOf, useDraftRevision } from '../chats/composerDrafts';
import { filesOf, useDraftFilesRevision } from '../chats/composerFiles';
import { deleteChat } from '../chats/deleteChat';
import { workspaceHead } from '../openWith';
import styles from './AgentList.module.css';
import { ArchiveButton } from './ArchiveButton';
import { AGENTS_SCOPE, agentCommands } from './agentCommands';
import {
    type AgentGroup,
    type AgentRow,
    type AgentSelection,
    agentGroups,
    agentRows,
    ancestorChats,
    asksThePerson,
    groupFolderOf,
    isActiveThread,
    orchestratorOf,
} from './agentTree';
import { ChatIcon, ChatStatus } from './ChatIcon';
import { chatListPreferences } from './chatListPreferences';
import { GroupFolderName } from './GroupFolderName';
import { StarCard } from './StarCard';
import { useChatListOrder } from './useChatListOrder';

import type { Chat, ChatId, ChatWorkspace, FolderId, ProjectWorkspaceInfo } from '@clowdy/protocol';

/** The id of the first row, the one that starts a chat. Chat ids never look like it. */
export const NEW_CHAT_ROW = '@new-chat';

/** The ids of the rows a grouped list adds: the heading of a folder's group, and the row of a group with no chat. Chat ids never look like them. */
const GROUP_PREFIX = '@folder:';
const EMPTY_PREFIX = '@empty:';
const groupKey = (folderId: FolderId) => `${GROUP_PREFIX}${folderId}`;

/** What a line of the list is: a chat (or a thread), the heading of a folder's group, or the note of a group that has no chat. */
type ListEntry =
    | { kind: 'chat'; row: AgentRow }
    | { kind: 'group'; group: AgentGroup; isCollapsed: boolean }
    | { kind: 'empty'; folderId: FolderId };

/** The key of a line's row in the grid list: a chat's id, or the id of a heading or a note. */
const entryKey = (entry: ListEntry) =>
    entry.kind === 'chat'
        ? entry.row.id
        : entry.kind === 'group'
          ? groupKey(entry.group.folder.id)
          : `${EMPTY_PREFIX}${entry.folderId}`;

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
 * The project's agents: the row that starts a chat, then the chats in use in the person's order, each with the
 * threads its agents started below it, folded until the person opens them. Archived chats are not here, they are in the archive's list (the button
 * in the heading, beside the filters), and take their threads with them. `missing` are the folders gone from the disk (`Screen` reads them once for the list and the new-chat page): their group is marked and its button is off. With the menu's Group chats by folder on (it is, until the person turns it off), the
 * chats stand in a group for the folder they work in, under a heading that folds the group. Its name opens the folder's menu (`GroupFolderName`), and the menu and heading both offer a new chat in that folder.
 * A chat that works in a worktree has a branch mark after its title, with its branch in the mark's title: the one the tree has checked out, from `workspaces` (`ProjectInfo.workspaces`, which `Screen` reads).
 */
export function AgentList({
    selection,
    chats,
    missing,
    workspaces,
    isCovered,
}: {
    selection: AgentSelection;
    chats: readonly Chat[];
    missing: ReadonlySet<FolderId>;
    /** What the daemon last read of the project's worktrees: the branch each has now. */
    workspaces?: readonly ProjectWorkspaceInfo[];
    /** The side panel is in the place of the chat, so the list is a plate of its own. */
    isCovered: boolean;
}) {
    const root = useRootStore();
    useDraftRevision();
    useDraftFilesRevision();
    const project = useProjectState();
    const ui = useProjectUi();
    const [renamingId, setRenamingId] = useState<ChatId | null>(null);
    const saveRename = useRef<() => void>(() => {});
    const [menuChat, setMenuChat] = useState<Chat | null>(null);
    // The chat whose `⋯` menu is open: its row keeps the hover plate while the pointer is in the menu.
    const [menuOpenId, setMenuOpenId] = useState<ChatId | null>(null);
    const list = useRef<HTMLDivElement>(null);
    const heading = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const order = useChatListOrder(chats, selection.draft ? undefined : selection.chat?.id);
    const runOf = (chat: Chat) => orchestratorOf(chat, project.runs);
    const actions: ChatActions = {
        // The popover hands focus back to its trigger as it closes: starting at once would have that blur end the rename.
        rename: chat => void setTimeout(() => setRenamingId(chat.id), 150),
        archive: chat => void archiveChat(root, ui, chat, selection.chat?.id === chat.id),
        remove: chat => deleteChat(root, chat, runOf(chat) !== undefined, project.threadsBelow(chat.id).length),
        // The daemon refuses both while an agent of the chat works, or an agent of a thread that would go with it.
        busy: chat => {
            if (isRunActive(runOf(chat))) return 'Stop the chat first';

            return project.threadsBelow(chat.id).some(thread => isActiveThread(thread, project.runs))
                ? 'Stop its threads first'
                : undefined;
        },
    };

    // A native sub-agent has no row: its chat stays selected while its page is open. The new-chat page has none.
    const openChatId = selection.draft ? undefined : selection.chat?.id;
    const { folders } = project.project;
    const grouped = ui.groupByFolder;
    // The new-chat row is the open one on every new-chat page, whatever folder it is for: the folder is told by the select under the message box.
    const selectedId = selection.draft ? NEW_CHAT_ROW : openChatId;
    const rowsOf = (roots: readonly Chat[]) =>
        agentRows({
            roots,
            threadsOf: chatId => project.threadsOf(chatId),
            runs: project.runs,
            expanded: new Set(ui.expandedChats),
            showFinished: chatListPreferences.showFinishedThreads,
            openChatId,
        });
    const entries: ListEntry[] = grouped
        ? agentGroups(chats, folders).flatMap((group): ListEntry[] => {
              const isCollapsed = ui.collapsedFolders.includes(group.folder.id);
              const groupRows = isCollapsed ? [] : rowsOf(group.roots);
              const body: ListEntry[] = isCollapsed
                  ? []
                  : groupRows.length > 0
                    ? groupRows.map(row => ({ kind: 'chat', row }))
                    : [{ kind: 'empty', folderId: group.folder.id }];

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
    useCommands(
        AGENTS_SCOPE,
        agentCommands({
            list: () => list.current,
            // The headings are rows the arrows stop on, so they are in the order J and K step through; a group's note has no focus.
            ids: () => [NEW_CHAT_ROW, ...entries.filter(entry => entry.kind !== 'empty').map(entryKey)],
            openId: () => selectedId,
        })
    );

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

        if (entry?.kind === 'chat' && entry.row.childCount > 0)
            return { isExpanded: entry.row.isExpanded, toggle: () => ui.toggleChatExpanded(entry.row.id) };

        if (entry?.kind === 'group')
            return { isExpanded: !entry.isCollapsed, toggle: () => ui.toggleFolderCollapsed(entry.group.folder.id) };

        return undefined;
    };

    // The grid list keeps the arrows between rows; Right opens a fold and Left closes it. Read in the capture phase, because a row with buttons moves
    // the focus into them on these keys and stops the event there; one that toggles a fold does not reach the row.
    const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
        const { target } = event;

        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'row') return;

        // Enter or Space on the row of the chat that is open selects nothing new, and the list reports no selection: the chat is still wanted on screen.
        if ((event.key === 'Enter' || event.key === ' ') && target.dataset.key === selectedId) ui.showChat();

        const folded = foldOf(target.dataset.key);

        if (!folded) return;

        if ((event.key === 'ArrowRight' && !folded.isExpanded) || (event.key === 'ArrowLeft' && folded.isExpanded)) {
            folded.toggle();
            event.preventDefault();
            event.stopPropagation();
        }
    };

    // A press on the row of the chat that is open, and not on a control of the row: the same as above, for the pointer. Read in the capture phase: a row stops the click it takes.
    const onClick = (event: MouseEvent) => {
        const target = event.target as Element;

        if (!target.closest('button') && target.closest('[role="row"]')?.getAttribute('data-key') === selectedId)
            ui.showChat();
    };

    const select = (id: string) => {
        if (id === NEW_CHAT_ROW) ui.openDraft();
        // A heading is a label, not a page: only its chevron, and Right and Left on it, fold the group.
        else if (!id.startsWith(GROUP_PREFIX)) ui.openChat(id);
    };

    const renderGroup = (group: AgentGroup, isCollapsed: boolean) => {
        const isMissing = missing.has(group.folder.id);
        // Chats in the main folder have no folder id of their own.
        const openNewChat = () => ui.openDraft([], group.isMain ? null : group.folder.id);

        return (
            <GridListItem
                key={groupKey(group.folder.id)}
                id={groupKey(group.folder.id)}
                text={group.name}
                className={styles.group}
                plateless
                endAffix={
                    <span className={styles.end} {...ownEvents}>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="xs"
                            iconOnly
                            aria-label={`New chat in ${group.name}`}
                            tooltip={isMissing ? 'This folder no longer exists' : `New chat in ${group.name}`}
                            isDisabled={isMissing}
                            preventFocusOnPress
                            data-show={listBoxItemDataShow.itemBoth}
                            onPress={openNewChat}
                        >
                            <NewChat />
                        </Button>
                    </span>
                }
                data-collapsed={isCollapsed || undefined}
                data-missing={isMissing || undefined}
            >
                <span className={styles.groupTitle}>
                    <span className={styles.groupNameBox} {...ownEvents}>
                        <GroupFolderName
                            name={group.name}
                            folder={group.folder}
                            missing={isMissing}
                            onNewChat={openNewChat}
                        />
                    </span>
                    {/* The way to fold the group. On a folded group it is always there, which says it is folded; on an open one it comes with the pointer or the keyboard. */}
                    <span className={styles.groupFold} {...ownEvents}>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="xs"
                            iconOnly
                            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.name}`}
                            aria-expanded={!isCollapsed}
                            preventFocusOnPress
                            data-show={isCollapsed ? undefined : listBoxItemDataShow.itemBoth}
                            onPress={() => ui.toggleFolderCollapsed(group.folder.id)}
                        >
                            {isCollapsed ? <ChevronRight /> : <ChevronDown />}
                        </Button>
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
                    <GridListItem
                        key={entryKey(entry)}
                        id={entryKey(entry)}
                        text="No chats"
                        icon={<Message />}
                        className={styles.empty}
                        isDisabled
                    >
                        <span className={styles.title}>No chats</span>
                    </GridListItem>
                );
        }
    };

    const renderRow = (row: AgentRow) => {
        const { chat } = row;
        const run = runOf(chat);
        const busy = actions.busy(chat);
        const threads = project
            .threadsBelow(chat.id)
            .some(thread => thread.archivedAt === undefined && asksThePerson(thread, project.runs))
            ? ('asking' as const)
            : project.threadsBelow(chat.id).some(thread => isActiveThread(thread, project.runs))
              ? ('working' as const)
              : undefined;
        const draft = messageOf(draftOf(chat.id)) !== '' || filesOf(chat.id).length > 0;
        const status = <ChatStatus run={run} threads={threads} draft={draft} className={styles.archiveStatus} />;
        const icon = <ChatIcon chat={chat} run={run} threads={threads} showStatus={false} />;

        return (
            <GridListItem
                key={chat.id}
                id={chat.id}
                text={chat.title}
                // Only a row with threads below it has a chevron: on hover it takes the place of the icon, so the row needs no room for it.
                icon={
                    row.childCount > 0 && renamingId !== chat.id ? (
                        <Fold row={row} icon={icon} onToggle={() => ui.toggleChatExpanded(chat.id)} />
                    ) : (
                        icon
                    )
                }
                endAffix={
                    renamingId === chat.id ? (
                        <span {...ownEvents}>
                            <Button
                                variant="filling"
                                color="secondary"
                                size="xs"
                                iconOnly
                                aria-label="Save chat title"
                                tooltip="Save"
                                preventFocusOnPress
                                onPress={() => saveRename.current()}
                            >
                                <Check />
                            </Button>
                        </span>
                    ) : (
                        <RowEnd
                            chat={chat}
                            actions={actions}
                            busy={busy}
                            status={status}
                            isOpen={menuOpenId === chat.id}
                            onOpenChange={open => setMenuOpenId(open ? chat.id : null)}
                            move={menuOpenId === chat.id ? order.actions(chat.id) : undefined}
                        />
                    )
                }
                className={styles.chatRow}
                style={{ '--depth': row.depth } as CSSProperties}
                // The row of an open menu, from its button or the right click, stays as if hovered: the pointer is in the menu, not on the row.
                data-open={menuOpenId === chat.id || (contextMenu.isOpen && menuChat?.id === chat.id) || undefined}
                data-renaming={renamingId === chat.id || undefined}
                data-depth={row.depth}
                data-drop-position={order.drop?.indicatorId === chat.id ? order.drop.position : undefined}
            >
                {renamingId === chat.id ? (
                    <RenameField chat={chat} onDone={() => setRenamingId(null)} saveRename={saveRename} />
                ) : (
                    <span
                        className={styles.titleLine}
                        draggable={row.depth === 0 ? true : undefined}
                        onDragStart={row.depth === 0 ? event => order.start(event, chat.id) : undefined}
                    >
                        <span className={styles.title} onDoubleClick={() => setRenamingId(chat.id)}>
                            {chat.title}
                        </span>
                        {chat.workspace && <WorktreeMark workspace={chat.workspace} read={workspaces} />}
                    </span>
                )}
            </GridListItem>
        );
    };

    return (
        <Panel side="left" className={isCovered ? styles.covered : undefined}>
            <SidebarHeading ref={heading} title={<ProjectSelect />} className={styles.heading}>
                <ArchiveButton anchor={heading} />
                <FilterMenu />
            </SidebarHeading>

            <PanelContent contentClass={styles.content}>
                <div
                    ref={list}
                    onClickCapture={onClick}
                    onContextMenu={openContextMenu}
                    onKeyDownCapture={onKeyDownCapture}
                    {...order.handlers}
                >
                    <GridList
                        aria-label="Agents"
                        size="md"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={selectedId}
                        onSelectionChange={keys => {
                            const [id] = keys === 'all' ? [] : keys;

                            if (id !== undefined) select(String(id));
                        }}
                    >
                        <GridListItem
                            id={NEW_CHAT_ROW}
                            text="New chat"
                            icon={<NewChat />}
                            className={styles.newChat}
                            // The shortcut is a hint for the pointer on its way to the row, not a label the row wears at rest.
                            endAffix={
                                <span className={styles.end} data-show={listBoxItemDataShow.itemHover}>
                                    <CommandHotkey id={NEW_CHAT_COMMAND} size="xs" />
                                </span>
                            }
                        >
                            <span className={styles.title}>New chat</span>
                        </GridListItem>
                        {entries.map(renderEntry)}
                    </GridList>
                </div>
            </PanelContent>

            <StarCard />

            <Show when={contextMenu.isOpen ? menuChat : null}>
                {chat => (
                    <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
                        <ChatMenu
                            busy={actions.busy(chat)}
                            onClose={contextMenu.close}
                            onRename={() => actions.rename(chat)}
                            onArchive={() => actions.archive(chat)}
                            onDelete={() => actions.remove(chat)}
                            {...order.actions(chat.id)}
                        />
                    </Popover>
                )}
            </Show>
        </Panel>
    );
}

/**
 * The header's `⋯`: whether the list shows finished threads and whether chats stand in groups by folder.
 */
function FilterMenu() {
    const ui = useProjectUi();
    const { showFinishedThreads } = chatListPreferences;
    const [isOpen, setIsOpen] = useState(false);
    const shown = [...(showFinishedThreads ? ['finished'] : []), ...(ui.groupByFolder ? ['folders'] : [])];

    return (
        <PopoverTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
            <Button variant="filling" size="sm" iconOnly aria-label="Filters" tooltip="Filters">
                <More />
            </Button>
            <Popover placement="bottom end" spacing="xs" width={240}>
                <PopoverScroll>
                    <Menu aria-label="Filters" size="sm">
                        <MenuSection
                            aria-label="Show"
                            selectionMode="multiple"
                            selectedKeys={shown}
                            onSelectionChange={keys => {
                                const on = (key: string) => keys === 'all' || keys.has(key);

                                if (on('finished') !== showFinishedThreads)
                                    chatListPreferences.setShowFinishedThreads(!showFinishedThreads);
                                if (on('folders') !== ui.groupByFolder) ui.setGroupByFolder(!ui.groupByFolder);
                            }}
                        >
                            <MenuItem
                                id="finished"
                                textValue="Show finished sub-threads"
                                endAffix={showFinishedThreads ? <Check /> : undefined}
                            >
                                Show finished sub-threads
                            </MenuItem>
                            <MenuItem
                                id="folders"
                                textValue="Group chats by folder"
                                endAffix={ui.groupByFolder ? <Check /> : undefined}
                            >
                                Group chats by folder
                            </MenuItem>
                        </MenuSection>
                    </Menu>
                </PopoverScroll>
            </Popover>
        </PopoverTrigger>
    );
}

/**
 * The mark of a chat that works in a worktree: a branch icon after its title, whose own title names the branch. The branch is the one the worktree has now when the daemon's
 * read has it (an agent may have switched), else the one it was made with, which only a list that has not heard of the worktree yet can still show.
 */
function WorktreeMark({
    workspace,
    read,
}: {
    workspace: ChatWorkspace;
    read: readonly ProjectWorkspaceInfo[] | undefined;
}) {
    const head = workspaceHead(workspace, read);
    const branch = head?.branch ?? workspace.branch;
    const title = head?.gone
        ? 'The worktree no longer exists'
        : branch
          ? `Works in a worktree on ${branch}`
          : 'Works in a worktree';

    return (
        <Tooltip content={title}>
            <span className={styles.worktree} role="img" aria-label={title} data-gone={head?.gone || undefined}>
                <Version aria-hidden="true" />
            </span>
        </Tooltip>
    );
}

/** The icon of a row that has threads below it: on hover the chevron that folds them takes its place, in the same room. */
function Fold({ row, icon, onToggle }: { row: AgentRow; icon: ReactNode; onToggle: () => void }) {
    return (
        <span className={styles.foldIcon}>
            <span className={styles.restIcon} data-show={listBoxItemDataShow.itemRest}>
                {icon}
            </span>
            {/* The button is a React child of the row, so its clicks and keys would reach the row through the tree. */}
            <span className={styles.fold} data-show={listBoxItemDataShow.itemHover} {...ownEvents}>
                <Button
                    variant="filling"
                    color="secondary"
                    size="xs"
                    iconOnly
                    tabIndex={-1}
                    aria-label={
                        row.isExpanded ? `Collapse ${row.chat.title} threads` : `Expand ${row.chat.title} threads`
                    }
                    aria-expanded={row.isExpanded}
                    preventFocusOnPress
                    onPress={onToggle}
                >
                    {row.isExpanded ? <ChevronDown /> : <ChevronRight />}
                </Button>
            </span>
        </span>
    );
}

/** The activity indicator takes the archive shortcut's place while the chat or its threads are active. */
function RowEnd({
    chat,
    actions,
    busy,
    status,
    isOpen,
    onOpenChange,
    move,
}: {
    chat: Chat;
    actions: ChatActions;
    busy: string | undefined;
    status: ReactNode;
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    move?: { onMoveUp?: () => void; onMoveDown?: () => void };
}) {
    const close = () => onOpenChange(false);

    return (
        // The buttons and the popover are React children of the row, so their clicks and keys would reach the row through the tree.
        <span className={styles.chatActions} {...ownEvents}>
            {status}
            {!busy && (
                <Button
                    className={styles.rowAction}
                    variant="filling"
                    color="secondary"
                    size="xs"
                    iconOnly
                    aria-label="Archive"
                    tooltip="Archive"
                    preventFocusOnPress
                    onPress={() => actions.archive(chat)}
                >
                    <Archive />
                </Button>
            )}
            <PopoverTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
                <Button
                    className={styles.rowAction}
                    variant="filling"
                    color="secondary"
                    size="xs"
                    iconOnly
                    aria-label="Chat actions"
                    preventFocusOnPress
                >
                    <More />
                </Button>
                <Popover placement="bottom end" spacing="xs">
                    <ChatMenu
                        busy={busy}
                        onClose={close}
                        onRename={() => actions.rename(chat)}
                        onArchive={() => actions.archive(chat)}
                        onDelete={() => actions.remove(chat)}
                        {...move}
                    />
                </Popover>
            </PopoverTrigger>
        </span>
    );
}

/** The title as a field in the title's own place: Enter or leaving it renames, Escape keeps the old name. */
function RenameField({
    chat,
    onDone,
    saveRename,
}: {
    chat: Chat;
    onDone: () => void;
    saveRename: { current: () => void };
}) {
    const root = useRootStore();
    const [title, setTitle] = useState(chat.title);
    const finished = useRef(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const commit = () => {
        if (finished.current) return;
        finished.current = true;
        const next = title.trim();

        onDone();

        if (next && next !== chat.title) void perform(root, { type: 'chat.rename', chatId: chat.id, title: next });
    };
    saveRename.current = commit;
    const edit = useCellEditMode(event => {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            commit();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            finished.current = true;
            onDone();
        }
    }, inputRef);

    return (
        <Input
            type="text"
            variant="inline"
            aria-label="Chat title"
            autoFocus
            autoSelect
            inputRef={inputRef}
            value={title}
            onChange={setTitle}
            onFocus={edit.onFocus}
            onBlur={event => {
                edit.onBlur(event);
                commit();
            }}
        />
    );
}
