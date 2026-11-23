import { resolve } from 'node:path';
import { MAX_GIT_BRANCH_ENTRIES, MAX_GIT_RECENT_BRANCHES } from '@clowdy/protocol';

import { listWorkspacesOfProject } from '../db/workspaces';
import { gitRead } from '../domain/git';
import { unavailable } from '../errors';
import { baseOf, parseWorktrees, placeOf, workingTreeRoot } from './state';

import type { GitBranches, GitBranchHolder, GitLocalBranch, GitRemoteBranch, Project } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { Store } from '../store';

/** The only remote whose branches are offered: it is the only one the app moves commits to and from. */
const ORIGIN = 'origin';

/**
 * Between the fields of a `for-each-ref` line. A branch name cannot hold a control character (`git check-ref-format`), so neither the separator nor a newline can be in a name,
 * whatever the branch is called.
 */
const SEPARATOR = '\x1F';

/** How `for-each-ref --format` is told to write `SEPARATOR` (`%xx` is a byte in hexadecimal). */
const FORMAT_SEPARATOR = '%1f';

/** How many lines of the reflog of HEAD are read to find the branches it was on lately: a place that switches often has the five long before. */
const REFLOG_LINES = 1000;

/** What a branch's checkout says in the reflog: `checkout: moving from main to feature/x` (a name has no space, so the two names are the words around ` to `). */
const CHECKOUT_LINE = /^checkout: moving from (\S+) to (\S+)$/;

/** One local branch as `for-each-ref` printed it, before it is known which place holds it. */
interface ListedLocal {
    name: string;
    current: boolean;
    upstream?: string;
    committedAt?: number;
}

/** A tip's commit time in milliseconds, nothing for a field that is no number. */
function timeOf(field: string | undefined): number | undefined {
    const seconds = Number(field);

    return field === undefined || field === '' || Number.isNaN(seconds) ? undefined : seconds * 1000;
}

/** The records of `git for-each-ref --format=<fields joined by SEPARATOR>`: one line each, newest commit first. */
const recordsOf = (output: string): string[][] =>
    output
        .split('\n')
        .filter(line => line !== '')
        .map(line => line.split(SEPARATOR));

/** The local branches in the output of `for-each-ref refs/heads` with the format of `readRefs`: name, upstream, tip time and the `*` of the checked out one. */
export function parseLocalBranches(output: string): ListedLocal[] {
    return recordsOf(output).flatMap(([ref = '', upstream = '', time, head]) => {
        if (!ref.startsWith('refs/heads/')) return [];

        const committedAt = timeOf(time);

        return [
            {
                name: ref.slice('refs/heads/'.length),
                current: head === '*',
                ...(upstream !== '' && { upstream }),
                ...(committedAt !== undefined && { committedAt }),
            },
        ];
    });
}

/** The branches of `origin` in the output of `for-each-ref refs/remotes/origin` (name and tip time), without the remote's `HEAD`, which is an alias and no branch. */
export function parseRemoteBranches(output: string): Array<{ name: string; committedAt?: number }> {
    const prefix = `refs/remotes/${ORIGIN}/`;

    return recordsOf(output).flatMap(([ref = '', time]) => {
        if (!ref.startsWith(prefix) || ref === `${prefix}HEAD`) return [];

        const committedAt = timeOf(time);

        return [{ name: ref.slice(prefix.length), ...(committedAt !== undefined && { committedAt }) }];
    });
}

/**
 * The branches HEAD was on lately, newest first, from the lines of its reflog (`%gs`): each `checkout: moving from X to Y` names two, where HEAD is now and where it was. Only local
 * branches that still exist count (a commit's hash from a detached HEAD, a branch that was deleted), and the one that is checked out now does not: it is the first row of the list anyway.
 */
export function recentBranches(reflog: string, local: ReadonlySet<string>, current: string | undefined): string[] {
    const recent: string[] = [];

    for (const line of reflog.split('\n')) {
        const found = CHECKOUT_LINE.exec(line.trim());

        for (const name of found ? [found[2]!, found[1]!] : []) {
            if (name !== current && local.has(name) && !recent.includes(name)) recent.push(name);
        }

        if (recent.length >= MAX_GIT_RECENT_BRANCHES) break;
    }

    return recent.slice(0, MAX_GIT_RECENT_BRANCHES);
}

/**
 * Which branch of the lists is the default one: `baseOf` writes it as the repository's branch list does (`main` for a local branch, `origin/main` for a remote's), and a local
 * branch of that name comes first, so a folder that has `main` and `origin/main` has `main`. Nothing when the base is another remote's or a branch the lists do not have.
 */
export function defaultOf(
    base: string | undefined,
    local: ReadonlySet<string>,
    remote: ReadonlySet<string>
): string | undefined {
    if (base === undefined) return undefined;

    if (local.has(base)) return base;

    const name = base.startsWith(`${ORIGIN}/`) ? base.slice(ORIGIN.length + 1) : undefined;

    return name !== undefined && (local.has(name) || remote.has(name)) ? name : undefined;
}

