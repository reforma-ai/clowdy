import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { getChat, getChatLastRun, setChatLastRun } from '../db/chats';
import { nextSeq } from '../db/items';
import { getRun, getRunWork } from '../db/runs';
import { gitRead } from '../domain/git';
import { workingTreeRoot } from './state';

import type { ChatLastRun } from '@clowdy/protocol';
import type { Store } from '../store';

/** What the two git commands that make a tree may take together; past it the snapshot is given up and nothing is kept. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * How long a message that goes into a session that is already running (`RunDriver.hand`) waits for the start snapshot of its turn before it is sent: the agent is warm and may
 * answer within a second. The first turn of a session does not wait at all: its snapshot is started before the session is, and an agent needs seconds to start and answer. A
 * snapshot slower than the agent (a very large tree) may then contain an edit of the agent's first moments and the scope misses it, which is the price of not holding a turn back.
 */
export const START_WAIT_MS = 1000;

/** How long a turn's end waits for its snapshot before the run settles without it; the snapshot goes on and the plate comes as soon as it is done, since it is pushed with the chat. */
export const END_WAIT_MS = 4000;

/** The settings every git command of a snapshot is run with: the index is written whole, so no `sharedindex.*` file is made in the repository for it. */
const SNAPSHOT_CONFIG = ['-c', 'core.splitIndex=false'];

/** A folder as an entry of `GIT_ALTERNATE_OBJECT_DIRECTORIES`: the entries are told apart by the platform's path delimiter, and one that has it (or a quote) in its name is written in quotes. */
const alternate = (folder: string) =>
    folder.includes(delimiter) || folder.includes('"') ? `"${folder.replace(/["\\]/g, '\\$&')}"` : folder;

/**
 * Moves the loose objects a snapshot wrote in its quarantine into the repository's own object folder, which is where a tree has to be for git to read it later. An object that is
 * there already (another git wrote the same content meanwhile) is the same object and stays. Packs are not moved: git writes one only for a file bigger than `core.bigFileThreshold`
 * (512 MiB), which a run's list could not draw anyway, so a snapshot that made one is none.
 */
async function adopt(quarantine: string, objects: string): Promise<boolean> {
    for (const name of await readdir(quarantine)) {
        if (name === 'pack') {
            if ((await readdir(join(quarantine, name))).some(file => file.endsWith('.pack'))) return false;

            continue;
        }

        if (!/^[0-9a-f]{2}$/.test(name)) continue;

        await mkdir(join(objects, name), { recursive: true });

        for (const file of await readdir(join(quarantine, name))) {
            const target = join(objects, name, file);

            await rename(join(quarantine, name, file), target).catch(async (error: unknown) => {
                if (
                    !(await stat(target).then(
                        () => true,
                        () => false
                    ))
                )
                    throw error;
            });
        }
    }

    return true;
}

/**
 * The id of a tree that holds the files of a working directory as `git add -A` would put them in a commit: the tracked files as they are on the disk now, and the new ones that
 * `.gitignore` and the other exclude rules do not hide; a file that was deleted is not there. It is made in an index of its own, a copy of the repository's index in a temporary
 * folder (`GIT_INDEX_FILE`) which is removed again, so the repository's own index, its refs, its config and its working tree are never touched, and the copy's cached file
 * stats make a tree of an unchanged project cost one pass over the files, not one read of each.
 *
 * Objects are written (`add` stores each changed or new file as a blob, and `write-tree` the trees), which is the one trace left in the repository: loose objects that nothing refers
 * to, which git's own `gc` removes after two weeks. They are written into a quarantine folder of their own inside the repository's object folder (`GIT_OBJECT_DIRECTORY`, with the
 * repository's own objects as an alternate so nothing is written twice) and moved into place only once both commands have succeeded: a git that is killed for the time limit while it
 * writes a large file leaves a half-written `tmp_obj_*` behind it, which would otherwise stay in the repository for two weeks for every turn. The person's clean filters run, as for
 * `git add` (a Git LFS user's clean step stores a file in `.git/lfs`).
 *
 * Nothing when the folder is not the root of a working tree, when git is not there, or when it takes longer than `timeoutMs` (a tree of a huge project, a file too big to hash in time),
 * and for any failure of either command (a file git cannot read): a snapshot is whole or it is none, and a snapshot that is none has written nothing.
 */
