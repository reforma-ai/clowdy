import { errorMessage } from '@clowdy/lib';
import { makeAutoObservable, runInAction } from 'mobx';

import type { FolderId, ProjectId, TerminalInfo } from '@clowdy/protocol';
import type { TerminalStreamStatus } from '../../daemon/terminalStream';
import type { Transport } from '../../daemon/transport';

/** The size a terminal is made at, before the window has measured the place it is shown in; the view fits it right after. */
export const FIRST_SIZE = { cols: 80, rows: 24 };

/** What the window holds for a terminal while it lives here: ended with the session, when the terminal is closed or gone. */
export interface TerminalViewHandle {
    dispose: () => void;
}

/** A shell of the daemon as this window knows it. */
export class TerminalSession {
    info: TerminalInfo;
    status: TerminalStreamStatus = 'connecting';
    /** Set by the view that draws the terminal (the one with the xterm, which is not loaded until the tab is first shown). */
    view: TerminalViewHandle | undefined;

    constructor(info: TerminalInfo) {
        this.info = info;
        makeAutoObservable(this, { view: false }, { autoBind: true });
    }

    get id(): string {
        return this.info.id;
    }

    get isRunning(): boolean {
        return this.info.state === 'running';
    }

    update(info: Partial<Pick<TerminalInfo, 'cols' | 'rows' | 'state' | 'exitCode'>>): void {
        Object.assign(this.info, info);
    }

    setStatus(status: TerminalStreamStatus): void {
        this.status = status;
    }
}

const keyOf = (projectId: ProjectId, folderId: FolderId) => `${ projectId }/${ folderId }`;

/**
 * The terminals the window shows: every shell the daemon runs for the projects it has been asked about, grouped by the folder each runs in. The daemon owns them,
 * so a reloaded window asks (`load`) and finds the same shells with their screens. The store knows nothing of xterm; the view that draws a session is kept with it.
 */
export class TerminalsStore {
    sessions: TerminalSession[] = [];
    /** The terminal each folder shows, by `projectId/folderId`; the last one made when a folder has not chosen. */
    chosen = new Map<string, string>();
    error = '';
    readonly #loaded = new Map<ProjectId, Promise<void>>();
    /** The folders whose empty tab already got its first shell: closing the last one leaves the tab empty rather than starting another. */
    readonly #started = new Set<string>();

    constructor(readonly transport: Pick<Transport, 'listTerminals' | 'createTerminal' | 'closeTerminal' | 'openTerminal'>) {
        makeAutoObservable<TerminalsStore, 'transport'>(this, { transport: false });
    }

    sessionsOf(projectId: ProjectId, folderId: FolderId): TerminalSession[] {
        return this.sessions.filter(session => session.info.projectId === projectId && session.info.folderId === folderId);
    }

    activeOf(projectId: ProjectId, folderId: FolderId): TerminalSession | undefined {
        const sessions = this.sessionsOf(projectId, folderId);
        const chosen = this.chosen.get(keyOf(projectId, folderId));

        return sessions.find(session => session.id === chosen) ?? sessions[sessions.length - 1];
    }

    select(session: TerminalSession): void {
        this.chosen.set(keyOf(session.info.projectId, session.info.folderId), session.id);
    }

    /** Whether the project's terminals were read from the daemon yet. */
    isLoaded(projectId: ProjectId): boolean {
        return this.#loaded.has(projectId);
    }

    /** Reads the project's shells from the daemon, once; a second ask waits for the first. A failure is kept in `error` and the next ask tries again. */
    load(projectId: ProjectId): Promise<void> {
        let loading = this.#loaded.get(projectId);

        if (!loading) {
            loading = this.#read(projectId).catch((error: unknown) => {
                this.#loaded.delete(projectId);
                runInAction(() => {
                    this.error = errorMessage(error);
                });
            });
            this.#loaded.set(projectId, loading);
        }

        return loading;
    }

    /** Makes the folder's first shell when it has none and never had one in this window: opening the tab gives a prompt. */
    async ensureOne(projectId: ProjectId, folderId: FolderId): Promise<void> {
        const key = keyOf(projectId, folderId);

        if (this.#started.has(key)) return;

        this.#started.add(key);

        if (this.sessionsOf(projectId, folderId).length === 0) await this.start(projectId, folderId);
    }

    /** Starts a shell in the folder, or in a folder below it, and chooses it. */
    async start(projectId: ProjectId, folderId: FolderId, path?: string): Promise<TerminalSession | undefined> {
        try {
            const info = await this.transport.createTerminal({ projectId, folderId, ...(path ? { path } : {}), ...FIRST_SIZE });

            return runInAction(() => {
                this.error = '';

                const session = this.#adopt(info);

                this.select(session);

                return session;
            });
        }
        catch (error) {
            runInAction(() => {
                this.error = errorMessage(error);
            });

            return undefined;
        }
    }

    /** Ends the shell and forgets it. */
    async close(session: TerminalSession): Promise<void> {
        this.forget(session);

        try {
            await this.transport.closeTerminal(session.id);
        }
        catch (error) {
            runInAction(() => {
                this.error = errorMessage(error);
            });
        }
    }

    /** Drops a terminal the daemon no longer has, or that was closed here. */
    forget(session: TerminalSession): void {
        session.view?.dispose();
        session.view = undefined;
        this.sessions = this.sessions.filter(candidate => candidate !== session);
    }

    /** Ends every view and forgets everything. */
    dispose(): void {
        for (const session of this.sessions) session.view?.dispose();

        this.sessions = [];
        this.chosen.clear();
        this.#loaded.clear();
        this.#started.clear();
    }

    async #read(projectId: ProjectId): Promise<void> {
        const infos = await this.transport.listTerminals(projectId);

        runInAction(() => {
            this.error = '';

            const present = new Set(infos.map(info => info.id));

            for (const gone of this.sessions.filter(session => session.info.projectId === projectId && !present.has(session.id))) this.forget(gone);

            for (const info of infos) this.#adopt(info);
        });
    }

    /** The session of a terminal: the one already held, brought up to date, or a new one. */
    #adopt(info: TerminalInfo): TerminalSession {
        const held = this.sessions.find(session => session.id === info.id);

        if (held) {
            held.update(info);

            return held;
        }

        const session = new TerminalSession(info);

        this.sessions.push(session);

        return session;
    }
}
