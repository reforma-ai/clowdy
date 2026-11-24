import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { ChevronRight } from '@clowdy/icons/8';
import { Folder, Settings, Version, VersionPlus } from '@clowdy/icons/14';
import { capitalize } from '@clowdy/lib';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { OverlayTriggerStateContext, PopoverContext, type PressEvent } from 'react-aria-components';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { isInPickerPopover, type PickerOption, PickerPopover } from '../../shared/PickerPopover';
import { Unavailable } from '../../shared/Unavailable';
import { ChipTrigger } from './ChipTrigger';
import { MainBranchPicker } from './MainBranchPicker';
import { type MainBranchBlock } from './mainBranch';
import styles from './WorkspaceChips.module.css';
import { chatsUsing, pickableWorktrees, type Repository, repositoryOf, worktreeLabel } from './workspaceChoice';

import type { Chat, ChatId, ChatWorkspaceChoice, GitWorktree } from '@clowdy/protocol';
import type { BranchListing } from '../changes/branchChoices';
import type { FolderGit } from '../openWith';
import type { FolderRepository } from './useFolderRepository';

/**
 * Where a chat that has started works, read only, in one label: the branch the tree has checked out now (`git`, from `useFolderGit`; the short hash of a detached HEAD)
 * after the git mark, and for a worktree the word `Worktree` before it in a dimmer tone, the worktree's path on hover. In the folder's own checkout the label is the branch
 * alone, since that is where a chat works unless it was sent into a worktree. Nothing while no branch is known and the chat is not in a worktree (the folder is no repository,
 * or the read has not answered); a worktree whose branch is not known says `Worktree` alone. The control of the new-chat page (`WorkspaceChips`) becomes this one when the first
 * message is sent, and stays in its place.
 */
