import { pathVariants, tildePath } from '../../shared/displayPath';

import type { GitBranches, GitBranchHolder, GitHead, GitSwitchStart } from '@clowdy/protocol';
import type { PickerOption } from '../../shared/PickerPopover';

/** A listing of a place that is a repository. */
export type BranchListing = Extract<GitBranches, { isRepository: true }>;

export const UNAVAILABLE_BRANCH_GROUP = 'Unavailable';
const RECENT_BRANCH_GROUP = 'Recent';

/** What a worktree that has a branch checked out is called in a reason: its path, with the home folder as `~`, or the folder's own checkout. */
export function holderWords(holder: GitBranchHolder, home: string | undefined): string {
    return holder.main ? 'the main worktree' : tildePath(holder.path, home);
}

/** What comes before where, for a branch that a worktree holds. */
const HELD = 'Checked out in ';

/** `Checked out in <where>`: why a branch that a worktree holds is not offered. The daemon refuses it with the same words. */
export const heldWords = (holder: GitBranchHolder, home: string | undefined): string =>
    `${HELD}${holderWords(holder, home)}`;

/** How many characters the second line of a row has room for in the 288 px popover, before the list cuts the end of it. */
const ROW_CHARS = 38;

/**
 * `heldWords` for the second line of a row, which cuts the end of what does not fit, and the end of a path is what tells which worktree it is: the path loses its middle names by whole
 * names (`Checked out in ~/Clowdy/…/ab12cd34/app`), as `PathText` does where it can measure. The daemon's own refusal says the whole path.
 */
export function heldRowWords(holder: GitBranchHolder, home: string | undefined): string {
    if (holder.main) return heldWords(holder, home);

    const forms = pathVariants(tildePath(holder.path, home));

    return `${HELD}${forms.find(form => HELD.length + form.length <= ROW_CHARS) ?? forms.at(-1)}`;
}

/**
 * Pin the default branch above the recent and remaining branches. Prefer local rows and show the rest from origin with their remote prefix.
 * Branches checked out in another worktree go last, with the reason under each name.
 */
export function branchOptions(listing: BranchListing, home?: string): PickerOption[] {
    const localByName = new Map(listing.local.map(branch => [branch.name, branch]));
    const remoteNames = new Set(listing.remote.map(branch => branch.name));
    const options: PickerOption[] = [];
    const unavailable: PickerOption[] = [];
    const taken = new Set<string>();
    const add = (name: string, group?: string) => {
        if (taken.has(name)) return;

        const local = localByName.get(name);

        if (!local && !remoteNames.has(name)) return;

        taken.add(name);

        if (local?.heldBy) {
            unavailable.push({
                id: name,
                label: name,
                group: UNAVAILABLE_BRANCH_GROUP,
                isDisabled: true,
                stacked: true,
                description: heldRowWords(local.heldBy, home),
            });
        } else {
            options.push({ id: name, label: local ? name : `origin/${name}`, group });
        }
    };

    if (listing.defaultBranch !== undefined) add(listing.defaultBranch);

    for (const name of listing.recent) add(name, RECENT_BRANCH_GROUP);

    const otherGroup = options.some(option => option.group === RECENT_BRANCH_GROUP) ? 'Other branches' : undefined;

    for (const name of localByName.keys()) add(name, otherGroup);

    for (const name of remoteNames) add(name, otherGroup);

    return [...options, ...unavailable];
}

/** The two places a new branch can start from, as the form words them: the default branch (`main`) and the current one, each with the name it has now. Nothing for a start that has no name (a detached HEAD, a repository with no default). */
export interface NewBranchStarts {
    default?: string;
    current?: string;
}

export function newBranchStarts(listing: BranchListing | undefined, head: GitHead | undefined): NewBranchStarts {
    const current =
        head?.kind === 'branch' ? head.name : head?.kind === 'detached' ? `${head.commit.slice(0, 7)}` : undefined;

    return {
        ...(listing?.defaultBranch !== undefined && { default: listing.defaultBranch }),
        ...(current !== undefined && { current }),
    };
}

/** What a choice of the form is called, in GitHub Desktop's words. */
export const START_WORDS: Record<GitSwitchStart, { label: (name: string | undefined) => string; description: string }> =
    {
        default: {
            label: name => (name === undefined ? 'The default branch' : `The default branch (${name})`),
            description:
                "The default branch in your repository. Pick this to start on something new that's not dependent on your current branch.",
        },
        current: {
            label: name => (name === undefined ? 'The current branch' : `The current branch (${name})`),
            description:
                'The currently checked out branch. Pick this if you need to build on work done on this branch.',
        },
    };

/** Whether the person can press `Create branch`: a name is typed (the daemon says what is wrong with it) and the start they chose has a branch to start from. */
export const canCreate = (name: string, start: GitSwitchStart, starts: NewBranchStarts): boolean =>
    name.trim() !== '' && starts[start] !== undefined;
