import { branchOptions, UNAVAILABLE_BRANCH_GROUP } from '../changes/branchChoices';
import { isRunActive } from '../chats/chatRun';
import { folderById, orchestratorOf } from './agentTree';

import type { Chat, FolderId, GitStatus, ProjectFolder, Run, RunId } from '@clowdy/protocol';
import type { PickerOption } from '../../shared/PickerPopover';
import type { BranchListing } from '../changes/branchChoices';

/** Why the new chat's branch cannot be picked now: the daemon's own words for it, with the line it adds under them. */
export interface MainBranchBlock {
    message: string;
    hint?: string;
}

/** The daemon's words for a tree with a change in it (`GitSwitch`), which the pill says before the person asks. */
export const COMMIT_FIRST = 'Commit or discard the changes first';

/**
 * How many chats of the project work in the folder's own checkout right now, as the daemon counts them (`chatsWorkingIn`): the chats whose orchestrator has not ended (queued, running,
 * waiting for the person, blocked or waiting for its background work), in this folder and not in a worktree. A chat with no folder follows the main folder (`folderById`), and a thread is a chat
 * of its own. A convenience: the daemon sees runs the window has not heard of, and has the last word.
 */
export function chatsWorkingInCheckout(
    chats: Iterable<Chat>,
    runs: ReadonlyMap<RunId, Run>,
    folders: readonly ProjectFolder[],
    folderId: FolderId
): number {
    let working = 0;

    for (const chat of chats) {
        if (chat.workspace === undefined && folderById(folders, chat.folderId).id === folderId && isWorking(chat, runs))
            working++;
    }

    return working;
}

const isWorking = (chat: Chat, runs: ReadonlyMap<RunId, Run>): boolean => isRunActive(orchestratorOf(chat, runs));

/**
 * Why the folder's checkout cannot change branch, the first that holds, from what the window knows (the chats that work there and the status of the tree); `undefined` when nothing in
 * its way is known. The daemon judges the same things in the same order and says the same words, and also the ones the window cannot see (a merge or a rebase under way, an agent that is
 * not Clowdy's): a convenience, never the rule. A status that was not read (`undefined`), is not a repository, or lists no path says nothing; one that was cut counts `N+` files.
 */
export function mainBranchBlock(working: number, status: GitStatus | undefined): MainBranchBlock | undefined {
    if (working > 0)
        return {
            message: `${working} ${working === 1 ? 'chat is' : 'chats are'} working here`,
            hint: 'Stop them or wait until they finish',
        };

    if (status?.isRepository !== true || status.entries.length === 0) return undefined;

    const count = status.entries.length;

    return {
        message: COMMIT_FIRST,
        hint: `${count}${status.truncated ? '+' : ''} ${count === 1 && !status.truncated ? 'file' : 'files'} changed`,
    };
}

/** The branch the folder's checkout is on, as the listing says it; none on a detached HEAD. */
export const currentBranchOf = (listing: BranchListing): string | undefined =>
    listing.local.find(branch => branch.current)?.name;

/**
 * The rows of the Changes branch picker. When the checkout is blocked, only its current branch is available.
 */
export function mainBranchOptions(
    listing: BranchListing,
    block: MainBranchBlock | undefined,
    home: string | undefined
): PickerOption[] {
    const options = branchOptions(listing, home);

    if (block === undefined) return options;

    const current = currentBranchOf(listing);
    const available = options.find(option => option.id === current);

    return [
        ...(available ? [{ ...available, group: undefined }] : []),
        ...options
            .filter(option => option.id !== current)
            .map(option => ({ ...option, group: UNAVAILABLE_BRANCH_GROUP, isDisabled: true })),
    ];
}
