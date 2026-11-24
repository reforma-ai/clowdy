import type { GitBase, GitRemoteAction, GitRemoteResult, GitStatus, GitUpstream } from '@clowdy/protocol';

/** A status of a place that is a repository. */
type RepositoryStatus = Extract<GitStatus, { isRepository: true }>;

/** The only remote the app moves commits to and from. */
const ORIGIN = 'origin';

/**
 * What the sidebar can run. Publishing pushes a branch that has no upstream yet, `update` merges the base into the branch,
 * and `abort` undoes a merge that stopped.
 */
export type RemoteActionId = 'fetch' | 'pull' | 'push' | 'publish' | 'update' | 'abort';

/** The transport call an action makes. */
export const remoteCall = (id: RemoteActionId): GitRemoteAction => (id === 'publish' ? 'push' : id);

/** One entry of the menu: what it is called, how many commits it moves and whether it is available. */
export interface RemoteActionView {
    id: Exclude<RemoteActionId, 'update' | 'abort'>;
    label: string;
    /** `Pull`: the commits the upstream has that the branch lacks; `Push`: the commits the branch has that the upstream lacks. */
    count?: number;
    disabled: boolean;
}

/** The branch a status is on, nothing for a HEAD that is on none. */
export const branchOf = (status: RepositoryStatus): string | undefined =>
    status.head.kind === 'detached' ? undefined : status.head.name;

/** Whether a branch tracks something on `origin`: its upstream is named `origin/<something>`. */
const onOrigin = (upstream: GitUpstream): boolean => upstream.name.startsWith(`${ORIGIN}/`);

/**
 * How a branch stands with what it tracks, which every action of the sidebar is judged by. The app moves a branch only to and from the branch **of its own name** on origin: that is the
 * only upstream it sends commits to, the same rule as git's own `push.default=simple`. A branch made from another one (`git switch -c feat origin/main` tracks `origin/main`) would be sent to
 * `main` itself, so it counts as not published until it is published under its own name, which also points its upstream there.
 * - `none`: no upstream;
 * - `foreign`: the upstream is on another remote, or is a local branch: the app moves nothing of it;
 * - `renamed`: the upstream is on origin under another name than the branch's;
 * - `gone`: the upstream is `origin/<branch>` and is gone from origin;
 * - `published`: the upstream is `origin/<branch>` and is there, with the counts of the last fetch.
 */
type Tracking = { kind: 'none' } | { kind: 'foreign' | 'renamed' | 'gone' | 'published'; upstream: GitUpstream };

function trackingOf(status: RepositoryStatus): Tracking {
    const { upstream } = status;

    if (!upstream) return { kind: 'none' };

    if (!onOrigin(upstream)) return { kind: 'foreign', upstream };

    if (upstream.name !== `${ORIGIN}/${branchOf(status)}`) return { kind: 'renamed', upstream };

    return { kind: upstream.gone ? 'gone' : 'published', upstream };
}

const foreignWords = (upstream: GitUpstream): string => `Tracks ${upstream.name}, not ${ORIGIN}`;

/** Whether the branch and its upstream each have commits the other lacks, so a pull merges and a push waits for it. */
export const isDiverged = (upstream: GitUpstream | undefined): boolean =>
    upstream !== undefined && !upstream.gone && upstream.ahead > 0 && upstream.behind > 0;

/** Fetch, Pull and either Push or Publish. A diverged branch can be pulled to merge. */
export function remoteActions(status: GitStatus | undefined, busy: boolean): RemoteActionView[] {
    if (status?.isRepository !== true) return [];

    const blocked = !status.origin || busy;
    const tracking = trackingOf(status);
    const movesBlocked = blocked || status.head.kind !== 'branch' || tracking.kind === 'foreign';
    const fetch: RemoteActionView = { id: 'fetch', label: 'Fetch origin', disabled: blocked };
    const upstream =
        tracking.kind === 'published' || (tracking.kind === 'foreign' && !tracking.upstream.gone)
            ? tracking.upstream
            : undefined;

    if (!upstream) {
        return [
            fetch,
            { id: 'pull', label: 'Pull origin', disabled: true },
            { id: 'publish', label: 'Publish branch', disabled: movesBlocked },
        ];
    }

    const { ahead, behind } = upstream;

    return [
        fetch,
        {
            id: 'pull',
            label: 'Pull origin',
            ...(behind > 0 && { count: behind }),
            disabled: movesBlocked || behind === 0,
        },
        {
            id: 'push',
            label: 'Push origin',
            ...(ahead > 0 && { count: ahead }),
            disabled: movesBlocked || ahead === 0 || behind > 0,
        },
    ];
}

/** `1 commit`, `2 commits`. */
export const commitsWords = (count: number): string => `${count} ${count === 1 ? 'commit' : 'commits'}`;

/**
 * When the last fetch was, in GitHub Desktop's words: `Last fetched 3 minutes ago`, `Last fetched just now` under a minute, and `Never fetched` for a repository that has not fetched
 * (`GitStatus.lastFetchedAt` is absent). The unit is the largest that fits, rounded down: minutes, hours, days, weeks, months, years.
 */
