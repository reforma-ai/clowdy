import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Check, Version } from '@clowdy/icons/14';
import { capitalize } from '@clowdy/lib';
import { useRef, useState, type ReactNode } from 'react';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import { PickerPopover, type PickerOption } from '../../shared/PickerPopover';
import { Unavailable } from '../../shared/Unavailable';
import { ChipTrigger } from './ChipTrigger';
import styles from './WorkspaceChips.module.css';
import { chatsUsing, modeOf, pickableWorktrees, repositoryOf, worktreeLabel, type Repository, type WorkspaceMode } from './workspaceChoice';

import type { Chat, ChatId, ChatWorkspaceChoice } from '@clowdy/protocol';
import type { FolderGit } from '../openWith';
import type { FolderRepository } from './useFolderRepository';

/** What the pills say of each way a new chat may work. */
const MODE_LABELS: Record<WorkspaceMode, string> = { checkout: 'Project checkout', new: 'New worktree', existing: 'Existing worktree' };

/** A chip with nothing to press, in the place and the size of the pills: a mark, and what it says. */
function ChipLabel({ icon, label, title, 'aria-label': ariaLabel }: { icon?: ReactNode; label: string; title?: string; 'aria-label'?: string }) {
    return (
        <div role="group" className={ styles.label } title={ title } aria-label={ ariaLabel }>
            { icon }
            <Text truncate>{ label }</Text>
        </div>
    );
}

/** The branch that is checked out, in the muted type of the line: its name, or the short hash of a detached HEAD. */
export function BranchLabel({ branch, detached }: { branch: string; detached?: boolean }) {
    return <ChipLabel icon={ <Version aria-hidden="true" /> } label={ branch } title={ detached ? 'Detached HEAD' : 'Branch' } aria-label={ `Branch: ${ branch }` } />;
}

/**
 * Where a chat that has started works, read only: `Project checkout` for the folder's own checkout, `Worktree` for a worktree (the path on hover), and the branch the tree has
 * checked out now (`git`, from `useFolderGit`). The pills of the new-chat page (`WorkspaceChips`) become these when the first message is sent, and stay in their place.
 */
export function WorkspaceLabels({ worktree, git }: { worktree: string | undefined; git: FolderGit | undefined }) {
    return (
        <>
            <ChipLabel label={ worktree ? 'Worktree' : 'Project checkout' } title={ worktree && tildePath(worktree, homeFolder.path) } aria-label={ `Where it runs: ${ worktree ? 'Worktree' : 'Project checkout' }` } />
            { git?.branch && <BranchLabel branch={ git.branch } detached={ git.detached } /> }
        </>
    );
}

/** Why a folder offers no worktrees: git could not be asked, or the folder is no repository. Nothing while the answer is on its way. */
function whyNoWorktrees(repository: FolderRepository): string | undefined {
    switch (repository.status) {
        case 'loading':
            return undefined;
        case 'failed':
            return repository.reason ? capitalize(repository.reason) : 'Couldn\'t read the folder\'s git';
        case 'ready':
            return repository.git.isRepository ? undefined : 'This folder is not a git repository';
    }
}

/** What the list of existing worktrees says under a worktree's branch: the chats that work in it, by name. */
function usersLine(chats: readonly Chat[]): string {
    if (chats.length === 0) return 'No chat uses it';

    if (chats.length <= 2) return chats.map(chat => chat.title).join(', ');

    return `${ chats[0].title }, ${ chats[1].title } and ${ chats.length - 2 } more`;
}

function worktreeOptions(repository: Repository, chats: ReadonlyMap<ChatId, Chat>): PickerOption[] {
    return pickableWorktrees(repository).map(worktree => ({
        id: worktree.path,
        label: worktreeLabel(worktree),
        icon: <Version aria-hidden="true" />,
        stacked: true,
        description: usersLine(chatsUsing(chats.values(), worktree.path)),
        trailing: worktree.dirty ? <span className={ styles.changes } title="Something in it is not committed">Changes</span> : undefined,
    }));
}

interface ModeChipProps {
    repository: FolderRepository;
    /** The repository, when the folder is one. */
    git: Repository | undefined;
    /** What the chat is sent with: `undefined` for Project checkout. */
    choice: ChatWorkspaceChoice | undefined;
    chats: ReadonlyMap<ChatId, Chat>;
    onChoose: (choice: ChatWorkspaceChoice | null) => void;
}

/**
 * The mode of the new chat: `Project checkout`, `New worktree` or `Existing worktree…` (which opens the folder's worktrees, each with its branch, the chats that work in it
 * and a mark when something in it is not committed). A pill that opens the list of the three, or, where the folder offers no worktree (no repository, git not there, or the answer
 * still on its way), the first of them alone, off, with the reason on hover.
 */
