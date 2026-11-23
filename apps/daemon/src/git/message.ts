import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { gitRead } from '../domain/git';
import { exclusive, pathKey, placeOf } from '../domain/workspaces';
import { COMMIT_MESSAGE_SETTING } from '../engine/acp/catalog';
import { CommandError } from '../errors';
import { GenerateFailure } from '../providers/generate';
import { selectChanged } from './selection';

import type { GitChangedFile, GitChangeKind, GitErrorDetails, GitMessage, GitMessageFailure } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { AgentRegistry } from '../engine/acp/registry';
import type { TextGeneration } from '../providers/generate';
import type { ProvidersService } from '../providers/service';
import type { Store } from '../store';
import type { Selection } from './selection';

/** What the person is told whenever a message could not be written, whatever the reason (which is in `details.reason` for the app to tell apart). */
export const MESSAGE_FAILED = 'Couldn\'t write the message';

/** The longest subject: git's own convention, and what the prompt asks for. */
export const MAX_SUBJECT_COLUMNS = 72;

/** How much of the changes the prompt carries: the excerpt of the diff, shared among the files, and the list of the files with what happened to each. */
export const DIFF_EXCERPT_BYTES = 32_000;
export const FILE_LIST_BYTES = 4000;

/** A line of a diff that is longer is cut (a minified file would use the whole excerpt for one line), and a file read for a new file gives at most this much. */
const MAX_LINE_CHARS = 200;
const MAX_NEW_FILE_BYTES = 64 * 1024;

/** How many of the repository's last subjects are shown as the style to follow. */
const RECENT_SUBJECTS = 10;

/** The most a diff of the paths may print for the daemon to read it: more than this and the files are named with no excerpt. */
const DIFF_READ_BYTES = 8 * 1024 * 1024;
const DIFF_READ_TIMEOUT_MS = 15_000;

const STATUS_LETTER: Record<GitChangeKind, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflicted: 'U' };

/** A path given to git as a path, whatever it has in it. */
const literal = (path: string) => `:(literal)${ path }`;

const byteLength = (text: string) => Buffer.byteLength(text);

/** The first `bytes` bytes of the text as whole lines (and as whole characters): what a diff is cut to. */
export function cutLines(text: string, bytes: number): string {
    if (byteLength(text) <= bytes) return text;

    const head = Buffer.from(text).subarray(0, Math.max(0, bytes)).toString('utf8').replace(/�+$/, '');
    const end = head.lastIndexOf('\n');

    return end > 0 ? head.slice(0, end) : head;
}

/** The list of the files as `git diff --name-status` writes it (`M<TAB>path`, `R<TAB>old<TAB>new`), with what cannot be shown noted, cut to `FILE_LIST_BYTES`. */
export function nameStatus(files: readonly GitChangedFile[]): string {
    const lines = files.map((file) => {
        const letter = STATUS_LETTER[file.kind];
        const names = file.oldPath !== undefined && file.kind === 'renamed' ? `${ file.oldPath }\t${ file.path }` : file.path;
        const note = file.binary ? ' (binary)' : file.tooLarge ? ' (too large to show)' : '';

        return `${ letter }\t${ names }${ note }`;
    });
    const shown: string[] = [];
    let used = 0;

    for (const line of lines) {
        used += byteLength(line) + 1;

        if (used > FILE_LIST_BYTES && shown.length > 0) break;

        shown.push(line);
    }

    return shown.length < lines.length ? [...shown, `... and ${ lines.length - shown.length } more files`].join('\n') : shown.join('\n');
}

/**
 * The excerpts of several files' diffs that fit a budget, shared fairly: the smallest ones are kept whole, and what they leave unused goes to the bigger ones, so a file of thousands of
 * lines cannot starve the others and a small one is never cut for it. Each is cut at a line. Joined in the order they came in.
 */
export function shareExcerpt(chunks: readonly string[], budget: number): string {
    const order = chunks.map((text, index) => ({ index, size: byteLength(text) })).sort((a, b) => a.size - b.size || a.index - b.index);
    const taken = new Map<number, number>();
    let left = budget;

    for (const [position, { index, size }] of order.entries()) {
        const share = Math.floor(left / (order.length - position));
        const take = Math.min(size, share);

        taken.set(index, take);
        left -= take;
    }

    return chunks.map((text, index) => cutLines(text, taken.get(index) ?? 0)).filter(text => text !== '').join('\n');
}

/** Cuts the lines of a diff that are longer than the cap. */
const capLines = (text: string) => text.split('\n').map(line => (line.length > MAX_LINE_CHARS ? `${ line.slice(0, MAX_LINE_CHARS) }…` : line)).join('\n');

/** The path a chunk of `git diff` (from its `diff --git` line to the next) is about: the new path. */
function chunkPath(chunk: string, paths: readonly string[]): string | undefined {
    const header = chunk.slice(0, chunk.indexOf('\n') === -1 ? undefined : chunk.indexOf('\n'));

    return paths.find(path => header.endsWith(` b/${ path }`));
}

