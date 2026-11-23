import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover, PopoverScroll } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Check, Version } from '@clowdy/icons/14';
import { ChevronRight } from '@clowdy/icons/8';
import { capitalize } from '@clowdy/lib';
import { useRef, useState, type KeyboardEvent } from 'react';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { PickerPopover, type PickerOption } from '../../shared/PickerPopover';
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

    const title = worktree ? tildePath(worktree, homeFolder.path) : git?.detached ? 'Detached HEAD' : 'Project checkout';

    return (
        <div role="group" className={ styles.label } title={ title } aria-label={ `Where it runs: ${ worktree ? 'Worktree' : 'Project checkout' }${ branch ? `, branch ${ branch }` : '' }` }>
            <Version aria-hidden="true" />
            { worktree && <Text className={ styles.lead } color="secondary">Worktree</Text> }
            { branch && <Text truncate color={ worktree ? 'default' : 'secondary' }>{ branch }</Text> }
        </div>
    );
}

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

interface WorkspaceChipProps {
    /** The repository the folder is. */
    git: Repository;
    /** What the chat is sent with: `undefined` for the folder's own checkout. */
    choice: ChatWorkspaceChoice | undefined;
    chats: ReadonlyMap<ChatId, Chat>;
    onChoose: (choice: ChatWorkspaceChoice | null) => void;
}

/**
 * The one control of the new chat's place: a pill that says where the chat will work and opens a menu to change it. Closed it says the branch alone for the folder's own
 * checkout, `New worktree` and `from <base>` for a worktree to be made, and `Worktree` and the branch for one that exists. The menu has `Current checkout` (with its branch),
 * `New worktree` (pressing the row chooses it, pressing the base at its end opens the searchable list of the folder's branches to start from, as does the right arrow on the
 * row), and, after a separator, one row for each of the folder's other worktrees with the chats that use it by name and a mark when something in it is not committed. A row's
 * check is at its start. The list of branches is the only popover that follows the menu, and it opens as the menu closes: two at once fight for the focus.
 */
