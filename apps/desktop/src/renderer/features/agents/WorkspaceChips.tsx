import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { ChevronRight } from '@clowdy/icons/8';
import { GitFolder, Settings, WorktreeFolder } from '@clowdy/icons/14';
import { capitalize } from '@clowdy/lib';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { OverlayTriggerStateContext, PopoverContext, type PressEvent } from 'react-aria-components';

import { isInPickerPopover, type PickerOption } from '../../shared/PickerPopover';
import { BranchPickerWithCreate } from './BranchPickerWithCreate';
import { ChipTrigger } from './ChipTrigger';
import { MainBranchPicker } from './MainBranchPicker';
import { type MainBranchBlock } from './mainBranch';
import { PlaceTooltip } from './PlaceTooltip';
import styles from './WorkspaceChips.module.css';
import {
    chatsUsing,
    pickableWorktrees,
    type Repository,
    repositoryOf,
    samePath,
    worktreeLabel,
} from './workspaceChoice';
import { worktreeKey as sidebarWorktreeKey, type WorktreeCard, worktreeRank } from './worktreeCards';

import type {
    Chat,
    ChatId,
    ChatWorkspace,
    ChatWorkspaceChoice,
    FolderId,
    GitHead,
    GitWorktree,
    ProjectFolder,
} from '@clowdy/protocol';
import type { BranchSwitch } from '../changes/BranchSwitch';
import type { BranchListing } from '../changes/branchChoices';
import type { FolderRepository } from './useFolderRepository';

/** A chosen worktree remains visible while its repository data is unavailable. */
function WorkspaceLabel({ worktree, branch }: { worktree: string; branch?: string }) {
    return (
        <Tooltip content={<PlaceTooltip path={worktree} worktree />}>
            <div
                role="img"
                className={styles.label}
                aria-label={`Where it runs: Worktree${branch ? `, branch ${branch}` : ''}`}
            >
                <WorktreeFolder aria-hidden="true" />
                <Text truncate>{branch ?? 'Worktree'}</Text>
            </div>
        </Tooltip>
    );
}

/** What a screen reader says of what is checked out: a branch, or on a detached HEAD the commit it is at. */
const branchWords = (name: string, detached: boolean) => (detached ? `detached at ${name}` : `branch ${name}`);

/** Why a folder offers no worktrees when git could not be asked: the daemon's reason when it gave one. Nothing for an answer that is on its way or a folder that is no repository. */
function whyUnread(repository: FolderRepository): string | undefined {
    return repository.status === 'failed'
        ? repository.reason
            ? capitalize(repository.reason)
            : "Couldn't read the folder's git"
        : undefined;
}

/** Number of chats using a worktree. */
function usersLine(chats: readonly Chat[]): string {
    if (chats.length === 0) return 'Worktree';

    return `Worktree used in ${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}`;
}

/**
 * The refs a new worktree may start from, as a list of the folder's branches in two groups, `Local` and `Remote` (one list with no headings when the folder has only the one kind), the
 * default one marked. On a detached HEAD the default is the commit, which is no branch of the list, and is listed first.
 */
function baseOptions(git: Repository): PickerOption[] {
    const options: PickerOption[] = git.branches.map(branch => ({
        id: branch.name,
        label: branch.name,
        description: branch.name === git.defaultBranch ? 'Default' : undefined,
        group: branch.remote ? 'Remote' : 'Local',
    }));

    if (git.defaultBranch !== undefined && !options.some(option => option.id === git.defaultBranch))
        options.unshift({ id: git.defaultBranch, label: git.defaultBranch, description: 'Default', group: 'Local' });

    const local = options.filter(option => option.group === 'Local');
    const remote = options.filter(option => option.group === 'Remote');

    return local.length > 0 && remote.length > 0
        ? [...local, ...remote]
        : options.map(({ group: _group, ...option }) => option);
}

/** The key of the row of a worktree in the menu: its path, which no other row's key is. */
const worktreeKey = (path: string) => `worktree:${path}`;

/** The key of the row that opens folder settings: it is no place to choose, so it is in a section of its own that selects nothing. */
const MANAGE_KEY = 'manage';

/**
 * What the pill needs to pick the branch of the folder's own checkout (`useMainBranch` has it): the folder's branches read when the list opens, what stands in the way of a switch (from what the
 * window knows, `block`; from the daemon when it refused at send, `refusal`), and the switch that is running while the daemon makes the chat.
 */
