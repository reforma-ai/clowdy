import { GIT_COMMIT_SCOPE_PREFIX, MAX_GIT_CHANGED_FILES, MAX_GIT_DIFF_LINES, MAX_GIT_SIDE_BYTES } from '@clowdy/protocol';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { gitLine, gitRead, gitRecords } from '../domain/git';
import { invalid, notFound, unavailable } from '../errors';
import { workingTreeRoot } from './state';
import { commitAt, headCommit, kindOf, mergeBaseOf } from './status';

import type { GitBaseState, GitChangedFile, GitChangeKind, GitChanges, GitFileSides, GitScope } from '@clowdy/protocol';
import type { Stats } from 'node:fs';
import type { Place } from '../domain/places';
import type { BaseOptions } from './status';

/** A diff of a large change may take a while; past this it is given up (`unavailable`). */
const DIFF_TIMEOUT_MS = 15_000;

/** The most a diff's listing (`--raw --numstat`) may print: about a hundred thousand files. */
const DIFF_MAX_BYTES = 32 * 1024 * 1024;

/** The most new files that are listed: a tree that is all new (a build folder nobody ignored) is read only as far as this, and `GitChanges.truncated` says so. */
const MAX_NEW_FILES_LISTED = 5000;

/** What the daemon spends on counting the lines of new files, which git does not track and has no numbers for: past any of these the rest are listed without lines (`statsComplete: false`). */
const MAX_NEW_FILES_COUNTED = 200;
const MAX_NEW_BYTES_COUNTED = 16 * 1024 * 1024;
const COUNT_BUDGET_MS = 5000;

/** How much of a file git looks at to call it binary (a NUL byte in it), as git does. */
const BINARY_SNIFF_BYTES = 8000;

/** The hashes of working-tree files are asked of git this many paths, or characters of paths, at a time: a command line has a limit, and Windows' is the smallest. */
const HASH_CHUNK_PATHS = 100;
const HASH_CHUNK_CHARS = 8000;
const HASH_TIMEOUT_MS = 10_000;

/** The most bytes a side's text may come to as git prints it: a side is within `MAX_GIT_SIDE_BYTES` stored, and a checkout filter may make its lines longer. */
const TEXT_MAX_BYTES = 2 * MAX_GIT_SIDE_BYTES + 1024;

/** A mode git writes for a side that is not there, and for a submodule. */
const ABSENT_MODE = '000000';
const SUBMODULE_MODE = '160000';

/** One file of the output of `git diff --raw --numstat -z`, or a new file git does not track. */
export interface DiffEntry {
    path: string;
    oldPath?: string;
    kind: GitChangeKind;
    oldMode: string;
    newMode: string;
    oldBlob: string;
    /** All zeros for a file in the working tree whose content git did not hash (`settle` does). */
    newBlob: string;
    additions?: number;
    deletions?: number;
    binary?: true;
    untracked?: true;
}

const isZeros = (id: string) => /^0*$/.test(id);

/**
 * The records of `git diff --raw --numstat -z --no-abbrev`: first one raw record for each file (`:<oldMode> <newMode> <oldBlob> <newBlob> <status>`, the path after a NUL, two
 * paths for a rename or a copy), then one numstat record for each (`<added>\t<deleted>\t<path>`, with an empty path and the two paths after it for a rename). A binary
 * file's numbers are `-`. The records are told apart by their first character and read by position, so a path that looks like a record is a path.
 */
