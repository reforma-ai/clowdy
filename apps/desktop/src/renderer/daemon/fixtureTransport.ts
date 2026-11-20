import { folderNames, isBusyRunStatus, isTerminalRunStatus, mainFolder, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_BYTES_PER_MESSAGE, STOPPED_TOOL } from '@clowdy/protocol';

import {
    catalogTokens,
    createFixtureData,
    DEFAULT_STATUSES,
    docHash,
    docsTree,
    FIXTURE_LIVE_RUN_ID,
    FIXTURE_LIVE_TEXT_ID,
    FIXTURE_LIVE_TOOL_ID,
    type FixtureData,
} from './fixtureData';
import { TransportError, type CommandInput, type FeedStatus, type StreamTarget, type Transport } from './transport';

import type {
    AgentInfo,
    AgentModels,
    AgentOverrides,
    Attachment,
    Chat,
    ClowdyEvent,
    CommandResult,
    DocFile,
    DocsTree,
    ErrorCode,
    EventData,
    FolderId,
    Project,
    ProjectFileMatch,
    ProjectId,
    ProjectInfo,
    ProjectSnapshot,
    QueuedMessage,
    QueuedMessageMode,
    RootSnapshot,
    Run,
    RunId,
    SkillCatalog,
    StreamItem,
    StreamItemBody,
    Task,
    TaskDetail,
    TaskId,
    ThreadNotice,
} from '@clowdy/protocol';

export interface FixtureTransportOptions {
    /** Starts from other data. Tests use this. */
    data?: FixtureData;
    /** Events nobody asked for (a tool finishing, text streaming in) after the first subscription. */
    timeline?: boolean;
}

/** What the fixture keeps of a file: its bytes, and whether a message carries it already. */
interface StoredFile {
    projectId: ProjectId;
    attachment: Attachment;
    blob: Blob;
    sent: boolean;
}

/** Where the fixture's programs are found when a path override is cleared. */
const FIXTURE_PROGRAMS: Record<string, string> = {
    claude: '/Users/dev/.local/bin/claude',
    codex: '/opt/homebrew/bin/codex',
    cursor: '/Users/dev/.local/bin/cursor-agent',
};

/** The sign-in link each fixture agent prints, and when the scripted sign-in prints it and ends. */
const FIXTURE_SIGN_IN_LINKS: Record<string, string> = {
    claude: 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code',
    codex: 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73',
    cursor: 'https://cursor.com/loginDeepControl?challenge=3f9c1e&mode=login',
};
const SIGN_IN_LINK_MS = 400;
const SIGN_IN_DONE_MS = 4000;
/** How long a turn the fixture starts lasts, and how long its agent takes to take a steer. */
const TURN_MS = 1400;
const STEER_MS = 800;
/** How long the fixture's agent takes to compact its context, and what the queue shows for a Compact pressed while it works. */
const COMPACT_MS = 1200;
const COMPACT_TEXT = 'Compact the conversation';

const isCompact = (item: QueuedMessage) => item.command === 'compact';
const REPLY = 'Got it. I will split this into tasks, start the independent ones in parallel, and report back here.';
/** What the fixture's agent says when it is told that threads stopped. */
const NOTICE_REPLY = 'Noted. I will look at what the thread found and carry on.';
/** How much of a thread's last words its parent is told. */
const NOTICE_TEXT_MAX = 600;

/** The words of a notice's outcome, as the queue's summary says them. */
const OUTCOME_SUMMARY: Record<ThreadNotice['outcome'], string> = { finished: 'finished', failed: 'failed', interrupted: 'was interrupted' };

/** The one line a queued notice shows: `Thread "Fix login" finished`, or how many threads stopped. */
function noticeSummary(threads: readonly ThreadNotice[]): string {
    if (threads.length === 1) return `Thread "${ threads[0].title }" ${ OUTCOME_SUMMARY[threads[0].outcome] }`;

    return `${ threads.length } threads stopped`;
}

/** The stream item a queued message becomes when the agent gets it: a notice has no words of its own, a thread's message keeps its sender. */
function userBody(item: QueuedMessage): StreamItemBody {
    const text = item.from?.kind === 'threadNotice' ? '' : item.text;

    return { kind: 'user', text, ...(item.attachments && { attachments: item.attachments }), ...(item.from && { from: item.from }) };
}

/** Puts a message at the end of its own kind (or at `index` in it), the steers before the next turns, as the daemon does. */
function placeQueued(queue: readonly QueuedMessage[], item: QueuedMessage, index?: number): QueuedMessage[] {
    const others = queue.filter(entry => entry.id !== item.id);
    const steers = others.filter(entry => entry.mode === 'steer');
    const turns = others.filter(entry => entry.mode !== 'steer');
    const part = item.mode === 'steer' ? steers : turns;

    part.splice(Math.min(index ?? part.length, part.length), 0, item);

    return [...steers, ...turns];
}

/** The overrides of an agent without the parts that are not set, or none at all when nothing is left. */
function withoutEmpty(overrides: AgentOverrides): AgentOverrides | undefined {
    const { path, env } = overrides;

    return path === undefined && env === undefined ? undefined : { ...(path !== undefined && { path }), ...(env !== undefined && { env }) };
}

type Outcome = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };

/** What a field becomes when a command may name it: the value it names, nothing for `null`, and `kept` when the command leaves it out. */
const named = <T>(change: T | null | undefined, kept: T | undefined): T | undefined => (change === undefined ? kept : change ?? undefined);

const ok = (data: unknown = {}): Outcome => ({ ok: true, data });
const fail = (code: ErrorCode, message: string, details?: unknown): Outcome => ({ ok: false, error: { code, message, details } });

/**
 * A daemon in memory: scripted data in the shape of the protocol, and commands that change it and announce the
 * change as events, so the UI is interactive without a daemon. Not a model of the real daemon's rules.
 */
export class FixtureTransport implements Transport {
    readonly #data: FixtureData;
    readonly #timeline: boolean;
    readonly #log: ClowdyEvent[] = [];
    readonly #subscribers = new Set<(event: ClowdyEvent) => void>();
    #cursor = 1000;
    #idCounter = 100;
    #timelineStarted = false;
    readonly #files = new Map<string, StoredFile>();
    /** The turn each run is on, so the end of an older turn does not end a newer one. */
    readonly #turns = new Map<RunId, number>();

    constructor({ data = createFixtureData(), timeline = false }: FixtureTransportOptions = {}) {
        this.#data = data;
        this.#timeline = timeline;

        for (const { projectId, attachment, content } of data.attachments) {
            this.#files.set(attachment.id, { projectId, attachment, blob: new Blob([content], { type: attachment.mediaType }), sent: true });
        }
    }

