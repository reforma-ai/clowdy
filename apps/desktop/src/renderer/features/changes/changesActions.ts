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

    return upstream && !upstream.gone && !onOrigin(upstream) ? `Tracks ${ upstream.name }, not ${ ORIGIN }` : undefined;
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
    const fetch: RemoteActionView = { id: 'fetch', label: 'Fetch', ...(block && { reason: block }) };

    // A branch that is not on origin has nothing to pull from, and is published in place of being pushed.
    if (!published) {
        const pull: RemoteActionView = { id: 'pull', label: 'Pull', reason: moves ?? (status.upstream ? `Upstream gone from ${ ORIGIN }` : 'Not published yet') };

        return [fetch, pull, { id: 'publish', label: 'Publish', ...(moves && { reason: moves }) }];
    }

    const pullReason = moves ?? (isDiverged(published) ? divergedWords(published) : published.behind === 0 ? 'Nothing to pull' : undefined);
    const pushReason = moves ?? (isDiverged(published) ? divergedWords(published) : published.ahead === 0 ? 'Nothing to push' : undefined);

    return [
        fetch,
        { id: 'pull', label: 'Pull', ...(published.behind > 0 && { count: published.behind }), ...(pullReason && { reason: pullReason }) },
        { id: 'push', label: 'Push', ...(published.ahead > 0 && { count: published.ahead }), ...(pushReason && { reason: pushReason }) },
    ];
}

/** What the menu's button says of where the branch stands against its upstream: the name (or that it is not published) and how far apart they are. */
export interface UpstreamView {
    /** The upstream's name (`origin/feature`), `Not published` for a branch with none, or what a HEAD with no branch has. */
    label: string;
    /** How far apart, as a few words; absent for a branch that is not published. */
    detail?: string;
    /** `warning` for what needs the person (a branch that diverged, an upstream that is gone). */
    tone?: 'warning';
    /** The whole of it, for a title. */
    title: string;
}

/** How the branch stands against its upstream, in words: `origin/feature · 1 ahead`, `Not published`, `origin/main · diverged`. Nothing for a place that is not a repository. */
export function upstreamView(status: GitStatus | undefined): UpstreamView | undefined {
    if (status?.isRepository !== true) return undefined;

    const { head, upstream } = status;

    if (head.kind === 'detached') return { label: 'Not on a branch', title: 'HEAD is detached' };

    if (head.kind === 'unborn') return { label: 'No commits yet', title: 'The branch has no commits yet' };

    if (!upstream) return { label: 'Not published', title: 'The branch is not on origin yet' };

    if (upstream.gone) return { label: upstream.name, detail: 'gone', tone: 'warning', title: `${ upstream.name } is gone from ${ ORIGIN }` };

    if (isDiverged(upstream)) return { label: upstream.name, detail: 'diverged', tone: 'warning', title: `${ upstream.name }, ${ divergedWords(upstream).toLowerCase() }` };

    const detail = upstream.ahead > 0 ? `${ upstream.ahead } ahead` : upstream.behind > 0 ? `${ upstream.behind } behind` : 'up to date';

    return { label: upstream.name, detail, title: `${ upstream.name }, ${ detail }` };
}

/** `1 commit`, `2 commits`. */
const commitsWords = (count: number): string => `${ count } ${ count === 1 ? 'commit' : 'commits' }`;

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

    const published = publishedUpstream(status.upstream);

    if (!published) return undefined;

    if (!onOrigin(published)) return `Tracks ${ published.name }, not ${ ORIGIN }`;

    if (isDiverged(published)) return divergedWords(published);

    return published.behind > 0 ? `${ commitsWords(published.behind) } to pull first` : undefined;
}

/** The action that sends the branch of a status after a commit: a push when it is on origin, else its publishing. */
export const pushOrPublish = (status: GitStatus | undefined): 'push' | 'publish' => (status?.isRepository === true && publishedUpstream(status.upstream) ? 'push' : 'publish');

/** What a running action says: the word of the menu's entry in the present, so the button that was pressed names what it is doing. */
export const RUNNING_WORDS: Record<RemoteActionId, string> = { fetch: 'Fetching origin', pull: 'Pulling', push: 'Pushing', publish: 'Publishing' };

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
    const published = publishedUpstream(status.upstream);

    // The branch the work is compared with is the branch itself: there is no pull request to make from it.
    if (githubBaseName(base) === branch) return { kind: 'blocked', label: 'Create PR', reason: 'Switch to a feature branch' };

    if (base.state === 'ready' && base.ahead === 0) return { kind: 'blocked', label: 'Create PR', reason: `No commits ahead of ${ base.name }` };

    if (!published) return { kind: 'publish', label: 'Publish first' };

    if (!onOrigin(published)) return { kind: 'blocked', label: 'Create PR', reason: `Tracks ${ published.name }, not ${ ORIGIN }` };

    if (isDiverged(published)) return { kind: 'blocked', label: 'Create PR', reason: divergedWords(published) };

    return published.ahead > 0 ? { kind: 'push', label: 'Push first' } : { kind: 'ready', label: 'Create PR' };
}