export interface MainBranchControls {
    model?: BranchSwitch;
    head?: GitHead;
    listing: BranchListing | undefined;
    loading: boolean;
    listFailure: string | undefined;
    /** What the window knows is in the way: the tree has changes, chats work in the folder. Every branch but the folder's own is off while it holds. */
    block: MainBranchBlock | undefined;
    /** What the daemon answered at the last send, for the branch that is chosen. */
    refusal: MainBranchBlock | undefined;
    /** The branch the daemon is switching to while it makes the chat. */
    running: string | undefined;
    /** The list is opening: read the branches and the tree again. */
    onOpen: () => void;
}

interface FolderChoices {
    folders: readonly ProjectFolder[];
    selectedFolderId: FolderId;
    missing: ReadonlySet<FolderId>;
}

interface WorkspaceChipProps extends FolderChoices {
    restoreRef: (element: HTMLButtonElement | HTMLAnchorElement | null) => void;
    /** The repository the folder is. */
    git: Repository;
    /** What the chat is sent with: `undefined` for the folder's own checkout. */
    choice: ChatWorkspaceChoice | undefined;
    workspaceRow?: ChatWorkspace;
    chats: ReadonlyMap<ChatId, Chat>;
    worktreeOrder: readonly string[];
    sidebarCards: readonly WorktreeCard[];
    sidebarGrouped: boolean;
    draftWorktrees: readonly string[];
    showUnusedWorktrees: boolean;
    /** The branch of the folder's own checkout: without it the row only says which branch the folder is on. */
    main?: MainBranchControls;
    onChoose: (choice: ChatWorkspaceChoice | null) => void;
    onManage: () => void;
}

/**
 * The one control of the new chat's place: a pill that says where the chat will work and opens a menu to change it. Closed it says the branch alone for the folder's own
 * checkout (`Switch to <branch>` when the person picked another branch than the one the folder is on: the daemon switches the checkout when the chat is made, and the pill turns to the warning
 * colour while something is in the way), `Worktree` and `from <base>` for a worktree to be made, and `Worktree` and the branch for one that exists. The menu has `Main worktree` (the folder itself;
 * the branch at the row's end is a chip of its own, pressed, or with the right arrow on the row, it opens the list of the folder's branches at the menu's side, the way the new worktree's base does:
 * it follows the Changes branch picker and checks the folder's current branch),
 * `New worktree` (pressing the row chooses it; the base at its end is a chip of its own whose press, or the right arrow on the row, opens the searchable list of the folder's branches to start from, in
 * the groups Local and Remote, at the menu's side, with the menu staying open under it). Existing worktrees follow as rows with their branch and chat count. The rows have an icon each and no
 * check: the row that is on is the one the menu highlights. `Folder settings…` ends the menu behind a separator: it shuts the menu and opens the settings of this folder (`onManage`), and chooses
 * nothing. The list of branches is drawn inside the menu's popover, as its child, so that focus moving into it does not shut the menu; picking a branch chooses a new worktree from it and shuts both.
 */
