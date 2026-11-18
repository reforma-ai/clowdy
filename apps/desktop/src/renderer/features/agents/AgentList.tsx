import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { GridList, GridListHeader, GridListItem, GridListSection, listBoxItemDataShow, Menu, MenuItem, useCellEditMode } from '@clowdy/components/List';
import { Panel, PanelContent } from '@clowdy/components/Panel';
import { Popover, PopoverScroll, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Check, Message, More, Plus } from '@clowdy/icons/14';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';

import { CommandHotkey, useCommands, useHotkeyScope } from '../../hotkeys';
import { RUN_STATUS_VIEW, SidebarHeading, StatusDot } from '../../shared';
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
import { agentRows, ancestorIds, chatDotTone, countActiveChildren, describeRun, type AgentRow, type AgentSelection } from './agentTree';

import type { Chat, ChatId, Run } from '@clowdy/protocol';

/** The id of the first row, the one that starts a chat. Chat and run ids never look like it. */
export const NEW_CHAT_ROW = '@new-chat';

/**
 * The icon of a chat's row: the mark of the provider it runs on once it has started (the chat's own, else its orchestrator's), a speech bubble before and for an agent that has no mark.
 * What the orchestrator is doing is a dot on the icon's top right corner (`chatDotTone`), so the row needs no room of its own for it.
 */
function chatIcon(chat: Chat, run: Run | undefined) {
    const engine = chat.engine ?? run?.engine;
    const icon = chat.orchestratorRunId && engine && (PROVIDER_IDS as readonly string[]).includes(engine) ? <ProviderIcon agentId={ engine } size={ 14 } data-provider={ engine } /> : <Message />;
    const tone = chatDotTone(run);

    if (!run || !tone) return icon;

    return (
        <span className={ styles.icon }>
            { icon }
            <span className={ styles.dot } role="img" aria-label={ RUN_STATUS_VIEW[run.status].label }>
                <StatusDot status={ run.status } tone={ tone } className={ styles.dotMark } />
            </span>
        </span>
    );
}

/** A row's `⋯` button and the right-click menu are the same actions; a rename is a rename of the row it started on. */
interface ChatActions {
    rename: (chat: Chat) => void;
    archive: (chat: Chat) => void;
    remove: (chat: Chat) => void;
}

/**
 * The project's agents as a tree: the row that starts a chat, then the chats it is given (newest activity first), each with
 * the runs its orchestrator started below it (its subthreads), and a `⋯` menu with what to show. Archived chats, when
 * shown, are a group of their own at the bottom, headed Archived, with their subthreads still below them.
 */
