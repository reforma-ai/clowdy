import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import {
    GridList,
    GridListItem,
    GridListSection,
    RowActionButton,
    RowControls,
    useCellEditMode,
} from '@clowdy/components/List';
import { Panel, PanelContent } from '@clowdy/components/Panel';
import { Popover, PopoverTrigger, useContextMenu } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Tooltip } from '@clowdy/components/Tooltip';
import { Archive, Check, Close, Message, More, NewChat, Plus, Robot2, Summary } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { mainFolder } from '@clowdy/protocol';
import {
    type CSSProperties,
    type KeyboardEvent,
    type MouseEvent,
    memo,
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';

import { hotkeys, useCommands, useHotkeyScope } from '../../hotkeys';
import { SidebarHeading, useRunLabel } from '../../shared';
import { ProjectIcon } from '../../shared/ProjectIcon';
import { useFileDragHover } from '../../shared/useFileDragHover';
import { ProjectSelect } from '../../shell/ProjectSelect';
import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import {
    type BranchPullRequestKey,
    type BranchPullRequests,
    branchPullRequestsOf,
} from '../changes/branchPullRequests';
import { archiveChat, archiveRun } from '../chats/archiveChat';
import { ChatMenu } from '../chats/ChatMenu';
import { isRunActive } from '../chats/chatRun';
import { perform } from '../chats/commands';
import { draftOf, messageOf, useDraftRevision } from '../chats/composerDrafts';
import { filesOf, useDraftFilesRevision } from '../chats/composerFiles';
import { deleteChat } from '../chats/deleteChat';
import { isDraftSending } from '../chats/draftSending';
import { workspaceHead } from '../openWith/workspaceHead';
import styles from './AgentList.module.css';
import { ArchiveButton, WorktreeArchiveButton } from './ArchiveButton';
import { AGENTS_SCOPE, agentCommands } from './agentCommands';
import {
    type AgentGroup,
    type AgentRow,
    type AgentSelection,
    agentGroups,
    agentRows,
    agentsWorkingInside,
    ancestorChats,
    asksThePerson,
    busySubagents,
    type ChatRow,
    chatDotTone,
    folderById,
    groupFolderOf,
    isActiveThread,
    nativeAgentsByRoot,
    orchestratorOf,
    type SubagentRow,
} from './agentTree';
import { BranchPullRequestBadge } from './BranchPullRequestBadge';
import { ChatIcon, ChatStatus } from './ChatIcon';
import { chatListPreferences } from './chatListPreferences';
import { ManageWorktreesButton } from './ManageWorktreesButton';
import { openNewChat } from './openNewChat';
import { ProjectMenu } from './ProjectMenu';
import { RowFold } from './RowFold';
import { StarCard } from './StarCard';
import { SubagentMenu } from './SubagentMenu';
import { useChatListOrder } from './useChatListOrder';
import { WorktreeCardHeader } from './WorktreeCardHeader';
import { chatWorktreeKey, type WorktreeCard, worktreeCards, worktreeKey, worktreeRank } from './worktreeCards';

import type { Chat, ChatId, FolderId, FolderWorktrees, ProjectInfo, Run } from '@clowdy/protocol';
import type { NewChatDraft } from '../../stores/NewChatDrafts';

const NO_RUNS: readonly Run[] = [];

/** The ids of the rows a grouped list adds: the heading of a folder's group, and the row of a group with no chat. Chat ids never look like them. */
const GROUP_PREFIX = '@folder:';
const EMPTY_PREFIX = '@empty:';
const LINKED_THREAD_PREFIX = '@linked-thread:';
const ARCHIVE_PREFIX = '@archive:';
const groupKey = (folderId: FolderId) => `${GROUP_PREFIX}${folderId}`;

/** What a line of the list is: a chat (or a thread) or a sub-agent of one; the heading of a folder's group, or the note of a group that has no chat. */
type ListEntry =
    | { kind: 'row'; row: AgentRow }
    | { kind: 'draft'; draft: NewChatDraft }
    | { kind: 'group'; group: AgentGroup; isCollapsed: boolean }
    | { kind: 'empty'; folderId: FolderId }
    | {
          kind: 'worktree';
          card: WorktreeCard;
          isCollapsed: boolean;
          rows: AgentRow[];
          drafts: NewChatDraft[];
          linkedThreads: Chat[];
      };

/** The key of a line's row in the grid list: a chat's id, a sub-agent's run id, or the id of a heading or a note. */
const entryKey = (entry: ListEntry) =>
    entry.kind === 'draft'
        ? `@draft:${entry.draft.id}`
        : entry.kind === 'row'
          ? entry.row.id
          : entry.kind === 'group'
            ? groupKey(entry.group.folder.id)
            : entry.kind === 'worktree'
              ? entry.card.key
              : `${EMPTY_PREFIX}${entry.folderId}`;

/** A row's `⋯` button and the right-click menu are the same actions; a rename is a rename of the row it started on. */
interface ChatActions {
    rename: (chat: Chat) => void;
    archive: (chat: Chat) => void;
    remove: (chat: Chat) => void;
    /** Why the chat can be neither archived nor deleted now; absent when it can. */
    busy: (chat: Chat) => string | undefined;
}

/**
 * The project's agents: the row that starts a chat, then the chats in use in the person's order, each with what works for it below: the native sub-agents it
 * started and the threads its agents started in one list, oldest first, folded until the person opens them, except what works (with Expand working threads on)
 * or waits for the person. Archived chats are not here, they are in the archive's list (the button
 * in the heading, beside the project menu), and take their threads with them. `missing` are the folders gone from the disk (`Screen` reads them once for the list and the new-chat page): their group is marked and its button is off. With the menu's folder layout (the default), the
 * chats stand in a group for the folder they work in, under a heading that folds the group. Its title folds the group, and its actions offer a new chat in that folder.
 */
export function AgentList({
    selection,
    chats,
    missing,
    isCovered,
    projectInfo,
    sidebarWorktrees,
    preview = false,
}: {
    selection: AgentSelection;
    chats: readonly Chat[];
    missing: ReadonlySet<FolderId>;
    /** The side panel is in the place of the chat, so the list is a plate of its own. */
    isCovered: boolean;
    projectInfo?: ProjectInfo;
    sidebarWorktrees?: readonly FolderWorktrees[];
    preview?: boolean;
}) {
    const root = useRootStore();
    useDraftRevision();
    useDraftFilesRevision();
    const project = useProjectState();
    const ui = useProjectUi();
    const runLabel = useRunLabel();
    const [archiveOpenKey, setArchiveOpenKey] = useState<string | null>(null);
    const [renamingId, setRenamingId] = useState<ChatId | null>(null);
    const saveRename = useRef<() => void>(() => {});
    const [menuChat, setMenuChat] = useState<Chat | null>(null);
    // The sub-agent whose right-click menu is open; at most one of this and `menuChat` is set.
    const [menuRun, setMenuRun] = useState<Run | null>(null);
    // The chat whose `⋯` menu is open: its row keeps the hover plate while the pointer is in the menu.
    const [menuOpenId, setMenuOpenId] = useState<ChatId | null>(null);
    const list = useRef<HTMLDivElement>(null);
    const heading = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu();
    const histories = branchPullRequestsOf(root.transport);
    useEffect(() => {
        if (!projectInfo) return;
        for (const workspace of projectInfo.workspaces ?? []) {
            if (workspace.exists)
                histories.rememberWorkspaceBranch(
                    projectInfo.projectId,
                    workspace.workspaceId,
                    workspace.detached ? null : (workspace.branch ?? null)
                );
        }
    }, [projectInfo, histories]);

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

    // The chat of a sub-agent whose page is open is the open chat too, and the sub-agent's row is the selected one (the chat's row is, while that has none). The new-chat page has none.
    const openChatId = selection.draft ? undefined : selection.chat?.id;
    const openRun = selection.draft ? undefined : selection.run;
    const { folders } = project.project;
    const grouped = ui.groupByFolder;
    const groupedByWorktree = ui.groupByWorktree;
    const actual = sidebarWorktrees;
    const draftItems = ui.newChatDrafts.drafts;
    const draftFolder = (draft: NewChatDraft) =>
        folders.find(folder => folder.id === draft.folderId)?.id ?? mainFolder(project.project).id;
    const additionalDraftKey = (draft: NewChatDraft) =>
        draft.workspace?.mode === 'existing' ? worktreeKey(draftFolder(draft), draft.workspace.path) : undefined;
    const additionalCards = worktreeCards(
        chats,
        project.chats.values(),
        folders,
        actual,
        projectInfo,
        ui.worktreeOrder
    );
    // Remember Git's canonical path as soon as it is known, including for archived chats.
    useEffect(() => {
        if (preview) return;
        const aliases = new Map(
            additionalCards.flatMap(card => (card.orderAliases ?? []).map(alias => [alias, card.key] as const))
        );
        const next = [
            ...new Set(ui.worktreeOrder.flatMap(key => (aliases.has(key) ? [aliases.get(key)!, key] : [key]))),
        ];
        if (next.length !== ui.worktreeOrder.length || next.some((key, index) => key !== ui.worktreeOrder[index]))
            ui.setWorktreeOrder(next);
    });
    for (const draft of draftItems) {
        const key = additionalDraftKey(draft);
        if (!key || additionalCards.some(card => card.key === key) || draft.workspace?.mode !== 'existing') continue;
        const folder = folders.find(candidate => candidate.id === draftFolder(draft));
        if (!folder) continue;
        additionalCards.push({
            key,
            folder,
            folderName: agentGroups([], folders).find(group => group.folder.id === folder.id)?.name ?? folder.path,
            path: draft.workspace.path,
            missing: false,
            pending: true,
            used: false,
            roots: [],
            linkedChats: [],
        });
    }
    const { showFinishedThreads, expandRunningAgents, showUnusedWorktrees } = chatListPreferences;
    const shownAdditional = additionalCards.filter(
        card =>
            draftItems.some(draft => additionalDraftKey(draft) === card.key) ||
            card.roots.length > 0 ||
            showUnusedWorktrees
    );
    const mainCards: WorktreeCard[] = groupedByWorktree
        ? agentGroups(chats, folders).flatMap(group => {
              const roots = group.roots.filter(chat => !chat.workspace);
              return [
                  {
                      key: worktreeKey(group.folder.id, group.folder.path),
                      main: true,
                      folder: group.folder,
                      folderName: group.name,
                      path: group.folder.path,
                      missing: missing.has(group.folder.id),
                      pending: false,
                      used: true,
                      roots,
                      linkedChats: [...project.chats.values()].filter(
                          chat =>
                              !chat.workspace &&
                              chat.archivedAt === undefined &&
                              folderById(folders, chat.folderId).id === group.folder.id
                      ),
                  },
              ];
          })
        : [];
    const draftCardKey = (draft: NewChatDraft) =>
        additionalDraftKey(draft) ??
        (draft.workspace?.mode !== 'existing'
            ? mainCards.find(card => card.folder.id === draftFolder(draft))?.key
            : undefined);
    const rank = new Map(ui.worktreeOrder.map((key, index) => [key, index]));
    const cards = [...mainCards, ...additionalCards].sort(
        (a, b) =>
            folders.indexOf(a.folder) - folders.indexOf(b.folder) ||
            Number(Boolean(b.main)) - Number(Boolean(a.main)) ||
            worktreeRank(a, rank) - worktreeRank(b, rank)
    );
    const shownCards = cards.filter(card => card.main || shownAdditional.includes(card));
    const order = useChatListOrder(chats, openChatId, cards, shownCards);
    // The sub-agents of every chat, found in one pass over the project's runs and not once per chat.
    const agentsByRoot = nativeAgentsByRoot(project.runs.values());
    const agentsOf = (chat: Chat): readonly Run[] =>
        (chat.orchestratorRunId !== undefined && agentsByRoot.get(chat.orchestratorRunId)) || NO_RUNS;
    // Put away from a row of a sub-agent. The rows are memoised, so the handler they get never changes; it reads the page that is open when it is pressed.
    const archiveSubagent = useRef<(run: Run) => void>(() => {});
    archiveSubagent.current = run =>
        void archiveRun(root, project, ui, run, selection.draft ? undefined : selection.run);
    const onArchiveSubagent = useCallback((run: Run) => archiveSubagent.current(run), []);
    // The daemon refuses a sub-agent that works, or that started one that does: the row offers no Archive then.
    const busySubagentIds = busySubagents(project.runs);
    const rowsOf = (roots: readonly Chat[]) =>
        agentRows({
            roots,
            threadsOf: chatId => project.threadsOf(chatId),
            runs: project.runs,
            agentsOf,
            expanded: new Set(ui.expandedChats),
            showFinished: showFinishedThreads,
            expandRunning: expandRunningAgents,
            openChatId,
            openRunId: openRun?.id,
        });
    const rowEntries = (roots: readonly Chat[]): ListEntry[] => rowsOf(roots).map(row => ({ kind: 'row', row }));
    const entries: ListEntry[] = groupedByWorktree
        ? shownCards.map(card => {
              const isCollapsed = ui.collapsedWorktrees.includes(card.key);
              return {
                  kind: 'worktree' as const,
                  card,
                  isCollapsed,
                  rows: isCollapsed ? [] : rowsOf(card.roots),
                  drafts: isCollapsed ? [] : draftItems.filter(draft => draftCardKey(draft) === card.key),
                  linkedThreads: isCollapsed
                      ? []
                      : card.linkedChats.filter(
                            chat =>
                                chat.parentChatId &&
                                !card.roots.some(root => root.id === chat.id) &&
                                !ancestorChats(project.chats, chat.id).some(ancestor =>
                                    card.roots.some(root => root.id === ancestor.id)
                                )
                        ),
              };
          })
        : grouped
          ? agentGroups(chats, folders).flatMap((group): ListEntry[] => {
                const isCollapsed = ui.collapsedFolders.includes(group.folder.id);
                const body = isCollapsed
                    ? []
                    : [
                          ...draftItems
                              .filter(draft => draftFolder(draft) === group.folder.id)
                              .map(draft => ({ kind: 'draft' as const, draft })),
                          ...rowEntries(group.roots),
                      ];
                return [
                    { kind: 'group', group, isCollapsed },
                    ...(isCollapsed || body.length ? body : [{ kind: 'empty' as const, folderId: group.folder.id }]),
                ];
            })
          : [...draftItems.map(draft => ({ kind: 'draft' as const, draft })), ...rowEntries(chats)];

    const visibleRows = new Map<string, AgentRow>();
    const navigationIds = entries.flatMap(entry => {
        if (entry.kind === 'empty') return [];
        const rows = entry.kind === 'worktree' ? entry.rows : entry.kind === 'row' ? [entry.row] : [];
        for (const row of rows) visibleRows.set(row.id, row);
        return entry.kind === 'worktree'
            ? [
                  entryKey(entry),
                  ...entry.drafts.map(draft => `@draft:${draft.id}`),
                  ...rows.map(row => row.id),
                  ...entry.linkedThreads.map(chat => `${LINKED_THREAD_PREFIX}${chat.id}`),
              ]
            : [entryKey(entry)];
    });
    // A sub-agent that has no row (its chat's folder group is folded, or it is no native sub-agent) leaves its chat's row as the open one, so the list never shows nothing open.
    const selectedId = selection.draft
        ? ui.draftId && navigationIds.includes(`@draft:${ui.draftId}`)
            ? `@draft:${ui.draftId}`
            : undefined
        : openRun && navigationIds.includes(openRun.id)
          ? openRun.id
          : openChatId;
    useFileDragHover(
        element => {
            const row = element.closest<HTMLElement>('[role="row"][data-key]');
            const key = row?.dataset.key;
            return row && list.current?.contains(row) && key && project.chats.has(key) ? key : undefined;
        },
        id => {
            if (id !== selectedId) ui.openChat(id);
            else if (isCovered) ui.showChat();
        }
    );

    // A thread opened from elsewhere (a chip, a card, back and forward, the keyboard) may sit below a fold: open the folds above it, and the folded group of
    // the chat it belongs to. A sub-agent needs no fold of its chat opened: its row stands below a folded chat while it is the open page. When the open page
    // changes, and when the list turns grouped; not on other changes, so the person can still fold the chat or the group it sits in.
    const openRunId = openRun?.id;
    const opened = openChatId ? project.chats.get(openChatId) : undefined;
    const ancestors = opened ? ancestorChats(project.chats, opened.id) : [];
    // An unarchived child whose parent is archived/missing is itself a visible root.
    const rootChat = opened && [opened, ...ancestors].find(chat => chats.some(root => root.id === chat.id));
    const selectedCard =
        groupedByWorktree && rootChat
            ? (chatWorktreeKey(rootChat, cards) ?? mainCards.find(card => card.roots.includes(rootChat))?.key)
            : undefined;
    const selectedFolder = selectedCard ? cards.find(card => card.key === selectedCard)?.folder.id : undefined;
    const activeDraft = ui.draftId ? ui.newChatDrafts.get(ui.draftId) : undefined;
    const activeDraftFolder = activeDraft ? draftFolder(activeDraft) : undefined;
    const activeDraftCard = activeDraft ? draftCardKey(activeDraft) : undefined;
    useEffect(() => {
        if (preview) return;
        if (!selection.draft) return;
        if (grouped && activeDraftFolder) ui.expandFolder(activeDraftFolder);
        if (groupedByWorktree && activeDraftCard) ui.expandWorktree(activeDraftCard);
    }, [preview, selection.draft, ui.draftId, activeDraftFolder, activeDraftCard, grouped, groupedByWorktree, ui]);
    useEffect(() => {
        if (preview) return;
        if (openChatId === undefined) return;

        ui.expandChats(ancestorChats(project.chats, openChatId).map(chat => chat.id));

        const folderId = grouped
            ? (selectedFolder ?? groupFolderOf(project.chats, project.project.folders, openChatId))
            : undefined;

        if (folderId !== undefined) ui.expandFolder(folderId);
        if (selectedCard) ui.expandWorktree(selectedCard);
    }, [preview, openChatId, openRunId, grouped, selectedCard, selectedFolder, project, ui]);

    useHotkeyScope(AGENTS_SCOPE, hotkeys, !preview);
    useCommands(
        AGENTS_SCOPE,
        agentCommands({
            list: () => list.current,
            // The headings are rows the arrows stop on, so they are in the order J and K step through; a group's note has no focus.
            ids: () => navigationIds,
            openId: () => selectedId,
        }),
        hotkeys,
        !preview
    );

    // Right-click anywhere on a chat's row, or on the row of a sub-agent that is over: the rows are the list's own elements, so the click is found by its row's key.
    const openContextMenu = (event: MouseEvent) => {
        const key = (event.target as Element).closest('[role="row"]')?.getAttribute('data-key');
        const chat = key ? project.chats.get(key) : undefined;
        const row = key ? visibleRows.get(key) : undefined;
        const run = row?.kind === 'subagent' && !busySubagentIds.has(row.id) ? row.run : undefined;

        if (!chat && !run) return;

        setMenuChat(chat ?? null);
        setMenuRun(run ?? null);
        contextMenu.areaProps.onContextMenu(event);
    };

    /** The fold a row has, if any: the threads of a chat, or the chats of a folder's group. */
    const foldOf = (key: string | undefined): { isExpanded: boolean; toggle: () => void } | undefined => {
        const entry = entries.find(candidate => entryKey(candidate) === key);
        const row = key === undefined ? undefined : visibleRows.get(key);

        // Only a chat has a fold: a sub-agent's row has none.
        if (row && row.childCount > 0)
            return { isExpanded: row.isExpanded, toggle: () => ui.toggleChatExpanded(row.id) };
        if (entry?.kind === 'worktree')
            return { isExpanded: !entry.isCollapsed, toggle: () => ui.toggleWorktreeCollapsed(entry.card.key) };

        if (entry?.kind === 'group')
            return { isExpanded: !entry.isCollapsed, toggle: () => ui.toggleFolderCollapsed(entry.group.folder.id) };

        return undefined;
    };

    // The row that is open is wanted on screen; when it is a chat's only because its sub-agent has no listed row, the chat is wanted, not the sub-agent's page.
    const showSelected = () =>
        openRun && openChatId !== undefined && selectedId === openChatId ? ui.openChat(openChatId) : ui.showChat();

    // The grid list keeps the arrows between rows; Right opens a fold and Left closes it. Read in the capture phase, because a row with buttons moves
    // the focus into them on these keys and stops the event there; one that toggles a fold does not reach the row.
    const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
        const { target } = event;

        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'row') return;

        // Enter or Space on the row of the chat that is open selects nothing new, and the list reports no selection: the chat is still wanted on screen.
        if ((event.key === 'Enter' || event.key === ' ') && target.dataset.key === selectedId) showSelected();

        const folded = foldOf(target.dataset.key);

        if (!folded) return;

        if ((event.key === 'ArrowRight' && !folded.isExpanded) || (event.key === 'ArrowLeft' && folded.isExpanded)) {
            folded.toggle();
            event.preventDefault();
            event.stopPropagation();
        }
    };

    // Row controls handle their own clicks; an open chat stays selected and a folded worktree opens.
    const onClick = (event: MouseEvent) => {
        const target = event.target as Element;
        if (target.closest('button')) return;
        const key = target.closest('[role="row"]')?.getAttribute('data-key');
        const entry = entries.find(candidate => entryKey(candidate) === key);

        if (
            entry?.kind === 'worktree' &&
            entry.isCollapsed &&
            (entry.card.used || draftItems.some(draft => draftCardKey(draft) === entry.card.key))
        )
            ui.expandWorktree(entry.card.key);
        else if (key === selectedId) showSelected();
    };

    const select = (id: string) => {
        const row = visibleRows.get(id);

        if (id.startsWith(ARCHIVE_PREFIX)) setArchiveOpenKey(id.slice(ARCHIVE_PREFIX.length));
        else if (id.startsWith(LINKED_THREAD_PREFIX)) ui.openChat(id.slice(LINKED_THREAD_PREFIX.length));
        else if (id.startsWith('@draft:')) ui.openDraftId(id.slice('@draft:'.length));
        else if (row?.kind === 'subagent') ui.openRun(row.id);
        // A heading is a label, not a page: only its chevron, and Right and Left on it, fold the group.
        else if (row?.kind === 'chat') ui.openChat(id);
    };

    const renderGroup = (group: AgentGroup, isCollapsed: boolean) => {
        const isMissing = missing.has(group.folder.id);
        const startChat = () => openNewChat(project, ui, group.folder.id);

        return (
            <WorktreeCardHeader
                key={groupKey(group.folder.id)}
                id={groupKey(group.folder.id)}
                card={{
                    key: groupKey(group.folder.id),
                    main: true,
                    folder: group.folder,
                    folderName: group.name,
                    path: group.folder.path,
                    missing: isMissing,
                    pending: false,
                    used: false,
                    roots: [],
                    linkedChats: [],
                }}
                collapsed={isCollapsed}
                onToggle={() => ui.toggleFolderCollapsed(group.folder.id)}
                onNewChat={startChat}
            />
        );
    };

    const cardActivity = (card: WorktreeCard) => {
        const active = [...card.linkedChats, ...card.roots.flatMap(chat => project.threadsBelow(chat.id))].filter(
            chat => chat.archivedAt === undefined
        );
        return active.some(chat => asksThePerson(chat, project.runs))
            ? 'asking'
            : active.some(chat => isActiveThread(chat, project.runs))
              ? 'working'
              : undefined;
    };

    const renderDraft = (draft: NewChatDraft) => {
        const label =
            draft.workspace?.mode === 'new'
                ? 'New worktree'
                : draft.workspace?.mode === 'existing' && !groupedByWorktree
                  ? (cards.find(card => card.key === draftCardKey(draft))?.branch ??
                    draft.workspace.path.split(/[\\/]/).pop())
                  : undefined;
        return (
            <GridListItem
                key={`@draft:${draft.id}`}
                id={`@draft:${draft.id}`}
                text="New chat"
                icon={<Plus />}
                className={styles.chatRow}
                data-depth={0}
                endAffix={
                    !isDraftSending(`@new-chat:${project.id}:${draft.id}`) &&
                    !draft.operation &&
                    !draft.firstMessage &&
                    !messageOf(draft.doc) &&
                    !draft.attachments?.length &&
                    !draft.reply &&
                    filesOf(`@new-chat:${project.id}:${draft.id}`).length === 0 &&
                    ui.pendingFilesFor(draft.id).length === 0 ? (
                        <RowControls>
                            <RowActionButton
                                icon={<Close />}
                                label="Close draft"
                                onPress={() => {
                                    ui.newChatDrafts.remove(draft.id);
                                    if (ui.draftId === draft.id && !root.history.backInProject())
                                        ui.openChat(ui.chatId);
                                }}
                            />
                        </RowControls>
                    ) : undefined
                }
            >
                <span className={styles.title}>{label ? `New chat — ${label}` : 'New chat'}</span>
            </GridListItem>
        );
    };

    const archivedByCard = new Map<string, (Chat & { archivedAt: number })[]>();
    for (const chat of project.chats.values()) {
        if (chat.archivedAt === undefined) continue;
        const folder = folderById(folders, chat.folderId);
        const key = chat.workspace ? chatWorktreeKey(chat, cards) : worktreeKey(folder.id, folder.path);
        if (!key) continue;
        const list = archivedByCard.get(key) ?? [];
        list.push(chat as Chat & { archivedAt: number });
        archivedByCard.set(key, list);
    }
    for (const list of archivedByCard.values()) list.sort((a, b) => b.archivedAt - a.archivedAt);
    useEffect(() => {
        if (
            archiveOpenKey &&
            (!groupedByWorktree ||
                !archivedByCard.has(archiveOpenKey) ||
                !shownCards.some(card => card.key === archiveOpenKey) ||
                ui.collapsedWorktrees.includes(archiveOpenKey))
        )
            setArchiveOpenKey(null);
    });

    const renderEntry = (entry: ListEntry) => {
        switch (entry.kind) {
            case 'draft':
                return renderDraft(entry.draft);
            case 'row':
                return renderAgentRow(entry.row);
            case 'group':
                return renderGroup(entry.group, entry.isCollapsed);
            case 'worktree': {
                const archived = archivedByCard.get(entry.card.key) ?? [];
                const chatCount = archived.filter(chat => !chat.parentChatId).length;
                const threadCount = archived.length - chatCount;
                const emptyLabel =
                    [
                        chatCount ? `${chatCount} archived ${chatCount === 1 ? 'chat' : 'chats'}` : '',
                        threadCount ? `${threadCount} archived ${threadCount === 1 ? 'thread' : 'threads'}` : '',
                    ]
                        .filter(Boolean)
                        .join(', ') || 'No chats';
                return (
                    <GridListSection
                        key={entry.card.key}
                        id={entry.card.key + ':section'}
                        className={styles.worktreeCard}
                        data-worktree-card={entry.card.key}
                        data-drop-position={
                            order.drop?.indicatorId === entry.card.key ? order.drop.position : undefined
                        }
                    >
                        <WorktreeCardHeader
                            card={entry.card}
                            pullRequestStatus={
                                <BranchPullRequestBadge
                                    className={styles.pullRequests}
                                    branchKey={cardBranchKey(projectInfo, entry.card, histories)}
                                    visible
                                    crossWorktree={false}
                                />
                            }
                            collapsed={entry.isCollapsed}
                            activity={cardActivity(entry.card)}
                            onToggle={() => ui.toggleWorktreeCollapsed(entry.card.key)}
                            onDragStart={event => order.startCard(event, entry.card.key)}
                        />
                        {entry.drafts.map(renderDraft)}
                        {entry.rows.map(row => renderAgentRow(row, entry.card))}
                        {entry.linkedThreads.map(chat => (
                            <GridListItem
                                key={`${LINKED_THREAD_PREFIX}${chat.id}`}
                                id={`${LINKED_THREAD_PREFIX}${chat.id}`}
                                text={`Thread in another chat: ${chat.title}`}
                                icon={<Summary />}
                            >
                                <span
                                    className={styles.title}
                                    title="Also shown under its parent chat"
                                >{`Thread in another chat: ${chat.title}`}</span>
                            </GridListItem>
                        ))}
                        {!entry.isCollapsed &&
                            (archived.length > 0 ||
                                (entry.rows.length === 0 &&
                                    entry.drafts.length === 0 &&
                                    entry.linkedThreads.length === 0)) && (
                                <GridListItem
                                    id={`${archived.length ? ARCHIVE_PREFIX : EMPTY_PREFIX}${entry.card.key}`}
                                    text={emptyLabel}
                                    icon={archived.length ? <Archive /> : <Message />}
                                    className={styles.empty}
                                    isDisabled={archived.length === 0}
                                >
                                    {archived.length ? (
                                        <WorktreeArchiveButton
                                            chats={archived}
                                            label={emptyLabel}
                                            isOpen={archiveOpenKey === entry.card.key}
                                            onOpenChange={open => setArchiveOpenKey(open ? entry.card.key : null)}
                                        />
                                    ) : (
                                        <span className={styles.title}>{emptyLabel}</span>
                                    )}
                                </GridListItem>
                            )}
                    </GridListSection>
                );
            }
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

    const renderAgentRow = (row: AgentRow, card?: WorktreeCard) => {
        switch (row.kind) {
            case 'chat':
                return renderRow(row, card);
            case 'subagent':
                return renderSubagent(row);
        }
    };

    // A sub-agent is the page of its parent's work, not a chat of its own: nothing to rename, delete, move or drag, and the parent's guards and unread mark do not
    // read it. Its row opens the page and shows the state it is in, and once it and what it started are over it offers Archive, as a chat's row does.
    const renderSubagent = ({ run, depth, id }: SubagentRow) => (
        <SubagentItem
            key={id}
            run={run}
            label={runLabel(run)}
            depth={depth}
            drop={order.drop?.indicatorId === id ? order.drop.position : undefined}
            canArchive={!busySubagentIds.has(id)}
            isMenuOpen={contextMenu.isOpen && menuRun?.id === id}
            onArchive={onArchiveSubagent}
        />
    );

    const renderRow = (row: ChatRow, card?: WorktreeCard) => {
        const { chat } = row;
        const run = runOf(chat);
        const busy = actions.busy(chat);
        const below = project.threadsBelow(chat.id);
        // The agents that work inside the chat, its sub-agents and its threads with theirs, whether its row is folded or not and whether the chat works itself. The row says it with
        // an agent icon where its dot would be: a chat with an agent inside and a working dot (or a command's icon) shows the agent icon only, and only what needs the person
        // (a failure, a question, a request) is shown over it. A native sub-agent never asks for the chat's dot or counts as unread: its question is a card in the stream.
        const agentsInside = agentsWorkingInside(chat, below, project.runs, agentsOf);
        const threads = below.some(thread => thread.archivedAt === undefined && asksThePerson(thread, project.runs))
            ? ('asking' as const)
            : agentsInside > 0
              ? ('working' as const)
              : undefined;
        const draft = messageOf(draftOf(chat.id)) !== '' || filesOf(chat.id).length > 0;
        const unread = ui.hasUnreadCompletion(run);
        const showPullRequests = !card || chatDotTone(run, threads, draft, unread) === undefined;
        const status = (
            <ChatStatus
                run={run}
                threads={threads}
                agentsInside={agentsInside}
                draft={draft}
                unread={unread}
                className={styles.archiveStatus}
            />
        );
        const icon = <ChatIcon chat={chat} run={run} threads={threads} showStatus={false} />;
        const parent = chat.parentChatId ? project.chats.get(chat.parentChatId) : undefined;

        return (
            <GridListItem
                key={chat.id}
                id={chat.id}
                text={chat.title}
                // Only a row with threads below it has a chevron: on hover it takes the place of the icon, so the row needs no room for it.
                icon={
                    row.childCount > 0 && renamingId !== chat.id ? (
                        <RowFold
                            label={`${row.isExpanded ? 'Collapse' : 'Expand'} ${chat.title} threads`}
                            isExpanded={row.isExpanded}
                            icon={icon}
                            onToggle={() => ui.toggleChatExpanded(chat.id)}
                        />
                    ) : (
                        icon
                    )
                }
                endAffix={
                    renamingId === chat.id ? (
                        <RowControls>
                            <RowActionButton
                                icon={<Check />}
                                label="Save chat title"
                                tooltip="Save"
                                onPress={() => saveRename.current()}
                            />
                        </RowControls>
                    ) : (
                        <RowEnd
                            chat={chat}
                            actions={actions}
                            busy={busy}
                            status={status}
                            showPullRequests={showPullRequests}
                            crossWorktree={
                                groupedByWorktree &&
                                row.depth > 0 &&
                                parent !== undefined &&
                                chatWorktreeKey(chat, cards) !== chatWorktreeKey(parent, cards)
                            }
                            isOpen={menuOpenId === chat.id}
                            onOpenChange={open => setMenuOpenId(open ? chat.id : null)}
                            branchKey={
                                card &&
                                (chat.workspace
                                    ? chatWorktreeKey(chat, cards) === card.key
                                    : card.main && groupFolderOf(project.chats, folders, chat.id) === card.folder.id)
                                    ? undefined
                                    : chatBranchKey(
                                          projectInfo,
                                          chat.workspace?.folderId ?? groupFolderOf(project.chats, folders, chat.id),
                                          chat,
                                          histories
                                      )
                            }
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
                        className={styles.title}
                        draggable={row.depth === 0 ? true : undefined}
                        onDragStart={row.depth === 0 ? event => order.start(event, chat.id) : undefined}
                        onDoubleClick={() => setRenamingId(chat.id)}
                    >
                        {chat.title}
                    </span>
                )}
            </GridListItem>
        );
    };

    return (
        <Panel side="left" className={isCovered ? styles.covered : undefined}>
            <SidebarHeading ref={heading} title={<ProjectSelect />} className={styles.heading}>
                <ManageWorktreesButton />
                <ArchiveButton anchor={heading} />
                <ProjectMenu />
            </SidebarHeading>

            <PanelContent contentClass={styles.content}>
                <Button
                    variant="bordered"
                    size="sm"
                    fullWidth
                    aria-label="New chat"
                    className={styles.newChat}
                    onPress={() => openNewChat(project, ui)}
                >
                    <Plus aria-hidden="true" /> New chat
                </Button>
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
                        {entries.map(renderEntry)}
                    </GridList>
                </div>
            </PanelContent>

            <StarCard />

            <nav className={styles.projectDots} aria-label="Switch space">
                {[
                    ...root.projects.filter(candidate => candidate.personal),
                    ...root.projects.filter(candidate => !candidate.personal),
                ].map(candidate => (
                    <Tooltip
                        key={candidate.id}
                        placement="top"
                        warmUp
                        content={
                            <span className={styles.projectTooltip}>
                                <ProjectIcon project={candidate} />
                                {candidate.name}
                            </span>
                        }
                    >
                        <button
                            type="button"
                            className={styles.projectDot}
                            aria-label={candidate.name}
                            aria-current={candidate.id === project.id ? 'true' : undefined}
                            onClick={() => root.selectProject(candidate.id)}
                        >
                            <span />
                        </button>
                    </Tooltip>
                ))}
            </nav>

            <Show when={contextMenu.isOpen ? menuChat : null}>
                {chat => (
                    <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
                        <ChatMenu
                            busy={actions.busy(chat)}
                            onClose={contextMenu.close}
                            onRename={() => actions.rename(chat)}
                            onArchive={() => actions.archive(chat)}
                            onDelete={() => actions.remove(chat)}
                        />
                    </Popover>
                )}
            </Show>
            <Show when={contextMenu.isOpen ? menuRun : null}>
                {run => (
                    <Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">
                        <SubagentMenu onClose={contextMenu.close} onArchive={() => onArchiveSubagent(run)} />
                    </Popover>
                )}
            </Show>
        </Panel>
    );
}

/**
 * A sub-agent's row. A component of its own that the list draws again only when its run, its place, its drop mark or what it can do changes, since a chat that
 * ran a workflow lists hundreds of them and every change to any run draws the list again (so `onArchive` must be the same function every time). While it or a
 * sub-agent it started works, the row shows its state; once they are over, its state gives way to Archive on hover, as a chat's row does.
 */
const SubagentItem = memo(function SubagentItem({
    run,
    label,
    depth,
    drop,
    canArchive,
    isMenuOpen,
    onArchive,
}: {
    run: Run;
    label: string;
    depth: number;
    drop: 'before' | 'after' | undefined;
    canArchive: boolean;
    /** Its right-click menu is open: the row stays as if hovered, since the pointer is in the menu. */
    isMenuOpen: boolean;
    onArchive: (run: Run) => void;
}) {
    return (
        <GridListItem
            id={run.id}
            text={label}
            icon={<Robot2 />}
            endAffix={
                canArchive ? (
                    <RowControls className={styles.chatActions}>
                        <ChatStatus run={run} className={styles.archiveStatus} />
                        <RowActionButton
                            className={cn(styles.rowAction, styles.archiveAction)}
                            icon={<Archive />}
                            label="Archive"
                            onPress={() => onArchive(run)}
                        />
                    </RowControls>
                ) : (
                    <span className={styles.agentStatus}>
                        <ChatStatus run={run} />
                    </span>
                )
            }
            className={cn(styles.agentRow, canArchive && styles.archivable)}
            style={{ '--depth': depth } as CSSProperties}
            data-depth={depth}
            data-drop-position={drop}
            data-open={isMenuOpen || undefined}
        >
            <span className={styles.title} title={label}>
                {label}
            </span>
        </GridListItem>
    );
});

/** Chat actions appear to the left of the status indicators. */
function RowEnd({
    chat,
    actions,
    busy,
    status,
    isOpen,
    onOpenChange,
    branchKey,
    showPullRequests,
    crossWorktree,
}: {
    chat: Chat;
    actions: ChatActions;
    busy: string | undefined;
    status: ReactNode;
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    branchKey?: BranchPullRequestKey;
    showPullRequests: boolean;
    crossWorktree: boolean;
}) {
    const close = () => onOpenChange(false);

    return (
        <RowControls className={styles.chatActions}>
            <PopoverTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
                <RowActionButton className={styles.rowAction} icon={<More />} label="Chat actions" tooltip={null} />
                <Popover placement="bottom end" spacing="xs">
                    <ChatMenu
                        busy={busy}
                        onClose={close}
                        onRename={() => actions.rename(chat)}
                        onArchive={() => actions.archive(chat)}
                        onDelete={() => actions.remove(chat)}
                    />
                </Popover>
            </PopoverTrigger>
            {!busy && (
                <RowActionButton
                    className={cn(styles.rowAction, styles.archiveAction)}
                    icon={<Archive />}
                    label="Archive"
                    onPress={() => actions.archive(chat)}
                />
            )}
            <BranchPullRequestBadge
                className={styles.pullRequests}
                branchKey={branchKey}
                visible
                hoverOnly={!showPullRequests}
                crossWorktree={crossWorktree}
            />
            {status}
        </RowControls>
    );
}

/** The branch of the actual worktree, falling back to its last known branch only if the worktree is gone. */
function chatBranchKey(
    info: ProjectInfo | undefined,
    folderId: FolderId | undefined,
    chat: Chat,
    histories: BranchPullRequests
): BranchPullRequestKey | undefined {
    const folder = info?.folders.find(folder => folder.folderId === folderId);
    if (!info || !folder?.exists || !folder.remoteUrl) return undefined;

    const workspace = chat.workspace?.folderId === folder.folderId ? chat.workspace : undefined;
    const branch = workspace
        ? histories.workspaceHistoryBranch(info.projectId, workspace, workspaceHead(workspace, info.workspaces))
        : folder.detached
          ? undefined
          : folder.branch;

    return branch ? { projectId: info.projectId, folderId: folder.folderId, branch } : undefined;
}

/** Read the checkout itself, including cards with no chats, and never use a pending checkout's recorded branch. */
function cardBranchKey(
    info: ProjectInfo | undefined,
    card: WorktreeCard,
    histories: BranchPullRequests
): BranchPullRequestKey | undefined {
    const folder = info?.folders.find(folder => folder.folderId === card.folder.id);
    if (!info || !folder?.exists || !folder.remoteUrl || card.pending) return undefined;
    const branch = card.main
        ? folder.detached
            ? undefined
            : folder.branch
        : card.workspace
          ? histories.workspaceHistoryBranch(
                info.projectId,
                card.workspace,
                workspaceHead(card.workspace, info.workspaces)
            )
          : card.missing
            ? undefined
            : card.branch;
    return branch ? { projectId: info.projectId, folderId: folder.folderId, branch } : undefined;
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