export function parseDiff(output: string): DiffEntry[] {
    const tokens = output.split('\0');
    const entries: DiffEntry[] = [];
    const byPath = new Map<string, DiffEntry>();

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;

        if (token.startsWith(':')) {
            const [oldMode = '', newMode = '', oldBlob = '', newBlob = '', status = ''] = token.slice(1).split(' ');
            const copy = status.startsWith('R') || status.startsWith('C');
            const oldPath = copy ? tokens[++index] : undefined;
            const path = tokens[++index];

            if (path === undefined) break;

            const entry: DiffEntry = { path, ...(oldPath !== undefined && { oldPath }), kind: kindOf(status[0]) ?? 'modified', oldMode, newMode, oldBlob, newBlob };

            entries.push(entry);
            byPath.set(path, entry);
        }
        else {
            const found = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);

            if (!found) continue;

            let path = found[3]!;

            // A renamed file's numbers are followed by the two paths, which are the record's own.
            if (path === '') {
                index += 2;
                path = tokens[index] ?? '';
            }

            const entry = byPath.get(path);

            if (!entry) continue;

            if (found[1] === '-') {
                entry.binary = true;
            }
            else {
                entry.additions = Number(found[1]);
                entry.deletions = Number(found[2]);
            }
        }
    }

    return entries;
}

/** What a scope is counted between: two commits, or a commit and the working tree. */
interface Plan {
    /** The commit counted from; none for the empty tree (a root commit, an unborn branch). */
    from?: string;
    /** The commit counted to; none for the working tree. */
    to?: string;
    /** Files git does not track are part of it. */
    untracked: boolean;
    /** Nothing is in it (`branch` with no base to count from). */
    empty?: true;
    /** `all` and `branch`: how the base stood. */
    baseState?: GitBaseState;
}

/** The tree git has no object for and every repository can name: what a root commit and an unborn branch are counted from. Its id depends on the repository's hash. */
async function emptyTree(cwd: string): Promise<string> {
    const read = await gitRead(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });

    if (!read.ok) throw unavailable('git did not answer');

    return read.stdout.trim();
}

/** What a read of one file may be told besides the base: the commit its list counted from. */
export interface FileOptions extends BaseOptions {
    /**
     * The commit the list the file comes from was counted from (`GitChanges.from`: a hash, short or whole). With it a scope starts there and nothing is looked up to find where it
     * starts: no base, no merge base, no parent, no HEAD for `uncommitted`, so the file cannot be diffed against any other commit than its list was.
     */
    from?: string;
}

/**
 * What a scope is counted between when the list's own start is known (`FileOptions.from`): the same plans as `planOf` makes, with `from` in place of the merge base, the parent
 * or HEAD. A `from` that is not a hash is `invalid` and a commit the repository does not have is `not_found`. The start of a commit's scope is its parent, which a root commit
 * has none of, so a list sends no `from` for it and the commit's own plan is made.
 */
async function pinnedPlanOf(place: Place, scope: GitScope, from: string): Promise<Plan> {
    const cwd = place.path;

    if (!/^[0-9a-f]{7,64}$/i.test(from)) throw invalid('The start of the comparison is not a hash');

    const start = await commitAt(cwd, from);

    if (!start) throw notFound('Commit', from);

    if (scope.startsWith(GIT_COMMIT_SCOPE_PREFIX)) {
        const sha = scope.slice(GIT_COMMIT_SCOPE_PREFIX.length);

        if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw invalid('The commit is not a hash');

        const commit = await commitAt(cwd, sha);

        if (!commit) throw notFound('Commit', sha);

        return { from: start, to: commit, untracked: false };
    }

    if (scope === 'branch') {
        const head = await headCommit(cwd);

        return head ? { from: start, to: head, untracked: false } : { untracked: false, empty: true };
    }

    return { from: start, untracked: true };
}

/**
 * What a scope is counted between (`GitScope`). A commit's scope is its first parent to it (the empty tree for a root commit); a commit the repository does not have is
 * `not_found`. `all` and `branch` start at the merge base with the place's base (`mergeBaseOf`); with none, `all` starts at HEAD and `branch` is empty. A read that is told where
 * the scope starts (`FileOptions.from`) uses that and looks nothing up.
 */