function WorkspaceChip({
    git,
    choice,
    workspaceRow,
    chats,
    worktreeOrder,
    sidebarCards,
    sidebarGrouped,
    draftWorktrees,
    showUnusedWorktrees,
    main,
    onChoose,
    onManage,
    folders,
    selectedFolderId,
    missing,
    restoreRef,
}: WorkspaceChipProps) {
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    // The row of a new worktree while the list of its base branches is open beside the menu.
    const [listAnchor, setListAnchor] = useState<HTMLElement | null>(null);
    // The row of the main worktree while the list of its branches is open beside the menu.
    const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);
    // A pick can give the pill a tooltip or take it away, which draws it again as another element (`Button` wraps itself in a tooltip only when it has one), and the menu hands focus back to the
    // element it opened from, which has gone with the old pill: the pill that is there now takes it, as the keyboard's person left it.
    const pill = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
    const wasOpen = useRef(false);

    useEffect(() => {
        if (isMenuOpen) {
            wasOpen.current = true;

            return;
        }

        if (!wasOpen.current) return;

        wasOpen.current = false;

        const frame = requestAnimationFrame(() => {
            if (document.activeElement === document.body) pill.current?.focus();
        });

        return () => cancelAnimationFrame(frame);
    }, [isMenuOpen]);

    const worktrees = pickableWorktrees(git);
    // Match the sidebar: visible cards first, then the saved card order, with Git order as the fallback.
    const rank = new Map(worktreeOrder.map((key, index) => [key, index]));
    const cardOf = (worktree: GitWorktree) =>
        sidebarCards.find(card => card.folder.id === selectedFolderId && samePath(card.path, worktree.path));
    const visible = (worktree: GitWorktree) =>
        sidebarGrouped &&
        (showUnusedWorktrees ||
            (cardOf(worktree)?.roots.length ?? 0) > 0 ||
            draftWorktrees.some(path => samePath(path, worktree.path)));
    const rankOf = (worktree: GitWorktree) => {
        const card = cardOf(worktree);
        return card
            ? worktreeRank(card, rank)
            : (rank.get(sidebarWorktreeKey(selectedFolderId, worktree.path)) ?? Infinity);
    };
    const orderedWorktrees = [...worktrees].sort(
        (a, b) => Number(visible(b)) - Number(visible(a)) || rankOf(a) - rankOf(b)
    );
    const worktreeItem = (worktree: GitWorktree) => (
        <MenuItem
            key={worktree.path}
            id={worktreeKey(worktree.path)}
            shouldCloseOnSelect
            stacked
            data-align="center"
            data-worktree=""
            icon={<WorktreeFolder aria-hidden="true" />}
            text={worktreeLabel(worktree)}
            description={usersLine(chatsUsing(chats.values(), worktree.path))}
        />
    );
    const chosen =
        choice?.mode === 'existing'
            ? (worktrees.find(worktree => samePath(worktree.path, choice.path)) ?? workspaceRow)
            : undefined;
    const base = choice?.mode === 'new' ? (choice.base ?? git.defaultBranch) : git.defaultBranch;
    const canMakeOne = git.defaultBranch !== undefined;
    const branch = git.branch;
    const selected = choice?.mode === 'new' ? 'new' : chosen ? worktreeKey(chosen.path) : 'checkout';
    // The base at the end of the row is pressed, and so is the row under it: react-aria's row takes the release of a press that began on the base as its own and acts. The row's
    // action then leaves the choice alone, since the press was the base's, which opens the list itself.
    const baseHeld = useRef(false);
    // The same for the branch at the end of the main worktree's row.
    const branchHeld = useRef(false);
    const rowOf = (from: Element | null) => from?.closest<HTMLElement>('[role^="menuitem"]') ?? null;
    const openList = (from: Element | null) => {
        setBranchAnchor(null);
        setListAnchor(rowOf(from));
        main?.onOpen();
    };
    const openBranches = (from: Element | null) => {
        setListAnchor(null);
        setBranchAnchor(rowOf(from));
        main?.onOpen();
    };
    // The right arrow on the row of a new worktree opens the list its base is picked from, and on the row of the main worktree the list of its branches, as the button at the row's end does for the pointer.
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowRight') return;

        const target = event.target as HTMLElement;

        if (canMakeOne && target.closest('[data-new-worktree]')) {
            event.preventDefault();
            openList(target);
        } else if (main && canMakeOne && target.closest('[data-main-worktree]')) {
            event.preventDefault();
            openBranches(target);
        }
    };
    // What the pill says of the folder's own checkout: the branch it is on, or the one the person picked to switch it to.
    const picked = choice?.mode === 'main' ? choice.branch : undefined;
    const shown = picked ?? branch;
    const why = main?.refusal ?? main?.block;
    const whyWords = why && (why.hint ? `${why.message} (${why.hint})` : why.message);
    // The selected worktree path remains available even while its listing is refreshing.
    const path =
        choice?.mode === 'existing' ? choice.path : folders.find(folder => folder.id === selectedFolderId)?.path;
    const placeTooltip = path
        ? (worktree: boolean, note?: string, detached?: boolean) => (
              <PlaceTooltip path={path} worktree={worktree} note={note} detached={detached} />
          )
        : undefined;
    const trigger =
        choice?.mode === 'new'
            ? {
                  label: 'Worktree',
                  trail: base === undefined ? undefined : `from ${base}`,
                  ariaLabel: `Where it runs: New worktree${base === undefined ? '' : ` from ${base}`}`,
              }
            : choice?.mode === 'existing'
              ? {
                    label: chosen ? worktreeLabel(chosen) : 'Worktree',
                    ariaLabel: chosen
                        ? `Where it runs: Worktree, ${chosen.branch ? `branch ${chosen.branch}` : worktreeLabel(chosen).toLowerCase()}`
                        : 'Where it runs: Worktree',
                    tooltip: placeTooltip?.(
                        true,
                        undefined,
                        Boolean(chosen && 'head' in chosen && chosen.head && !chosen.branch)
                    ),
                }
              : picked !== undefined
                ? {
                      lead: main?.running === picked ? 'Switching to' : 'Switch to',
                      label: picked,
                      ariaLabel: `Where it runs: Main worktree, ${main?.running === picked ? 'switching' : 'switch'} to branch ${picked}${whyWords ? `, ${whyWords}` : ''}`,
                      tooltip: placeTooltip?.(
                          false,
                          whyWords ?? `The main worktree changes to ${picked} when the chat starts`
                      ),
                      missing: why !== undefined,
                  }
                : {
                      label: branch ?? 'Main worktree',
                      ariaLabel: `Where it runs: Main worktree${branch ? `, ${branchWords(branch, git.detached === true)}` : ''}`,
                      tooltip: placeTooltip?.(false, undefined, git.detached),
                  };

    return (
        <>
            <MenuTrigger
                isOpen={isMenuOpen}
                onOpenChange={isOpen => {
                    setIsMenuOpen(isOpen);

                    // The lists are the menu's children: they go with it, and are not there when the menu comes back.
                    if (!isOpen) {
                        setListAnchor(null);
                        setBranchAnchor(null);
                    }
                }}
            >
                <ChipTrigger
                    ref={element => {
                        pill.current = element;
                        restoreRef(element);
                    }}
                    icon={
                        choice?.mode === 'new' || choice?.mode === 'existing' ? (
                            <WorktreeFolder aria-hidden="true" />
                        ) : (
                            <GitFolder aria-hidden="true" />
                        )
                    }
                    lead={'lead' in trigger ? trigger.lead : undefined}
                    label={trigger.label}
                    trail={'trail' in trigger ? trigger.trail : undefined}
                    aria-label={trigger.ariaLabel}
                    tooltip={'tooltip' in trigger ? trigger.tooltip : undefined}
                    missing={missing.has(selectedFolderId) || ('missing' in trigger && trigger.missing)}
                />
                <Popover
                    placement="bottom start"
                    spacing="xs"
                    width={400}
                    shouldCloseOnInteractOutside={element => !isInPickerPopover(element)}
                >
                    <PopoverScroll maxHeight={360}>
                        {/* The menu has no key handler of its own to give, so the arrow is read on the way up from the focused row; the box itself takes no room. */}
                        <div className={styles.keys} onKeyDown={onKeyDown}>
                            <Menu
                                aria-label="Where the chat works"
                                size="sm"
                                selectionMode="single"
                                selectedKeys={[selected]}
                                disallowEmptySelection
                                onAction={key => {
                                    if (key === 'checkout') {
                                        // A press that was the branch's has its own answer, and leaves the menu as it is.
                                        if (branchHeld.current) {
                                            branchHeld.current = false;

                                            return;
                                        }

                                        onChoose(null);
                                        setIsMenuOpen(false);
                                    } else if (String(key).startsWith('worktree:')) {
                                        onChoose({ mode: 'existing', path: String(key).slice('worktree:'.length) });
                                        setIsMenuOpen(false);
                                    } else if (key === MANAGE_KEY) {
                                        setIsMenuOpen(false);
                                        requestAnimationFrame(() => {
                                            pill.current?.focus();
                                            onManage();
                                        });
                                    } else if (key === 'new') {
                                        // A press that was the base's has its own answer, and leaves the menu as it is.
                                        if (baseHeld.current) {
                                            baseHeld.current = false;

                                            return;
                                        }

                                        // Pressing the mode it is in keeps its base.
                                        if (choice?.mode !== 'new') onChoose({ mode: 'new' });

                                        setIsMenuOpen(false);
                                    }
                                }}
                            >
                                <MenuItem
                                    id="checkout"
                                    data-align="center"
                                    data-main-worktree=""
                                    // The row shuts the menu itself (`onAction`): a press on the branch inside it must not.
                                    shouldCloseOnSelect={false}
                                    stacked
                                    icon={<GitFolder aria-hidden="true" />}
                                    text="Main worktree"
                                    description="Use the space folder"
                                    endAffix={
                                        shown ? (
                                            main && canMakeOne ? (
                                                <RowButton
                                                    name={shown}
                                                    aria-label={`Branch: ${shown}`}
                                                    held={branchHeld}
                                                    onPress={event => openBranches(event.target as Element)}
                                                />
                                            ) : (
                                                <Text truncate color="secondary" className={styles.suffix}>
                                                    {shown}
                                                </Text>
                                            )
                                        ) : undefined
                                    }
                                />
                                <MenuItem
                                    id="new"
                                    data-align="center"
                                    data-new-worktree=""
                                    // The row shuts the menu itself (`onAction`): a press on the base inside it must not.
                                    shouldCloseOnSelect={false}
                                    icon={<WorktreeFolder aria-hidden="true" />}
                                    text="New worktree"
                                    stacked
                                    description={
                                        canMakeOne ? 'Use a new folder and branch' : 'The repository has no commit yet'
                                    }
                                    isDisabled={!canMakeOne}
                                    endAffix={
                                        canMakeOne && base !== undefined ? (
                                            <RowButton
                                                name={`From ${base}`}
                                                aria-label={`Start from: ${base}`}
                                                held={baseHeld}
                                                onPress={event => openList(event.target as Element)}
                                            />
                                        ) : undefined
                                    }
                                />
                                {orderedWorktrees.map(worktreeItem)}
                                <MenuSeparator />
                                <MenuSection aria-label="Worktrees of the space" selectionMode="none">
                                    <MenuItem
                                        id={MANAGE_KEY}
                                        shouldCloseOnSelect
                                        icon={<Settings aria-hidden="true" />}
                                        text="Folder settings…"
                                    />
                                </MenuSection>
                            </Menu>
                        </div>
                    </PopoverScroll>
                    {/* A child of the menu's popover, as a submenu is, so that focus moving into it is not the menu losing it; it opens at the menu's side. The contexts the menu's trigger
                        gives its popover are cleared, or the list would take the menu's anchor and close the menu with itself. */}
                    {branchAnchor && main && (
                        <PopoverContext.Provider value={null}>
                            <OverlayTriggerStateContext.Provider value={null}>
                                <MainBranchPicker
                                    model={main.model}
                                    head={main.head}
                                    anchor={branchAnchor}
                                    listing={main.listing}
                                    loading={main.loading}
                                    listFailure={main.listFailure}
                                    chosen={picked}
                                    block={main.block}
                                    refusal={main.refusal}
                                    onPick={name => {
                                        // The branch the folder is on is no change: nothing is sent, as when nothing was picked.
                                        onChoose(
                                            name === branch && !git.detached ? null : { mode: 'main', branch: name }
                                        );
                                        setIsMenuOpen(false);
                                    }}
                                    onClose={() => setBranchAnchor(null)}
                                />
                            </OverlayTriggerStateContext.Provider>
                        </PopoverContext.Provider>
                    )}
                    {listAnchor && (
                        <PopoverContext.Provider value={null}>
                            <OverlayTriggerStateContext.Provider value={null}>
                                <BranchPickerWithCreate
                                    model={main?.model}
                                    head={main?.head}
                                    anchor={listAnchor}
                                    placement="right top"
                                    options={baseOptions(git)}
                                    selectedIds={base === undefined ? [] : [base]}
                                    aria-label="Branches"
                                    placeholder="Search branches"
                                    onPick={picked => {
                                        onChoose({ mode: 'new', base: picked });
                                        setIsMenuOpen(false);
                                    }}
                                    onClose={() => setListAnchor(null)}
                                />
                            </OverlayTriggerStateContext.Provider>
                        </PopoverContext.Provider>
                    )}
                </Popover>
            </MenuTrigger>
        </>
    );
}

