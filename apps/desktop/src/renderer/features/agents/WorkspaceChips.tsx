import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger, SubmenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Check, Version } from '@clowdy/icons/14';
import { ChevronRight } from '@clowdy/icons/8';
import { capitalize } from '@clowdy/lib';
import { useRef, useState, type KeyboardEvent } from 'react';
import { OverlayTriggerStateContext, PopoverContext, type PressEvent } from 'react-aria-components';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { isInPickerPopover, PickerPopover, type PickerOption } from '../../shared/PickerPopover';
import { Unavailable } from '../../shared/Unavailable';
import { ChipTrigger } from './ChipTrigger';
import styles from './WorkspaceChips.module.css';
import { chatsUsing, pickableWorktrees, repositoryOf, worktreeLabel, type Repository } from './workspaceChoice';

import type { Chat, ChatId, ChatWorkspaceChoice } from '@clowdy/protocol';
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
    const title = path ? (detached ? `${ path }\nDetached HEAD` : path) : detached ? 'Detached HEAD' : 'Main worktree';

    return (
        <div role="group" className={ styles.label } title={ title } aria-label={ `Where it runs: ${ worktree ? 'Worktree' : 'Main worktree' }${ branch ? `, ${ branchWords(branch, detached) }` : '' }` }>
            <Version aria-hidden="true" />
            { worktree && <Text className={ styles.lead } color="secondary">Worktree</Text> }
            { branch && <Text truncate color={ worktree ? 'default' : 'secondary' }>{ branch }</Text> }
        </div>
    );
}

/** What a screen reader says of what is checked out: a branch, or on a detached HEAD the commit it is at. */
const branchWords = (name: string, detached: boolean) => (detached ? `detached at ${ name }` : `branch ${ name }`);

/** Why a folder offers no worktrees when git could not be asked: the daemon's reason when it gave one. Nothing for an answer that is on its way or a folder that is no repository. */
function whyUnread(repository: FolderRepository): string | undefined {
    return repository.status === 'failed' ? (repository.reason ? capitalize(repository.reason) : 'Couldn\'t read the folder\'s git') : undefined;
}

/** What the list of existing worktrees says under a worktree's branch: the chats that work in it, by name. */
function usersLine(chats: readonly Chat[]): string {
    if (chats.length === 0) return 'No chat uses it';

    if (chats.length <= 2) return chats.map(chat => chat.title).join(', ');

    return `${ chats[0].title }, ${ chats[1].title } and ${ chats.length - 2 } more`;
}

/** The slot at the start of a row of the menu: the check of the row that is on, and room of the same width for the others, so the words line up. */
function Mark({ checked }: { checked: boolean }) {
    return <span className={ styles.mark } aria-hidden="true">{ checked && <Check /> }</span>;
}

/** The ref a new worktree starts from, as a list of the folder's branches (local and remote) with the default one marked. On a detached HEAD the default is the commit, which is no branch of the list. */
function baseOptions(git: Repository): PickerOption[] {
    const names = git.branches.map(branch => branch.name);

    return [
        ...(git.defaultBranch !== undefined && !names.includes(git.defaultBranch) ? [git.defaultBranch] : []),
        ...names,
    ].map(name => ({ id: name, label: name, description: name === git.defaultBranch ? 'Default' : undefined }));
}

/** The key of the row of a worktree in the menu: its path, which no other row's key is. */
const worktreeKey = (path: string) => `worktree:${ path }`;

/** The key of the row that opens the Manage worktrees dialog: it is no place to choose, so it is in a section of its own that selects nothing. */
const MANAGE_KEY = 'manage';

interface WorkspaceChipProps {
    /** The repository the folder is. */
    git: Repository;
    /** What the chat is sent with: `undefined` for the folder's own checkout. */
    choice: ChatWorkspaceChoice | undefined;
    chats: ReadonlyMap<ChatId, Chat>;
    onChoose: (choice: ChatWorkspaceChoice | null) => void;
    onManage: () => void;
}

/**
 * The one control of the new chat's place: a pill that says where the chat will work and opens a menu to change it. Closed it says the branch alone for the folder's own
 * checkout, `New worktree` and `from <base>` for a worktree to be made, and `Worktree` and the branch for one that exists. The menu has `Main worktree` (the folder itself, with its branch),
 * `New worktree` (pressing the row chooses it; the base at its end is a chip of its own whose press, or the right arrow on the row, opens the searchable list of the folder's branches to start from at
 * the menu's side, with the menu staying open under it), and `Existing worktree`, a submenu that flies the folder's other worktrees out to its side, each with the chats that use it by name and a
 * mark when something in it is not committed (it has no default to choose, so it is a plain submenu). A row's check is at its start. `Manage worktrees…` ends the menu behind a separator: it shuts
 * the menu and opens the dialog of the project's worktrees (`onManage`), and chooses nothing. The list of branches is drawn inside the menu's popover, as its child, so that focus moving into it does not
 * shut the menu; picking a branch chooses a new worktree from it and shuts both.
 */