async function planOf(place: Place, scope: GitScope, options: FileOptions): Promise<Plan> {
    const cwd = place.path;

    if (options.from !== undefined) return pinnedPlanOf(place, scope, options.from);

    if (scope.startsWith(GIT_COMMIT_SCOPE_PREFIX)) {
        const sha = scope.slice(GIT_COMMIT_SCOPE_PREFIX.length);

        // A hash only: anything else would be read by git as a revision expression, or as an option.
        if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw invalid('The commit is not a hash');

        const commit = await commitAt(cwd, sha);

        if (!commit) throw notFound('Commit', sha);

        const parents = (await gitLine(cwd, ['rev-list', '--parents', '-n', '1', commit]))?.split(' ') ?? [];

        return { ...(parents[1] && { from: parents[1] }), to: commit, untracked: false };
    }

    if (scope === 'uncommitted') {
        const head = await headCommit(cwd);

        return { ...(head && { from: head }), untracked: true };
    }

    const merged = await mergeBaseOf(place, options);

    if (merged.state === 'ready') {
        return scope === 'all' ? { from: merged.mergeBase, untracked: true, baseState: 'ready' } : { from: merged.mergeBase, to: merged.head, untracked: false, baseState: 'ready' };
    }

    if (scope === 'all') {
        const head = await headCommit(cwd);

        return { ...(head && { from: head }), untracked: true, baseState: merged.state };
    }

    return { untracked: false, empty: true, baseState: merged.state };
}

