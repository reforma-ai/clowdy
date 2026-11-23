import type { GitBase, GitRemoteAction, GitRemoteResult, GitStatus, GitUpstream } from '@clowdy/protocol';

/** A status of a place that is a repository. */
type RepositoryStatus = Extract<GitStatus, { isRepository: true }>;

/** The only remote the app moves commits to and from. */
const ORIGIN = 'origin';

/** The four things the sidebar's menu offers. Publishing is pushing a branch that has no upstream yet, so it is one call of the transport (`remoteCall`). */
export type RemoteActionId = 'fetch' | 'pull' | 'push' | 'publish';

/** The transport call an action makes. */
export const remoteCall = (id: RemoteActionId): GitRemoteAction => (id === 'publish' ? 'push' : id);

/** One entry of the menu: what it is called, how many commits it moves, and why it cannot run right now. */
export interface RemoteActionView {
    id: RemoteActionId;
    label: string;
    /** `Pull`: the commits the upstream has that the branch lacks; `Push`: the commits the branch has that the upstream lacks. */
    count?: number;
    /** Why it cannot run, in a few words; absent when it can. */
    reason?: string;
}

/** Whether a branch tracks something on `origin`: its upstream is named `origin/<branch>`. */
const onOrigin = (upstream: GitUpstream): boolean => upstream.name.startsWith(`${ ORIGIN }/`);

/** The upstream of a branch that tracks something that is not on `origin` (another remote, or a local branch), still there or gone: the daemon moves nothing of it, and publishing is refused too. */
const foreignUpstream = (upstream: GitUpstream | undefined): GitUpstream | undefined => (upstream && !onOrigin(upstream) ? upstream : undefined);

const foreignWords = (upstream: GitUpstream): string => `Tracks ${ upstream.name }, not ${ ORIGIN }`;

/** Whether the branch and its upstream each have commits the other lacks, so neither a pull nor a push can settle it. */
export const isDiverged = (upstream: GitUpstream | undefined): boolean => upstream !== undefined && !upstream.gone && upstream.ahead > 0 && upstream.behind > 0;

const divergedWords = (upstream: GitUpstream): string => `Diverged: ${ upstream.ahead } ahead, ${ upstream.behind } behind`;

/** The upstream of a branch that is published: it has one that is still there. Nothing for a branch that is not published and for one whose upstream is gone from origin. */
const publishedUpstream = (upstream: GitUpstream | undefined): GitUpstream | undefined => (upstream && !upstream.gone ? upstream : undefined);

/**
 * What stops any move of the branch right now, as a few words: the repository has no `origin`, or another action is running. Nothing when neither is so.
 */
function blockOf(status: RepositoryStatus, busy: boolean): string | undefined {
    if (!status.origin) return 'No origin';

    return busy ? 'An action is running' : undefined;
}

/** What stops a pull or a push, beyond what stops any move: a HEAD that is on no branch, a branch with no commit, an upstream that is not on `origin`. */
function branchBlock(status: RepositoryStatus): string | undefined {
    const { head, upstream } = status;

    if (head.kind === 'detached') return 'HEAD is detached';

    if (head.kind === 'unborn') return 'No commits yet';

    const foreign = foreignUpstream(upstream);

    return foreign && foreignWords(foreign);
}

/**
 * The menu of the sidebar for a place: Fetch, Pull and, last, Publish while the branch has no upstream (or its upstream is gone from origin) and Push once it has one. Each action is listed
 * with the reason it cannot run (no origin, an action running, a detached HEAD, nothing to pull, nothing to push, not published, diverged), so a person sees why and not only that it is
 * off. Nothing for a place that is not a repository. The commit counts are those of the last fetch: Fetch is how they are brought up to date.
 */
