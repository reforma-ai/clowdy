import { tildePath } from '../../shared/displayPath';

import type { GitBranches, GitBranchHolder, GitHead, GitSwitchStart } from '@clowdy/protocol';
import type { PickerOption } from '../../shared/PickerPopover';

/** A listing of a place that is a repository. */
export type BranchListing = Extract<GitBranches, { isRepository: true }>;

/** What the button says, and the tooltip of its off state, for a chat's worktree: it is the branch the chat was made on, and the daemon refuses to change it. */
export const WORKTREE_KEEPS_BRANCH = 'A chat\'s worktree keeps its branch';

/** The groups of the list, in the order they are drawn (GitHub Desktop's: the default branch, the ones lately on, the rest, and what only `origin` has). */
export const BRANCH_GROUPS = { default: 'Default', recent: 'Recent', local: 'Local', remote: 'Remote' } as const;

/** What a worktree that has a branch checked out is called in a reason: its path, with the home folder as `~`, or the folder's own checkout. */
export function holderWords(holder: GitBranchHolder, home: string | undefined): string {
    return holder.main ? 'the main worktree' : tildePath(holder.path, home);
}

/** `Checked out in <where>`: why a branch that a worktree holds is not offered. The daemon refuses it with the same words. */
export const heldWords = (holder: GitBranchHolder, home: string | undefined): string => `Checked out in ${ holderWords(holder, home) }`;

/**
 * The rows of the list, in groups and each branch in one: the default branch alone under `Default`, the branches HEAD was on lately under `Recent` (the daemon leaves out the current
 * one), the other local branches under `Local` and the branches only `origin` has under `Remote`. A branch another worktree has checked out is a dimmed row that says where, and is never
 * picked: git would refuse it. A group with no row is not drawn (the options of no group are not listed in it by the list).
 */
export function branchOptions(listing: BranchListing, home?: string): PickerOption[] {
    const options: PickerOption[] = [];
    const taken = new Set<string>();
    const add = (group: string, name: string, holder?: GitBranchHolder) => {
        if (taken.has(name)) return;

        taken.add(name);
        options.push({ id: name, label: name, group, ...(holder && { isDisabled: true, stacked: true, description: heldWords(holder, home) }) });
    };
    const holderOf = (name: string) => listing.local.find(branch => branch.name === name)?.heldBy;
    const defaults = [...listing.local.filter(branch => branch.default).map(branch => branch.name), ...listing.remote.filter(branch => branch.default).map(branch => branch.name)];

    for (const name of defaults) add(BRANCH_GROUPS.default, name, holderOf(name));

    for (const name of listing.recent) add(BRANCH_GROUPS.recent, name, holderOf(name));

    for (const branch of listing.local) add(BRANCH_GROUPS.local, branch.name, branch.heldBy);

    for (const branch of listing.remote) add(BRANCH_GROUPS.remote, branch.name);

    return options;
}

/** The two places a new branch can start from, as the form words them: the default branch (`main`) and the current one, each with the name it has now. Nothing for a start that has no name (a detached HEAD, a repository with no default). */
export interface NewBranchStarts {
    default?: string;
    current?: string;
}

export function newBranchStarts(listing: BranchListing | undefined, head: GitHead | undefined): NewBranchStarts {
    const current = head?.kind === 'branch' ? head.name : head?.kind === 'detached' ? `${ head.commit.slice(0, 7) }` : undefined;

    return { ...(listing?.defaultBranch !== undefined && { default: listing.defaultBranch }), ...(current !== undefined && { current }) };
}

/** What a choice of the form is called, in GitHub Desktop's words. */
export const START_WORDS: Record<GitSwitchStart, { label: (name: string | undefined) => string; description: string }> = {
    default: {
        label: name => (name === undefined ? 'The default branch' : `The default branch (${ name })`),
        description: 'The default branch in your repository. Pick this to start on something new that\'s not dependent on your current branch.',
    },
    current: {
        label: name => (name === undefined ? 'The current branch' : `The current branch (${ name })`),
        description: 'The currently checked out branch. Pick this if you need to build on work done on this branch.',
    },
};

/** Whether the person can press `Create branch`: a name is typed (the daemon says what is wrong with it) and the start they chose has a branch to start from. */
export const canCreate = (name: string, start: GitSwitchStart, starts: NewBranchStarts): boolean => name.trim() !== '' && starts[start] !== undefined;