function WorkspaceChip({ git, choice, chats, onChoose, onManage }: WorkspaceChipProps) {
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    // The row of a new worktree while the list of its base branches is open beside the menu.
    const [listAnchor, setListAnchor] = useState<HTMLElement | null>(null);
    const worktrees = pickableWorktrees(git);
    const chosen = choice?.mode === 'existing' ? worktrees.find(worktree => worktree.path === choice.path) : undefined;
    const base = choice?.mode === 'new' ? choice.base ?? git.defaultBranch : git.defaultBranch;
    const canMakeOne = git.defaultBranch !== undefined;
    const branch = git.branch;
    const selected = choice?.mode === 'new' ? 'new' : chosen ? 'existing' : 'checkout';
    // The base at the end of the row is pressed, and so is the row under it: react-aria's row takes the release of a press that began on the base as its own and acts. The row's
    // action then leaves the choice alone, since the press was the base's, which opens the list itself.
    const baseHeld = useRef(false);
    const openList = (from: Element | null) => setListAnchor(from?.closest<HTMLElement>('[role^="menuitem"]') ?? null);
    // The right arrow on the row of a new worktree opens the list its base is picked from, as the base at its end does for the pointer.
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowRight' || !canMakeOne || !(event.target as HTMLElement).closest('[data-new-worktree]')) return;

        event.preventDefault();
        openList(event.target as HTMLElement);
    };
    // What `effectiveChoice` hands over is a worktree the folder lists, so an existing choice always has its row; anything else is the folder's own checkout.
    const trigger = choice?.mode === 'new'
        ? { label: 'New worktree', trail: base === undefined ? undefined : `from ${ base }`, ariaLabel: `Where it runs: New worktree${ base === undefined ? '' : ` from ${ base }` }` }
        : chosen
            ? { lead: 'Worktree', label: worktreeLabel(chosen), ariaLabel: `Where it runs: Worktree, ${ chosen.branch ? `branch ${ chosen.branch }` : worktreeLabel(chosen).toLowerCase() }` }
            : { label: branch ?? 'Main worktree', ariaLabel: `Where it runs: Main worktree${ branch ? `, ${ branchWords(branch, git.detached === true) }` : '' }`, tooltip: git.detached ? 'Detached HEAD' : undefined };

    return (
        <>
            <MenuTrigger
                isOpen={ isMenuOpen }
                onOpenChange={ (isOpen) => {
                    setIsMenuOpen(isOpen);
                    // The list is the menu's child: it goes with it, and is not there when the menu comes back.
                    if (!isOpen) setListAnchor(null);
                } }
            >
                <ChipTrigger
                    icon={ <Version aria-hidden="true" /> }
                    lead={ 'lead' in trigger ? trigger.lead : undefined }
                    label={ trigger.label }
                    trail={ 'trail' in trigger ? trigger.trail : undefined }
                    aria-label={ trigger.ariaLabel }
                    tooltip={ 'tooltip' in trigger ? trigger.tooltip : undefined }
                />
                <Popover placement="bottom start" spacing="xs" width={ 400 } shouldCloseOnInteractOutside={ element => !isInPickerPopover(element) }>
                    <PopoverScroll maxHeight={ 360 }>
                        {/* The menu has no key handler of its own to give, so the arrow is read on the way up from the focused row; the box itself takes no room. */}
                        <div className={ styles.keys } onKeyDown={ onKeyDown }>
                            <Menu
                                aria-label="Where the chat works"
                                size="sm"
                                selectionMode="single"
                                selectedKeys={ [selected] }
                                disallowEmptySelection
                                onAction={ (key) => {
                                    if (key === 'checkout') onChoose(null);
                                    else if (key === MANAGE_KEY) onManage();
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
                                } }
                            >
                                <MenuItem
                                    id="checkout"
                                    // Every item shuts the menu, from the keyboard's Space too, which a single choice list leaves open.
                                    shouldCloseOnSelect
                                    stacked
                                    icon={ <Mark checked={ selected === 'checkout' } /> }
                                    text="Main worktree"
                                    description="Work in the folder as it is"
                                    endAffix={ branch ? <Text truncate color="secondary" className={ styles.suffix }>{ branch }</Text> : undefined }
                                />
                                <MenuItem
                                    id="new"
                                    data-new-worktree=""
                                    // The row shuts the menu itself (`onAction`): a press on the base inside it must not.
                                    shouldCloseOnSelect={ false }
                                    icon={ <Mark checked={ selected === 'new' } /> }
                                    text="New worktree"
                                    stacked
                                    description={ canMakeOne ? 'A separate checkout on a branch of its own' : 'The repository has no commit yet' }
                                    isDisabled={ !canMakeOne }
                                    endAffix={ canMakeOne && base !== undefined ? <BaseButton base={ base } held={ baseHeld } onPress={ event => openList(event.target as Element) } /> : undefined }
                                />
                                {/* Nothing to choose by default here, so the row is a plain submenu's trigger: it flies the folder's worktrees out to its side. */}
                                <SubmenuTrigger>
                                    <MenuItem
                                        id="existing"
                                        icon={ <Mark checked={ selected === 'existing' } /> }
                                        text="Existing worktree"
                                        stacked
                                        description={ worktrees.length === 0 ? 'The folder has no other worktrees' : 'Pick one the folder already has' }
                                        isDisabled={ worktrees.length === 0 }
                                        endAffix={ <ChevronRight aria-hidden="true" /> }
                                    />
                                    <Popover spacing="xs" width={ 340 }>
                                        <PopoverScroll maxHeight={ 360 }>
                                            <Menu
                                                aria-label="Existing worktrees"
                                                size="sm"
                                                selectionMode="single"
                                                selectedKeys={ chosen ? [worktreeKey(chosen.path)] : [] }
                                                onAction={ key => onChoose({ mode: 'existing', path: String(key).slice('worktree:'.length) }) }
                                            >
                                                { worktrees.map(worktree => (
                                                    <MenuItem
                                                        key={ worktree.path }
                                                        id={ worktreeKey(worktree.path) }
                                                        shouldCloseOnSelect
                                                        stacked
                                                        icon={ <Mark checked={ chosen?.path === worktree.path } /> }
                                                        text={ worktreeLabel(worktree) }
                                                        description={ usersLine(chatsUsing(chats.values(), worktree.path)) }
                                                        endAffix={ worktree.dirty ? <span className={ styles.changes } title="Something in it is not committed">Changes</span> : undefined }
                                                    />
                                                )) }
                                            </Menu>
                                        </PopoverScroll>
                                    </Popover>
                                </SubmenuTrigger>
                                <MenuSeparator />
                                <MenuSection aria-label="Worktrees of the project" selectionMode="none">
                                    <MenuItem id={ MANAGE_KEY } shouldCloseOnSelect icon={ <Mark checked={ false } /> } text="Manage worktrees…" />
                                </MenuSection>
                            </Menu>
                        </div>
                    </PopoverScroll>
                    {/* A child of the menu's popover, as a submenu is, so that focus moving into it is not the menu losing it; it opens at the menu's side. The contexts the menu's trigger
                        gives its popover are cleared, or the list would take the menu's anchor and close the menu with itself. */}
                    { listAnchor && (
                        <PopoverContext.Provider value={ null }>
                            <OverlayTriggerStateContext.Provider value={ null }>
                                <PickerPopover
                                    anchor={ listAnchor }
                                    placement="right top"
                                    options={ baseOptions(git) }
                                    selectedIds={ base === undefined ? [] : [base] }
                                    aria-label="Branches"
                                    placeholder="Search branches"
                                    onPick={ (picked) => {
                                        onChoose({ mode: 'new', base: picked });
                                        setIsMenuOpen(false);
                                    } }
                                    onClose={ () => setListAnchor(null) }
                                />
                            </OverlayTriggerStateContext.Provider>
                        </PopoverContext.Provider>
                    ) }
                </Popover>
            </MenuTrigger>
        </>
    );
}