    async getRootSnapshot(): Promise<RootSnapshot> {
        return structuredClone({ cursor: this.#cursor, projects: this.#listed() });
    }

    async getProjectsInfo(): Promise<ProjectInfo[]> {
        const { chats, tasks, git } = this.#data;

        return structuredClone(this.#listed().map(project => ({
            projectId: project.id,
            folders: project.folders.map(folder => ({ folderId: folder.id, exists: true, ...git[folder.path] })),
            chats: chats.filter(chat => chat.projectId === project.id).length,
            tasks: tasks.filter(task => task.projectId === project.id).length,
            activeRuns: this.#activeRuns(project.id),
        })));
    }

    async getProjectSnapshot(projectId: ProjectId): Promise<ProjectSnapshot> {
        const project = this.#project(projectId);
        const data = this.#data;
        const chatIds = new Set(data.chats.filter(chat => chat.projectId === projectId).map(chat => chat.id));
        const runIds = new Set(data.runs.filter(run => run.projectId === projectId).map(run => run.id));

        return structuredClone({
            cursor: this.#cursor,
            project,
            statuses: data.statuses[projectId] ?? DEFAULT_STATUSES,
            chats: data.chats.filter(chat => chat.projectId === projectId),
            tasks: data.tasks.filter(task => task.projectId === projectId),
            runs: data.runs.filter(run => run.projectId === projectId),
            chatTaskLinks: data.chatTaskLinks.filter(link => chatIds.has(link.chatId)),
            runTaskLinks: data.runTaskLinks.filter(link => runIds.has(link.runId)),
        });
    }

    subscribe(cursor: number, onEvent: (event: ClowdyEvent) => void, onStatus: (status: FeedStatus) => void): () => void {
        let active = true;
        // Events arrive on their own turn, as they would over the network.
        const deliver = (event: ClowdyEvent) => queueMicrotask(() => active && onEvent(event));

        this.#subscribers.add(deliver);
        this.#log.filter(event => event.cursor > cursor).forEach(deliver);
        queueMicrotask(() => active && onStatus('connected'));

        if (this.#timeline && !this.#timelineStarted) {
            this.#timelineStarted = true;
            this.#runTimeline();
        }

        return () => {
            active = false;
            this.#subscribers.delete(deliver);
        };
    }

    async command(command: CommandInput): Promise<CommandResult> {
        const requestId = crypto.randomUUID();
        const outcome = this.#apply(command);

        return outcome.ok ? { ok: true, requestId, data: outcome.data } : { ok: false, requestId, error: outcome.error };
    }

    async getItems(target: StreamTarget, afterSeq = 0): Promise<StreamItem[]> {
        const runId = 'runId' in target ? target.runId : this.#data.chats.find(chat => chat.id === target.chatId)?.orchestratorRunId;

        return structuredClone((runId ? this.#data.items[runId] ?? [] : []).filter(item => item.seq > afterSeq));
    }

    async getTaskDetail(taskId: TaskId): Promise<TaskDetail> {
        const data = this.#data;

        return structuredClone({
            taskId,
            chatIds: data.chatTaskLinks.filter(link => link.taskId === taskId).map(link => link.chatId),
            runIds: data.runTaskLinks.filter(link => link.taskId === taskId).map(link => link.runId),
            artifacts: data.artifacts.filter(artifact => artifact.taskId === taskId),
        });
    }

    async getDocsTree(projectId: ProjectId): Promise<DocsTree> {
        // Every fixture folder exists; one without a docs folder has no documents, and reading does not make one.
        return this.#project(projectId).folders.map(folder => ({ folderId: folder.id, nodes: docsTree(Object.keys(this.#data.docs[folder.path] ?? {})) }));
    }

    async getDocFile(projectId: ProjectId, folderId: FolderId, path: string): Promise<DocFile> {
        const folder = this.#project(projectId).folders.find(candidate => candidate.id === folderId);

        if (!folder) throw new TransportError(`No such folder: ${ folderId }`, 404);

        const content = this.#data.docs[folder.path]?.[path];

        if (content === undefined) throw new TransportError(`No such file: ${ path }`, 404);

        return { path, content, hash: docHash(content) };
    }

    async getProjectFiles(projectId: ProjectId, query: string, limit = 40): Promise<ProjectFileMatch[]> {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const project = this.#data.projects.find(candidate => candidate.id === projectId);

        if (!project) return [];

        // Like the daemon: every folder's files, the folder's name counting as part of the path when there are several.
        const names = folderNames(project.folders);
        const several = project.folders.length > 1;
        const found = project.folders.flatMap((folder, index) => (this.#data.files[folder.path] ?? []).map(path => ({ folderId: folder.id, path, searched: several ? `${ names[index] }/${ path }` : path })));

        return found.filter(file => words.every(word => file.searched.toLowerCase().includes(word))).slice(0, limit).map(({ folderId, path }) => ({ folderId, path }));
    }

    async uploadAttachment(projectId: ProjectId, file: File): Promise<Attachment> {
        this.#project(projectId);

        if (file.size > MAX_ATTACHMENT_BYTES) throw new TransportError(`${ file.name } is over the size limit`, 413);

        const attachment: Attachment = { id: this.#id('a'), name: file.name, mediaType: file.type || 'application/octet-stream', size: file.size };

        this.#files.set(attachment.id, { projectId, attachment, blob: file, sent: false });

        return structuredClone(attachment);
    }

    async getAttachment(projectId: ProjectId, attachmentId: string): Promise<Blob> {
        const stored = this.#files.get(attachmentId);

        if (stored?.projectId !== projectId) throw new TransportError('No such attachment', 404);

        return stored.blob;
    }

    async getProjectIcon(projectId: ProjectId): Promise<Blob | undefined> {
        const project = this.#data.projects.find(candidate => candidate.id === projectId);
        // Like the daemon: the main folder's icon, and none for the personal space.
        const svg = project && !project.personal ? this.#data.icons[mainFolder(project).path] : undefined;

        return svg === undefined ? undefined : new Blob([svg], { type: 'image/svg+xml' });
    }

    async deleteAttachment(projectId: ProjectId, attachmentId: string): Promise<void> {
        const stored = this.#files.get(attachmentId);

        if (stored?.projectId !== projectId) throw new TransportError('No such attachment', 404);

        if (stored.sent) throw new TransportError('The file was sent already', 409);

        this.#files.delete(attachmentId);
    }

    async getSkills(projectId?: ProjectId): Promise<SkillCatalog> {
        if (projectId !== undefined) this.#project(projectId);

        const entries = this.#data.skills.filter(skill => skill.projectId === undefined || skill.projectId === projectId).map(({ projectId: _projectId, ...entry }) => entry);

        return structuredClone({ entries, tokens: catalogTokens(entries), warnings: this.#data.skillWarnings });
    }

    async getAgents(): Promise<AgentInfo[]> {
        return structuredClone(this.#data.agents);
    }

    async getAgentModels(agentId: string): Promise<AgentModels> {
        return structuredClone(this.#data.agentModels[agentId] ?? { state: 'unavailable', models: [], detail: `Clowdy cannot list the models of ${ agentId }` });
    }

    /* --------------------------------- Events --------------------------------- */

    #emit(projectId: ProjectId, data: EventData): void {
        const event: ClowdyEvent = structuredClone({ cursor: ++this.#cursor, at: Date.now(), projectId, data });

        this.#log.push(event);
        this.#subscribers.forEach(deliver => deliver(event));
    }

    /** Tells every project's clients to refetch the agents, as the daemon does. */
    #agentsChanged(): void {
        this.#data.projects.forEach(project => this.#emit(project.id, { type: 'agents.changed' }));
    }

    #later(ms: number, action: () => void): void {
        setTimeout(action, ms);
    }

    #id(prefix: string): string {
        return `${ prefix }-${ ++this.#idCounter }`;
    }

    #project(projectId: ProjectId): Project {
        const project = this.#data.projects.find(candidate => candidate.id === projectId);

        if (!project) throw new TransportError(`No such project: ${ projectId }`, 404);

        return project;
    }

    /** The daemon refuses an agent it does not know when a chat is made or changed; one that is switched off waits for the first message. */
    #refuseEngine(engine: string | undefined): Outcome | undefined {
        return engine && !this.#data.agents.some(agent => agent.id === engine) ? fail('unavailable', `The ${ engine } engine is not available in this daemon`) : undefined;
    }

    #saveRun(run: Run): void {
        this.#emit(run.projectId, { type: 'run.upserted', run });
    }

    #saveTask(task: Task): void {
        this.#emit(task.projectId, { type: 'task.upserted', task });
    }

    /** Adds or replaces a stream item (by id) and announces it. */
    #saveItem(run: Run, item: StreamItem): void {
        const items = this.#data.items[run.id] ??= [];
        const index = items.findIndex(candidate => candidate.id === item.id);

        if (index === -1) items.push(item);
        else items[index] = item;

        this.#emit(run.projectId, { type: 'stream.item', item });
    }

    #appendItem(run: Run, body: StreamItemBody): StreamItem {
        const items = this.#data.items[run.id] ??= [];
        const seq = (items.at(-1)?.seq ?? 0) + 1;
        const item = { id: `${ run.id }-${ seq }`, runId: run.id, seq, at: Date.now(), body };

        this.#saveItem(run, item);

        return item;
    }

    /** Streams a reply into one item in three steps, the way an engine's text arrives. */
    #streamReply(run: Run, text: string): void {
        const words = text.split(' ');
        const cut = (share: number) => words.slice(0, Math.ceil(words.length * share)).join(' ');
        const item = this.#appendItem(run, { kind: 'assistant', text: cut(0.3), done: false });

        this.#later(350, () => this.#saveItem(run, { ...item, body: { kind: 'assistant', text: cut(0.7), done: false } }));
        this.#later(700, () => this.#saveItem(run, { ...item, body: { kind: 'assistant', text, done: true } }));
    }

    #agent(id: string): AgentInfo | undefined {
        return this.#data.agents.find(agent => agent.id === id);
    }

    #updateAgent({ id, enabled, settings, path, env }: Extract<CommandInput, { type: 'agent.update' }>): Outcome {
        const agent = this.#agent(id);

        if (!agent) return fail('not_found', `There is no agent called "${ id }"`);

        if (enabled !== undefined) {
            agent.enabled = enabled;

            // A program that is not there stays not there; only a ready agent and a switched-off one trade places.
            if (agent.status === 'ready' || agent.status === 'disabled') agent.status = enabled ? 'ready' : 'disabled';
        }

        for (const [settingId, value] of Object.entries(settings ?? {})) {
            const setting = agent.settings?.find(candidate => candidate.id === settingId);

            if (!setting) return fail('invalid', `${ agent.name } has no setting called "${ settingId }"`);

            setting.value = value;
        }

        // What the person changed about how the agent starts, kept as the daemon keeps it: a path they chose (`null` goes
        // back to looking for the program) and the variables, which replace the saved set.
        if (path === null) {
            agent.path = FIXTURE_PROGRAMS[id];
            agent.overrides = withoutEmpty({ ...agent.overrides, path: undefined });
        }
        else if (path !== undefined) {
            agent.path = path;
            agent.overrides = { ...agent.overrides, path };
        }

        if (env !== undefined) agent.overrides = withoutEmpty({ ...agent.overrides, env });

        this.#agentsChanged();

        return ok({ id });
    }

    /** A sign-in that starts, prints its link, and ends a few seconds later with the agent signed in. */
    #startSignIn(id: string): Outcome {
        const agent = this.#agent(id);

        if (!agent) return fail('not_found', `There is no agent called "${ id }"`);

        if (!agent.canSignIn) return fail('invalid', `${ agent.name } has to be signed in from a terminal: ${ agent.login ?? 'see its documentation' }`);

        if (agent.signInSession?.step === 'starting' || agent.signInSession?.step === 'waiting') return fail('conflict', 'A sign-in is already running');

        const startedAt = Date.now();
        const session = { step: 'starting' as const, startedAt };

        agent.signInSession = session;
        this.#agentsChanged();

        const running = () => agent.signInSession?.startedAt === startedAt && (agent.signInSession.step === 'starting' || agent.signInSession.step === 'waiting');

        this.#later(SIGN_IN_LINK_MS, () => {
            if (!running()) return;

            agent.signInSession = { step: 'waiting', startedAt, url: FIXTURE_SIGN_IN_LINKS[id] ?? 'https://example.com/sign-in' };
            this.#agentsChanged();
        });
        this.#later(SIGN_IN_DONE_MS, () => {
            if (!running()) return;

            agent.signInSession = { step: 'done', startedAt };
            agent.signIn = { status: 'signed-in', account: { email: 'dev@example.com', method: 'subscription', plan: agent.signIn?.account?.plan ?? 'Pro' }, checkedAt: Date.now() };
            this.#agentsChanged();
        });

        return ok({ id });
    }

    #cancelSignIn(id: string): Outcome {
        const agent = this.#agent(id);

        if (!agent) return fail('not_found', `There is no agent called "${ id }"`);

        if (agent.signInSession?.step === 'starting' || agent.signInSession?.step === 'waiting') {
            agent.signInSession = { step: 'cancelled', startedAt: agent.signInSession.startedAt, message: 'Sign-in cancelled' };
            this.#agentsChanged();
        }

        return ok({ id });
    }

    #runTimeline(): void {
        const run = this.#data.runs.find(candidate => candidate.id === FIXTURE_LIVE_RUN_ID);
        const items = run && this.#data.items[run.id];
        const tool = items?.find(item => item.id === FIXTURE_LIVE_TOOL_ID);
        const text = items?.find(item => item.id === FIXTURE_LIVE_TEXT_ID);

        if (!run || !tool || !text || tool.body.kind !== 'tool') return;

        const toolBody = tool.body;
        const say = (message: string, done: boolean) => this.#saveItem(run, { ...text, at: Date.now(), body: { kind: 'assistant', text: message, done } });

        this.#later(2500, () => this.#saveItem(run, { ...tool, body: { ...toolBody, state: 'done', output: '0 errors, 0 warnings' } }));
        this.#later(3500, () => say('Checking confirmation handling. The confirmation view reads the saved booking', false));
        this.#later(4500, () => say('Checking confirmation handling. The confirmation view reads the saved booking, so a reload keeps it.', true));
        this.#later(6000, () => {
            const parent = this.#data.runs.find(candidate => candidate.id === run.parentRunId);
            const call = parent && this.#data.items[parent.id]?.find(item => item.body.kind === 'tool' && item.body.toolCallId === run.parentToolCallId);

            // The sub-agent is done: its run ends and the call that started it returns its report, as a session reports a sub-agent.
            if (run.status !== 'running') return;

            run.status = 'succeeded';
            run.result = 'The form is one view now, and the typecheck passes.';
            run.finishedAt = Date.now();
            this.#saveRun(run);

            if (parent && call?.body.kind === 'tool') this.#saveItem(parent, { ...call, body: { ...call.body, state: 'done', output: run.result } });
        });
    }

    /* -------------------------------- Commands -------------------------------- */

    #apply(command: CommandInput): Outcome {
        const data = this.#data;

        switch (command.type) {
            case 'project.add': {
                const paths = command.folders ?? [];

                if (paths.length === 0 && command.name === undefined) return fail('invalid', 'A project without folders needs a name: its new folder is named after it');

                if (new Set(paths).size !== paths.length) return fail('invalid', 'A folder is listed twice');

                const known = paths.length > 0 && data.projects.find(project => project.folders.length === paths.length && project.folders.every(folder => paths.includes(folder.path)));

                if (known) return ok({ project: structuredClone(known), existing: true });

                const name = command.name ?? paths[0]?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project';

                return this.#addProject(name, paths.length > 0 ? paths : [`/Users/dev/Clowdy/projects/${ name.toLowerCase().replace(/\W+/g, '-') }`]);
            }
            case 'project.update': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);

                if (!project) return fail('not_found', 'No such project');

                if (command.folders?.length === 0) return fail('invalid', 'A project needs at least one folder');

                const folders = command.folders?.map(entry => ('id' in entry ? project.folders.find(folder => folder.id === entry.id) : (project.folders.find(folder => folder.path === entry.path) ?? { id: this.#id('fld'), path: entry.path })));

                if (folders?.some(folder => folder === undefined)) return fail('invalid', 'A folder is not one of the project\'s');

                const nextFolders = (folders as Project['folders'] | undefined) ?? project.folders;

                if (new Set(nextFolders.map(folder => folder.path)).size !== nextFolders.length) return fail('invalid', 'A folder is listed twice');

                const renamed = command.name !== undefined && command.name !== project.name;
                const refoldered = nextFolders.map(folder => `${ folder.id }:${ folder.path }`).join('|') !== project.folders.map(folder => `${ folder.id }:${ folder.path }`).join('|');

                if (project.personal && (renamed || refoldered)) return fail('conflict', 'The personal space cannot be renamed or given other folders');

                if (project.personal && command.settings?.icon !== undefined) return fail('conflict', 'The personal space has no icon of its own');

                if (mainFolder({ folders: nextFolders }).id !== mainFolder(project).id && this.#activeRuns(project.id) > 0) return fail('conflict', 'The agents of this project are still working. Stop them first.');

                const settings: Project['settings'] = { ...project.settings };

                for (const [key, value] of Object.entries(command.settings ?? {})) {
                    if (value === null) delete settings[key as keyof Project['settings']];
                    else Object.assign(settings, { [key]: value });
                }

                Object.assign(project, { name: command.name ?? project.name, folders: nextFolders, settings });
                this.#emit(project.id, { type: 'project.upserted', project, statuses: data.statuses[project.id] ?? DEFAULT_STATUSES });

                // Like the daemon: the project's skills come from its folders.
                if (refoldered) this.#emit(project.id, { type: 'skills.changed' });

                // Like the daemon: `{ project }`.
                return ok({ project: structuredClone(project) });
            }
            case 'project.delete': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);

                if (!project) return fail('not_found', 'No such project');

                if (project.personal) return fail('conflict', 'The personal space cannot be removed');

                if (this.#activeRuns(project.id) > 0) return fail('conflict', 'The agents of this project are still working. Stop them first.');

                const runIds = new Set(data.runs.filter(run => run.projectId === project.id).map(run => run.id));

                data.projects = data.projects.filter(candidate => candidate.id !== project.id);
                data.chats = data.chats.filter(chat => chat.projectId !== project.id);
                data.tasks = data.tasks.filter(task => task.projectId !== project.id);
                data.runs = data.runs.filter(run => run.projectId !== project.id);
                data.runTaskLinks = data.runTaskLinks.filter(link => !runIds.has(link.runId));
                data.artifacts = data.artifacts.filter(artifact => artifact.projectId !== project.id);
                runIds.forEach(runId => delete data.items[runId]);
                delete data.statuses[project.id];
                // Not the documents and files: as with the daemon, they live in the folders, which stay (and another project may have them).
                this.#emit(project.id, { type: 'project.deleted' });

                return ok({ projectId: project.id });
            }
            case 'project.reorder': {
                const unknown = command.projectIds.find(id => !data.projects.some(project => project.id === id));

                if (unknown !== undefined) return fail('invalid', `No such project: ${ unknown }`);

                const named = [...new Set(command.projectIds)].flatMap(id => data.projects.find(project => project.id === id && !project.personal) ?? []);
                const rest = data.projects.filter(project => !project.personal && !named.includes(project));
                const ordered = [...data.projects.filter(project => project.personal), ...named, ...rest];

                data.projects = ordered;
                ordered.forEach((project, index) => {
                    if (project.personal || project.position === index) return;

                    project.position = index;
                    this.#emit(project.id, { type: 'project.upserted', project, statuses: data.statuses[project.id] ?? DEFAULT_STATUSES });
                });

                return ok({ projects: structuredClone(ordered) });
            }

            case 'chat.create': {
                const refused = this.#refuseEngine(command.engine);

                if (refused) return refused;

                const now = Date.now();
                const chat: Chat = {
                    id: this.#id('c'),
                    projectId: command.projectId,
                    title: command.title ?? 'New chat',
                    mode: command.mode ?? 'autopilot',
                    ...(command.engine && { engine: command.engine }),
                    ...(command.model && { model: command.model }),
                    ...(command.effort && { effort: command.effort }),
                    createdAt: now,
                    updatedAt: now,
                };

                data.chats.push(chat);
                this.#emit(chat.projectId, { type: 'chat.upserted', chat });

                // Like the daemon: `{ chat }`.
                return ok({ chat: structuredClone(chat) });
            }
            case 'chat.rename':
            case 'chat.setMode': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                if (command.type === 'chat.rename') chat.title = command.title;
                else chat.mode = command.mode;

                chat.updatedAt = Date.now();
                this.#emit(chat.projectId, { type: 'chat.upserted', chat });

                return ok();
            }
            case 'chat.setModel': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                const refused = this.#refuseEngine(command.engine);

                if (refused) return refused;

                // The daemon's rules (`setChatModel`): the provider is fixed by the first message, another provider brings its own models, a new model its own levels.
                const switched = (command.engine ?? chat.engine) !== chat.engine;

                if (switched && chat.orchestratorRunId) return fail('conflict', 'The provider of a chat is fixed once its first message was sent');

                const model = named(command.model, switched ? undefined : chat.model);
                const effort = named(command.effort, switched || model !== chat.model ? undefined : chat.effort);

                // Nothing changes silently: a call that changes nothing announces nothing and does not move the chat up the list.
                if (switched || model !== chat.model || effort !== chat.effort) {
                    delete chat.model;
                    delete chat.effort;

                    if (command.engine) chat.engine = command.engine;
                    if (model) chat.model = model;
                    if (effort) chat.effort = effort;

                    chat.updatedAt = Date.now();
                    this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                }

                // The orchestrator's next turn reads its own row.
                const run = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

                if (run && (run.model !== chat.model || run.effort !== chat.effort)) {
                    delete run.model;
                    delete run.effort;

                    if (chat.model) run.model = chat.model;
                    if (chat.effort) run.effort = chat.effort;

                    this.#saveRun(run);
                }

                return ok({ chat: structuredClone(chat) });
            }
            case 'chat.compact': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                const run = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

                if (!run) return fail('invalid', 'This chat has no conversation to compact yet');

                // Only these agents have a command of their own to compact the conversation.
                if (run.engine !== 'claude' && run.engine !== 'codex') {
                    return fail('invalid', `${ data.agents.find(agent => agent.id === run.engine)?.name ?? run.engine } has no command to compact its conversation`);
                }

                // While the orchestrator works, Compact waits in the queue until it has finished; asking again changes nothing.
                if (!isTerminalRunStatus(run.status)) {
                    if (!chat.queue?.some(isCompact)) {
                        chat.queue = placeQueued(chat.queue ?? [], { id: this.#id('q'), mode: 'queue', command: 'compact', text: COMPACT_TEXT, content: '/compact', createdAt: Date.now() });
                        this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                    }

                    return ok({ chatId: chat.id, runId: run.id });
                }

                // A compact item that waited in a held queue is this same request.
                if (chat.queue?.some(isCompact)) {
                    this.#setQueue(chat, chat.queue.filter(item => !isCompact(item)));
                    this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                }

                this.#startCompact(chat, run);

                return ok({ chatId: chat.id, runId: run.id });
            }
            case 'chat.setArchived': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                if (command.archived && chat.archivedAt === undefined) {
                    const threads = this.#threadsBelow(chat);

                    if (this.#isChatBusy(chat)) return fail('conflict', 'The agents of this chat are still working. Stop the chat first.');

                    if (threads.some(thread => this.#isChatBusy(thread))) return fail('conflict', 'A thread of this chat is still working. Stop it first.');

                    // Like the daemon: the threads go with it, each before its parent, so no thread is ever listed without its parent.
                    const now = Date.now();

                    for (const archived of [...threads.filter(thread => thread.archivedAt === undefined).reverse(), chat]) {
                        archived.archivedAt = now;
                        this.#emit(archived.projectId, { type: 'chat.upserted', chat: archived });
                    }
                }
                else if (!command.archived && chat.archivedAt !== undefined) {
                    delete chat.archivedAt;
                    this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                }

                return ok({ chat: structuredClone(chat) });
            }
            case 'chat.delete': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                // Like the daemon: the threads below go with it, archived ones too, once no agent of any of them works.
                const gone = [...this.#threadsBelow(chat).reverse(), chat];

                if (gone.some(candidate => this.#isChatBusy(candidate))) return fail('conflict', 'The agents of this chat or of its threads are still working. Stop them first.');

                for (const deleted of gone) {
                    const runIds = new Set(this.#runsOfChat(deleted).map(run => run.id));

                    data.chats = data.chats.filter(candidate => candidate.id !== deleted.id);
                    data.runs = data.runs.filter(run => !runIds.has(run.id));
                    data.chatTaskLinks = data.chatTaskLinks.filter(link => link.chatId !== deleted.id);
                    data.runTaskLinks = data.runTaskLinks.filter(link => !runIds.has(link.runId));
                    runIds.forEach(runId => delete data.items[runId]);
                    this.#emit(deleted.projectId, { type: 'chat.deleted', chatId: deleted.id, runIds: [...runIds] });
                }

                return ok({ chatId: chat.id });
            }
            case 'chat.send':
                return this.#sendMessage(command.chatId, command.text, command.attachmentIds ?? [], command.mode ?? 'queue');
            case 'chat.removeQueued':
                return this.#removeQueued(command.chatId, command.itemId, command.keepFiles === true);
            case 'chat.moveQueued':
                return this.#changeQueued(command.chatId, command.itemId, (chat, item) => placeQueued(chat.queue ?? [], item, command.index));
            case 'chat.sendQueued':
                return this.#sendQueued(command.chatId, command.itemId);

            case 'task.create': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);

                if (!project) return fail('not_found', 'No such project');

                const number = Math.max(0, ...data.tasks.filter(task => task.projectId === project.id).map(task => task.number)) + 1;
                const now = Date.now();
                const task: Task = {
                    id: this.#id('t'),
                    projectId: project.id,
                    number,
                    key: `${ project.taskPrefix }-${ number }`,
                    title: command.title,
                    description: command.description ?? '',
                    statusId: command.statusId ?? 'todo',
                    dependsOn: command.dependsOn ?? [],
                    createdBy: { kind: 'user' },
                    createdAt: now,
                    updatedAt: now,
                };

                data.tasks.push(task);
                this.#saveTask(task);

                if (command.chatId) {
                    const link = { chatId: command.chatId, taskId: task.id };

                    data.chatTaskLinks.push(link);
                    this.#emit(project.id, { type: 'link.chatTask', link, present: true });
                }

                return ok(structuredClone(task));
            }
            case 'task.update': {
                const task = data.tasks.find(candidate => candidate.id === command.taskId);

                if (!task) return fail('not_found', 'No such task');

                const { type: _type, taskId: _taskId, ...changes } = command;

                Object.assign(task, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)), { updatedAt: Date.now() });
                this.#saveTask(task);

                return ok(structuredClone(task));
            }
            case 'task.delete': {
                const task = data.tasks.find(candidate => candidate.id === command.taskId);

                if (!task) return fail('not_found', 'No such task');

                data.tasks = data.tasks.filter(candidate => candidate.id !== task.id);
                data.chatTaskLinks = data.chatTaskLinks.filter(link => link.taskId !== task.id);
                data.runTaskLinks = data.runTaskLinks.filter(link => link.taskId !== task.id);
                this.#emit(task.projectId, { type: 'task.deleted', taskId: task.id });

                return ok();
            }
            case 'task.start':
                return this.#startTask(command.taskId, command.force === true);

            case 'run.cancel':
                return this.#cancelRun(command.runId);
            case 'run.stopAgents':
                return this.#stopAgents(command.runId);
            case 'run.stopBackground':
                return this.#stopBackground(command.runId, command.itemId);
            case 'run.answer':
                return this.#answerQuestion(command.runId, command.questionId, command.answer);

            case 'skills.setEnabled': {
                const skill = data.skills.find(candidate => candidate.name === command.name);

                if (!skill) return fail('not_found', `Skill ${ command.name } does not exist`);

                if (skill.source !== 'user') return fail('invalid', skill.source === 'system' ? 'System skills cannot be switched off' : 'Only user skills can be switched on or off');

                if (skill.enabled !== command.enabled) {
                    skill.enabled = command.enabled;
                    data.projects.forEach(project => this.#emit(project.id, { type: 'skills.changed' }));
                }

                return ok({ name: command.name, enabled: command.enabled });
            }
            case 'agent.add':
            case 'agent.remove':
                return fail('unavailable', 'The demo data cannot add or remove agents');
            case 'agent.update':
                return this.#updateAgent(command);
            case 'agent.signIn':
                return this.#startSignIn(command.id);
            case 'agent.cancelSignIn':
                return this.#cancelSignIn(command.id);
            case 'agents.refresh': {
                const now = Date.now();

                for (const agent of data.agents) {
                    if (agent.signIn) agent.signIn.checkedAt = now;

                    if (agent.usage?.state === 'ok') agent.usage.fetchedAt = now;
                }

                this.#agentsChanged();

                return ok();
            }
            case 'docs.write': {
                const folder = data.projects.find(project => project.id === command.projectId)?.folders.find(candidate => candidate.id === command.folderId);

                if (!folder) return fail('not_found', `Folder ${ command.folderId } does not exist`);

                // The first document of a folder makes its docs folder.
                const files = data.docs[folder.path] ??= {};
                const existing = files[command.path];

                if (command.baseHash === null && existing !== undefined) return fail('conflict', 'The file already exists', { hash: docHash(existing), content: existing });

                if (command.baseHash !== null) {
                    if (existing === undefined) return fail('not_found', 'No such file');

                    if (docHash(existing) !== command.baseHash) return fail('conflict', 'The file changed on disk', { hash: docHash(existing), content: existing });
                }

                files[command.path] = command.content;

                // Like the daemon: every project that has the folder hears of it, with the id the folder has there.
                for (const project of data.projects) {
                    const shared = project.folders.find(candidate => candidate.path === folder.path);

                    if (shared) this.#emit(project.id, { type: 'docs.changed', folderId: shared.id, path: command.path, change: existing === undefined ? 'created' : 'modified' });
                }

                return ok({ hash: docHash(command.content) });
            }
        }
    }

    /** The projects as the daemon lists them: the personal space first, then in the person's order. */
    #listed(): Project[] {
        return [...this.#data.projects].sort((a, b) => Number(b.personal === true) - Number(a.personal === true) || a.position - b.position);
    }

    /** Runs of the project that have not finished: what stops it from being removed or moved. */
    #activeRuns(projectId: ProjectId): number {
        return this.#data.runs.filter(run => run.projectId === projectId && !isTerminalRunStatus(run.status)).length;
    }

    /** The runs of a chat: its orchestrator and every run of its tree (native sub-agents). A thread's runs are its own chat's, not its parent's. */
    #runsOfChat(chat: Chat): Run[] {
        return this.#data.runs.filter(run => run.chatId === chat.id || (chat.orchestratorRunId !== undefined && run.rootRunId === chat.orchestratorRunId));
    }

    /** An agent of the chat still works: what the daemon refuses an archive or a delete for. */
    #isChatBusy(chat: Chat): boolean {
        return this.#runsOfChat(chat).some(run => !isTerminalRunStatus(run.status));
    }

    /** Every thread below the chat, at any depth and archived ones too, each after its parent. */
    #threadsBelow(chat: Chat): Chat[] {
        const found: Chat[] = [];
        const seen = new Set([chat.id]);

        for (let index = -1; index < found.length; index++) {
            const parentId = index < 0 ? chat.id : found[index].id;

            for (const thread of this.#data.chats.filter(candidate => candidate.parentChatId === parentId && !seen.has(candidate.id))) {
                seen.add(thread.id);
                found.push(thread);
            }
        }

        return found;
    }

    /**
     * A thread's turn ended: its parent is told, as the daemon does. A parent at rest (also one that waits for its background work) starts a turn with
     * the notice at once; a busy one, or one whose queue is held, gets it in its queue, merged with the notices already waiting there (the latest of
     * a thread wins). Nothing for a turn that said nothing, and nothing for a parent in the archive.
     */
    #notifyParent(thread: Chat, run: Run): void {
        const parent = this.#data.chats.find(candidate => candidate.id === thread.parentChatId);
        const parentRun = parent && this.#data.runs.find(candidate => candidate.id === parent.orchestratorRunId);
        const said = this.#data.items[run.id]?.findLast(item => item.body.kind === 'assistant')?.body;
        const text = said?.kind === 'assistant' ? said.text.trim().slice(0, NOTICE_TEXT_MAX) : '';

        if (!parent || !parentRun || parent.archivedAt !== undefined || text === '') return;

        const open = run.status === 'waiting_background' ? (run.background ?? []).map(item => item.title) : [];
        const notice: ThreadNotice = { chatId: thread.id, title: thread.title, outcome: 'finished', text, ...(open.length > 0 && { background: open }) };

        if (!isBusyRunStatus(parentRun.status) && !parent.queuePaused) {
            this.#startTurn(parent, parentRun, { kind: 'user', text: '', from: { kind: 'threadNotice', threads: [notice] } }, NOTICE_REPLY);

            return;
        }

        const waiting = parent.queue?.find(item => item.from?.kind === 'threadNotice');
        const earlier = waiting?.from?.kind === 'threadNotice' ? waiting.from.threads.filter(entry => entry.chatId !== thread.id) : [];
        const threads = [...earlier, notice];
        const summary = noticeSummary(threads);
        const item: QueuedMessage = { id: waiting?.id ?? this.#id('q'), mode: 'queue', text: summary, content: `${ summary }.`, from: { kind: 'threadNotice', threads }, createdAt: waiting?.createdAt ?? Date.now() };

        parent.queue = waiting ? (parent.queue ?? []).map(entry => (entry.id === item.id ? item : entry)) : placeQueued(parent.queue ?? [], item);
        this.#emit(parent.projectId, { type: 'chat.upserted', chat: parent });
    }

    #addProject(name: string, paths: readonly string[]): Outcome {
        const prefix = name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'TSK';
        const position = Math.max(0, ...this.#data.projects.map(candidate => candidate.position)) + 1;
        const folders = paths.map(path => ({ id: this.#id('fld'), path }));
        const project: Project = { id: this.#id('p'), name, folders, taskPrefix: prefix, settings: {}, createdAt: Date.now(), position };

        this.#data.projects.push(project);
        this.#data.statuses[project.id] = DEFAULT_STATUSES;
        this.#emit(project.id, { type: 'project.upserted', project, statuses: DEFAULT_STATUSES });

        // Like the daemon: `{ project }`.
        return ok({ project: structuredClone(project) });
    }

    #sendMessage(chatId: string, rawText: string, attachmentIds: string[], mode: QueuedMessageMode): Outcome {
        const data = this.#data;
        const chat = data.chats.find(candidate => candidate.id === chatId);
        const text = rawText.trim();

        if (!chat) return fail('not_found', 'No such chat');

        if (!text && attachmentIds.length === 0) return fail('invalid', 'The message is empty');

        const files: StoredFile[] = [];

        for (const id of new Set(attachmentIds)) {
            const stored = this.#files.get(id);

            if (stored?.projectId !== chat.projectId) return fail('not_found', `No such attachment: ${ id }`);

            if (stored.sent) return fail('conflict', `${ stored.attachment.name } was sent already`);

            files.push(stored);
        }

        if (files.reduce((sum, stored) => sum + stored.attachment.size, 0) > MAX_ATTACHMENTS_BYTES_PER_MESSAGE) return fail('invalid', 'The files are over the size limit of one message');

        for (const stored of files) stored.sent = true;

        const attachments = files.map(stored => structuredClone(stored.attachment));
        const existing = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

        chat.updatedAt = Date.now();

        // A busy orchestrator gets the message later: it waits in the chat's queue, and a steer is taken a moment later, as an agent would.
        if (existing && isBusyRunStatus(existing.status)) {
            const item: QueuedMessage = { id: this.#id('q'), mode, text, ...(attachments.length > 0 && { attachments }), content: text, createdAt: Date.now() };

            chat.queue = placeQueued(chat.queue ?? [], item);
            this.#emit(chat.projectId, { type: 'chat.upserted', chat });

            if (mode === 'steer') this.#later(STEER_MS, () => this.#takeSteer(chat.id, item.id));

            return ok({ chatId: chat.id, runId: existing.id });
        }

        let run = existing;

        if (!run) {
            const number = data.runs.filter(candidate => candidate.role === 'orchestrator').length + 1;
            const id = this.#id('r-orch');

            run = {
                id,
                projectId: chat.projectId,
                rootRunId: id,
                chatId: chat.id,
                role: 'orchestrator',
                name: `Orchestrator ${ String(number).padStart(2, '0') }`,
                summary: chat.title,
                status: 'running',
                engine: chat.engine ?? 'fake',
                ...(chat.model && { model: chat.model }),
                ...(chat.effort && { effort: chat.effort }),
                createdAt: Date.now(),
                startedAt: Date.now(),
            };
            data.runs.push(run);
            this.#saveRun(run);
            chat.orchestratorRunId = id;
        }

        this.#emit(chat.projectId, { type: 'chat.upserted', chat });
        this.#startTurn(chat, run, { kind: 'user', text, ...(attachments.length > 0 && { attachments }) });

        return ok({ chatId: chat.id, runId: run.id });
    }

    /** A turn of a chat's orchestrator: the message that starts it, a canned reply, and the end of the turn, after which the queue gives the next one. */
    #startTurn(chat: Chat, run: Run, body: StreamItemBody, reply = REPLY): void {
        const turn = (this.#turns.get(run.id) ?? 0) + 1;

        this.#turns.set(run.id, turn);

        if (run.status !== 'running') {
            run.status = 'running';
            run.statusReason = undefined;
            delete run.finishedAt;
            this.#saveRun(run);
        }

        this.#appendItem(run, body);
        this.#later(400, () => this.#streamReply(run, reply));
        this.#later(TURN_MS, () => {
            if (this.#turns.get(run.id) !== turn || run.status !== 'running') return;

            this.#endTurn(chat, run);
        });
    }

    /**
     * The turn is over. A session that has background work open stays alive and waits for it, as the daemon's driver does, so a message
     * sent meanwhile reaches the same orchestrator; otherwise the run is done. The queue gives the next message in both cases, and the parent of a
     * thread is told when the turn `said` something.
     */
    #endTurn(chat: Chat, run: Run, said = true): void {
        if ((run.background?.length ?? 0) > 0) {
            run.status = 'waiting_background';
            run.statusReason = 'Waiting for background work';
        }
        else {
            run.status = 'succeeded';
            run.finishedAt = Date.now();
        }

        this.#saveRun(run);

        if (said && chat.parentChatId !== undefined) this.#notifyParent(chat, run);

        this.#settleQueue(chat);
    }

    /**
     * A compact turn: the agent's compaction call, running, then done with what it saved and a lower reading (Claude's report), and the end of the turn,
     * after which the queue gives the next one. No bubble: the person wrote nothing.
     */
    #startCompact(chat: Chat, run: Run): void {
        const turn = (this.#turns.get(run.id) ?? 0) + 1;
        const before = run.context?.used;
        const toolCallId = this.#id('tc-compact');
        const input = { title: 'Compact conversation' };

        this.#turns.set(run.id, turn);
        run.status = 'running';
        run.statusReason = undefined;
        delete run.finishedAt;
        this.#saveRun(run);

        const item = this.#appendItem(run, { kind: 'tool', toolCallId, name: 'compact', input, state: 'running' });

        this.#later(COMPACT_MS, () => {
            if (this.#turns.get(run.id) !== turn || run.status !== 'running') return;

            const after = before === undefined ? undefined : Math.round(before / 4);
            const output = JSON.stringify({ trigger: 'manual', ...(before !== undefined && { preTokens: before, postTokens: after }), durationMs: COMPACT_MS });

            this.#saveItem(run, { ...item, body: { kind: 'tool', toolCallId, name: 'compact', input, state: 'done', output } });

            if (run.context && after !== undefined) run.context = { ...run.context, used: after };

            // A compaction says nothing, so a thread's parent is not told.
            this.#endTurn(chat, run, false);
        });
    }

    /**
     * The orchestrator rests: steers it did not take go first as next turns, and a queue that is not paused gives it its head. A compact item waits for
     * an orchestrator that has finished, and the messages behind it go first meanwhile.
     */
    #settleQueue(chat: Chat): void {
        const run = this.#data.runs.find(candidate => candidate.id === chat.orchestratorRunId);
        const queue = (chat.queue ?? []).map(item => (item.mode === 'steer' ? { ...item, mode: 'queue' as const } : item));

        if (!run || isBusyRunStatus(run.status) || queue.length === 0) return;

        chat.queue = queue;

        const next = chat.queuePaused ? undefined : queue.find(item => !isCompact(item) || isTerminalRunStatus(run.status));

        if (!next) {
            this.#emit(chat.projectId, { type: 'chat.upserted', chat });

            return;
        }

        this.#dispatch(chat, run, next);
    }

    /** Takes a message out of the queue and makes it the orchestrator's next turn; sending a message from the queue lets a paused one flow again. */
    #dispatch(chat: Chat, run: Run, item: QueuedMessage): void {
        this.#setQueue(chat, (chat.queue ?? []).filter(entry => entry.id !== item.id));
        delete chat.queuePaused;
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });

        if (isCompact(item)) this.#startCompact(chat, run);
        else this.#startTurn(chat, run, userBody(item), item.from?.kind === 'threadNotice' ? NOTICE_REPLY : REPLY);
    }

    /** The agent took a steer: it leaves the queue, and its bubble goes where the agent got it. */
    #takeSteer(chatId: string, itemId: string): void {
        const chat = this.#data.chats.find(candidate => candidate.id === chatId);
        const run = this.#data.runs.find(candidate => candidate.id === chat?.orchestratorRunId);
        const item = chat?.queue?.find(entry => entry.id === itemId && entry.mode === 'steer');

        if (!chat || !item || run?.status !== 'running') return;

        this.#setQueue(chat, (chat.queue ?? []).filter(entry => entry.id !== itemId));
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });
        this.#appendItem(run, userBody(item));
        this.#later(300, () => this.#streamReply(run, 'Noted. I will take that into account.'));
    }

    #setQueue(chat: Chat, queue: QueuedMessage[]): void {
        if (queue.length > 0) {
            chat.queue = queue;

            return;
        }

        delete chat.queue;
        delete chat.queuePaused;
    }

    #changeQueued(chatId: string, itemId: string, change: (chat: Chat, item: QueuedMessage) => QueuedMessage[]): Outcome {
        const chat = this.#data.chats.find(candidate => candidate.id === chatId);
        const item = chat?.queue?.find(entry => entry.id === itemId);

        if (!chat || !item) return fail('not_found', `Queued message ${ itemId } does not exist`);

        this.#setQueue(chat, change(chat, item));
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });

        return ok({ chat: structuredClone(chat) });
    }

    #removeQueued(chatId: string, itemId: string, keepFiles: boolean): Outcome {
        return this.#changeQueued(chatId, itemId, (chat, item) => {
            for (const attachment of item.attachments ?? []) {
                const stored = this.#files.get(attachment.id);

                if (stored && keepFiles) stored.sent = false;
                else this.#files.delete(attachment.id);
            }

            return (chat.queue ?? []).filter(entry => entry.id !== itemId);
        });
    }

    #sendQueued(chatId: string, itemId: string): Outcome {
        const chat = this.#data.chats.find(candidate => candidate.id === chatId);
        const item = chat?.queue?.find(entry => entry.id === itemId);
        const run = this.#data.runs.find(candidate => candidate.id === chat?.orchestratorRunId);

        if (!chat || !item || !run) return fail('not_found', `Queued message ${ itemId } does not exist`);

        // A compact item steers nothing: it keeps its place while the orchestrator works, and goes only once it has finished.
        if (isCompact(item)) {
            if (isBusyRunStatus(run.status)) return ok({ chatId: chat.id, runId: run.id });

            if (!isTerminalRunStatus(run.status)) return fail('conflict', 'The orchestrator is waiting for background work. Compact the chat when it has finished');

            this.#dispatch(chat, run, item);

            return ok({ chatId: chat.id, runId: run.id });
        }

        if (isBusyRunStatus(run.status)) {
            this.#setQueue(chat, placeQueued(chat.queue ?? [], { ...item, mode: 'steer' }));
            this.#emit(chat.projectId, { type: 'chat.upserted', chat });
            this.#later(STEER_MS, () => this.#takeSteer(chat.id, item.id));
        }
        else {
            chat.updatedAt = Date.now();
            this.#dispatch(chat, run, item);
        }

        return ok({ chatId: chat.id, runId: run.id });
    }

    #startTask(taskId: TaskId, force: boolean): Outcome {
        const data = this.#data;
        const task = data.tasks.find(candidate => candidate.id === taskId);

        if (!task) return fail('not_found', 'No such task');

        const runIds = new Set(data.runTaskLinks.filter(link => link.taskId === taskId && link.relation === 'assigned').map(link => link.runId));

        if (!force && data.runs.some(run => runIds.has(run.id) && !isTerminalRunStatus(run.status))) return fail('already_running', `${ task.key } already has an active run`);

        // Like the daemon: the task opens a chat named after it, and the chat's orchestrator is the run assigned to the task.
        const number = data.runs.filter(candidate => candidate.role === 'orchestrator').length + 1;
        const id = this.#id('r-orch');
        const now = Date.now();
        const chat: Chat = {
            id: this.#id('c'),
            projectId: task.projectId,
            title: task.title,
            mode: 'autopilot',
            engine: 'fake',
            orchestratorRunId: id,
            createdAt: now,
            updatedAt: now,
        };
        const run: Run = {
            id,
            projectId: task.projectId,
            rootRunId: id,
            chatId: chat.id,
            role: 'orchestrator',
            name: `Orchestrator ${ String(number).padStart(2, '0') }`,
            summary: task.title,
            status: 'running',
            engine: 'fake',
            createdAt: now,
            startedAt: now,
        };
        const link = { runId: id, taskId, relation: 'assigned' as const };
        const chatLink = { chatId: chat.id, taskId };
        const active = (data.statuses[task.projectId] ?? DEFAULT_STATUSES).find(status => status.category === 'active');

        data.chats.push(chat);
        data.runs.push(run);
        data.runTaskLinks.push(link);
        data.chatTaskLinks.push(chatLink);
        this.#emit(task.projectId, { type: 'chat.upserted', chat });
        this.#saveRun(run);
        this.#emit(task.projectId, { type: 'link.chatTask', link: chatLink, present: true });
        this.#emit(task.projectId, { type: 'link.runTask', link, present: true });

        if (active) {
            task.statusId = active.id;
            task.updatedAt = now;
            this.#saveTask(task);
        }

        this.#appendItem(run, { kind: 'user', text: `Work on ${ task.key }: ${ task.title }.` });
        this.#later(500, () => this.#streamReply(run, `I will start on ${ task.key } by reading the code around it.`));
        this.#later(2500, () => {
            run.status = 'succeeded';
            run.result = `Finished ${ task.key }.`;
            run.finishedAt = Date.now();
            this.#saveRun(run);

            const review = (data.statuses[task.projectId] ?? DEFAULT_STATUSES).find(status => status.category === 'review');

            if (review && data.tasks.includes(task)) {
                task.statusId = review.id;
                task.updatedAt = Date.now();
                this.#saveTask(task);
            }
        });

        // Like the daemon: `{ runId, chatId }`.
        return ok({ runId: run.id, chatId: chat.id });
    }

    #cancelRun(runId: RunId): Outcome {
        const data = this.#data;
        const target = data.runs.find(candidate => candidate.id === runId);

        if (!target) return fail('not_found', 'No such run');

        // Like the daemon: a sub-agent of a session is stopped alone when its session can end it, and refused when it cannot.
        if (target.origin === 'native' && !isTerminalRunStatus(target.status)) {
            if (!target.canStopAlone) return fail('conflict', 'A sub-agent runs inside its parent run; cancel the parent run instead');

            this.#endRun(target);

            return ok({ cancelled: [runId] });
        }

        const cancelled = this.#subtree(runId);

        for (const run of data.runs.filter(candidate => cancelled.has(candidate.id) && !isTerminalRunStatus(candidate.status))) {
            this.#endRun(run);
        }

        return ok({ cancelled: [...cancelled] });
    }

    /** Like the daemon's `run.stopAgents`: the sub-agents of the orchestrator's session that can stop alone stop; the orchestrator itself goes on, and so does its queue. */
    #stopAgents(runId: RunId): Outcome {
        const data = this.#data;

        if (!data.runs.some(candidate => candidate.id === runId)) return fail('not_found', 'No such run');

        const stopped: RunId[] = [];

        for (const id of this.#subtree(runId)) {
            const run = data.runs.find(candidate => candidate.id === id)!;

            if (id !== runId && run.canStopAlone && !isTerminalRunStatus(run.status)) {
                this.#endRun(run);
                stopped.push(id);
            }
        }

        return ok({ stopped });
    }

    /**
     * Like the daemon's `run.stopBackground`: one background command that its agent lets be stopped alone leaves the run's list and the stream says it was
     * stopped; the run and its other work go on. `stopped: false` for an item that is gone, cannot be stopped alone, or belongs to a run that ended.
     */
    #stopBackground(runId: RunId, itemId: string): Outcome {
        const run = this.#data.runs.find(candidate => candidate.id === runId);

        if (!run) return fail('not_found', 'No such run');

        const item = run.background?.find(candidate => candidate.id === itemId);

        if (!item?.canStopAlone || item.kind === 'subagent' || isTerminalRunStatus(run.status)) return ok({ stopped: false });

        const rest = (run.background ?? []).filter(candidate => candidate.id !== itemId);

        if (rest.length > 0) run.background = rest;
        else delete run.background;

        this.#saveRun(run);
        this.#appendItem(run, { kind: 'note', text: `Background command stopped: ${ item.title }` });

        return ok({ stopped: true });
    }

    /** The run and every run below it. */
    #subtree(runId: RunId): Set<RunId> {
        const { runs } = this.#data;
        const found = new Set([runId]);

        for (let size = 0; size !== found.size;) {
            size = found.size;
            runs.filter(run => run.parentRunId && found.has(run.parentRunId)).forEach(run => found.add(run.id));
        }

        return found;
    }

    /** A run is cancelled: what it had open in the background ends with it, a call it left running is stopped, and a stopped orchestrator holds its chat's queue. */
    #endRun(run: Run): void {
        const data = this.#data;

        run.status = 'cancelled';
        run.statusReason = undefined;
        // A run that ended has nothing open in the background: stopping it ends that work too.
        delete run.background;
        run.finishedAt = Date.now();
        this.#saveRun(run);

        // A sub-agent that stopped leaves its parent's list of open work.
        const parent = run.origin === 'native' ? data.runs.find(candidate => candidate.id === run.parentRunId) : undefined;

        if (parent?.background && run.parentToolCallId) {
            parent.background = parent.background.filter(item => item.id !== run.parentToolCallId);
            this.#saveRun(parent);
        }

        for (const item of data.items[run.id] ?? []) {
            if (item.body.kind === 'tool' && item.body.state === 'running') this.#saveItem(run, { ...item, body: { ...item.body, state: 'error', error: STOPPED_TOOL } });
        }

        // Stop holds the queue of the chat whose orchestrator it stopped.
        const chat = data.chats.find(candidate => candidate.orchestratorRunId === run.id);

        if (chat?.queue?.length) {
            chat.queuePaused = 'stopped';
            this.#settleQueue(chat);
        }
    }

    #answerQuestion(runId: RunId, questionId: string, answer: string): Outcome {
        const run = this.#data.runs.find(candidate => candidate.id === runId);
        const item = this.#data.items[runId]?.find(candidate => candidate.body.kind === 'question' && candidate.body.questionId === questionId);

        if (!run || !item || item.body.kind !== 'question') return fail('not_found', 'No such question');

        this.#saveItem(run, { ...item, body: { ...item.body, answer } });
        run.status = 'running';
        run.statusReason = undefined;
        this.#saveRun(run);
        this.#later(500, () => this.#streamReply(run, `Thanks. I will go with "${ answer }" and continue.`));

        return ok();
    }
}