/** The files a plan changes that git tracks, with their numbers: `git diff <from> [<to>]`, which for no `to` is the working tree (the index is read, never changed). */
async function trackedChanges(cwd: string, plan: Plan, pathspecs: string[] = []): Promise<DiffEntry[]> {
    if (plan.empty) return [];

    const from = plan.from ?? await emptyTree(cwd);
    const args = ['diff', '--raw', '--numstat', '-z', '--no-abbrev', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', from, ...(plan.to ? [plan.to] : []), '--', ...pathspecs];
    const read = await gitRead(cwd, args, { parsed: true, timeoutMs: DIFF_TIMEOUT_MS, maxBytes: DIFF_MAX_BYTES });

    if (!read.ok) throw unavailable('git did not answer');

    return parseDiff(read.stdout);
}

/** The new files git does not track and does not ignore, in git's order (a folder that is a repository of its own is left out); `truncated` when there are more than are read. */
async function newFiles(cwd: string, pathspecs: string[] = []): Promise<{ paths: string[]; truncated: boolean }> {
    const args = ['ls-files', '-z', '--others', '--exclude-standard', ...(pathspecs.length > 0 ? ['--', ...pathspecs] : [])];
    const read = await gitRecords(cwd, args, { maxRecords: MAX_NEW_FILES_LISTED, timeoutMs: DIFF_TIMEOUT_MS, parsed: true });

    if (!read.ok) throw unavailable('git did not answer');

    return { paths: read.records.filter(path => path !== '' && !path.endsWith('/')), truncated: read.truncated };
}

/** A new file as a change: added, with no old side. Its mode and content id are filled in from the file (`settle`). */
const newFileEntry = (path: string): DiffEntry => ({ path, kind: 'added', untracked: true, oldMode: ABSENT_MODE, newMode: '100644', oldBlob: '', newBlob: '' });

/** A new file with the lines `countNewFiles` found in it: all of them added, or none and binary. A file it did not count has neither. */
function withLines(entry: DiffEntry, count: { additions: number } | { binary: true } | undefined): DiffEntry {
    if (!count) return entry;

    return 'binary' in count ? { ...entry, binary: true } : { ...entry, additions: count.additions, deletions: 0 };
}

/** The lines in a file's bytes, or that git would take it for binary. A last line that does not end in a newline counts as a line. */
function countLines(content: Buffer): { additions: number } | { binary: true } {
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { binary: true };

    let lines = 0;

    for (let at = content.indexOf(10); at !== -1; at = content.indexOf(10, at + 1)) lines++;

    return { additions: content.length > 0 && content.at(-1) !== 10 ? lines + 1 : lines };
}

/**
 * The lines of new files, which git has no numbers for until they are added: each file is read and its lines counted, in path order, within a budget of files, bytes and
 * time. The first file past it, and every one after, is left uncounted, and `complete` is false.
 */
async function countNewFiles(cwd: string, paths: string[]): Promise<{ counts: Map<string, { additions: number } | { binary: true }>; complete: boolean }> {
    const counts = new Map<string, { additions: number } | { binary: true }>();
    const deadline = Date.now() + COUNT_BUDGET_MS;
    let bytes = 0;

    for (const [index, path] of paths.entries()) {
        if (index >= MAX_NEW_FILES_COUNTED || Date.now() > deadline) return { counts, complete: false };

        const info = await lstat(join(cwd, path)).catch(() => undefined);

        // A link is one line, as git counts it: its target. A folder or a file that went since the listing has none.
        if (info?.isSymbolicLink()) {
            counts.set(path, { additions: 1 });
        }
        else if (info?.isFile()) {
            bytes += info.size;

            if (bytes > MAX_NEW_BYTES_COUNTED) return { counts, complete: false };

            const content = await readFile(join(cwd, path)).catch(() => undefined);

            if (content) counts.set(path, countLines(content));
        }
    }

    return { counts, complete: true };
}

/** What the working tree has at a path: a file, a link (git's content for it is its target), or something git has no content for. */
interface WorkingFact {
    kind: 'file' | 'link' | 'other';
    size: number;
    mtimeMs: number;
    /** The mode git would record for it. */
    mode: string;
}

const factOf = (info: Stats): WorkingFact => ({
    kind: info.isSymbolicLink() ? 'link' : info.isFile() ? 'file' : 'other',
    size: info.size,
    mtimeMs: info.mtimeMs,
    mode: info.isSymbolicLink() ? '120000' : info.mode & 0o100 ? '100755' : '100644',
});

/** What the working tree has at each of the paths; a path that is gone has no entry. */
async function inspectWorking(cwd: string, paths: string[]): Promise<Map<string, WorkingFact>> {
    const facts = new Map<string, WorkingFact>();

    await Promise.all(paths.map(async (path) => {
        const info = await lstat(join(cwd, path)).catch(() => undefined);

        if (info) facts.set(path, factOf(info));
    }));

    return facts;
}

/** What stands for a file's content id when git could not hash it in time: its size and its modification time, which an edit changes. */
const stampOf = (fact: WorkingFact) => `stat-${ fact.size }-${ Math.trunc(fact.mtimeMs) }`;

/**
 * The commit a submodule's own checkout is at, which is what git records for it. Only a folder with a `.git` of its own is asked: git would answer for an empty folder (a
 * submodule that is not set up) with the HEAD of the repository around it.
 */
async function submoduleHead(directory: string): Promise<string | undefined> {
    return lstat(join(directory, '.git')).then(() => gitLine(directory, ['rev-parse', '--verify', '--quiet', 'HEAD']), () => undefined);
}

/**
 * The content ids of files in the working tree, as `git hash-object` gives them (its checkout filters applied, as `git add` would): files in groups of paths, a link by its
 * target, a submodule by the commit it is at. What git could not hash (too slow, a file that went) has `stampOf` in its place. Nothing is written to the repository:
 * `hash-object` without `-w` stores nothing.
 */
async function hashWorking(cwd: string, facts: Map<string, WorkingFact>, paths: string[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    const files = paths.filter(path => facts.get(path)?.kind === 'file');
    const chunks: string[][] = [];

    for (const path of files) {
        const last = chunks.at(-1);

        if (last && last.length < HASH_CHUNK_PATHS && last.join('').length + path.length <= HASH_CHUNK_CHARS) {
            last.push(path);
        }
        else {
            chunks.push([path]);
        }
    }

    await Promise.all([
        ...chunks.map(async (chunk) => {
            const read = await gitRead(cwd, ['hash-object', '--', ...chunk], { timeoutMs: HASH_TIMEOUT_MS });
            const lines = read.ok ? read.stdout.split('\n').filter(line => line !== '') : [];

            for (const [index, path] of chunk.entries()) {
                if (lines.length === chunk.length) ids.set(path, lines[index]!);
            }
        }),
        ...paths.filter(path => facts.get(path)?.kind === 'link').map(async (path) => {
            const target = await readlink(join(cwd, path)).catch(() => undefined);
            const read = target === undefined ? undefined : await gitRead(cwd, ['hash-object', '--stdin'], { input: target, timeoutMs: HASH_TIMEOUT_MS });

            if (read?.ok) ids.set(path, read.stdout.trim());
        }),
        ...paths.filter(path => facts.get(path)?.kind === 'other').map(async (path) => {
            const head = await submoduleHead(join(cwd, path));

            if (head) ids.set(path, head);
        }),
    ]);

    for (const path of paths) {
        const fact = facts.get(path);

        if (fact && !ids.has(path)) ids.set(path, stampOf(fact));
    }

    return ids;
}

/** The sizes of blobs, by content id, in one `cat-file --batch-check`; an id git does not have (a submodule's commit) has none, and neither has any id when git did not answer. */
async function blobSizes(cwd: string, ids: string[]): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    const unique = [...new Set(ids)];

    if (unique.length === 0) return sizes;

    const read = await gitRead(cwd, ['cat-file', '--batch-check'], { input: `${ unique.join('\n') }\n`, timeoutMs: HASH_TIMEOUT_MS });

    for (const line of read.ok ? read.stdout.split('\n') : []) {
        const [id, type, size] = line.split(' ');

        if (id && type === 'blob' && size !== undefined) sizes.set(id, Number(size));
    }

    return sizes;
}

/** A change whose working-tree side has been read: the ids and mode that are filled in, the sizes of its sides, and its revision. */
interface Settled {
    entry: DiffEntry;
    oldSize?: number;
    newSize?: number;
    fact?: WorkingFact;
    revision: string;
}

/**
 * What the changes' own output leaves open: a file in the working tree has the id git did not compute (all zeros) and a new file has neither id nor mode, so they are
 * read from the files (`hashWorking`); the sizes of both sides are asked of git (`blobSizes`) and of the file system; and each file's revision, `<oldMode>:<oldBlob>:<newMode>:<newBlob>`, is made. A
 * new file that is gone since it was listed is left out.
 */
async function settle(cwd: string, plan: Plan, entries: DiffEntry[]): Promise<Settled[]> {
    const working = plan.to === undefined;
    const facts = working ? await inspectWorking(cwd, entries.filter(entry => entry.untracked || entry.newMode !== ABSENT_MODE).map(entry => entry.path)) : new Map<string, WorkingFact>();
    const present = entries.filter(entry => !entry.untracked || facts.has(entry.path));
    const zeros = '0'.repeat(entries.find(entry => entry.oldBlob !== '')?.oldBlob.length ?? 40);
    const hashed = await hashWorking(cwd, facts, present.filter(entry => working && entry.newMode !== ABSENT_MODE && (entry.untracked || isZeros(entry.newBlob))).map(entry => entry.path));
    const stored = (id: string, mode: string) => (mode === ABSENT_MODE || mode === SUBMODULE_MODE || id === '' || isZeros(id) ? undefined : id);
    const sizes = await blobSizes(cwd, present.flatMap(entry => [stored(entry.oldBlob, entry.oldMode), working ? undefined : stored(entry.newBlob, entry.newMode)]).filter((id): id is string => id !== undefined));

    return present.map((original) => {
        const fact = facts.get(original.path);
        const entry: DiffEntry = {
            ...original,
            ...(original.untracked && fact && { newMode: fact.mode }),
            oldBlob: original.oldBlob === '' ? zeros : original.oldBlob,
            newBlob: working && original.newMode !== ABSENT_MODE && (original.untracked || isZeros(original.newBlob)) ? hashed.get(original.path) ?? zeros : original.newBlob,
        };
        const oldId = stored(entry.oldBlob, entry.oldMode);
        const newId = working ? undefined : stored(entry.newBlob, entry.newMode);
        const oldSize = oldId === undefined ? undefined : sizes.get(oldId);
        const newSize = newId === undefined ? fact?.size : sizes.get(newId);

        return { entry, ...(oldSize !== undefined && { oldSize }), ...(newSize !== undefined && { newSize }), ...(fact && { fact }), revision: `${ entry.oldMode }:${ entry.oldBlob }:${ entry.newMode }:${ entry.newBlob }` };
    });
}

/** Whether a change is too big to draw: more changed lines than `MAX_GIT_DIFF_LINES`, or a side over `MAX_GIT_SIDE_BYTES`. A binary file is none: it has no text to be too big. */
function isTooLarge({ entry, oldSize = 0, newSize = 0 }: Settled): boolean {
    return !entry.binary && ((entry.additions ?? 0) + (entry.deletions ?? 0) > MAX_GIT_DIFF_LINES || oldSize > MAX_GIT_SIDE_BYTES || newSize > MAX_GIT_SIDE_BYTES);
}

/** Paths in the order git sorts them: by bytes, not by the locale's rules, so a list is the same on every machine. */
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The files that changed in a scope (`GET /v1/projects/:id/git/changes`): git's own list of the tracked files with their line counts (`git diff --raw --numstat`, the index
 * read and never changed) and, for the scopes that include them, the new files git does not track, their lines counted by the daemon within a budget (`countNewFiles`). The
 * list is sorted by path and cut at `MAX_GIT_CHANGED_FILES`; the count and the totals cover every file. A place that is not the root of a working tree is `isRepository: false`.
 */