/** The beginning of a new file as a diff of it: the lines of its first `MAX_NEW_FILE_BYTES`, all added. A file git has no HEAD to compare with (a new one, a new repository) is read this way. */
async function newFileChunk(cwd: string, path: string): Promise<string | undefined> {
    const info = await lstat(join(cwd, path)).catch(() => undefined);

    if (!info?.isFile()) return undefined;

    const handle = await open(join(cwd, path), 'r').catch(() => undefined);

    if (!handle) return undefined;

    try {
        const buffer = Buffer.alloc(Math.min(info.size, MAX_NEW_FILE_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString('utf8');

        if (text.includes('\0')) return undefined;

        const lines = (info.size > bytesRead ? cutLines(text, bytesRead) : text).split('\n');

        // The last "line" of a text that ends in a newline is nothing.
        if (lines.at(-1) === '') lines.pop();

        return [`diff --git a/${ path } b/${ path }`, 'new file', '--- /dev/null', `+++ b/${ path }`, `@@ -0,0 +1,${ lines.length } @@`, ...lines.map(line => `+${ line }`)].join('\n');
    }
    finally {
        await handle.close();
    }
}

/**
 * The excerpt of the diff of the files that are about to be committed (the working tree against HEAD, `git diff HEAD` for the files git tracks, the text of the file for a new one), cut
 * to `DIFF_EXCERPT_BYTES` and shared fairly among the files. A binary file and one too large to show are not in it, and are named in the list.
 */
export async function diffExcerpt(place: Place, selection: Selection): Promise<string> {
    const cwd = place.path;
    const shown = selection.files.filter(file => file.binary !== true && file.tooLarge !== true);
    const tracked = shown.filter(file => file.untracked !== true);
    const chunks = new Map<string, string>();

    if (tracked.length > 0) {
        const paths = tracked.flatMap(file => (file.kind === 'renamed' && file.oldPath !== undefined ? [file.path, file.oldPath] : [file.path]));
        const read = await gitRead(cwd, ['diff', 'HEAD', '-U2', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--', ...paths.map(literal)], { parsed: true, timeoutMs: DIFF_READ_TIMEOUT_MS, maxBytes: DIFF_READ_BYTES });

        for (const chunk of read.ok ? read.stdout.split(/^(?=diff --git )/m) : []) {
            const path = chunkPath(chunk, tracked.map(file => file.path));

            if (path !== undefined) chunks.set(path, chunk.trimEnd());
        }
    }

    // A new file has no diff yet, and neither has an added one in a repository with no commit: its text is the diff.
    for (const file of shown) {
        if (chunks.has(file.path) || (file.kind !== 'added' && file.untracked !== true)) continue;

        const chunk = await newFileChunk(cwd, file.path);

        if (chunk !== undefined) chunks.set(file.path, chunk);
    }

    return shareExcerpt(shown.flatMap(file => chunks.get(file.path) ?? []).map(capLines), DIFF_EXCERPT_BYTES);
}

/** The subjects of the repository's last commits, newest first: the style to follow. Nothing for a repository with no commit. */
export async function recentSubjects(cwd: string): Promise<string[]> {
    const read = await gitRead(cwd, ['log', `-${ RECENT_SUBJECTS }`, '--format=%s'], { parsed: true });

    return read.ok ? read.stdout.split('\n').map(line => line.trim()).filter(line => line !== '') : [];
}

/** What the agent is asked: one Conventional Commits subject for the changes, in the style of the repository's own history. */
export function buildPrompt({ files, excerpt, recent }: { files: readonly GitChangedFile[]; excerpt: string; recent: readonly string[] }): string {
    return [
        'Write the subject line of a git commit for the changes below.',
        '',
        'Reply with one line and nothing else, in the form type(scope): description',
        '- type is one of feat, fix, chore, refactor, docs, test, ci, perf and revert; the scope is optional',
        `- present tense, no period at the end, at most ${ MAX_SUBJECT_COLUMNS } characters, no body, no quotes`,
        '- follow the style of the recent subjects of this repository',
        '',
        ...(recent.length > 0 ? ['Recent subjects of this repository:', ...recent.map(subject => `- ${ subject }`), ''] : []),
        'Changed files:',
        nameStatus(files),
        ...(excerpt === '' ? [] : ['', 'Excerpt of the diff (cut to fit, so some files may be partial or missing):', excerpt]),
    ].join('\n');
}

/**
 * What the agent answered as a subject: its first line, without the quotes or backticks it may have put round it and without a period at the end, and if it is longer than
 * `MAX_SUBJECT_COLUMNS` characters, cut at the last word that fits (the agent is not asked again). Nothing for an answer with no text.
 */
export function cleanSubject(answer: string): string | undefined {
    const first = answer.split(/\r?\n/).map(line => line.trim()).find(line => line !== '');

    if (first === undefined) return undefined;

    // Quotes round the whole line are the model's habit, not part of a subject; a period at the end is what the prompt forbids.
    const unquoted = first.replace(/^(["'`])(.*)\1$/, '$2').trim().replace(/\.+$/, '').trim();
    const characters = Array.from(unquoted);

    if (characters.length <= MAX_SUBJECT_COLUMNS) return unquoted || undefined;

    const head = characters.slice(0, MAX_SUBJECT_COLUMNS).join('');
    // The line goes on after a space: the head is whole words. Else the last word is cut, and the head ends before it (a line with no space in it is cut where it is).
    const lastSpace = head.search(/\s\S*$/);
    const cut = /\s/.test(characters[MAX_SUBJECT_COLUMNS]!) || lastSpace <= 0 ? head : head.slice(0, lastSpace);

    return cut.trim().replace(/[\s,;:(-]+$/, '') || undefined;
}

export interface CommitMessagesOptions {
    /** Where the one-at-a-time line of each place is kept (`exclusive`). */
    store: Store;
    /** The agents' settings: which of them the person turned `Commit messages` on for. */
    agents: Pick<AgentRegistry, 'setting'>;
    /** Who is signed in. */
    providers: Pick<ProvidersService, 'signedIn'>;
    generation: TextGeneration;
}

const failed = (reason: GitMessageFailure, code: 'invalid' | 'unavailable' = 'unavailable') => new CommandError(code, MESSAGE_FAILED, { reason } satisfies GitErrorDetails);

/**
 * The commit message of a place's ticked files (`POST /v1/projects/:id/git/message`): the changes are put into a prompt (`buildPrompt`) and the agent the person turned `Commit messages`
 * on for, and that is signed in, writes one subject in a run of its own with no tools (`TextGeneration`): Codex first, and Claude Code when Codex is off or signed out, or when its
 * run fails. Nothing runs until it is asked for: no timer, no change of a file, no run of an agent that the person did not choose. A place is asked once at a time, and a second request
 * for the same files while one is going on gets that one's answer.
 */
export class CommitMessages {
    readonly #options: CommitMessagesOptions;
    readonly #running = new Map<string, Promise<GitMessage>>();

    constructor(options: CommitMessagesOptions) {
        this.#options = options;
    }

    /** Ends the run that is going on, and refuses new ones. */
    stop(): void {
        this.#options.generation.stop();
    }

    /**
     * The agents that have the switch on and are signed in, in the order of the table (`TextGeneration.agents`: Codex, then Claude Code). The reason there is none is the error: `off` for
     * no agent with the switch on (`invalid`: nothing to ask, the app shows no button) and `signed_out` for ones that are on and not signed in.
     */
    async #agents(): Promise<string[]> {
        const on = this.#options.generation.agents.filter(id => this.#options.agents.setting(id, COMMIT_MESSAGE_SETTING) === true);

        if (on.length === 0) throw failed('off', 'invalid');

        const signedIn = await Promise.all(on.map(id => this.#options.providers.signedIn(id)));
        const ready = on.filter((_, index) => signedIn[index]);

        if (ready.length === 0) throw failed('signed_out');

        return ready;
    }

    /** What the agent writes for these files, or the reason it could not (`MESSAGE_FAILED` with `details.reason`). */
    generate(place: Place, paths: unknown): Promise<GitMessage> {
        const line = `message:${ pathKey(placeOf(place.path)) }`;
        const same = `${ line }\0${ Array.isArray(paths) ? paths.join('\0') : '' }`;
        const running = this.#running.get(same);

        if (running) return running;

        const run = exclusive(this.#options.store, line, undefined, () => this.#write(place, paths)).finally(() => this.#running.delete(same));

        this.#running.set(same, run);

        return run;
    }

    /**
     * The first agent of those that are on and signed in answers; when its run fails, does not end in time or says nothing, the next one is asked once, and so on to the end of the list.
     * With none left the error is the last one's reason. An agent that is off or signed out is never asked, and is not a failure to fall back from.
     */
    async #write(place: Place, paths: unknown): Promise<GitMessage> {
        const agents = await this.#agents();
        const selection = await selectChanged(place, paths);
        const [excerpt, recent] = await Promise.all([diffExcerpt(place, selection), recentSubjects(place.path)]);
        const prompt = buildPrompt({ files: selection.files, excerpt, recent });
        let reason: GitMessageFailure = 'failed';

        for (const agent of agents) {
            try {
                const message = cleanSubject(await this.#options.generation.run(agent, prompt));

                if (message !== undefined) return { message };

                reason = 'failed';
            }
            catch (error) {
                reason = error instanceof GenerateFailure ? error.reason : 'failed';
            }
        }

        throw failed(reason);
    }
}