export function remoteActions(status: GitStatus | undefined, busy: boolean): RemoteActionView[] {
    if (status?.isRepository !== true) return [];

    const block = blockOf(status, busy);
    const moves = block ?? branchBlock(status);
    const published = publishedUpstream(status.upstream);
    const fetch: RemoteActionView = { id: 'fetch', label: 'Fetch origin', ...(block && { reason: block }) };

    // A branch that is not on origin has nothing to pull from, and is published in place of being pushed.
    if (!published) {
        const pull: RemoteActionView = { id: 'pull', label: 'Pull origin', reason: moves ?? (status.upstream ? `Upstream gone from ${ ORIGIN }` : 'Not published yet') };

        return [fetch, pull, { id: 'publish', label: 'Publish branch', ...(moves && { reason: moves }) }];
    }

    const pullReason = moves ?? (isDiverged(published) ? divergedWords(published) : published.behind === 0 ? 'Nothing to pull' : undefined);
    const pushReason = moves ?? (isDiverged(published) ? divergedWords(published) : published.ahead === 0 ? 'Nothing to push' : undefined);

    return [
        fetch,
        { id: 'pull', label: 'Pull origin', ...(published.behind > 0 && { count: published.behind }), ...(pullReason && { reason: pullReason }) },
        { id: 'push', label: 'Push origin', ...(published.ahead > 0 && { count: published.ahead }), ...(pushReason && { reason: pushReason }) },
    ];
}

/** `1 commit`, `2 commits`. */
const commitsWords = (count: number): string => `${ count } ${ count === 1 ? 'commit' : 'commits' }`;

/**
 * When the last fetch was, in GitHub Desktop's words: `Last fetched 3 minutes ago`, `Last fetched just now` under a minute, and `Never fetched` for a repository that has not fetched
 * (`GitStatus.lastFetchedAt` is absent). The unit is the largest that fits, rounded down: minutes, hours, days, weeks, months, years.
 */
export function lastFetchedWords(at: number | undefined, now: number): string {
    if (at === undefined) return 'Never fetched';

    const minutes = Math.floor(Math.max(0, now - at) / 60_000);
    const ago = (count: number, unit: string) => `Last fetched ${ count } ${ unit }${ count === 1 ? '' : 's' } ago`;

    if (minutes < 1) return 'Last fetched just now';

    if (minutes < 60) return ago(minutes, 'minute');

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return ago(hours, 'hour');

    const days = Math.floor(hours / 24);

    if (days < 7) return ago(days, 'day');

    if (days < 30) return ago(Math.floor(days / 7), 'week');

    return days < 365 ? ago(Math.floor(days / 30), 'month') : ago(Math.floor(days / 365), 'year');
}

/** The state of the sync button, which is the next thing to do with the branch. */
export type SyncKind =
    /** An action is running: its progress is the label. */
    | 'running'
    /** The repository has no `origin`: nothing to sync with. */
    | 'no_origin'
    /** HEAD is on no branch, or the branch has no commit yet: there is nothing to publish. */
    | 'blocked'
    /** The branch is not on origin (or its upstream is gone): publish it. */
    | 'publish'
    /** Origin has commits the branch lacks. */
    | 'pull'
    /** The branch has commits origin lacks. */
    | 'push'
    /** Each side has commits the other lacks: the app leaves it alone, so nothing can be pressed. */
    | 'diverged'
    /** Nothing to move: look for what is new. */
    | 'fetch';

/** What the sync button says and does for a place. */
export interface SyncView {
    kind: SyncKind;
    /** The next action in GitHub Desktop's words (`Publish branch`, `Pull origin`, `Push origin`, `Fetch origin`), `Diverged`, or what is running (`Pulling origin`). */
    label: string;
    /** The line under the label: when the last fetch was, or the one thing to know about the state. */
    line?: string;
    /** Commits the branch has that its upstream lacks, drawn as an up arrow with the count; for Push and for a branch that diverged. */
    ahead?: number;
    /** Commits the upstream has that the branch lacks, drawn as a down arrow with the count; for Pull and for a branch that diverged. */
    behind?: number;
    /** The action a press runs; absent for a button that cannot be pressed. */
    action?: RemoteActionId;
    /** Why it cannot be pressed, shown as a tooltip on it; absent when it can. */
    reason?: string;
    /** `warning` for what needs the person (a branch that diverged, an upstream that is gone). */
    tone?: 'warning';
    /** The whole of it, for a tooltip, with the upstream's name. */
    title: string;
}

