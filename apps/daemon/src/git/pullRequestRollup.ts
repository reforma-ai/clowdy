import type {
    GitCheckState,
    GitChecks,
    GitMergeability,
    GitPullRequest,
    GitPullRequestState,
    GitReviewDecision,
} from '@clowdy/protocol';

/** A JSON object of GitHub's answer, whose members are not trusted to be what they should. */
export type Json = Record<string, unknown>;

export const asObject = (value: unknown): Json | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
export const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
/** Accept only web addresses for the pull request link. */
const asLink = (value: unknown): string | undefined => {
    const text = asString(value);

    return text !== undefined && /^https?:\/\//i.test(text) ? text : undefined;
};
const asTime = (value: unknown): number | undefined => {
    const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;

    return Number.isNaN(time) ? undefined : time;
};

/** One check as GitHub lists it, its state worked out, and when it began (nothing for a check that has not). */
interface RawCheck {
    name: string;
    state: GitCheckState;
    at?: number;
}

/** How a check run ended: unfinished is pending, and so is an ending GitHub does not name. */
function checkRunState(status: string | undefined, conclusion: string | undefined): GitCheckState {
    if (status !== 'COMPLETED') return 'pending';

    switch (conclusion) {
        case 'SUCCESS':
        case 'NEUTRAL':
            return 'passing';
        case 'SKIPPED':
            return 'skipped';
        case 'FAILURE':
        case 'CANCELLED':
        case 'TIMED_OUT':
        case 'ACTION_REQUIRED':
        case 'STARTUP_FAILURE':
        case 'STALE':
            return 'failing';
        default:
            return 'pending';
    }
}

/** How a commit status stands: `EXPECTED` is a status a rule waits for. */
function statusState(state: string | undefined): GitCheckState {
    if (state === 'SUCCESS') return 'passing';

    return state === 'FAILURE' || state === 'ERROR' ? 'failing' : 'pending';
}

/** A node of `statusCheckRollup.contexts`: a check run, or a commit status. */
function checkOf(node: unknown): RawCheck | undefined {
    const object = asObject(node);

    if (!object) return undefined;

    if (object.__typename === 'StatusContext' || asString(object.context) !== undefined) {
        const name = asString(object.context);
        const at = asTime(object.createdAt);

        return name === undefined
            ? undefined
            : {
                  name,
                  state: statusState(asString(object.state)),
                  ...(at !== undefined && { at }),
              };
    }

    const name = asString(object.name);
    const at = asTime(object.startedAt);

    return name === undefined
        ? undefined
        : {
              name,
              state: checkRunState(asString(object.status), asString(object.conclusion)),
              ...(at !== undefined && { at }),
          };
}

/** Whether `check` is the same check as `current` run at the same time or later, as bb has it: one that never began is the later of two that never did. */
function isSameOrLater(check: RawCheck, current: RawCheck): boolean {
    if (check.at === undefined) return current.at === undefined;

    return current.at === undefined || check.at >= current.at;
}

const ROLLUP_ORDER: Array<GitChecks['state']> = ['none', 'passing', 'pending', 'failing'];

/** What GitHub's own total of a commit's checks (`StatusState`) says, in the terms of `GitChecks.state`. */
function rollupStateOf(state: string | undefined): GitChecks['state'] {
    if (state === 'SUCCESS') return 'passing';

    if (state === 'FAILURE' || state === 'ERROR') return 'failing';

    return state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'none';
}

/**
 * Counts checks by their latest result. When GitHub has more than the first page, the counts cover
 * that page and the overall state takes the worse of the page's state and GitHub's total.
 */
export function rollupChecks(
    contexts: readonly unknown[],
    github: { state?: string; more: boolean } = { more: false }
): GitChecks {
    const latest = new Map<string, RawCheck>();

    for (const node of contexts) {
        const check = checkOf(node);
        const current = check && latest.get(check.name);

        if (check && (!current || isSameOrLater(check, current))) latest.set(check.name, check);
    }

    const counts = { passing: 0, failing: 0, pending: 0, skipped: 0 };

    for (const { state } of latest.values()) counts[state]++;

    const own: GitChecks['state'] =
        latest.size === 0 ? 'none' : counts.failing > 0 ? 'failing' : counts.pending > 0 ? 'pending' : 'passing';
    const total = github.more
        ? ROLLUP_ORDER[Math.max(ROLLUP_ORDER.indexOf(own), ROLLUP_ORDER.indexOf(rollupStateOf(github.state)))]!
        : own;

    return {
        state: total,
        ...counts,
        ...(github.more && { truncated: true as const }),
    };
}