/** The base of the row of a new worktree, a press target of its own at the row's end: it opens the list of branches at the menu's side and leaves the row unpressed. Keyboard users have the right arrow on the row. */
function BaseButton({ base, held, onPress }: { base: string; held: { current: boolean }; onPress: (event: PressEvent) => void }) {
    return (
        <Button
            size="xs"
            variant="filling"
            rounded
            className={ styles.base }
            contentClassName={ styles.baseContent }
            aria-label={ `Start from: ${ base }` }
            excludeFromTabOrder
            onPressStart={ () => void (held.current = true) }
            onPressEnd={ () => void (held.current = false) }
            onPress={ onPress }
        >
            <Text truncate color="secondary">{ base }</Text>
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
export function WorkspaceChips({ repository, choice, chats, onChoose, onManage }: WorkspaceChipsProps) {
    const git = repositoryOf(repository);

    if (git) return <WorkspaceChip git={ git } choice={ choice } chats={ chats } onChoose={ onChoose } onManage={ onManage } />;

    const why = whyUnread(repository);

    if (!why) return null;

    return (
        <Unavailable label="Where it runs: Main worktree" hint={ why } placement="bottom">
            <div role="group" className={ styles.label }>
                <Text truncate color="secondary">Main worktree</Text>
            </div>
        </Unavailable>
    );
}