/** The first letter in lower case, to carry a line on in a sentence: `Last fetched 3 minutes ago` is `last fetched 3 minutes ago` after a comma. */
const lowered = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The one button of the sidebar that moves the branch, in GitHub Desktop's order: **running** (the action's progress, and it cannot be pressed), **no origin** (nothing to sync with),
 * **detached HEAD** or a **branch with no commit** (`Publish branch`, off with the reason), **no upstream** or one that is gone (`Publish branch`), **an upstream that is not on origin**
 * (`Fetch origin` is all that works), **diverged** (`Diverged`, off: the app does not merge, so neither Pull nor Push is taken, and the line says to merge or rebase elsewhere), **behind**
 * (`Pull origin` with the count), **ahead** (`Push origin` with the count) and last, level, **`Fetch origin`**. The line under the label says when the last fetch was where the counts
 * are as old as it, and what else there is to know where they are not. The dropdown beside it keeps every action with its reason (`remoteActions`). Nothing for a place that is not a
 * repository.
 */
export function syncButton(status: GitStatus | undefined, running: RemoteActionId | undefined, now: number): SyncView | undefined {
    if (status?.isRepository !== true) return undefined;

    if (running !== undefined) return { kind: 'running', label: RUNNING_WORDS[running], reason: 'An action is running', title: RUNNING_WORDS[running] };

    if (!status.origin) return { kind: 'no_origin', label: 'No origin', line: 'Nothing to sync with', reason: 'No origin', title: `The repository has no remote called ${ ORIGIN }, so there is nothing to sync with` };

    const { head, upstream } = status;

    if (head.kind === 'detached') return { kind: 'blocked', label: 'Publish branch', line: 'HEAD is detached', reason: 'HEAD is detached', title: 'HEAD is detached, so there is no branch to publish' };

    if (head.kind === 'unborn') return { kind: 'blocked', label: 'Publish branch', line: 'No commits yet', reason: 'No commits yet', title: 'The branch has no commits yet, so there is nothing to publish' };

    const published = publishedUpstream(upstream);
    const fetched = lastFetchedWords(status.lastFetchedAt, now);
    const foreign = foreignUpstream(upstream);

    // What the branch tracks is not on origin, there or gone: the daemon refuses to pull, push or publish it, so Fetch origin is all that works.
    if (foreign) return { kind: 'fetch', label: 'Fetch origin', line: foreignWords(foreign), action: 'fetch', title: `${ foreignWords(foreign) }: pull, push and publish are off, ${ lowered(fetched) }` };

    if (!published) {
        return upstream
            ? { kind: 'publish', label: 'Publish branch', line: `Upstream gone from ${ ORIGIN }`, action: 'publish', tone: 'warning', title: `${ upstream.name } is gone from ${ ORIGIN }: publish the branch again` }
            : { kind: 'publish', label: 'Publish branch', line: `Publish this branch to ${ ORIGIN }`, action: 'publish', title: `The branch is not on ${ ORIGIN } yet: publish it` };
    }

    if (isDiverged(published)) {
        return {
            kind: 'diverged',
            label: 'Diverged',
            line: 'Merge or rebase in a terminal',
            ahead: published.ahead,
            behind: published.behind,
            reason: divergedWords(published),
            tone: 'warning',
            title: `Diverged from ${ published.name }: ${ published.ahead } ahead, ${ published.behind } behind. The app does not merge, so Pull and Push are off: merge or rebase it in a terminal, or ask the agent to`,
        };
    }

    if (published.behind > 0) return { kind: 'pull', label: 'Pull origin', line: fetched, behind: published.behind, action: 'pull', title: `Pull origin: ${ commitsWords(published.behind) } to take from ${ published.name }, ${ lowered(fetched) }` };

    if (published.ahead > 0) return { kind: 'push', label: 'Push origin', line: fetched, ahead: published.ahead, action: 'push', title: `Push origin: ${ commitsWords(published.ahead) } to send to ${ published.name }, ${ lowered(fetched) }` };

    return { kind: 'fetch', label: 'Fetch origin', line: fetched, action: 'fetch', title: `Fetch origin to look for new commits: ${ published.name } is up to date, ${ lowered(fetched) }` };
}