export async function placeChanges(place: Place, scope: GitScope, options: BaseOptions = {}): Promise<GitChanges> {
    const cwd = place.path;

    if (!await workingTreeRoot(cwd)) return { isRepository: false };

    const plan = await planOf(place, scope, options);
    const [tracked, fresh] = await Promise.all([trackedChanges(cwd, plan), plan.untracked ? newFiles(cwd) : { paths: [], truncated: false }]);
    // A path a staged deletion took out of the index and the person put back on the disk is listed by both: it is the deletion.
    const known = new Set(tracked.map(entry => entry.path));
    const newPaths = fresh.paths.filter(path => !known.has(path));
    const counted = await countNewFiles(cwd, newPaths);
    const entries = [...tracked, ...newPaths.map(path => withLines(newFileEntry(path), counted.counts.get(path)))].sort(byPath);
    const listed = await settle(cwd, plan, entries.slice(0, MAX_GIT_CHANGED_FILES));
    let additions = 0;
    let deletions = 0;

    for (const entry of entries) {
        additions += entry.additions ?? 0;
        deletions += entry.deletions ?? 0;
    }

    const files = listed.map((settled): GitChangedFile => {
        const { entry } = settled;

        return {
            path: entry.path,
            ...(entry.oldPath !== undefined && { oldPath: entry.oldPath }),
            kind: entry.kind,
            ...(entry.untracked && { untracked: true as const }),
            ...(entry.additions !== undefined && { additions: entry.additions }),
            ...(entry.deletions !== undefined && { deletions: entry.deletions }),
            ...(entry.binary && { binary: true as const }),
            ...(isTooLarge(settled) && { tooLarge: true as const }),
            revision: settled.revision,
        };
    });
    const truncated = entries.length > MAX_GIT_CHANGED_FILES || fresh.truncated;

    return {
        isRepository: true,
        scope,
        ...(plan.from && { from: plan.from }),
        ...(plan.baseState && { baseState: plan.baseState }),
        files,
        fileCount: entries.length,
        additions,
        deletions,
        statsComplete: counted.complete && !fresh.truncated,
        ...(truncated && { truncated: true as const }),
    };
}