export function WorkspaceLabel({ worktree, git }: { worktree: string | undefined; git: FolderGit | undefined }) {
    const branch = git?.branch;

    if (!worktree && !branch) return null;

    const detached = git?.detached === true;
    // A detached HEAD has no branch, only a commit: the hash is shown in a branch's place, so the title and the screen reader say so.
    const path = worktree && tildePath(worktree, homeFolder.path);
    const title = path ? (detached ? `${path}\nDetached HEAD` : path) : detached ? 'Detached HEAD' : 'Main worktree';

    return (
        <div
            role="group"
            className={styles.label}
            title={title}
            aria-label={`Where it runs: ${worktree ? 'Worktree' : 'Main worktree'}${branch ? `, ${branchWords(branch, detached)}` : ''}`}
        >
            <Version aria-hidden="true" />
            {worktree && (
                <Text className={styles.lead} color="secondary">
                    Worktree
                </Text>
            )}
            {branch && (
                <Text truncate color={worktree ? 'default' : 'secondary'}>
                    {branch}
                </Text>
            )}
        </div>
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
    return `Used in ${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}`;
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

/** The key of the row that opens the Manage worktrees dialog: it is no place to choose, so it is in a section of its own that selects nothing. */
const MANAGE_KEY = 'manage';

/**
 * What the pill needs to pick the branch of the folder's own checkout (`useMainBranch` has it): the folder's branches read when the list opens, what stands in the way of a switch (from what the
 * window knows, `block`; from the daemon when it refused at send, `refusal`), and the switch that is running while the daemon makes the chat.
 */
export interface MainBranchControls {
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

interface WorkspaceChipProps {
    /** The repository the folder is. */
    git: Repository;
    /** What the chat is sent with: `undefined` for the folder's own checkout. */
    choice: ChatWorkspaceChoice | undefined;
    chats: ReadonlyMap<ChatId, Chat>;
    /** The branch of the folder's own checkout: without it the row only says which branch the folder is on. */
    main?: MainBranchControls;
    onChoose: (choice: ChatWorkspaceChoice | null) => void;
    onManage: () => void;
}

/**
 * The one control of the new chat's place: a pill that says where the chat will work and opens a menu to change it. Closed it says the branch alone for the folder's own
 * checkout (`Switch to <branch>` when the person picked another branch than the one the folder is on: the daemon switches the checkout when the chat is made, and the pill turns to the warning
 * colour while something is in the way), `New worktree` and `from <base>` for a worktree to be made, and `Worktree` and the branch for one that exists. The menu has `Main worktree` (the folder itself;
 * the branch at the row's end is a chip of its own, pressed, or with the right arrow on the row, it opens the list of the folder's branches at the menu's side, the way the new worktree's base does:
 * Default, Recent, Local and Remote as in the Changes sidebar, the one the folder is on checked, and with nothing picked the chat starts on it as it is),
 * `New worktree` (pressing the row chooses it; the base at its end is a chip of its own whose press, or the right arrow on the row, opens the searchable list of the folder's branches to start from, in
 * the groups Local and Remote, at the menu's side, with the menu staying open under it). Existing worktrees follow as rows with their branch and chat count. The rows have an icon each and no
 * check: the row that is on is the one the menu highlights. `Manage worktrees…` ends the menu behind a separator: it shuts the menu and opens the dialog of the project's worktrees (`onManage`), and chooses
 * nothing. The list of branches is drawn inside the menu's popover, as its child, so that focus moving into it does not shut the menu; picking a branch chooses a new worktree from it and shuts both.
 */
function WorkspaceChip({ git, choice, chats, main, onChoose, onManage }: WorkspaceChipProps) {
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
    // Worktrees used by chats come first, followed by the rest.
    const used = worktrees.filter(worktree => chatsUsing(chats.values(), worktree.path).length > 0);
    const idle = worktrees.filter(worktree => !used.includes(worktree));
    const worktreeItem = (worktree: GitWorktree) => (
        <MenuItem
            key={worktree.path}
            id={worktreeKey(worktree.path)}
            shouldCloseOnSelect
            stacked
            data-align="center"
            data-worktree=""
            icon={<Version aria-hidden="true" />}
            text={worktreeLabel(worktree)}
            description={usersLine(chatsUsing(chats.values(), worktree.path))}
        />
    );
    const chosen = choice?.mode === 'existing' ? worktrees.find(worktree => worktree.path === choice.path) : undefined;
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
    // What `effectiveChoice` hands over is a worktree the folder lists, so an existing choice always has its row; anything else is the folder's own checkout.
    const trigger =
        choice?.mode === 'new'
            ? {
                  label: 'New worktree',
                  trail: base === undefined ? undefined : `from ${base}`,
                  ariaLabel: `Where it runs: New worktree${base === undefined ? '' : ` from ${base}`}`,
              }
            : chosen
              ? {
                    lead: 'Worktree',
                    label: worktreeLabel(chosen),
                    ariaLabel: `Where it runs: Worktree, ${chosen.branch ? `branch ${chosen.branch}` : worktreeLabel(chosen).toLowerCase()}`,
                }
              : picked !== undefined
                ? {
                      lead: main?.running === picked ? 'Switching to' : 'Switch to',
                      label: picked,
                      ariaLabel: `Where it runs: Main worktree, ${main?.running === picked ? 'switching' : 'switch'} to branch ${picked}${whyWords ? `, ${whyWords}` : ''}`,
                      tooltip: whyWords ?? `The main worktree changes to ${picked} when the chat starts`,
                      missing: why !== undefined,
                  }
                : {
                      label: branch ?? 'Main worktree',
                      ariaLabel: `Where it runs: Main worktree${branch ? `, ${branchWords(branch, git.detached === true)}` : ''}`,
                      tooltip: git.detached ? 'Detached HEAD' : undefined,
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
                    ref={pill}
                    icon={<Version aria-hidden="true" />}
                    lead={'lead' in trigger ? trigger.lead : undefined}
                    label={trigger.label}
                    trail={'trail' in trigger ? trigger.trail : undefined}
                    aria-label={trigger.ariaLabel}
                    tooltip={'tooltip' in trigger ? trigger.tooltip : undefined}
                    missing={'missing' in trigger ? trigger.missing : undefined}
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
                                    } else if (key === MANAGE_KEY) onManage();
                                    else if (key === 'new') {
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
                                    icon={<Folder aria-hidden="true" />}
                                    text="Main worktree"
                                    description="Work in the folder as it is"
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
                                    icon={<VersionPlus aria-hidden="true" />}
                                    text="New worktree"
                                    stacked
                                    description={
                                        canMakeOne
                                            ? 'A separate checkout on a branch of its own'
                                            : 'The repository has no commit yet'
                                    }
                                    isDisabled={!canMakeOne}
                                    endAffix={
                                        canMakeOne && base !== undefined ? (
                                            <RowButton
                                                name={base}
                                                aria-label={`Start from: ${base}`}
                                                held={baseHeld}
                                                onPress={event => openList(event.target as Element)}
                                            />
                                        ) : undefined
                                    }
                                />
                                {[...used, ...idle].map(worktreeItem)}
                                <MenuSeparator />
                                <MenuSection aria-label="Worktrees of the project" selectionMode="none">
                                    <MenuItem
                                        id={MANAGE_KEY}
                                        shouldCloseOnSelect
                                        icon={<Settings aria-hidden="true" />}
                                        text="Manage worktrees…"
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
                                <PickerPopover
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

export interface WorkspaceChipsProps {
    /** What the daemon says of the folder the new chat is for. */
    repository: FolderRepository;
    /** What the chat will be sent with (`effectiveChoice`): the control shows this and never what the repository does not bear out. */
    choice: ChatWorkspaceChoice | undefined;
    /** The project's chats, which the list of worktrees names the users of each by. */
    chats: ReadonlyMap<ChatId, Chat>;
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
export function WorkspaceChips({ repository, choice, chats, main, onChoose, onManage }: WorkspaceChipsProps) {
    const git = repositoryOf(repository);

    if (git)
        return (
            <WorkspaceChip
                git={git}
                choice={choice}
                chats={chats}
                main={main}
                onChoose={onChoose}
                onManage={onManage}
            />
        );

    const why = whyUnread(repository);

    if (!why) return null;

    return (
        <Unavailable label="Where it runs: Main worktree" hint={why} placement="bottom">
            <div role="group" className={styles.label}>
                <Text truncate color="secondary">
                    Main worktree
                </Text>
            </div>
        </Unavailable>
    );
}