function ModeChip({ repository, git, choice, chats, onChoose }: ModeChipProps) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [isListOpen, setIsListOpen] = useState(false);
    // The list of worktrees opens once the menu has closed: two popovers at once fight for the focus.
    const listWanted = useRef(false);
    const mode = modeOf(choice);

    if (!git) {
        const why = whyNoWorktrees(repository);
        const pill = <ChipLabel label={ MODE_LABELS.checkout } aria-label={ `Where it runs: ${ MODE_LABELS.checkout }` } />;

        return why ? <Unavailable label={ `Where it runs: ${ MODE_LABELS.checkout }` } hint={ why } placement="bottom">{ pill }</Unavailable> : pill;
    }

    const worktrees = pickableWorktrees(git);
    const chosen = choice?.mode === 'existing' ? worktrees.find(worktree => worktree.path === choice.path) : undefined;
    const label = chosen ? `Worktree: ${ worktreeLabel(chosen) }` : MODE_LABELS[mode];

    return (
        <>
            <MenuTrigger onOpenChange={ (isOpen) => {
                // A wish left over from a menu that was shut some other way is not one for this opening.
                if (isOpen) listWanted.current = false;
                else if (listWanted.current) {
                    listWanted.current = false;
                    setIsListOpen(true);
                }
            } }
            >
                <ChipTrigger ref={ setAnchor } label={ label } aria-label={ `Where it runs: ${ label }` } isOpen={ isListOpen || undefined } />
                <Popover placement="bottom start" spacing="xs" width={ 280 }>
                    <Menu
                        aria-label="Where the chat works"
                        size="sm"
                        selectionMode="single"
                        selectedKeys={ [mode] }
                        disallowEmptySelection
                        onAction={ (key) => {
                            if (key === 'checkout') onChoose(null);
                            // Pressing the mode it is in keeps its base.
                            else if (key === 'new' && mode !== 'new') onChoose({ mode: 'new' });
                            else if (key === 'existing') listWanted.current = true;
                        } }
                    >
                        <MenuItem
                            id="checkout"
                            // Every item shuts the menu, from the keyboard's Space too, which a single choice list leaves open: the list of worktrees opens as the menu closes.
                            shouldCloseOnSelect
                            text={ MODE_LABELS.checkout }
                            description="Work in the folder as it is"
                            stacked
                            endAffix={ mode === 'checkout' ? <Check aria-hidden="true" /> : undefined }
                        />
                        <MenuItem
                            id="new"
                            shouldCloseOnSelect
                            text={ MODE_LABELS.new }
                            description={ git.defaultBranch === undefined ? 'The repository has no commit yet' : 'A separate checkout on a branch of its own' }
                            stacked
                            isDisabled={ git.defaultBranch === undefined }
                            endAffix={ mode === 'new' ? <Check aria-hidden="true" /> : undefined }
                        />
                        <MenuItem
                            id="existing"
                            shouldCloseOnSelect
                            text={ `${ MODE_LABELS.existing }…` }
                            description={ worktrees.length === 0 ? 'The folder has no other worktrees' : 'Pick one the folder already has' }
                            stacked
                            isDisabled={ worktrees.length === 0 }
                            endAffix={ mode === 'existing' ? <Check aria-hidden="true" /> : undefined }
                        />
                    </Menu>
                </Popover>
            </MenuTrigger>

            { isListOpen && (
                <PickerPopover
                    anchor={ anchor }
                    options={ worktreeOptions(git, chats) }
                    selectedIds={ chosen ? [chosen.path] : [] }
                    aria-label="Existing worktrees"
                    placeholder="Search worktrees"
                    onPick={ path => onChoose({ mode: 'existing', path }) }
                    onClose={ () => setIsListOpen(false) }
                />
            ) }
        </>
    );
}

/** The ref a new worktree starts from: a searchable list of the folder's branches, the default one marked. */
function BaseChip({ git, current, onPick }: { git: Repository; current: string; onPick: (base: string) => void }) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    // On a detached HEAD the default is the commit, which is no branch of the list.
    const names = git.branches.map(branch => branch.name);
    const options: PickerOption[] = [
        ...(git.defaultBranch !== undefined && !names.includes(git.defaultBranch) ? [git.defaultBranch] : []),
        ...names,
    ].map(name => ({ id: name, label: name, description: name === git.defaultBranch ? 'Default' : undefined }));

    return (
        <>
            <ChipTrigger
                ref={ setAnchor }
                icon={ <Version aria-hidden="true" /> }
                label={ `Branch from: ${ current }` }
                aria-label={ `Branch from: ${ current }` }
                isOpen={ isOpen }
                onPress={ () => setIsOpen(true) }
            />

            { isOpen && (
                <PickerPopover
                    anchor={ anchor }
                    options={ options }
                    selectedIds={ [current] }
                    aria-label="Branches"
                    placeholder="Search branches"
                    onPick={ onPick }
                    onClose={ () => setIsOpen(false) }
                />
            ) }
        </>
    );
}

export interface WorkspaceChipsProps {
    /** What the daemon says of the folder the new chat is for. */
    repository: FolderRepository;
    /** What the chat will be sent with (`effectiveChoice`): the chips show this and never what the repository does not bear out. */
    choice: ChatWorkspaceChoice | undefined;
    /** The project's chats, which the list of worktrees names the users of each by. */
    chats: ReadonlyMap<ChatId, Chat>;
    onChoose: (choice: ChatWorkspaceChoice | null) => void;
}

/**
 * The mode and the branch of the new chat, after the folder, in the line under the message box. The mode says where the chat works: the folder's own checkout (`Project
 * checkout`, the default, with the branch that is checked out as a label), a new worktree (with `Branch from: <ref>` to pick the ref it starts from) or an existing one (the
 * worktree's own branch is its label, so no branch chip). Only a folder that is a repository offers a worktree; any other keeps Project checkout alone. The lists come
 * from `useFolderRepository`.
 */
export function WorkspaceChips({ repository, choice, chats, onChoose }: WorkspaceChipsProps) {
    const git = repositoryOf(repository);
    // A new worktree starts from the ref picked, else from the folder's default one, which `effectiveChoice` has made sure there is.
    const base = choice?.mode === 'new' ? choice.base ?? git?.defaultBranch : undefined;

    return (
        <>
            <ModeChip repository={ repository } git={ git } choice={ choice } chats={ chats } onChoose={ onChoose } />
            { git && !choice && git.branch && <BranchLabel branch={ git.branch } detached={ git.detached } /> }
            { git && base !== undefined && <BaseChip git={ git } current={ base } onPick={ picked => onChoose({ mode: 'new', base: picked }) } /> }
        </>
    );
}