export function lastFetchedWords(at: number | undefined, now: number): string {
    if (at === undefined) return 'Never fetched';

    const minutes = Math.floor(Math.max(0, now - at) / 60_000);
    const ago = (count: number, unit: string) => `Last fetched ${count} ${unit}${count === 1 ? '' : 's'} ago`;

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
    /** The branch is behind its base and there is no upstream action to take first. */
    | 'update'
    /** Nothing to move: look for what is new. */
    | 'fetch';

/** What the sync button says and does for a place. */
export interface SyncView {
    kind: SyncKind;
    /** The next action in GitHub Desktop's words (`Publish branch`, `Pull origin`, `Push origin`, `Fetch origin`), or what is running (`Pulling origin`). */
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
 * Show progress while an action runs and explain when sync is unavailable. Offer Publish for an unpublished branch, then Pull or Push
 * for changes against its upstream on origin. When none of those actions applies, offer Update if the base is ahead, or Fetch otherwise.
 */
export function syncButton(
    status: GitStatus | undefined,
    running: RemoteActionId | undefined,
    now: number
): SyncView | undefined {
    if (status?.isRepository !== true) return undefined;

    if (running !== undefined)
        return {
            kind: 'running',
            label: RUNNING_WORDS[running],
            reason: 'An action is running',
            title: RUNNING_WORDS[running],
        };

    if (!status.origin)
        return {
            kind: 'no_origin',
            label: 'No origin',
            line: 'Nothing to sync with',
            reason: 'No origin',
            title: `The repository has no remote called ${ORIGIN}, so there is nothing to sync with`,
        };

    const { head } = status;

    if (head.kind === 'detached')
        return {
            kind: 'blocked',
            label: 'Publish branch',
            line: 'HEAD is detached',
            reason: 'HEAD is detached',
            title: 'HEAD is detached, so there is no branch to publish',
        };

    if (head.kind === 'unborn')
        return {
            kind: 'blocked',
            label: 'Publish branch',
            line: 'No commits yet',
            reason: 'No commits yet',
            title: 'The branch has no commits yet, so there is nothing to publish',
        };

    const tracking = trackingOf(status);
    const fetched = lastFetchedWords(status.lastFetchedAt, now);

    if (tracking.kind === 'none')
        return {
            kind: 'publish',
            label: 'Publish branch',
            line: `Publish this branch to ${ORIGIN}`,
            action: 'publish',
            title: `The branch is not on ${ORIGIN} yet: publish it`,
        };

    if (tracking.kind === 'gone')
        return {
            kind: 'publish',
            label: 'Publish branch',
            line: `Upstream gone from ${ORIGIN}`,
            action: 'publish',
            tone: 'warning',
            title: `${tracking.upstream.name} is gone from ${ORIGIN}: publish the branch again`,
        };

    // A branch made from another one tracks that one (`git switch -c feat origin/main`), and a push would send it there: it counts as not published until it is, under its own name.
    if (tracking.kind === 'renamed')
        return {
            kind: 'publish',
            label: 'Publish branch',
            line: `Tracks ${tracking.upstream.name}`,
            action: 'publish',
            title: `${head.name} tracks ${tracking.upstream.name}, which a push would send it to: publish it as ${ORIGIN}/${head.name} instead`,
        };

    const { upstream } = tracking;

    if (tracking.kind === 'published' && upstream.behind > 0)
        return {
            kind: 'pull',
            label: 'Pull origin',
            line: fetched,
            behind: upstream.behind,
            ...(upstream.ahead > 0 && { ahead: upstream.ahead }),
            action: 'pull',
            title:
                upstream.ahead > 0
                    ? `Pull origin merges what ${upstream.name} has. This branch keeps its own, ${lowered(fetched)}.`
                    : `Pull origin: ${commitsWords(upstream.behind)} to take from ${upstream.name}, ${lowered(fetched)}`,
        };

    if (tracking.kind === 'published' && upstream.ahead > 0)
        return {
            kind: 'push',
            label: 'Push origin',
            line: fetched,
            ahead: upstream.ahead,
            action: 'push',
            title: `Push origin: ${commitsWords(upstream.ahead)} to send to ${upstream.name}, ${lowered(fetched)}`,
        };

    const update = updateFromBase(status);

    if (update)
        return {
            kind: 'update',
            label: update.label,
            line: tracking.kind === 'foreign' ? foreignWords(upstream) : fetched,
            action: 'update',
            title: update.label,
        };

    if (tracking.kind === 'foreign')
        return {
            kind: 'fetch',
            label: 'Fetch origin',
            line: foreignWords(upstream),
            action: 'fetch',
            title: `${foreignWords(upstream)}: pull, push and publish are off, ${lowered(fetched)}`,
        };

    return {
        kind: 'fetch',
        label: 'Fetch origin',
        line: fetched,
        action: 'fetch',
        title: `Fetch origin to look for new commits: ${upstream.name} is up to date, ${lowered(fetched)}`,
    };
}

/** A conflict can be reported before the refreshed status reaches the commit section. Successful actions need no separate line. */
export function remoteNotice(result: GitRemoteResult): { words: string; tone: 'warning' } | undefined {
    if (result.state !== 'conflicts' || result.conflicts === 0) return undefined;

    const { conflicts } = result;

    return {
        words: conflicts === 1 ? '1 conflict' : `${conflicts} conflicts`,
        tone: 'warning',
    };
}

/**
 * Why Commit & Push is not offered, as a few words; nothing when it is: there is no `origin`, HEAD is on no branch, a merge is in progress, the branch tracks something that is not on `origin`,
 * or its upstream has commits that it lacks (the push after the commit would be rejected, so it is pulled first). A branch with no commit yet is fine: the commit is its first, and publishing
 * it comes after.
 */
export function commitAndPushBlock(status: GitStatus | undefined): string | undefined {
    if (status?.isRepository !== true) return 'Not a repository';

    if (!status.origin) return 'No origin';

    if (status.head.kind === 'detached') return 'HEAD is detached';

    if (status.merging) return 'A merge is in progress';

    const tracking = trackingOf(status);

    if (tracking.kind === 'foreign') return foreignWords(tracking.upstream);

    // A branch that is not published is published by the push after the commit.
    if (tracking.kind !== 'published') return undefined;

    const { upstream: published } = tracking;

    if (isDiverged(published)) return 'Pull first';

    return published.behind > 0 ? `${commitsWords(published.behind)} to pull first` : undefined;
}

/** The action that sends the branch of a status after a commit: a push when it is published, else its publishing. */
export const pushOrPublish = (status: GitStatus | undefined): 'push' | 'publish' =>
    status?.isRepository === true && trackingOf(status).kind === 'published' ? 'push' : 'publish';

/** What a running action says, in GitHub Desktop's words: the label of the sync button that is doing it, and what the menu's entry of it becomes. */
export const RUNNING_WORDS: Record<RemoteActionId, string> = {
    fetch: 'Fetching origin',
    pull: 'Pulling origin',
    push: 'Pushing origin',
    publish: 'Publishing branch',
    update: 'Updating',
    abort: 'Aborting merge',
};

/**
 * The name GitHub knows a base by, from the base the Changes tab compares with (`GitBase.name`): `origin/main` is `main`, and a local `main` stays `main`. A base that is a commit (a
 * short hash) has no such name here, and the compare page is then left to choose its own.
 */
export function githubBaseName(base: GitBase | undefined): string | undefined {
    if (base?.state !== 'ready' && base?.state !== 'no_merge_base') return undefined;

    const name = base.name.startsWith(`${ORIGIN}/`) ? base.name.slice(ORIGIN.length + 1) : base.name;

    return /^[0-9a-f]{7,40}$/i.test(name) ? undefined : name;
}

/**
 * Update from the base, when the branch is behind the branch it is compared with and is not that branch. Nothing while a merge is in progress (the banner owns that), on a detached HEAD,
 * and when the base is not behind.
 */
export function updateFromBase(status: GitStatus | undefined): { label: string; behind: number } | undefined {
    if (status?.isRepository !== true || status.merging || status.head.kind !== 'branch') return undefined;

    const { base, head } = status;
    const name = githubBaseName(base);

    if (
        base.state !== 'ready' ||
        base.behind === 0 ||
        name === undefined ||
        name === head.name ||
        base.name === head.name
    )
        return undefined;

    return { label: `Update from ${name}`, behind: base.behind };
}

/** Whether the published branch can be proposed against the base shown in Changes. */
export function canCreatePullRequest(status: GitStatus | undefined): boolean {
    if (status?.isRepository !== true || !status.origin || status.head.kind !== 'branch') return false;

    const { base, head } = status;

    if (githubBaseName(base) === head.name || (base.state === 'ready' && base.ahead === 0)) return false;

    const tracking = trackingOf(status);

    return tracking.kind === 'published' && tracking.upstream.ahead === 0;
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

    return branch === undefined
        ? { name: 'detached HEAD', onBase: false }
        : { name: branch, onBase: githubBaseName(status.base) === branch };
}

export function commitLabel(files: number): string {
    return `Commit ${files} ${files === 1 ? 'file' : 'files'}`;
}

/** Why a commit is not taken, as GitHub Desktop's tooltips say it: no summary first, then no file ticked. Nothing when it can be made. */
export function commitBlock(message: string, ticked: number): string | undefined {
    if (message.trim() === '') return 'A commit summary is required to commit';

    return ticked === 0 ? 'Select one or more files to commit' : undefined;
}

/** Whether git's line is a push that origin refused because it has commits the branch lacks (`! [rejected] main -> main (fetch first)`): a fetch is what comes next, as GitHub Desktop's `Newer Commits on Remote` offers. */
export const isFetchFirst = (line: string): boolean => /\[rejected\].*\(fetch first\)/.test(line);