/** What an action that ended says, as a quiet line: what came in or went out, or that the branch was left as it was. */
export function remoteNotice(result: GitRemoteResult): { words: string; tone?: 'warning' } {
    if (result.state === 'diverged') return { words: `${ divergedWords(result.upstream) }, left as it was`, tone: 'warning' };

    switch (result.action) {
        case 'fetch':
            return { words: 'Fetched origin' };
        case 'pull':
            return { words: result.pulled ? `Pulled ${ commitsWords(result.pulled) }` : 'Already up to date' };
        default:
            return { words: result.published ? 'Published to origin' : 'Pushed to origin' };
    }
}

/**
 * Why Commit & Push is not offered, as a few words; nothing when it is: there is no `origin`, HEAD is on no branch, the branch tracks something that is not on `origin`, or its upstream has
 * commits that it lacks (the push after the commit would be rejected, so it is pulled first) or has diverged. A branch with no commit yet is fine: the commit is its first, and publishing it comes after.
 */
export function commitAndPushBlock(status: GitStatus | undefined): string | undefined {
    if (status?.isRepository !== true) return 'Not a repository';

    if (!status.origin) return 'No origin';

    if (status.head.kind === 'detached') return 'HEAD is detached';

    const foreign = foreignUpstream(status.upstream);

    if (foreign) return foreignWords(foreign);

    const published = publishedUpstream(status.upstream);

    if (!published) return undefined;

    if (isDiverged(published)) return divergedWords(published);

    return published.behind > 0 ? `${ commitsWords(published.behind) } to pull first` : undefined;
}

/** The action that sends the branch of a status after a commit: a push when it is on origin, else its publishing. */
export const pushOrPublish = (status: GitStatus | undefined): 'push' | 'publish' => (status?.isRepository === true && publishedUpstream(status.upstream) ? 'push' : 'publish');

/** What a running action says, in GitHub Desktop's words: the label of the sync button that is doing it, and what the menu's entry of it becomes. */
export const RUNNING_WORDS: Record<RemoteActionId, string> = { fetch: 'Fetching origin', pull: 'Pulling origin', push: 'Pushing origin', publish: 'Publishing branch' };

/** The branch a status is on, nothing for a HEAD that is on none. */
const branchOf = (status: RepositoryStatus): string | undefined => (status.head.kind === 'detached' ? undefined : status.head.name);

/**
 * The name the branch has on `origin`, which is the name GitHub knows it by: the branch it tracks there (a branch made with `git switch -c mine origin/feature` tracks `feature`, and that is
 * what a push sends it to), else its own name, which is what publishing it makes. Nothing for a HEAD on no branch.
 */
export function remoteBranchOf(status: RepositoryStatus): string | undefined {
    const { upstream } = status;

    return upstream && onOrigin(upstream) ? upstream.name.slice(ORIGIN.length + 1) : branchOf(status);
}

/**
 * The name GitHub knows a base by, from the base the Changes tab compares with (`GitBase.name`): `origin/main` is `main`, and a local `main` stays `main`. A base that is a commit (a
 * short hash) has no such name here, and the compare page is then left to choose its own.
 */
export function githubBaseName(base: GitBase | undefined): string | undefined {
    if (base?.state !== 'ready' && base?.state !== 'no_merge_base') return undefined;

    const name = base.name.startsWith(`${ ORIGIN }/`) ? base.name.slice(ORIGIN.length + 1) : base.name;

    return /^[0-9a-f]{7,40}$/i.test(name) ? undefined : name;
}

