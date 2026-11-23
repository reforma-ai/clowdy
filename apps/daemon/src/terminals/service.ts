import { isTerminalSize, MAX_TERMINALS } from '@clowdy/protocol';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CommandError, conflict, errorMessage, invalid, notFound, unavailable } from '../errors';
import { isInside, normalizeFsPath, outside } from '../fs/paths';
import { newId } from '../ids';
import { spawnPty } from './pty';
import { TerminalSession } from './session';
import { resolveShell, terminalEnvironment } from './shell';

import type { Project, TerminalCreate, TerminalInfo } from '@clowdy/protocol';
import type { Place } from '../domain/places';
import type { SpawnPty } from './pty';
import type { Shell } from './shell';

/** A shell that ended stays listed this long, so that a window that comes back still reads what it printed last. */
const EXITED_TTL_MS = 30 * 60_000;
const SWEEP_MS = 60_000;

export interface TerminalServiceOptions {
    /** The program a terminal runs; the person's own shell. */
    shell?: () => Shell;
    /** What a shell inherits; the daemon's own environment. */
    env?: () => Record<string, string | undefined>;
    /** Starts the program on a PTY; Bun's. */
    spawn?: SpawnPty;
    maxTerminals?: number;
    exitedTtlMs?: number;
}

/**
 * The shells the daemon runs for its clients. They belong to the daemon, not to a connection: they live until they are closed, they exit, or the daemon
 * stops, and a client can come and go.
 */
export class TerminalService {
    readonly #sessions = new Map<string, TerminalSession>();
    readonly #options: TerminalServiceOptions;
    readonly #sweeper: ReturnType<typeof setInterval>;

    constructor(options: TerminalServiceOptions = {}) {
        this.#options = options;
        this.#sweeper = setInterval(() => this.#sweep(), SWEEP_MS);
        this.#sweeper.unref?.();
    }

    /**
     * Starts a shell in the folder, or below it at `request.path`. With a `place` (`resolvePlace`'s answer for the request's folder and workspace) that is a worktree, the
     * shell starts in the worktree and the terminal says so (`workspaceId`), in place of the folder's own checkout: a project's terminals are told apart by folder and
     * workspace. The place is the caller's to have judged, as the folder lookup is here for a request without one.
     */
    create(project: Project, request: TerminalCreate, place?: Place): TerminalInfo {
        if (!isTerminalSize(request.cols, request.rows)) {
            throw invalid('The size of the terminal is not one a terminal can have');
        }

        const limit = this.#options.maxTerminals ?? MAX_TERMINALS;

        if ([...this.#sessions.values()].filter(session => session.isRunning).length >= limit) {
            throw conflict(`This machine already runs ${ limit } terminals`, { reason: 'limit' });
        }

        // A worktree asked for and not judged would start the shell in the folder's own checkout under the worktree's name.
        if (request.workspaceId && place?.workspace?.id !== request.workspaceId) {
            throw invalid('The worktree of the terminal was not resolved');
        }

        const folder = place?.folder ?? project.folders.find(candidate => candidate.id === request.folderId);

        if (!folder) {
            throw notFound('Folder', request.folderId);
        }

        const session = new TerminalSession(newId('trm'), {
            projectId: project.id,
            folderId: folder.id,
            ...(place?.workspace && { workspaceId: place.workspace.id }),
            cwd: directoryIn(place?.path ?? folder.path, request.path, place?.workspace ? 'worktree' : 'folder'),
            shell: (this.#options.shell ?? resolveShell)(),
            env: terminalEnvironment(this.#options.env?.() ?? process.env),
            cols: request.cols,
            rows: request.rows,
        });

        try {
            session.start(this.#options.spawn ?? spawnPty);
        }
        catch (error) {
            session.dispose();

            throw unavailable(`The shell could not be started: ${ errorMessage(error) }`);
        }

        this.#sessions.set(session.id, session);

        return session.info();
    }

    /** Running terminals and recently exited ones, oldest first; those of one project when it is named. */
    list(projectId?: string): TerminalInfo[] {
        return [...this.#sessions.values()]
            .filter(session => projectId === undefined || session.spec.projectId === projectId)
            .map(session => session.info());
    }

    find(id: string): TerminalSession | undefined {
        return this.#sessions.get(id);
    }

    require(id: string): TerminalSession {
        const session = this.find(id);

        if (!session) {
            throw notFound('Terminal', id);
        }

        return session;
    }

    /** Ends the shell and forgets the terminal. */
    remove(id: string): void {
        this.require(id).dispose();
        this.#sessions.delete(id);
    }

    /** Ends every shell: the daemon is stopping. */
    stop(): void {
        clearInterval(this.#sweeper);

        for (const session of this.#sessions.values()) {
            session.dispose();
        }

        this.#sessions.clear();
    }

    #sweep(): void {
        const ttl = this.#options.exitedTtlMs ?? EXITED_TTL_MS;

        for (const [id, session] of this.#sessions) {
            if (session.endedAt !== undefined && Date.now() - session.endedAt > ttl) {
                session.dispose();
                this.#sessions.delete(id);
            }
        }
    }
}

/** The real path of the project folder (or of its worktree, `what` saying which), or of a folder below it, which must be a folder that is there and that no link leads out of. */
function directoryIn(root: string, path = '', what: 'folder' | 'worktree' = 'folder'): string {
    let base: string;

    try {
        base = realpathSync(root);
    }
    catch {
        throw unavailable(`The ${ what } ${ root } is missing`);
    }

    const wanted = join(base, normalizeFsPath(path));
    let real: string;

    try {
        real = realpathSync(wanted);
    }
    catch {
        throw new CommandError('not_found', `${ path } does not exist`, { path });
    }

    if (!isInside(base, real)) {
        throw outside('The path leads out of the folder');
    }

    if (!statSync(real).isDirectory()) {
        throw invalid(`${ path } is not a folder`, { path });
    }

    return real;
}