/** A list cut at `MAX_GIT_BRANCH_ENTRIES`, newest first: the current branch and the default one are kept whatever their age, since they are what the person looks for first. */
function cut<T extends { current?: true; default?: true }>(branches: readonly T[]): T[] {
    return [
        ...branches.slice(0, MAX_GIT_BRANCH_ENTRIES),
        ...branches.slice(MAX_GIT_BRANCH_ENTRIES).filter(branch => branch.current || branch.default),
    ];
}

/** `git for-each-ref` over some refs, newest tip first (the name second, so the order is the same on every run), with the fields joined by `SEPARATOR`. `unavailable` when git cannot answer. */
async function readRefs(cwd: string, fields: string[], patterns: string[]): Promise<string> {
    const read = await gitRead(cwd, [
        'for-each-ref',
        '--sort=refname',
        '--sort=-committerdate',
        `--format=${fields.join(FORMAT_SEPARATOR)}`,
        ...patterns,
    ]);

    if (!read.ok) throw unavailable('git did not answer');

    return read.stdout;
}

/** The worktrees git lists with the branch each has checked out. A git too old to list them says nothing, and no branch is held. */
async function heldBranches(store: Store, project: Project, place: Place): Promise<Map<string, GitBranchHolder>> {
    const read = await gitRead(place.path, ['worktree', 'list', '--porcelain']);

    if (!read.ok) {
        if (read.reason === 'unavailable') throw unavailable('git did not answer');

        return new Map();
    }

    const [own, folder] = await Promise.all([placeOf(place.path), placeOf(place.folder.path)]);
    // The worktrees Clowdy keeps a record of for this folder, by where they really are, so the chat's worktree and a link to it are one.
    const records = await Promise.all(
        listWorkspacesOfProject(store.db, project.id)
            .filter(record => record.folderId === place.folder.id)
            .map(async record => ({ id: record.id, at: await placeOf(record.path) }))
    );
    const held = new Map<string, GitBranchHolder>();

    for (const entry of parseWorktrees(read.stdout)) {
        if (entry.branch === undefined || entry.bare) continue;

        const at = await placeOf(entry.path);

        // The place's own branch is the current one, not a branch that is held.
        if (at !== undefined && at === own) continue;

        const workspace = at === undefined ? undefined : records.find(record => record.at === at);

        held.set(entry.branch, {
            path: resolve(entry.path),
            ...(at !== undefined && at === folder && { main: true as const }),
            ...(workspace && { workspaceId: workspace.id }),
        });
    }

    return held;
}

/**
 * The branches a place can switch to (`GET /v1/projects/:id/git/branches`): the repository's local branches with the current one, the default one, the upstream, the worktree that
 * has the branch checked out when it is not this place, and the time of the tip; the branches `origin` has that no local branch is called after; and the last branches HEAD was on.
 * Newest tip first, each list cut at `MAX_GIT_BRANCH_ENTRIES` (the current and the default branch are kept whatever their age). Read only: nothing is fetched (`origin` is what the last
 * fetch left) and no index is touched; no ahead and behind per branch, which costs a walk of history for each. A folder that is not the root of a working tree is `isRepository: false`,
 * a git that does not answer `unavailable`.
 */
export async function placeBranches(store: Store, project: Project, place: Place): Promise<GitBranches> {
    const cwd = place.path;

    if (!(await workingTreeRoot(cwd))) return { isRepository: false };

    const [localOutput, remoteOutput, reflog, held, base] = await Promise.all([
        readRefs(cwd, ['%(refname)', '%(upstream:short)', '%(committerdate:unix)', '%(HEAD)'], ['refs/heads']),
        readRefs(cwd, ['%(refname)', '%(committerdate:unix)'], [`refs/remotes/${ORIGIN}`]),
        gitRead(cwd, ['reflog', 'show', '--format=%gs', '-n', String(REFLOG_LINES), 'HEAD', '--']),
        heldBranches(store, project, place),
        baseOf({ ...place.folder, path: cwd }),
    ]);
    const listed = parseLocalBranches(localOutput);
    const names = new Set(listed.map(branch => branch.name));
    const remoteOnly = parseRemoteBranches(remoteOutput).filter(branch => !names.has(branch.name));
    const defaultBranch = defaultOf(base, names, new Set(remoteOnly.map(branch => branch.name)));
    const current = listed.find(branch => branch.current)?.name;
    const local: GitLocalBranch[] = listed.map(({ name, ...rest }) => ({
        name,
        ...(rest.current && { current: true as const }),
        ...(name === defaultBranch && { default: true as const }),
        ...(rest.upstream !== undefined && { upstream: rest.upstream }),
        ...(!rest.current && held.has(name) && { heldBy: held.get(name) }),
        ...(rest.committedAt !== undefined && { committedAt: rest.committedAt }),
    }));
    const remote: GitRemoteBranch[] = remoteOnly.map(branch => ({
        ...branch,
        ...(branch.name === defaultBranch && { default: true as const }),
    }));

    const truncated = local.length > MAX_GIT_BRANCH_ENTRIES || remote.length > MAX_GIT_BRANCH_ENTRIES;

    return {
        isRepository: true,
        ...(defaultBranch !== undefined && { defaultBranch }),
        local: cut(local),
        remote: cut(remote),
        recent: reflog.ok ? recentBranches(reflog.stdout, names, current) : [],
        ...(truncated && { truncated: true as const }),
    };
}