/** A path as a client writes it: one the repository can have, relative, with `/` separators and no `.` or `..` in it. */
export function checkPath(path: string): void {
    if (path === '' || path.includes('\0') || isAbsolute(path) || path.endsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
        throw invalid('The path is not a path inside the repository');
    }
}

/** A path given to git as a path, whatever it has in it: `*`, `[`, a leading `:` or `!` are not pattern characters. */
const literal = (path: string) => `:(literal)${ path }`;

/** The text of a blob, as it is stored, or as a checkout would write it for the path `filters` names. */
async function blobText(cwd: string, id: string, filters?: string): Promise<string> {
    // The checkout filters (a Windows person's `core.autocrlf`) make the old side's lines end as the file on disk's do; a filter that cannot run leaves the stored text.
    if (filters !== undefined) {
        const filtered = await gitRead(cwd, ['cat-file', '--filters', `--path=${ filters }`, id], { maxBytes: TEXT_MAX_BYTES });

        if (filtered.ok) return filtered.stdout;
    }

    const read = await gitRead(cwd, ['cat-file', 'blob', id], { maxBytes: TEXT_MAX_BYTES });

    if (!read.ok) throw unavailable('git did not answer');

    return read.stdout;
}

/** The text of the file in the working tree: a link's target, or the file's own text. A file whose real path is outside the working tree (a folder that is a link) is not read. */
async function workingText(cwd: string, path: string, fact: WorkingFact): Promise<string | null> {
    if (fact.kind === 'link') return await readlink(join(cwd, path)).catch(() => null);

    if (fact.kind !== 'file') return null;

    const [root, real] = await Promise.all([realpath(cwd), realpath(join(cwd, path)).catch(() => undefined)]);

    const inside = real === undefined ? undefined : relative(root, real);

    if (real === undefined || inside === undefined || inside === '..' || inside.startsWith(`..${ sep }`) || isAbsolute(inside)) throw notFound('File', path);

    return (await readFile(real).catch(() => undefined))?.toString('utf8') ?? null;
}

