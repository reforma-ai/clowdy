import { isTerminalRunStatus } from '@clowdy/protocol';

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
    ClowdyEvent,
    CommandResult,
    DocFile,
    DocsTree,
    ErrorCode,
    EventData,
    Project,
    ProjectId,
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

type Outcome = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };

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

    constructor({ data = createFixtureData(), timeline = false }: FixtureTransportOptions = {}) {
        this.#data = data;
        this.#timeline = timeline;
    }

    async getRootSnapshot(): Promise<RootSnapshot> {
        return structuredClone({ cursor: this.#cursor, projects: this.#data.projects });
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

    async getSkills(projectId?: ProjectId): Promise<SkillCatalog> {
        if (projectId !== undefined) this.#project(projectId);

        const entries = this.#data.skills.filter(skill => skill.projectId === undefined || skill.projectId === projectId).map(({ projectId: _projectId, ...entry }) => entry);

        return structuredClone({ entries, tokens: catalogTokens(entries), warnings: this.#data.skillWarnings });
    }

    /* --------------------------------- Events --------------------------------- */

    #emit(projectId: ProjectId, data: EventData): void {
        const event: ClowdyEvent = structuredClone({ cursor: ++this.#cursor, at: Date.now(), projectId, data });

        this.#log.push(event);
        this.#subscribers.forEach(deliver => deliver(event));
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

                Object.assign(project, { name: command.name ?? project.name, settings: { ...project.settings, ...command.settings } });
                this.#emit(project.id, { type: 'project.upserted', project, statuses: data.statuses[project.id] ?? DEFAULT_STATUSES });

                return ok(structuredClone(project));
            }

            case 'chat.create': {
                const now = Date.now();
                const chat = { id: this.#id('c'), projectId: command.projectId, title: command.title ?? 'New chat', mode: command.mode ?? 'autopilot', createdAt: now, updatedAt: now };

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
            case 'chat.send':
                return this.#sendMessage(command.chatId, command.text);

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

    #addProject(name: string, path: string): Outcome {
        const prefix = name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'TSK';
        const project: Project = { id: this.#id('p'), name, path, taskPrefix: prefix, settings: {}, createdAt: Date.now() };

        this.#data.projects.push(project);
        this.#data.statuses[project.id] = DEFAULT_STATUSES;
        this.#data.docs[project.id] = {};
        this.#emit(project.id, { type: 'project.upserted', project, statuses: DEFAULT_STATUSES });

        return ok(structuredClone(project));
    }

    #sendMessage(chatId: string, text: string): Outcome {
        const data = this.#data;
        const chat = data.chats.find(candidate => candidate.id === chatId);

        if (!chat) return fail('not_found', 'No such chat');

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
                engine: 'fake',
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

        this.#appendItem(run, { kind: 'user', text });

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
