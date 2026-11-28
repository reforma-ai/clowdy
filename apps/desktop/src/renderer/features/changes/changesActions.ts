import type {
    GitBase,
    GitRemoteResult,
    GitStatus,
    GitSyncProgress,
    GitSyncResult,
    GitUpstream,
} from '@clowdy/protocol';

/** A status of a place that is a repository. */
type RepositoryStatus = Extract<GitStatus, { isRepository: true }>;

/** The only remote the app moves commits to and from. */
const ORIGIN = 'origin';

export type RemoteActionId = 'fetch' | 'pull' | 'push' | 'sync' | 'update' | 'abort';

/** One direct remote action in the Sync menu. */
export interface RemoteActionView {
    id: 'fetch' | 'pull' | 'push';
    label: string;
    /** How many commits the upstream had when it was last fetched. */
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

/** Fetch and Pull are still available independently of Sync. */
export function remoteActions(status: GitStatus | undefined, switching: boolean): RemoteActionView[] {
    if (status?.isRepository !== true) return [];

    const blocked = !status.origin || switching;
    const tracking = trackingOf(status);
    const behind = tracking.kind === 'published' ? tracking.upstream.behind : 0;
    const ahead = tracking.kind === 'published' ? tracking.upstream.ahead : 0;
    const canPush =
        !blocked &&
        status.head.kind === 'branch' &&
        !status.merging &&
        !status.rebasing &&
        tracking.kind !== 'foreign' &&
        (tracking.kind !== 'published' || (ahead > 0 && behind === 0));

    return [
        { id: 'fetch', label: 'Fetch origin', disabled: blocked },
        {
            id: 'pull',
            label: 'Pull origin',
            ...(behind > 0 && { count: behind }),
            disabled:
                blocked ||
                status.head.kind !== 'branch' ||
                tracking.kind !== 'published' ||
                !!status.merging ||
                !!status.rebasing,
        },
        { id: 'push', label: 'Push origin', ...(ahead > 0 && { count: ahead }), disabled: !canPush },
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

export type SyncKind = 'running' | 'no_origin' | 'blocked' | 'publish' | 'sync' | 'pull' | 'push' | 'update' | 'fetch';

/** The sync button's copy, progress and counts. */
export interface SyncView {
    kind: SyncKind;
    label: string;
    line?: string;
    ahead?: number;
    behind?: number;
    action?: 'sync' | 'update' | 'fetch';
    reason?: string;
    tone?: 'warning';
    /** Extra detail for a tooltip, when the button's words alone do not explain the action or its counts. */
    title?: string;
}

/** Show progress, then prefer the branch's origin over its base. Fetch is the fallback. */
export function syncButton(
    status: GitStatus | undefined,
    running: RemoteActionId | undefined,
    now: number,
    phase?: GitSyncProgress['phase']
): SyncView | undefined {
    if (status?.isRepository !== true) return undefined;

    if (running !== undefined) {
        const label = phase ? SYNC_WORDS[phase] : RUNNING_WORDS[running];
        return { kind: 'running', label, reason: 'An action is running' };
    }

    if (!status.origin)
        return {
            kind: 'no_origin',
            label: 'No origin',
            line: 'Nothing to sync with',
            reason: 'No origin',
            title: 'Add an origin remote to sync this repository',
        };

    const { head, merging, rebasing } = status;
    const blocked =
        head.kind === 'detached'
            ? { line: 'HEAD is detached', title: 'Check out a branch before syncing' }
            : head.kind === 'unborn'
              ? { line: 'No commits yet', title: 'Make your first commit before syncing' }
              : rebasing
                ? { line: 'Rebase in progress', title: 'Continue or abort the rebase first' }
                : merging && { line: 'Merge in progress', title: 'Complete or abort the merge first' };

    if (blocked) return { kind: 'blocked', label: 'Sync', ...blocked, reason: blocked.line };

    const tracking = trackingOf(status);
    const fetched = lastFetchedWords(status.lastFetchedAt, now);
    const update = updateFromBase(status);
    const updateView: SyncView | undefined = update && {
        ...update,
        kind: 'update',
        line: fetched,
        action: 'update',
    };

    if (tracking.kind === 'foreign') {
        const line = foreignWords(tracking.upstream);
        return updateView ?? { kind: 'fetch', label: 'Fetch origin', line, action: 'fetch' };
    }

    const publish = `Publish as ${ORIGIN}/${branchOf(status)}`;
    const label = 'Publish branch';

    if (tracking.kind === 'none')
        return { kind: 'publish', label, line: 'Publish this branch to origin', action: 'sync', title: publish };

    if (tracking.kind === 'gone')
        return {
            kind: 'publish',
            label,
            line: `Upstream gone from ${ORIGIN}`,
            action: 'sync',
            tone: 'warning',
            title: publish,
        };

    if (tracking.kind === 'renamed')
        return {
            kind: 'publish',
            label,
            line: `Tracks ${tracking.upstream.name}`,
            action: 'sync',
            title: publish,
        };

    const { ahead, behind } = tracking.upstream;
    if (ahead > 0 || behind > 0) {
        const kind = ahead > 0 ? (behind > 0 ? 'sync' : 'push') : 'pull';
        const label = kind === 'sync' ? 'Sync' : kind === 'push' ? 'Push origin' : 'Pull origin';
        const details = [behind > 0 && `${commitsWords(behind)} to pull`, ahead > 0 && `${commitsWords(ahead)} to push`]
            .filter(Boolean)
            .join(' and ');
        return {
            kind,
            label,
            line: fetched,
            action: 'sync',
            ...(ahead > 0 && { ahead }),
            ...(behind > 0 && { behind }),
            title: details,
        };
    }

    return (
        updateView ?? {
            kind: 'fetch',
            label: 'Fetch origin',
            line: fetched,
            action: 'fetch',
        }
    );
}

/** A conflict can be reported before the refreshed status reaches the commit section. Successful actions need no separate line. */
export function remoteNotice(result: GitRemoteResult | GitSyncResult): { words: string; tone: 'warning' } | undefined {
    if (result.state !== 'conflicts' || result.conflicts === 0) return undefined;

    const { conflicts } = result;

    return {
        words: conflicts === 1 ? '1 conflict' : `${conflicts} conflicts`,
        tone: 'warning',
    };
}

/** Sync can follow a first commit or a completed merge. Origin and a named branch are required. */
export function syncBlock(status: GitStatus | undefined): string | undefined {
    if (status?.isRepository !== true) return 'Not a repository';
    if (!status.origin) return 'No origin';
    if (status.head.kind === 'detached') return 'HEAD is detached';
    if (status.rebasing) return 'Continue or abort the rebase first';
    if ((status.merging?.conflicts ?? 0) > 0) return 'A merge is in progress';

    const tracking = trackingOf(status);
    return tracking.kind === 'foreign' ? foreignWords(tracking.upstream) : undefined;
}

export const SYNC_WORDS: Record<GitSyncProgress['phase'], string> = {
    fetch: 'Fetching origin',
    merge: 'Merging from origin',
    push: 'Pushing origin',
};

export const RUNNING_WORDS: Record<RemoteActionId, string> = {
    fetch: 'Fetching origin',
    pull: 'Pulling origin',
    push: 'Pushing origin',
    sync: 'Syncing…',
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
export function updateFromBase(
    status: GitStatus | undefined
): { label: string; behind: number; title: string } | undefined {
    if (status?.isRepository !== true || status.merging || status.rebasing || status.head.kind !== 'branch')
        return undefined;

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

    return {
        label: `Update from ${name}`,
        behind: base.behind,
        title: `${commitsWords(base.behind)} to merge from ${name}`,
    };
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
