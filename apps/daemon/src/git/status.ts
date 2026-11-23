import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { MAX_GIT_COMMITS, MAX_GIT_STATUS_ENTRIES } from '@clowdy/protocol';

import { gitLine, gitRead, gitRecords } from '../domain/git';
import { unavailable } from '../errors';
import { lastFetchedAt } from './lastFetch';
import { baseOf, workingTreeRoot } from './state';

import type {
    GitBase,
    GitChangeKind,
    GitCommit,
    GitHead,
    GitStatus,
    GitStatusEntry,
    GitUpstream,
} from '@clowdy/protocol';
import type { Place } from '../domain/places';

/** A `status` of a large tree may take a while; past this it is given up (`unavailable`). */
const STATUS_TIMEOUT_MS = 15_000;

/** How many records of `status -z` are read: the branch's four header lines and, for each entry, its record and the second one a rename has, plus one entry to know it was cut. */
const STATUS_RECORDS = 4 + 2 * (MAX_GIT_STATUS_ENTRIES + 1);

/** What a place's base is asked for: the branch the person's pull request is for, when there is one. */
export interface BaseOptions {
    /** A branch name (`main`, `origin/next`), tried before the worktree's own base and the folder's. The pull request of the branch names it (Stage 2). */
    base?: string;
}