/** What Create PR is, for a place and its branch. */
export type CreatePullRequestState =
    /** The branch is on origin and has work: the button opens the compare page. */
    | { kind: 'ready'; label: 'Create PR' }
    /** The branch is not on origin: publishing it comes first, and then the page can be opened. */
    | { kind: 'publish'; label: 'Publish first' }
    /** The branch is on origin and has commits that are not: they are pushed first. */
    | { kind: 'push'; label: 'Push first' }
    /** Create PR is shown and cannot be pressed, with the reason. */
    | { kind: 'blocked'; label: 'Create PR'; reason: string };

export interface CreatePullRequestInput {
    status: GitStatus | undefined;
    /** The branch already has a pull request: Create PR is then the chip's link and not a button. */
    hasPullRequest: boolean;
    /** The remote has a compare page: it is a GitHub one (`compareLink` builds the address of it). */
    onGitHub: boolean;
}

/**
 * Whether Create PR is offered for a place, and in what state. Nothing (no button) for a place that is not a repository, one with no `origin` or a remote that is not on GitHub, a HEAD on no
 * branch, and a branch that has a pull request already. Otherwise: **blocked** on the branch the work is compared with (`Switch to a feature branch`), on one with no commits ahead of it, on
 * one that diverged from its upstream and on one that tracks another remote; **publish first** for a branch that is not on origin; **push first** for one with commits that are not; else **ready**.
 * The compare page is never offered for a branch GitHub does not have.
 */
export function createPullRequest({ status, hasPullRequest, onGitHub }: CreatePullRequestInput): CreatePullRequestState | undefined {
    if (status?.isRepository !== true || !status.origin || hasPullRequest || !onGitHub) return undefined;

    const branch = branchOf(status);

    if (branch === undefined || status.head.kind === 'unborn') return undefined;

    const { base } = status;
    const foreign = foreignUpstream(status.upstream);
    const published = publishedUpstream(status.upstream);

    // The branch the work is compared with is the branch itself: there is no pull request to make from it.
    if (githubBaseName(base) === branch) return { kind: 'blocked', label: 'Create PR', reason: 'Switch to a feature branch' };

    if (base.state === 'ready' && base.ahead === 0) return { kind: 'blocked', label: 'Create PR', reason: `No commits ahead of ${ base.name }` };

    if (foreign) return { kind: 'blocked', label: 'Create PR', reason: foreignWords(foreign) };

    if (!published) return { kind: 'publish', label: 'Publish first' };

    if (isDiverged(published)) return { kind: 'blocked', label: 'Create PR', reason: divergedWords(published) };

    return published.ahead > 0 ? { kind: 'push', label: 'Push first' } : { kind: 'ready', label: 'Create PR' };
}

/** What the empty state of the commit box suggests: the next thing to do with a branch that has nothing uncommitted. */
export type NextStepKind = 'publish' | 'pull' | 'push' | 'pullRequest';

export interface NextStep {
    kind: NextStepKind;
    /** GitHub Desktop's words for the action: `Publish your branch`, `Pull 2 commits from the origin remote`, `Push 1 commit to the origin remote`, `Create a Pull Request from your current branch`. */
    title: string;
    /** One phrase on why, under the action. */
    description: string;
}

/**
 * The one step the empty state of the commit box suggests, as GitHub Desktop's `No local changes` does and in its order: **publish** a branch that is not on origin (or whose upstream is
 * gone), **pull** the commits origin has, **push** the commits the branch has, and **create a pull request** from a branch that is published and level and has none. Nothing when none
 * applies: no `origin`, a HEAD on no branch or a branch with no commit, an upstream that is not on origin, a branch that diverged (the sync button says so), and a branch that is level and
 * is the base or has a pull request. `pullRequest` is the state of Create PR for the place (`createPullRequest`): the last step is its `ready` state and no other, so it is offered
 * exactly where that button would open the compare page.
 */