export async function snapshotTree(cwd: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    let folder: string | undefined;
    let quarantine: string | undefined;

    try {
        const [root, paths] = await Promise.all([
            workingTreeRoot(cwd),
            gitRead(cwd, ['rev-parse', '--git-path', 'index', '--git-path', 'objects']),
        ]);
        const [index, objectsPath] = paths.ok ? paths.stdout.split('\n') : [];

        if (!root || !index || !objectsPath) return undefined;

        const objects = resolve(cwd, objectsPath);

        folder = await mkdtemp(join(tmpdir(), 'clowdy-tree-'));
        quarantine = await mkdtemp(join(objects, 'tmp_objdir-clowdy-'));

        const own = join(folder, 'index');

        // A repository that has no index yet (no commit, nothing added) starts the copy empty; a clone-on-write copy where the disk has them, a plain one elsewhere.
        await copyFile(resolve(cwd, index), own, constants.COPYFILE_FICLONE).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });

        const env = {
            GIT_INDEX_FILE: own,
            GIT_OBJECT_DIRECTORY: quarantine,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: [alternate(objects), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
                .filter(Boolean)
                .join(delimiter),
        };

        // A deadline that is already past (a slow disk, a slow first command) is none, without starting a git that would only be killed, or would finish before the kill.
        if (Date.now() >= deadline) return undefined;

        const added = await gitRead(cwd, [...SNAPSHOT_CONFIG, 'add', '-A'], {
            env,
            timeoutMs: deadline - Date.now(),
        });

        if (!added.ok || Date.now() >= deadline) return undefined;

        const written = await gitRead(cwd, [...SNAPSHOT_CONFIG, 'write-tree'], {
            env,
            timeoutMs: deadline - Date.now(),
        });
        const tree = written.ok ? written.stdout.trim() : '';

        return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(tree) && (await adopt(quarantine, objects)) ? tree : undefined;
    } catch {
        // A folder that went, a disk that is full, a git that is not there: the turn has no snapshot, and says nothing of it.
        return undefined;
    } finally {
        await Promise.all(
            [folder, quarantine].map(path => path && rm(path, { recursive: true, force: true }).catch(() => undefined))
        );
    }
}

