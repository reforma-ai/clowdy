import { isTerminalRunStatus, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_BYTES_PER_MESSAGE } from '@clowdy/protocol';

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
    Project,
    ProjectId,
    ProjectInfo,
    ProjectSnapshot,
    RootSnapshot,
    Run,
    RunId,
    SkillCatalog,
    StreamItem,
    StreamItemBody,
    Task,
    TaskDetail,
    TaskId,
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
            folderExists: true,
            ...git[project.id],
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
        return docsTree(Object.keys(this.#data.docs[projectId] ?? {}));
    }

    async getDocFile(projectId: ProjectId, path: string): Promise<DocFile> {
        const content = this.#data.docs[projectId]?.[path];

        if (content === undefined) throw new TransportError(`No such file: ${ path }`, 404);

        return { path, content, hash: docHash(content) };
    }

    async getProjectFiles(projectId: ProjectId, query: string, limit = 40): Promise<string[]> {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);

        return (this.#data.files[projectId] ?? []).filter(path => words.every(word => path.toLowerCase().includes(word))).slice(0, limit);
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
            agent.signInSession = { step: 'cancelled', startedAt: agent.signInSession.startedAt, message: 'The sign-in was cancelled.' };
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

            if (parent) this.#appendItem(parent, { kind: 'note', text: `${ run.name } passed the typecheck` });
        });
    }

    /* -------------------------------- Commands -------------------------------- */

    #apply(command: CommandInput): Outcome {
        const data = this.#data;

        switch (command.type) {
            case 'project.create':
                return this.#addProject(command.name, command.path ?? `/Users/dev/${ command.name.toLowerCase().replace(/\W+/g, '-') }`);
            case 'project.open': {
                const known = data.projects.find(project => project.path === command.path);

                return known ? ok(structuredClone(known)) : this.#addProject(command.name ?? command.path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project', command.path);
            }
            case 'project.update': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);

                if (!project) return fail('not_found', 'No such project');

                const renamed = command.name !== undefined && command.name !== project.name;
                const moved = command.path !== undefined && command.path !== project.path;

                if (project.personal && (renamed || moved)) return fail('conflict', 'The personal space cannot be renamed or moved');

                if (moved && this.#activeRuns(project.id) > 0) return fail('conflict', 'The agents of this project are still working. Stop them first.');

                if (moved && data.projects.some(other => other.id !== project.id && other.path === command.path)) return fail('conflict', `${ command.path } is already a project`);

                const settings: Project['settings'] = { ...project.settings };

                for (const [key, value] of Object.entries(command.settings ?? {})) {
                    if (value === null) delete settings[key as keyof Project['settings']];
                    else Object.assign(settings, { [key]: value });
                }

                Object.assign(project, { name: command.name ?? project.name, path: command.path ?? project.path, settings });
                this.#emit(project.id, { type: 'project.upserted', project, statuses: data.statuses[project.id] ?? DEFAULT_STATUSES });

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
                delete data.docs[project.id];
                delete data.files[project.id];
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

                if (!isTerminalRunStatus(run.status)) return fail('conflict', 'The orchestrator is working on this chat. Compact it when it has finished');

                this.#appendItem(run, { kind: 'note', text: 'Compacting the conversation' });

                // The agent reports a lower reading once it has compacted.
                if (run.context) run.context = { ...run.context, used: Math.round(run.context.used / 2) };

                this.#saveRun(run);

                return ok({ chatId: chat.id, runId: run.id });
            }
            case 'chat.setArchived': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                if (command.archived && chat.archivedAt === undefined) {
                    const busy = data.runs.some(run => (run.chatId === chat.id || (chat.orchestratorRunId !== undefined && run.rootRunId === chat.orchestratorRunId)) && !isTerminalRunStatus(run.status));

                    if (busy) return fail('conflict', 'The agents of this chat are still working. Stop the chat first.');

                    chat.archivedAt = Date.now();
                    this.#emit(chat.projectId, { type: 'chat.upserted', chat });
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

                const runs = data.runs.filter(run => run.chatId === chat.id || (chat.orchestratorRunId !== undefined && run.rootRunId === chat.orchestratorRunId));

                if (runs.some(run => !isTerminalRunStatus(run.status))) return fail('conflict', 'The agents of this chat are still working. Stop the chat first.');

                const runIds = new Set(runs.map(run => run.id));

                data.chats = data.chats.filter(candidate => candidate.id !== chat.id);
                data.runs = data.runs.filter(run => !runIds.has(run.id));
                data.chatTaskLinks = data.chatTaskLinks.filter(link => link.chatId !== chat.id);
                data.runTaskLinks = data.runTaskLinks.filter(link => !runIds.has(link.runId));
                runIds.forEach(runId => delete data.items[runId]);
                this.#emit(chat.projectId, { type: 'chat.deleted', chatId: chat.id, runIds: [...runIds] });

                return ok({ chatId: chat.id });
            }
            case 'chat.send':
                return this.#sendMessage(command.chatId, command.text, command.attachmentIds ?? []);

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
                const files = data.docs[command.projectId] ??= {};
                const existing = files[command.path];

                if (command.baseHash === null && existing !== undefined) return fail('conflict', 'The file already exists', { hash: docHash(existing), content: existing });

                if (command.baseHash !== null) {
                    if (existing === undefined) return fail('not_found', 'No such file');

                    if (docHash(existing) !== command.baseHash) return fail('conflict', 'The file changed on disk', { hash: docHash(existing), content: existing });
                }

                files[command.path] = command.content;
                this.#emit(command.projectId, { type: 'docs.changed', path: command.path, change: existing === undefined ? 'created' : 'modified' });

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

    #addProject(name: string, path: string): Outcome {
        const prefix = name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'TSK';
        const position = Math.max(0, ...this.#data.projects.map(candidate => candidate.position)) + 1;
        const project: Project = { id: this.#id('p'), name, path, taskPrefix: prefix, settings: {}, createdAt: Date.now(), position };

        this.#data.projects.push(project);
        this.#data.statuses[project.id] = DEFAULT_STATUSES;
        this.#data.docs[project.id] = {};
        this.#emit(project.id, { type: 'project.upserted', project, statuses: DEFAULT_STATUSES });

        return ok(structuredClone(project));
    }

    #sendMessage(chatId: string, text: string, attachmentIds: string[]): Outcome {
        const data = this.#data;
        const chat = data.chats.find(candidate => candidate.id === chatId);

        if (!chat) return fail('not_found', 'No such chat');

        if (!text.trim() && attachmentIds.length === 0) return fail('invalid', 'The message is empty');

        const files: StoredFile[] = [];

        for (const id of new Set(attachmentIds)) {
            const stored = this.#files.get(id);

            if (stored?.projectId !== chat.projectId) return fail('not_found', `No such attachment: ${ id }`);

            if (stored.sent) return fail('conflict', `${ stored.attachment.name } was sent already`);

            files.push(stored);
        }

        if (files.reduce((sum, stored) => sum + stored.attachment.size, 0) > MAX_ATTACHMENTS_BYTES_PER_MESSAGE) return fail('invalid', 'The files are over the size limit of one message');

        let run = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

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

        chat.updatedAt = Date.now();
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });

        if (run.status !== 'running') {
            run.status = 'running';
            run.statusReason = undefined;
            this.#saveRun(run);
        }

        for (const stored of files) stored.sent = true;

        this.#appendItem(run, { kind: 'user', text, ...(files.length > 0 && { attachments: files.map(stored => structuredClone(stored.attachment)) }) });

        const target = run;

        this.#later(400, () => this.#streamReply(target, 'Got it. I will split this into tasks, start the independent ones in parallel, and report back here.'));

        return ok();
    }

    #startTask(taskId: TaskId, force: boolean): Outcome {
        const data = this.#data;
        const task = data.tasks.find(candidate => candidate.id === taskId);

        if (!task) return fail('not_found', 'No such task');

        const runIds = new Set(data.runTaskLinks.filter(link => link.taskId === taskId && link.relation === 'assigned').map(link => link.runId));

        if (!force && data.runs.some(run => runIds.has(run.id) && !isTerminalRunStatus(run.status))) return fail('already_running', `${ task.key } already has an active run`);

        const number = data.runs.filter(candidate => candidate.role === 'executor').length + 1;
        const id = this.#id('r-ex');
        const now = Date.now();
        const run: Run = {
            id,
            projectId: task.projectId,
            rootRunId: id,
            role: 'executor',
            name: `Executor ${ String(number).padStart(2, '0') }`,
            summary: task.title,
            status: 'running',
            engine: 'fake',
            createdAt: now,
            startedAt: now,
        };
        const link = { runId: id, taskId, relation: 'assigned' as const };
        const active = (data.statuses[task.projectId] ?? DEFAULT_STATUSES).find(status => status.category === 'active');

        data.runs.push(run);
        data.runTaskLinks.push(link);
        this.#saveRun(run);
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

        return ok(structuredClone(run));
    }

    #cancelRun(runId: RunId): Outcome {
        const data = this.#data;

        if (!data.runs.some(candidate => candidate.id === runId)) return fail('not_found', 'No such run');

        const cancelled = new Set([runId]);

        // The run and every run below it.
        for (let size = 0; size !== cancelled.size;) {
            size = cancelled.size;
            data.runs.filter(run => run.parentRunId && cancelled.has(run.parentRunId)).forEach(run => cancelled.add(run.id));
        }

        for (const run of data.runs.filter(candidate => cancelled.has(candidate.id) && !isTerminalRunStatus(candidate.status))) {
            run.status = 'cancelled';
            run.statusReason = undefined;
            run.finishedAt = Date.now();
            this.#saveRun(run);
        }

        return ok();
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