/**
 * The branch at the end of a row of the menu (the base of a new worktree, the branch of the main worktree), a press target of its own: it opens the list of branches at the menu's side and leaves
 * the row unpressed. Keyboard users have the right arrow on the row.
 */
function RowButton({
    name,
    'aria-label': ariaLabel,
    held,
    onPress,
}: {
    name: string;
    'aria-label': string;
    held: { current: boolean };
    onPress: (event: PressEvent) => void;
}) {
    return (
        <Button
            size="xs"
            variant="filling"
            rounded
            className={styles.base}
            contentClassName={styles.baseContent}
            aria-label={ariaLabel}
            excludeFromTabOrder
            onPressStart={() => void (held.current = true)}
            onPressEnd={() => void (held.current = false)}
            onPress={onPress}
        >
            <Text truncate color="secondary">
                {name}
            </Text>
            <ChevronRight aria-hidden="true" />
        </Button>
    );
}

export interface WorkspaceChipsProps extends FolderChoices {
    /** What the daemon says of the folder the new chat is for. */
    repository: FolderRepository;
    /** What the chat will be sent with, including an existing path while the listing is being refreshed. */
    choice: ChatWorkspaceChoice | undefined;
    /** The selected checkout from `workspace.open`, which can answer before the listing does. */
    workspaceRow?: ChatWorkspace;
    /** The project's chats, which the list of worktrees names the users of each by. */
    chats: ReadonlyMap<ChatId, Chat>;
    worktreeOrder: readonly string[];
    sidebarCards: readonly WorktreeCard[];
    sidebarGrouped: boolean;
    draftWorktrees: readonly string[];
    showUnusedWorktrees: boolean;
    /** The branch of the folder's own checkout (`useMainBranch`); without it the main worktree's row only says which branch the folder is on. */
    main?: MainBranchControls;
    onChoose: (choice: ChatWorkspaceChoice | null) => void;
    /** Opens the dialog of the project's worktrees, on this chat's folder; the menu's last row calls it. */
    onManage: () => void;
}