/**
 * The text of one changed file before and after, for a diff to be drawn from (`GET /v1/projects/:id/git/file`). The file is found as the scope's own list finds it (the diff of
 * that path alone, and the new files for the scopes that include them), so a path that did not change in the scope is `not_found`. The old side is a stored blob; the new side is
 * a blob for a commit's scope and the file on disk for a working-tree scope, a link as its target. A binary file, a submodule, a side over `MAX_GIT_SIDE_BYTES` or a file that
 * changes more than `MAX_GIT_DIFF_LINES` lines carries no text. `oldPath` is the path before a rename: without it the file is read as a new one. `options.from` is the commit the
 * list was counted from (`GitChanges.from`): a card passes it, so the file is read against the list's own start and costs no base lookup.
 */
export async function placeFile(place: Place, scope: GitScope, path: string, oldPath: string | undefined, options: FileOptions = {}): Promise<GitFileSides> {
    checkPath(path);

    if (oldPath !== undefined) checkPath(oldPath);

    const cwd = place.path;

    if (!await workingTreeRoot(cwd)) throw invalid('The folder is not the root of a git repository');

    const plan = await planOf(place, scope, options);
    const pathspecs = oldPath !== undefined && oldPath !== path ? [literal(path), literal(oldPath)] : [literal(path)];
    let found = (await trackedChanges(cwd, plan, pathspecs)).find(entry => entry.path === path);

    if (!found && plan.untracked && (await newFiles(cwd, [literal(path)])).paths.includes(path)) {
        found = withLines(newFileEntry(path), (await countNewFiles(cwd, [path])).counts.get(path));
    }

    const settled = found ? (await settle(cwd, plan, [found]))[0] : undefined;

    if (!settled) throw notFound('Changed file', path);

    const { entry, revision, fact } = settled;

    if (entry.binary || entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE) return { state: 'binary', revision };

    if (isTooLarge(settled)) return { state: 'too_large', revision };

    const hasOld = entry.oldMode !== ABSENT_MODE && !isZeros(entry.oldBlob);
    const [original, modified] = await Promise.all([
        hasOld ? blobText(cwd, entry.oldBlob, plan.to === undefined ? entry.oldPath ?? entry.path : undefined) : null,
        entry.newMode === ABSENT_MODE ? null : plan.to !== undefined ? blobText(cwd, entry.newBlob) : fact ? workingText(cwd, entry.path, fact) : null,
    ]);

    if (original?.includes('\0') || modified?.includes('\0')) return { state: 'binary', revision };

    return { state: 'text', original, modified, revision };
}