/** The commit a ref or a hash is at, nothing when it is not there. `ref` is a full ref name or a hash: a revision expression (`main~1`, `@{u}`) is never passed. */
export async function commitAt(cwd: string, ref: string): Promise<string | undefined> {
    return gitLine(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** Whether `ancestor` is `descendant` or one of the commits it is built on. */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await gitRead(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
}

/** The short name of a full ref: `refs/heads/main` is `main`, `refs/remotes/origin/main` is `origin/main`. */
function shortRef(ref: string): string {
    return ref.replace(/^refs\/(?:heads|remotes)\//, '');
}

/** A commit that HEAD is at, nothing for a branch with no commit yet. */
export function headCommit(cwd: string): Promise<string | undefined> {
    return commitAt(cwd, 'HEAD');
}

/** What a ref's name may not have (`git check-ref-format`): control characters and spaces, `~ ^ : ? * [ \`, `..` and `@{`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a ref name may not have control characters
const NOT_A_REF_NAME = /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{/;

/** What a branch name resolves to: the ref's short name and the commit it is at. */
interface ResolvedRef {
    name: string;
    commit: string;
}

/**
 * The ref a base name means, picked as bb and GitHub Desktop do. A full ref (`refs/...`) is taken as it is. A name that is a local branch is `origin/<name>` when that
 * is where the local branch is or behind where it is (the person has not pulled; the remote's is the base that counts), and the local branch when it is ahead or has
 * diverged (its own commits are the base's). A name that is a remote branch already (`origin/main`) is taken as it is. A bare name with no local branch is `origin/<name>`.
 * Last, a hash is a commit. The refs are spelled out, `refs/heads/<name>` and `refs/remotes/<name>`, since a tag may be called `main` too.
 */
export async function resolveRef(cwd: string, name: string): Promise<ResolvedRef | undefined> {
    // Only a name a ref can have: `main~1` or `main^` would be read as a revision, and a name starting with `-` as an option.
    if (name === '' || name.startsWith('-') || NOT_A_REF_NAME.test(name)) return undefined;

    if (name.startsWith('refs/')) {
        const commit = await commitAt(cwd, name);

        return commit ? { name: shortRef(name), commit } : undefined;
    }

    const [local, remote, tracked] = await Promise.all([
        commitAt(cwd, `refs/heads/${name}`),
        commitAt(cwd, `refs/remotes/${name}`),
        commitAt(cwd, `refs/remotes/origin/${name}`),
    ]);

    if (local) {
        if (tracked && (tracked === local || (await isAncestor(cwd, local, tracked))))
            return { name: `origin/${name}`, commit: tracked };

        return { name, commit: local };
    }

    if (remote) return { name, commit: remote };

    if (tracked) return { name: `origin/${name}`, commit: tracked };

    if (/^[0-9a-f]{7,40}$/i.test(name)) {
        const commit = await commitAt(cwd, name);

        return commit ? { name: commit.slice(0, 7), commit } : undefined;
    }

    return undefined;
}

/** What the comparison of HEAD with the base comes to before anything is counted: the merge base, or why there is none. */
export type MergeBase =
    | { state: 'ready'; name: string; commit: string; mergeBase: string; head: string }
    | Exclude<GitBase, { state: 'ready' }>;

/**
 * HEAD's merge base with the place's base. The base is the first of these that resolves (`resolveRef`): the branch asked for (`options.base`), the base the worktree was
 * made from (`WorkspaceRecord.base`), the folder's own (`baseOf`: its configured base branch, else the default branch). A branch with no commit is `unborn`, a repository
 * with nothing to compare with is `no_base`, and a base that shares no history with HEAD is `no_merge_base`.
 */
export async function mergeBaseOf(place: Place, options: BaseOptions = {}): Promise<MergeBase> {
    const cwd = place.path;
    const head = await headCommit(cwd);

    if (!head) return { state: 'unborn' };

    const asked = [options.base, place.workspace?.base].filter(
        (name): name is string => name !== undefined && name !== ''
    );
    let base: ResolvedRef | undefined;

    for (const name of asked) {
        base = await resolveRef(cwd, name);

        if (base) break;
    }

    if (!base) {
        // The folder's own base reads the repository's branches, which a worktree shares with its folder: the place's path is read, so a folder that moved does not matter.
        const fallback = await baseOf({ ...place.folder, path: cwd });

        if (fallback && !asked.includes(fallback)) base = await resolveRef(cwd, fallback);

        if (!base) {
            const name = asked[0] ?? fallback;

            return name === undefined ? { state: 'no_base' } : { state: 'no_base', name };
        }
    }

    const mergeBase = await gitLine(cwd, ['merge-base', base.commit, head]);

    return mergeBase
        ? { state: 'ready', name: base.name, commit: base.commit, mergeBase, head }
        : { state: 'no_merge_base', name: base.name, commit: base.commit };
}

/** A read of git that must have an answer to go on: where git said nothing, it did not answer. */
function required<T>(value: T | undefined): T {
    if (value === undefined) throw unavailable('git did not answer');

    return value;
}

/** The commits `git log -z --format=%H%x1f%an%x1f%ct%x1f%s` printed, newest first. */
export function parseCommits(output: string): GitCommit[] {
    return output
        .split('\0')
        .filter(record => record !== '')
        .map(record => {
            const [sha = '', author = '', time = '0', ...subject] = record.split('\x1f');

            return {
                sha,
                shortSha: sha.slice(0, 7),
                subject: subject.join('\x1f'),
                author,
                committedAt: Number(time) * 1000,
            };
        });
}

/** How the branch stands against its base: `mergeBaseOf`, with the commits counted and listed when there is a base. */
export async function readBase(place: Place, options: BaseOptions = {}): Promise<GitBase> {
    const merged = await mergeBaseOf(place, options);

    if (merged.state !== 'ready') return merged;

    const { name, commit, mergeBase, head } = merged;
    const cwd = place.path;
    const [counts, log] = await Promise.all([
        gitLine(cwd, ['rev-list', '--left-right', '--count', `${commit}...${head}`]),
        gitRead(
            cwd,
            [
                'log',
                '-z',
                '--no-color',
                '--no-show-signature',
                `--max-count=${MAX_GIT_COMMITS}`,
                '--format=%H%x1f%an%x1f%ct%x1f%s',
                `${commit}..${head}`,
            ],
            { parsed: true }
        ),
    ]);
    const [behind = 0, ahead = 0] = required(counts).split(/\s+/).map(Number);

    if (!log.ok) throw unavailable('git did not answer');

    return { state: 'ready', name, commit, mergeBase, ahead, behind, commits: parseCommits(log.stdout) };
}

/** What `git status --porcelain=v2 --branch -z` says, before it is made into a `GitStatus`. */
export interface ParsedStatus {
    /** `# branch.oid`: the commit HEAD is at; absent for a branch with no commit yet (`(initial)`). */
    commit?: string;
    /** `# branch.head`: the branch's name; absent on a detached HEAD. */
    branch?: string;
    upstream?: GitUpstream;
    entries: GitStatusEntry[];
}

const KINDS: Record<string, GitChangeKind> = {
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    T: 'typechange',
    U: 'conflicted',
};

/** A status letter of git (`M`, `A`, `D`, `R`, `C`, `T`, `U`) as a change; `.` (nothing) and a letter git may add one day are none. */
export function kindOf(letter: string | undefined): GitChangeKind | undefined {
    return letter === undefined ? undefined : KINDS[letter];
}

/** The first `count` space-separated fields of a record and what follows them, which is a path and may have spaces in it. */
function fieldsOf(record: string, count: number): string[] {
    const fields: string[] = [];
    let start = 0;

    for (let index = 0; index < count; index++) {
        const end = record.indexOf(' ', start);

        if (end === -1) return [];

        fields.push(record.slice(start, end));
        start = end + 1;
    }

    return [...fields, record.slice(start)];
}

/**
 * The NUL-separated records of `git status --porcelain=v2 --branch -z`: `# branch.*` headers, then `1` (changed), `2` (renamed or copied, followed by the record of its
 * old path), `u` (unmerged) and `?` (untracked) entries. An ignored entry (`!`) and a header this does not know are skipped.
 */
export function parseStatus(records: readonly string[]): ParsedStatus {
    const parsed: ParsedStatus = { entries: [] };
    let upstream: string | undefined;
    let counts: { ahead: number; behind: number } | undefined;

    for (let index = 0; index < records.length; index++) {
        const record = records[index]!;

        if (record.startsWith('# branch.oid ')) {
            const commit = record.slice('# branch.oid '.length);

            if (commit !== '(initial)') parsed.commit = commit;
        } else if (record.startsWith('# branch.head ')) {
            const branch = record.slice('# branch.head '.length);

            if (branch !== '(detached)') parsed.branch = branch;
        } else if (record.startsWith('# branch.upstream ')) {
            upstream = record.slice('# branch.upstream '.length);
        } else if (record.startsWith('# branch.ab ')) {
            const found = /^\+(\d+) -(\d+)$/.exec(record.slice('# branch.ab '.length));

            if (found) counts = { ahead: Number(found[1]), behind: Number(found[2]) };
        } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
            const fields = fieldsOf(record, record.startsWith('1 ') ? 8 : 9);
            const xy = fields[1];
            const path = fields.at(-1);

            if (xy === undefined || path === undefined) continue;

            const staged = kindOf(xy[0]);
            const unstaged = kindOf(xy[1]);
            const oldPath = record.startsWith('2 ') ? records[++index] : undefined;

            parsed.entries.push({
                path,
                ...(oldPath !== undefined && { oldPath }),
                ...(staged && { staged }),
                ...(unstaged && { unstaged }),
            });
        } else if (record.startsWith('u ')) {
            const path = fieldsOf(record, 10).at(-1);

            if (path !== undefined) parsed.entries.push({ path, unstaged: 'conflicted' });
        } else if (record.startsWith('? ')) {
            parsed.entries.push({ path: record.slice(2), untracked: true });
        }
    }

    // `# branch.ab` is left out for an upstream that is named but gone.
    if (upstream !== undefined)
        parsed.upstream = {
            name: upstream,
            ahead: counts?.ahead ?? 0,
            behind: counts?.behind ?? 0,
            ...(counts === undefined && { gone: true as const }),
        };

    return parsed;
}

/** Whether the repository has a remote called `origin`. */
async function hasOrigin(cwd: string): Promise<boolean> {
    const remotes = await gitRead(cwd, ['remote']);

    return remotes.ok && remotes.stdout.split('\n').some(name => name.trim() === 'origin');
}

/**
 * What git says of a place (`GET /v1/projects/:id/git/status`): its branch and upstream, its uncommitted files (one `status --porcelain=v2 --branch -z
 * --untracked-files=all`, read as it comes and stopped at `MAX_GIT_STATUS_ENTRIES` entries), how far it is from its base (`readBase`) and when the repository last fetched
 * (`lastFetchedAt`, the time of a file). Nothing is fetched, and the index is not locked. A place that is not the root of a working tree is `isRepository: false`; a git that does not answer is `unavailable`.
 */
export async function placeStatus(place: Place, options: BaseOptions = {}): Promise<GitStatus> {
    const cwd = place.path;

    if (!(await workingTreeRoot(cwd))) return { isRepository: false };

    const [status, origin, base, fetched, merging] = await Promise.all([
        gitRecords(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ahead-behind'], {
            maxRecords: STATUS_RECORDS,
            timeoutMs: STATUS_TIMEOUT_MS,
            parsed: true,
        }),
        hasOrigin(cwd),
        readBase(place, options),
        lastFetchedAt(cwd),
        mergeUnderWay(cwd),
    ]);

    if (!status.ok) throw unavailable('git did not answer');

    const { commit, branch, upstream, entries } = parseStatus(status.records);
    const head: GitHead =
        branch === undefined
            ? { kind: 'detached', commit: commit ?? '' }
            : commit === undefined
              ? { kind: 'unborn', name: branch }
              : { kind: 'branch', name: branch, commit };
    const truncated = status.truncated || entries.length > MAX_GIT_STATUS_ENTRIES;

    return {
        isRepository: true,
        head,
        ...(upstream && { upstream }),
        origin,
        // A repository with no `origin` has nothing to fetch it from: what another remote wrote to `FETCH_HEAD` is not said.
        ...(origin && fetched !== undefined && { lastFetchedAt: fetched }),
        entries: entries.slice(0, MAX_GIT_STATUS_ENTRIES),
        ...(truncated && { truncated: true as const }),
        ...(merging && { merging }),
        base,
    };
}

/** A merge that is in progress, with how many paths are still unmerged and the first line of the message git prepared. Nothing when no merge is. */
async function mergeUnderWay(cwd: string): Promise<{ conflicts: number; subject?: string } | undefined> {
    const head = await gitRead(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);

    if (!head.ok || head.stdout.trim() === '') return undefined;

    const [unmerged, message] = await Promise.all([
        gitRead(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { parsed: true }),
        gitRead(cwd, ['rev-parse', '--git-path', 'MERGE_MSG']),
    ]);
    const conflicts = unmerged.ok ? unmerged.stdout.split('\0').filter(path => path !== '').length : 0;
    const subject = message.ok ? mergeSubject(cwd, message.stdout.trim()) : undefined;

    return { conflicts, ...(subject && { subject }) };
}

/** The first line of `MERGE_MSG` that is a line of the message, not a comment git leaves in it. Nothing when the file cannot be read. */
function mergeSubject(cwd: string, gitPath: string): string | undefined {
    if (gitPath === '') return undefined;

    try {
        const text = readFileSync(isAbsolute(gitPath) ? gitPath : join(cwd, gitPath), 'utf8');
        const line = text.split('\n').find(candidate => candidate.trim() !== '' && !candidate.startsWith('#'));

        return line === undefined ? undefined : line.trim().slice(0, 240);
    } catch {
        return undefined;
    }
}