/**
 * Where the new chat works, after the folder, in the line under the message box: one pill (`WorkspaceChip`) that says the branch of the folder's own checkout (the default),
 * a new worktree and the ref it starts from, or an existing worktree and its branch, and opens the menu to change it. Only a folder that is a repository offers a worktree; a
 * folder that is no repository, or whose read is still on its way, has nothing here, and one that git could not be asked about has a dim `Main worktree` that says why on
 * hover. The lists come from `useFolderRepository`.
 */
export function WorkspaceChips({
    repository,
    choice,
    workspaceRow,
    chats,
    worktreeOrder,
    sidebarCards,
    sidebarGrouped,
    draftWorktrees,
    showUnusedWorktrees,
    main,
    onChoose,
    onManage,
    folders,
    selectedFolderId,
    missing,
}: WorkspaceChipsProps) {
    const git = repositoryOf(repository);
    const trigger = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
    const restoreFocus = useRef(false);
    const restoreRef = (element: HTMLButtonElement | HTMLAnchorElement | null) => {
        if (!element && trigger.current === document.activeElement) restoreFocus.current = true;
        trigger.current = element;
        if (element && restoreFocus.current) {
            requestAnimationFrame(() => {
                if (document.activeElement === document.body) element.focus();
                restoreFocus.current = false;
            });
        }
    };

    if (git)
        return (
            <WorkspaceChip
                git={git}
                folders={folders}
                selectedFolderId={selectedFolderId}
                missing={missing}
                restoreRef={restoreRef}
                choice={choice}
                workspaceRow={workspaceRow}
                chats={chats}
                worktreeOrder={worktreeOrder}
                sidebarCards={sidebarCards}
                sidebarGrouped={sidebarGrouped}
                draftWorktrees={draftWorktrees}
                showUnusedWorktrees={showUnusedWorktrees}
                main={main}
                onChoose={onChoose}
                onManage={onManage}
            />
        );

    if (choice?.mode === 'existing') return <WorkspaceLabel worktree={choice.path} branch={workspaceRow?.branch} />;

    const why = whyUnread(repository);

    if (folders.length > 1 && (repository.status === 'loading' || !why)) {
        return (
            <span className={styles.label}>
                {repository.status === 'loading' ? 'Reading Git…' : 'Not a repository'}
            </span>
        );
    }

    if (!why) return null;

    return (
        // A dim pill that does not open: the reason is its tooltip.
        <Button
            size="sm"
            variant="transparent"
            color="secondary"
            rounded
            isDisabled
            disabledReason={why}
            tooltipPlacement="bottom"
            aria-label="Where it runs: Git unavailable"
        >
            Git unavailable
        </Button>
    );
}
