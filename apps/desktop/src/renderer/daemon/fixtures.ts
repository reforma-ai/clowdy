import { createFixtureData, withFixtureLastRun, withFixtureWorkspace } from './fixtureData';
import { FIXTURE_BRANCH_SCRIPTS } from './fixtureGitBranches';
import { FIXTURE_CLONE_SCRIPTS } from './fixtureGitClone';
import { FIXTURE_REMOTE_SCRIPTS } from './fixtureGitRemote';
import { FixtureTransport } from './fixtureTransport';

import type { FixturePullRequestScript } from './fixtureData';
import type { FixtureBranchScript } from './fixtureGitBranches';
import type { FixtureCloneScript } from './fixtureGitClone';
import type { FixtureRemoteScript } from './fixtureGitRemote';
import type { FixtureCommitScript, FixtureDiscardScript, FixtureMessageScript } from './fixtureGitWrites';

/*
 * The fixture daemon as the page's address asks for it. Only the dev server and the tests load this module (`createTransport` imports it on demand in
 * development), so a packaged app carries none of the fixtures.
 */

export interface FixtureOptions {
    timeline: boolean;
    worktree?: true;
    clean?: true;
    base?: true;
    commit?: FixtureCommitScript;
    message?: FixtureMessageScript;
    discard?: Exclude<FixtureDiscardScript, 'ok'>;
    remote?: FixtureRemoteScript;
    pr?: FixturePullRequestScript;
    branches?: FixtureBranchScript[];
    clone?: FixtureCloneScript;
}

/** The words the page's `&pr=` switch knows: what `GET git/pull-request` says of the fixture's worktree. */
const PULL_REQUEST_SCRIPTS = [
    'none',
    'open',
    'draft',
    'merged',
    'closed',
    'no_gh',
    'not_signed_in',
    'no_remote',
    'unavailable',
] as const satisfies readonly FixturePullRequestScript[];

/** The value of a switch of the page's address when it is one of the words the switch knows. */
const oneOf = <T extends string>(value: string | null, words: readonly T[]): T | undefined =>
    words.find(word => word === value);

/**
 * The fixtures the page's address asks for with `?fixtures` (`?fixtures=static` leaves out the timed events, `&worktree` adds the chat that works in a dirty worktree, `?chat=c-9`, whose changes
 * the side panel's Changes tab shows; `&commit=signing|hook|slow` and `&message=failed|slow` say how a commit and a request for its message end there, which the screenshots of the commit
 * box use; `&discard=slow|refused|hook` says how a discard of a file's changes ends (it takes a while, git refuses the file, a post-checkout hook fails after the file is back); `&remote=slow|behind|ahead|level|never|diverged|rejected|signing|offline|renamed|no_origin|detached|unborn` says how a fetch, a pull and a push end and where the branch stands against its upstream
 * and when the repository last fetched (the sync button's states), `&pr=none|open|draft|merged|closed|no_gh|not_signed_in|no_remote|unavailable` what GitHub says of the worktree's branch (`open` by default,
 * `none` is the one that offers Create PR), `&clean` leaves the worktree with nothing uncommitted (hiding the commit form), and `&base` puts the worktree on `main`, the branch the work is compared with; `&branches=remote,held,dirty,refused,slow,warned,merged,idle`, any of the
 * words joined by commas, says what the folder's branches and a switch from the Changes sidebar's branch button, or from the new chat's pill, are like: branches only origin has, branches that worktrees hold, a checkout with
 * changes, a switch that is refused for the chats working there, a switch that takes a while, a switch whose `post-checkout` hook failed after it, a merged worktree, and every chat at rest, which the new chat's pill needs to show a tree with changes alone: it counts the chats of the fixtures that work in the folder;
 * `&clone=slow|failed` says how a Clone repository… ends: it stops at 42% and waits to be cancelled, or git fails with its line and a hint; without it the clone goes through). A word a switch does not know is left out.
 */
export function fixtureOptions(search: string): FixtureOptions {
    const params = new URLSearchParams(search);
    const commit = oneOf(params.get('commit'), ['signing', 'hook', 'slow'] as const);
    const message = oneOf(params.get('message'), ['failed', 'slow'] as const);
    const discard = oneOf(params.get('discard'), ['slow', 'refused', 'hook'] as const);
    const remote = oneOf(params.get('remote'), FIXTURE_REMOTE_SCRIPTS);
    const clone = oneOf(params.get('clone'), FIXTURE_CLONE_SCRIPTS);
    const pr = oneOf(params.get('pr'), PULL_REQUEST_SCRIPTS);
    const branches = (params.get('branches') ?? '')
        .split(',')
        .flatMap(word => oneOf(word.trim(), FIXTURE_BRANCH_SCRIPTS) ?? []);

    return {
        timeline: params.get('fixtures') !== 'static',
        ...(params.has('worktree') && { worktree: true as const }),
        ...(params.has('clean') && { clean: true as const }),
        ...(params.has('base') && { base: true as const }),
        ...(commit && { commit }),
        ...(message && { message }),
        ...(discard && { discard }),
        ...(remote && { remote }),
        ...(pr && { pr }),
        ...(branches.length > 0 && { branches }),
        ...(clone && { clone }),
    };
}

/** The fixture daemon, with the data and the scripted answers `options` asks for. */
export function createFixtureTransport(options: FixtureOptions): FixtureTransport {
    const { timeline, commit, message, discard, remote, pr, branches, clean, base, clone } = options;
    const data = options.worktree ? withFixtureLastRun(withFixtureWorkspace(createFixtureData())) : createFixtureData();

    // The worktree's branch is the branch the work is compared with, which is where a commit goes straight to the base.
    if (base) for (const chat of data.chats) if (chat.workspace) chat.workspace.branch = 'main';

    // What GitHub says of the worktree's branch, for the states of Create PR to be looked at.
    if (pr) for (const scripts of Object.values(data.pullRequests)) scripts.worktree = pr;

    return new FixtureTransport({
        timeline,
        data,
        gitWrites: { commit, message, discard, remote, ...(clean && { clean }) },
        branches,
        clone,
    });
}