/** Waits for `work` for `ms` at most. What `work` is doing goes on past that by itself, and its failure is not this one's (`work` never rejects). */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            work,
            new Promise<void>(done => {
                timer = setTimeout(done, ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export interface TurnSnapshotsOptions {
    /** Makes the tree of a folder; `snapshotTree` unless a test says otherwise. */
    snapshot?: (cwd: string) => Promise<string | undefined>;
    startWaitMs?: number;
    endWaitMs?: number;
    now?: () => number;
}

/**
 * The two trees around a turn of a chat's orchestrator, which say what the turn changed (`Chat.lastRun`, `turnScope`). One `TurnTrees` is made when a turn starts (`begin`): it takes the
 * tree of the chat's working directory at once, and when the turn ends (`end`) takes a second and keeps the pair on the chat; they are the same tree for a turn that changed nothing
 * and then nothing is kept, and the chat's earlier record goes, since it is not the latest turn's any more. Only the orchestrator of a chat is measured, and only while it works in the
 * chat's own place: a sub-agent and a run that was given a folder of its own (a thread's `cwd`) have none, and the work of both is in the orchestrator's tree anyway.
 */
export class TurnSnapshots {
    readonly #snapshot: (cwd: string) => Promise<string | undefined>;
    readonly #startWaitMs: number;
    readonly #endWaitMs: number;
    readonly #now: () => number;

    constructor(
        private readonly store: Store,
        options: TurnSnapshotsOptions = {}
    ) {
        this.#snapshot = options.snapshot ?? (cwd => snapshotTree(cwd));
        this.#startWaitMs = options.startWaitMs ?? START_WAIT_MS;
        this.#endWaitMs = options.endWaitMs ?? END_WAIT_MS;
        this.#now = options.now ?? Date.now;
    }

    /** The trees of a turn of `runId` that works in `cwd`, started now; nothing for a run that is not a chat's orchestrator in its chat's own place. */
    begin(runId: string, cwd: string): TurnTrees | undefined {
        const run = getRun(this.store.db, runId);

        if (!run || run.role !== 'orchestrator' || run.chatId === undefined || getRunWork(this.store.db, runId).cwd)
            return undefined;

        return new TurnTrees(this, run.chatId, runId, cwd);
    }

    /** @internal for `TurnTrees` */
    take(cwd: string): Promise<string | undefined> {
        return this.#snapshot(cwd).catch(() => undefined);
    }

    /** @internal for `TurnTrees` */
    get waits(): { start: number; end: number } {
        return { start: this.#startWaitMs, end: this.#endWaitMs };
    }

    /** @internal for `TurnTrees`: where the run's stream is now and what time it is, which is when its turn ended. */
    mark(runId: string): { seq: number; at: number } {
        return { seq: nextSeq(this.store.db, runId) - 1, at: this.#now() };
    }

    /** @internal for `TurnTrees`: keeps what the turn changed on the chat (or forgets the earlier turn's), and publishes the chat when that changed it. */
    keep(
        chatId: string,
        trees: Pick<ChatLastRun, 'startTree' | 'endTree'> | undefined,
        mark: { seq: number; at: number }
    ): void {
        const { store } = this;

        try {
            store.tx(() => {
                const before = getChatLastRun(store.db, chatId);
                const lastRun: ChatLastRun | undefined = trees && { ...trees, ...mark };

                // A turn whose snapshot came in late (past its wait) and a newer turn that has already kept its own: the newer one stays.
                if ((before && before.at > mark.at) || (!before && !lastRun)) return;

                setChatLastRun(store.db, chatId, lastRun);

                const chat = getChat(store.db, chatId);

                if (chat) store.emit(chat.projectId, { type: 'chat.upserted', chat });
            });
        } catch {
            // The chat or the database went while the snapshot was made (the daemon stops, the chat is deleted): there is nothing left to keep it on.
        }
    }
}

/** The trees around one turn: see `TurnSnapshots`. */
export class TurnTrees {
    readonly #start: Promise<string | undefined>;
    #finished?: Promise<void>;

    /** @internal made by `TurnSnapshots.begin` */
    constructor(
        private readonly owner: TurnSnapshots,
        private readonly chatId: string,
        private readonly runId: string,
        readonly cwd: string
    ) {
        this.#start = owner.take(cwd);
    }

    /** Resolves once the start tree is made, or after `START_WAIT_MS`, whatever the snapshot has come to. Never rejects. */
    async started(): Promise<void> {
        await within(this.#start, this.owner.waits.start);
    }

    /**
     * Ends the turn: takes the second tree, keeps the pair on the chat when they differ and forgets the chat's earlier record when they do not (or when either could not be made),
     * and resolves when that is done or after `END_WAIT_MS`, whichever comes first; the work goes on by itself past that, and the chat is published when it is done. Asked again,
     * it is the first answer. Never rejects.
     */
    end(): Promise<void> {
        if (!this.#finished) {
            try {
                // Where the stream was when the turn ended, not when the second tree is done: a message the person writes meanwhile is newer than the turn.
                this.#finished = this.#finish(this.owner.mark(this.runId));
            } catch {
                // The run or the database is gone (the daemon is stopping): nothing to keep the trees on.
                this.#finished = Promise.resolve();
            }
        }

        return within(this.#finished, this.owner.waits.end);
    }

    async #finish(mark: { seq: number; at: number }): Promise<void> {
        const startTree = await this.#start;
        // A turn that could not be measured at its start is not measured at its end either: one failed attempt (not a repository, git gone) is not tried twice.
        const endTree = startTree === undefined ? undefined : await this.owner.take(this.cwd);

        this.owner.keep(
            this.chatId,
            startTree !== undefined && endTree !== undefined && startTree !== endTree
                ? { startTree, endTree }
                : undefined,
            mark
        );
    }
}