export function nextStep(status: GitStatus | undefined, pullRequest: CreatePullRequestState | undefined): NextStep | undefined {
    if (status?.isRepository !== true || !status.origin) return undefined;

    const branch = branchOf(status);

    if (branch === undefined || status.head.kind === 'unborn') return undefined;

    // What the branch tracks is not on origin: the app moves nothing of it, and publishing it is refused.
    if (foreignUpstream(status.upstream)) return undefined;

    const published = publishedUpstream(status.upstream);

    if (!published) return { kind: 'publish', title: 'Publish your branch', description: `${ branch } is not on ${ ORIGIN } yet` };

    if (isDiverged(published)) return undefined;

    if (published.behind > 0) return { kind: 'pull', title: `Pull ${ commitsWords(published.behind) } from the ${ ORIGIN } remote`, description: `${ ORIGIN } has ${ published.behind === 1 ? 'a commit' : 'commits' } that ${ branch } lacks` };

    if (published.ahead > 0) return { kind: 'push', title: `Push ${ commitsWords(published.ahead) } to the ${ ORIGIN } remote`, description: `${ published.ahead === 1 ? 'A commit is' : 'Commits are' } waiting to be sent to ${ ORIGIN }` };

    return pullRequest?.kind === 'ready' ? { kind: 'pullRequest', title: 'Create a Pull Request from your current branch', description: `${ branch } is on ${ ORIGIN }, ready to be proposed` } : undefined;
}

/** The most characters of a branch name the commit button shows: a longer one is cut in its middle, since its end is what tells branches of one family apart. */
export const COMMIT_BRANCH_MAX = 24;

const graphemes = new Intl.Segmenter();

/**
 * A text of at most `max` characters: a longer one keeps its start and its end and has an ellipsis between. `clowdy/ab12cd34-weekend-surcharge` is `clowdy/ab12c…d-surcharge`. A character is
 * what a person sees as one (an emoji, a letter with its accent), so the cut never splits one into halves that draw as nothing.
 */
export function middleCut(text: string, max: number): string {
    const characters = Array.from(graphemes.segment(text), part => part.segment);

    if (characters.length <= max) return text;

    const tail = Math.floor((max - 1) / 2);
    const head = max - 1 - tail;

    return `${ characters.slice(0, head).join('') }…${ characters.slice(characters.length - tail).join('') }`;
}

/** What a commit goes to: the branch checked out (`detached HEAD` for none), and whether it is the branch the work is compared with, which is where a commit goes straight to the base. */
export interface CommitTarget {
    name: string;
    onBase: boolean;
}

/**
 * Where a commit made now would land. `onBase` is the rule of Create PR's `Switch to a feature branch`: the branch is the base the Changes tab compares with (`githubBaseName`, so `main`
 * is the base whether the compared ref is `origin/main` or `main`). Nothing for a place that is not a repository.
 */
export function commitTarget(status: GitStatus | undefined): CommitTarget | undefined {
    if (status?.isRepository !== true) return undefined;

    const branch = branchOf(status);

    return branch === undefined ? { name: 'detached HEAD', onBase: false } : { name: branch, onBase: githubBaseName(status.base) === branch };
}

/** The commit button's label in GitHub Desktop's words: `Commit 3 files to main`, `Commit 1 file to main`, and `Commit to main` while no file is ticked. The branch is cut in its middle when long. */
export function commitLabel(files: number, branch: string | undefined): string {
    const to = branch === undefined ? '' : ` to ${ middleCut(branch, COMMIT_BRANCH_MAX) }`;

    return files > 0 ? `Commit ${ files } ${ files === 1 ? 'file' : 'files' }${ to }` : `Commit${ to }`;
}

/** Why a commit is not taken, as GitHub Desktop's tooltips say it: no summary first, then no file ticked. Nothing when it can be made. */
export function commitBlock(message: string, ticked: number): string | undefined {
    if (message.trim() === '') return 'A commit summary is required to commit';

    return ticked === 0 ? 'Select one or more files to commit' : undefined;
}

/** Whether git's line is a push that origin refused because it has commits the branch lacks (`! [rejected] main -> main (fetch first)`): a fetch is what comes next, as GitHub Desktop's `Newer Commits on Remote` offers. */
export const isFetchFirst = (line: string): boolean => /\[rejected\].*\(fetch first\)/.test(line);