function WorkspaceChip({ git, choice, chats, onChoose }: WorkspaceChipProps) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isListOpen, setIsListOpen] = useState(false);
    const worktrees = pickableWorktrees(git);
    const chosen = choice?.mode === 'existing' ? worktrees.find(worktree => worktree.path === choice.path) : undefined;
    const base = choice?.mode === 'new' ? choice.base ?? git.defaultBranch : git.defaultBranch;
    const canMakeOne = git.defaultBranch !== undefined;
    const branch = git.branch;
    const selected = choice?.mode === 'new' ? 'new' : chosen ? worktreeKey(chosen.path) : 'checkout';
    // The base at the end of the row is pressed, and so is the row under it: react-aria's row takes the release of a press that began on the base as its own and acts. The row's
    // action then opens the list in place of choosing the new worktree, whichever of the two reaches us (the base's own press may be gone with the menu by then).
    const baseHeld = useRef(false);
    const openList = () => {
        setIsMenuOpen(false);
        setIsListOpen(true);
    };
    // The right arrow on the row of a new worktree opens the list its base is picked from, as the base at its end does for the pointer.
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowRight' || !canMakeOne || !(event.target as HTMLElement).closest('[data-new-worktree]')) return;

        event.preventDefault();
        openList();
    };
    const trigger = choice?.mode === 'new'
        ? { label: 'New worktree', trail: base === undefined ? undefined : `from ${ base }`, ariaLabel: `Where it runs: New worktree${ base === undefined ? '' : ` from ${ base }` }` }
        : choice?.mode === 'existing'
            ? { lead: 'Worktree', label: chosen ? worktreeLabel(chosen) : 'Existing worktree', ariaLabel: `Where it runs: Worktree, branch ${ chosen ? worktreeLabel(chosen) : 'unknown' }` }
            : { label: branch ?? 'Project checkout', ariaLabel: `Where it runs: Project checkout${ branch ? `, branch ${ branch }` : '' }` };

    return (
        <>
            <MenuTrigger isOpen={ isMenuOpen } onOpenChange={ setIsMenuOpen }>
                <ChipTrigger
                    ref={ setAnchor }
                    icon={ <Version aria-hidden="true" /> }
                    lead={ 'lead' in trigger ? trigger.lead : undefined }
                    label={ trigger.label }
                    trail={ 'trail' in trigger ? trigger.trail : undefined }
                    aria-label={ trigger.ariaLabel }
                    isOpen={ isListOpen || undefined }
                />
                <Popover placement="bottom start" spacing="xs" width={ 320 }>
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
                                    else if (key === 'new') {
                                        if (baseHeld.current) {
                                            baseHeld.current = false;
                                            openList();
                                        }
                                        // Pressing the mode it is in keeps its base.
                                        else if (choice?.mode !== 'new') onChoose({ mode: 'new' });
                                    }
                                    else onChoose({ mode: 'existing', path: String(key).slice('worktree:'.length) });
                                } }
                            >
                                <MenuItem
                                    id="checkout"
                                    // Every item shuts the menu, from the keyboard's Space too, which a single choice list leaves open.
                                    shouldCloseOnSelect
                                    icon={ <Mark checked={ selected === 'checkout' } /> }
                                    text="Current checkout"
                                    endAffix={ branch ? <Text truncate color="secondary" className={ styles.suffix }>{ branch }</Text> : undefined }
                                />
                                <MenuItem
                                    id="new"
                                    data-new-worktree=""
                                    shouldCloseOnSelect
                                    icon={ <Mark checked={ selected === 'new' } /> }
                                    text="New worktree"
                                    stacked={ !canMakeOne }
                                    description={ canMakeOne ? undefined : 'The repository has no commit yet' }
                                    isDisabled={ !canMakeOne }
                                    endAffix={ canMakeOne && base !== undefined ? <BaseButton base={ base } held={ baseHeld } onPress={ openList } /> : undefined }
                                />
                                { worktrees.length > 0 && <MenuSeparator /> }
                                { worktrees.map(worktree => (
                                    <MenuItem
                                        key={ worktree.path }
                                        id={ worktreeKey(worktree.path) }
                                        shouldCloseOnSelect
                                        stacked
                                        icon={ <Mark checked={ selected === worktreeKey(worktree.path) } /> }
                                        text={ worktreeLabel(worktree) }
                                        description={ usersLine(chatsUsing(chats.values(), worktree.path)) }
                                        endAffix={ worktree.dirty ? <span className={ styles.changes } title="Something in it is not committed">Changes</span> : undefined }
                                    />
                                )) }
                            </Menu>
                        </div>
                    </PopoverScroll>
                </Popover>
            </MenuTrigger>

            { isListOpen && (
                <PickerPopover
                    anchor={ anchor }
                    options={ baseOptions(git) }
                    selectedIds={ base === undefined ? [] : [base] }
                    aria-label="Branches"
                    placeholder="Search branches"
                    onPick={ picked => onChoose({ mode: 'new', base: picked }) }
                    onClose={ () => setIsListOpen(false) }
                />
            ) }
        </>
    );
}

/** The base of the row of a new worktree, a press target of its own at the row's end: it opens the list of branches and leaves the row unpressed. Keyboard users have the right arrow on the row. */
function BaseButton({ base, held, onPress }: { base: string; held: { current: boolean }; onPress: () => void }) {
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
}

/**
 * Where the new chat works, after the folder, in the line under the message box: one pill (`WorkspaceChip`) that says the branch of the folder's own checkout (the default),
 * a new worktree and the ref it starts from, or an existing worktree and its branch, and opens the menu to change it. Only a folder that is a repository offers a worktree; a
 * folder that is no repository, or whose read is still on its way, has nothing here, and one that git could not be asked about has a dim `Project checkout` that says why on
 * hover. The lists come from `useFolderRepository`.
 */
export function WorkspaceChips({ repository, choice, chats, onChoose }: WorkspaceChipsProps) {
    const git = repositoryOf(repository);

    if (git) return <WorkspaceChip git={ git } choice={ choice } chats={ chats } onChoose={ onChoose } />;

    const why = whyUnread(repository);

    if (!why) return null;

    return (
        <Unavailable label="Where it runs: Project checkout" hint={ why } placement="bottom">
            <div role="group" className={ styles.label }>
                <Text truncate color="secondary">Project checkout</Text>
            </div>
        </Unavailable>
    );
}