/** One pull request of GitHub's answer, with the parts the app uses. */
export interface RawPullRequest {
    number: number;
    title: string;
    url: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    isDraft: boolean;
    base: string;
    head: string;
    headCommit: string;
    updatedAt: number;
    /** The branch comes from another repository (a fork), or from one whose owner is not the base repository's. */
    fork: boolean;
    reviewDecision?: string;
    mergeStateStatus?: string;
    mergeable?: string;
    contexts: unknown[];
    rollupState?: string;
    moreContexts: boolean;
}

/** A pull request as GitHub answers it, or nothing when it lacks what the app cannot do without (its number, address and state). */
export function readPullRequest(node: unknown, owner: string): RawPullRequest | undefined {
    const object = asObject(node);
    const state = asString(object?.state);
    const number = object?.number;
    const url = asLink(object?.url);

    if (
        !object ||
        typeof number !== 'number' ||
        url === undefined ||
        (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED')
    )
        return undefined;

    const headOwner = asString(asObject(object.headRepositoryOwner)?.login);
    const commits = asObject(object.commits)?.nodes;
    const rollup = asObject(
        asObject(Array.isArray(commits) ? asObject(commits[0])?.commit : undefined)?.statusCheckRollup
    );
    const contexts = asObject(rollup?.contexts);
    const reviewDecision = asString(object.reviewDecision);
    const mergeStateStatus = asString(object.mergeStateStatus);
    const mergeable = asString(object.mergeable);

    return {
        number,
        title: asString(object.title) ?? '',
        url,
        state,
        isDraft: object.isDraft === true,
        base: asString(object.baseRefName) ?? '',
        head: asString(object.headRefName) ?? '',
        headCommit: asString(object.headRefOid) ?? '',
        updatedAt: asTime(object.updatedAt) ?? 0,
        fork:
            object.isCrossRepository === true ||
            (headOwner !== undefined && headOwner.toLowerCase() !== owner.toLowerCase()),
        ...(reviewDecision && { reviewDecision }),
        ...(mergeStateStatus && { mergeStateStatus }),
        ...(mergeable && { mergeable }),
        contexts: Array.isArray(contexts?.nodes) ? contexts.nodes : [],
        ...(asString(rollup?.state) && { rollupState: asString(rollup?.state) }),
        moreContexts: asObject(contexts?.pageInfo)?.hasNextPage === true,
    };
}

/**
 * Which of a branch's pull requests is its own: of those from this repository (a fork's pull request from a branch of the same name is not), an open one first (the
 * newest), else the newest. On the repository's default branch only an open one counts: a branch that every other branch is merged into has a history of closed pull
 * requests that say nothing of what is checked out.
 */
export function choosePullRequest(
    candidates: readonly RawPullRequest[],
    { branch, defaultBranch }: { branch: string; defaultBranch?: string }
): RawPullRequest | undefined {
    const own = candidates
        .filter(pr => !pr.fork && (pr.state === 'OPEN' || branch !== defaultBranch))
        .sort((a, b) => b.number - a.number);

    return own.find(pr => pr.state === 'OPEN') ?? own[0];
}

const REVIEWS: Record<string, GitReviewDecision> = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changes_requested',
    REVIEW_REQUIRED: 'review_required',
};

/** Whether an open pull request can be merged as it stands, from what GitHub says (a merged or closed one, and one that GitHub has not yet worked out, say nothing). */
function mergeabilityOf(
    state: GitPullRequestState,
    mergeable: string | undefined,
    status: string | undefined
): GitMergeability | undefined {
    if (state === 'merged' || state === 'closed') return undefined;

    if (mergeable === 'CONFLICTING' || status === 'DIRTY') return 'conflicts';

    if (state === 'draft') return undefined;

    if (status === 'BLOCKED' || status === 'BEHIND') return 'blocked';

    return mergeable === 'MERGEABLE' || status === 'CLEAN' || status === 'HAS_HOOKS' || status === 'UNSTABLE'
        ? 'mergeable'
        : undefined;
}

/** A chosen pull request as the app has it. */
export function assemblePullRequest(raw: RawPullRequest): GitPullRequest {
    const state: GitPullRequestState =
        raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : raw.isDraft ? 'draft' : 'open';
    const reviewDecision = raw.reviewDecision === undefined ? undefined : REVIEWS[raw.reviewDecision];
    const mergeability = mergeabilityOf(state, raw.mergeable, raw.mergeStateStatus);

    return {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        state,
        base: raw.base,
        head: raw.head,
        headCommit: raw.headCommit,
        updatedAt: raw.updatedAt,
        ...(reviewDecision && { reviewDecision }),
        ...(mergeability && { mergeability }),
        checks: rollupChecks(raw.contexts, { state: raw.rollupState, more: raw.moreContexts }),
    };
}