export function AgentList({ selection, chats }: { selection: AgentSelection; chats: readonly Chat[] }) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [renamingId, setRenamingId] = useState<ChatId | null>(null);
    const [menuChat, setMenuChat] = useState<Chat | null>(null);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const list = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const runOf = (chat: Chat) => (chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined);
    const actions: ChatActions = {
        // The popover hands focus back to its trigger as it closes: starting at once would have that blur end the rename.
        rename: chat => void setTimeout(() => setRenamingId(chat.id), 150),
        archive: chat => void archiveChat(root, ui, chat, chat.archivedAt === undefined, selection.chat?.id === chat.id),
        remove: chat => deleteChat(root, chat, runOf(chat) !== undefined),
    };

    // Archived chats are a group of their own below the rest; their subthreads stay below them, as everywhere.
    const forest = ui.showSubthreads ? project.runTree(ui.showFinished) : [];
    const rows = agentRows(chats.filter(chat => chat.archivedAt === undefined), forest, collapsed);
    const archivedRows = agentRows(chats.filter(chat => chat.archivedAt !== undefined), forest, collapsed);
    const isGrouped = archivedRows.length > 0;
    const activeChildren = countActiveChildren(project.runs.values());
    const selectedId = selection.draft ? NEW_CHAT_ROW : (selection.run?.id ?? selection.chat?.id);

    // A run opened from elsewhere may sit below a fold: open the folds above it.
    useEffect(() => {
        if (!selection.run || !selection.chat) return;

        const above = [selection.chat.id, ...ancestorIds(project.runs, selection.run.id)];

        setCollapsed(current => (above.some(id => current.has(id)) ? new Set([...current].filter(id => !above.includes(id))) : current));
    }, [selection.run?.id, selection.chat?.id, project.runs]);

    const toggle = (id: string) => setCollapsed((current) => {
        const next = new Set(current);

        if (!next.delete(id)) next.add(id);

        return next;
    });

    useHotkeyScope(AGENTS_SCOPE);
    useCommands(AGENTS_SCOPE, agentCommands({
        list: () => list.current,
        ids: () => [NEW_CHAT_ROW, ...rows.map(row => row.id), ...archivedRows.map(row => row.id)],
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

    // The grid list keeps the arrows between rows; Right opens a fold and Left closes it.
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const { target } = event;

        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'row') return;

        const row = rows.find(candidate => candidate.id === target.dataset.key);

        if (!row || row.childCount === 0) return;

        if ((event.key === 'ArrowRight' && !row.isExpanded) || (event.key === 'ArrowLeft' && row.isExpanded)) {
            toggle(row.id);
            event.preventDefault();
        }
    };

    const select = (id: string) => {
        if (id === NEW_CHAT_ROW) ui.openDraft();
        else if (project.chats.has(id)) ui.openChat(id);
        else ui.openRun(id);
    };

    const renderRow = (row: AgentRow) => {
        // Only a row with rows below it has a chevron, and it takes no room: the icons stay where the list puts them.
        const fold = row.childCount > 0 ? <Fold row={ row } onToggle={ () => toggle(row.id) } /> : undefined;

        if (row.kind === 'chat') {
            const { chat } = row;

            return (
                <GridListItem
                    key={ chat.id }
                    id={ chat.id }
                    text={ chat.title }
                    startAffix={ fold }
                    icon={ chatIcon(chat, runOf(chat)) }
                    endAffix={ renamingId === chat.id ? undefined : <RowEnd chat={ chat } actions={ actions } /> }
                >
                    { renamingId === chat.id
                        ? <RenameField chat={ chat } onDone={ () => setRenamingId(null) } />
                        : <span className={ styles.title } onDoubleClick={ () => setRenamingId(chat.id) }>{ chat.title }</span> }
                </GridListItem>
            );
        }

        const { run } = row;
        const note = describeRun(run, activeChildren.get(run.id) ?? 0);

        return (
            <GridListItem
                key={ run.id }
                id={ run.id }
                text={ run.name }
                startAffix={ fold }
                icon={ <StatusDot status={ run.status } /> }
                description={ note?.text ?? (run.summary || undefined) }
                className={ styles.nested }
                style={ { '--depth': row.depth } as CSSProperties }
            >
                <span className={ styles.title }>{ run.name }</span>
            </GridListItem>
        );
    };

    return (
        <Panel side="left">
            <SidebarHeading title="Agents" className={ styles.heading }>
                <FilterMenu />
            </SidebarHeading>

            <PanelContent contentClass={ styles.content }>
                <div ref={ list } onContextMenu={ openContextMenu } onKeyDown={ onKeyDown }>
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
                        <GridListSection aria-label={ isGrouped ? 'New chat' : 'Chats' }>
                            <GridListItem
                                id={ NEW_CHAT_ROW }
                                text="New chat"
                                icon={ <Plus /> }
                                // The shortcut is a hint for the pointer on its way to the row, not a label the row wears at rest.
                                endAffix={ (
                                    <span className={ styles.end } data-show={ listBoxItemDataShow.itemHover }>
                                        <CommandHotkey id={ NEW_CHAT_COMMAND } size="xs" />
                                    </span>
                                ) }
                            >
                                <span className={ styles.title }>New chat</span>
                            </GridListItem>
                            { !isGrouped && rows.map(renderRow) }
                        </GridListSection>
                        {/* Once there is an Archived group the others need a name too, or the first reads as the list and the second as an afterthought. */}
                        { isGrouped && rows.length > 0 && (
                            <GridListSection>
                                <GridListHeader>Active</GridListHeader>
                                { rows.map(renderRow) }
                            </GridListSection>
                        ) }
                        { isGrouped && (
                            <GridListSection>
                                <GridListHeader>Archived</GridListHeader>
                                { archivedRows.map(renderRow) }
                            </GridListSection>
                        ) }
                    </GridList>
                </div>
            </PanelContent>

            <Show when={ contextMenu.isOpen ? menuChat : null }>
                { chat => (
                    <Popover { ...contextMenu.popoverProps } placement="bottom start" spacing="xs">
                        <ChatMenu
                            isBusy={ isRunActive(runOf(chat)) }
                            isArchived={ chat.archivedAt !== undefined }
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

/** The header's `⋯`: what the list shows. Checked entries are on. */
function FilterMenu() {
    const ui = useProjectUi();
    const [isOpen, setIsOpen] = useState(false);
    const on = new Set<string>([ui.showSubthreads && 'subthreads', ui.showFinished && 'finished', ui.showArchived && 'archived'].filter((key): key is string => Boolean(key)));

    return (
        <PopoverTrigger isOpen={ isOpen } onOpenChange={ setIsOpen }>
            <Button variant="filling" size="sm" iconOnly aria-label="Filters" tooltip="Filters">
                <More />
            </Button>
            <Popover placement="bottom end" spacing="xs" width={ 240 }>
                <PopoverScroll>
                    <Menu
                        aria-label="Filters"
                        size="sm"
                        selectionMode="multiple"
                        selectedKeys={ on }
                        onSelectionChange={ (keys) => {
                            const next = keys === 'all' ? new Set(['subthreads', 'finished', 'archived']) : new Set(keys);

                            ui.setShowSubthreads(next.has('subthreads'));
                            ui.setShowFinished(next.has('finished'));
                            ui.setShowArchived(next.has('archived'));
                        } }
                    >
                        <MenuItem id="subthreads" textValue="Show subthreads" endAffix={ on.has('subthreads') ? <Check /> : undefined }>Show subthreads</MenuItem>
                        <MenuItem id="finished" textValue="Show finished subthreads" isDisabled={ !ui.showSubthreads } endAffix={ on.has('finished') ? <Check /> : undefined }>
                            Show finished subthreads
                        </MenuItem>
                        <MenuItem id="archived" textValue="Show archived" endAffix={ on.has('archived') ? <Check /> : undefined }>Show archived</MenuItem>
                    </Menu>
                </PopoverScroll>
            </Popover>
        </PopoverTrigger>
    );
}

/** The chevron of a row that has rows below it, drawn in the row's left padding. */
function Fold({ row, onToggle }: { row: AgentRow; onToggle: () => void }) {
    const name = row.kind === 'chat' ? row.chat.title : row.run.name;

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
                aria-label={ row.isExpanded ? `Collapse ${ name }` : `Expand ${ name }` }
                aria-expanded={ row.isExpanded }
                onClick={ onToggle }
            >
                { row.isExpanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden /> }
            </button>
        </span>
    );
}

/** The `⋯` menu button, on hover. */
function RowEnd({ chat, actions }: { chat: Chat; actions: ChatActions }) {
    const project = useProjectState();
    const [isOpen, setIsOpen] = useState(false);
    const run = chat.orchestratorRunId ? project.runs.get(chat.orchestratorRunId) : undefined;
    const close = () => setIsOpen(false);

    return (
        <span className={ styles.end }>
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
                            isArchived={ chat.archivedAt !== undefined }
                            onClose={ close }
                            onRename={ () => actions.rename(chat) }
                            onArchive={ () => actions.archive(chat) }
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
