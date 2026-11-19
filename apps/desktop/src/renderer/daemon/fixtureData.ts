import type {
    AgentInfo,
    AgentModels,
    Artifact,
    Attachment,
    Chat,
    ChatTaskLink,
    DocNode,
    Project,
    ProjectId,
    Run,
    RunTaskLink,
    SkillEngine,
    SkillEntry,
    StreamItem,
    StreamItemBody,
    Task,
    TaskStatus,
} from '@clowdy/protocol';

/** Everything the fixture daemon holds. Plain data: the transport mutates it and announces the changes. */
export interface FixtureData {
    projects: Project[];
    /** What `git` says in each folder, by the folder's path: the `origin` address; a folder without an entry has no remote. */
    git: Record<string, { remoteUrl?: string }>;
    statuses: Record<string, TaskStatus[]>;
    chats: Chat[];
    tasks: Task[];
    runs: Run[];
    chatTaskLinks: ChatTaskLink[];
    runTaskLinks: RunTaskLink[];
    items: Record<string, StreamItem[]>;
    artifacts: Artifact[];
    /**
     * Markdown files of each folder's `.clowdy/docs`, by the folder's path, then by the path under it. A folder that is not listed has no
     * docs folder yet. Keyed by folder, as on disk: a folder several projects have shares its documents with all of them.
     */
    docs: Record<string, Record<string, string>>;
    /** Paths of the files of each folder, by the folder's path, relative to it, as the file search would list them. */
    files: Record<string, string[]>;
    /** The icon the daemon finds in each folder, by the folder's path: an SVG drawing. A folder that is not listed has none. */
    icons: Record<string, string>;
    /** Files sent with messages, by the fixture's seed data. */
    attachments: FixtureAttachment[];
    /** What the skills catalog lists; `projectId` marks a project's own skill. */
    skills: FixtureSkill[];
    skillWarnings: string[];
    /** The agents the daemon knows, as `GET /v1/agents` lists them. */
    agents: AgentInfo[];
    /** What `GET /v1/agents/:id/models` answers, by agent id. */
    agentModels: Record<string, AgentModels>;
}

/** A file a message already carries: the metadata the stream shows and the content the fixture serves. */
export interface FixtureAttachment {
    projectId: ProjectId;
    attachment: Attachment;
    content: string;
}

export type FixtureSkill = SkillEntry & { projectId?: ProjectId };

/** The daemon's estimate of what a skill's line costs: `skills/catalog.ts` in the daemon. */
export const estimateSkillTokens = (name: string, description: string) => 16 + Math.ceil((name.length + description.length) / 4);

/** What the engine that sees the most enabled skills pays, as the daemon reports it. */
export function catalogTokens(entries: SkillEntry[]): number {
    const engines: SkillEngine[] = ['claude', 'codex'];

    return Math.max(...engines.map(engine => entries.filter(entry => entry.enabled && entry.engines.includes(engine)).reduce((sum, entry) => sum + entry.tokens, 0)));
}

function fixtureSkills(projectId: ProjectId): FixtureSkill[] {
    const both: SkillEngine[] = ['claude', 'codex'];
    const skill = (source: SkillEntry['source'], name: string, description: string, rest: Partial<FixtureSkill> = {}): FixtureSkill => ({
        id: `${ source }:${ name }`,
        name,
        source,
        description,
        enabled: true,
        tokens: estimateSkillTokens(name, description),
        engines: both,
        ...rest,
    });

    return [
        skill('system', 'clowdy:autopilot', 'How to work without asking the user. Sort every fork, decide significant ones by explicit criteria and record them, and report only true blockers.'),
        skill('system', 'clowdy:docs', 'The contract for a project\'s documents: layout, file names, facts versus plans, decisions and how to supersede them, and how to edit them safely.'),
        skill('system', 'clowdy:executor', 'Manual for a spawned executor run: stay inside the owned scope, work in small verified steps, never ask the user, and finish with real evidence.'),
        skill('system', 'clowdy:orchestrate', 'Entry skill of every chat: classify the message, plan a task graph, run agents in parallel, verify the result independently, and report briefly.'),
        skill('system', 'clowdy:scaffold', 'Start a new application from nothing: product statement, stack, one verified skeleton, then the first task graph.'),
        skill('system', 'clowdy:semi-manual', 'Involve the user in the decisions that matter through question cards, then build with autopilot discipline.'),
        skill('system', 'clowdy:verify', 'Verify work independently with real commands, record the evidence, and give a verdict of pass, fail or blocked.'),
        skill('user', 'user:deploy', 'Build the app, run every check and push it to the staging server when asked to ship.', { path: '/Users/dev/.claude/skills/deploy' }),
        skill('user', 'user:release-notes', 'Write release notes in plain words from the merged work since the last release.', { path: '/Users/dev/.agents/skills/release-notes' }),
        skill('user', 'user:sql-review', 'Review a database migration for locks, missing indexes and data loss before it runs.', { path: '/Users/dev/.claude/skills/sql-review', enabled: false }),
        skill('user', 'user:brand-voice', 'Keep every message, email and screen text in the company voice: short, warm, no jargon.', { path: '/Users/dev/.agents/skills/brand-voice' }),
        skill('project', 'booking-rules', 'The pricing and cancellation rules of the booking service, for any change that touches a price.', { id: 'project:.claude/skills/booking-rules', path: '/Users/dev/car-rental/.claude/skills/booking-rules', engines: ['claude'], projectId }),
        skill('project', 'fleet-import', 'Import the fleet spreadsheet from the partner garage and report the rows it could not read.', { id: 'project:.agents/skills/fleet-import', path: '/Users/dev/car-rental/.agents/skills/fleet-import', engines: ['codex'], projectId }),
    ];
}

export const FIXTURE_PROJECT_ID = 'p-car';
export const FIXTURE_EMPTY_PROJECT_ID = 'p-clowdy';
export const FIXTURE_PERSONAL_PROJECT_ID = 'p-personal';
/** The run, and the two items of its stream, that the fixture timeline keeps changing. */
export const FIXTURE_LIVE_RUN_ID = 'r-ex-07';
export const FIXTURE_LIVE_TOOL_ID = 'r-ex-07-8';
export const FIXTURE_LIVE_TEXT_ID = 'r-ex-07-9';

const MINUTE = 60_000;

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * The models the three agents list, in the spelling of each: Claude's `default` row stands for Opus and its aliases are `featured`, a Cursor id
 * is a family (in Cursor's own order, Auto first), Codex has `ultra` and more models than a picker shows at once.
 */
function fixtureAgentModels(now: number): Record<string, AgentModels> {
    return {
        claude: {
            state: 'ok',
            fetchedAt: now,
            models: [
                { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for complex work', isDefault: true, resolvedId: 'claude-opus-5-5', efforts: CLAUDE_EFFORTS, featured: true },
                { id: 'opus', name: 'Opus 5.5', description: 'Best for complex work', resolvedId: 'claude-opus-5-5', efforts: CLAUDE_EFFORTS, featured: true },
                { id: 'fable', name: 'Fable 5.2', description: 'Deep reasoning and writing', resolvedId: 'claude-fable-5-2', efforts: CLAUDE_EFFORTS, featured: true },
                { id: 'sonnet', name: 'Sonnet 5.5', description: 'Best for everyday tasks', resolvedId: 'claude-sonnet-5-5', efforts: CLAUDE_EFFORTS, featured: true },
                { id: 'haiku', name: 'Haiku 5.5', description: 'Fastest for quick answers', resolvedId: 'claude-haiku-5-5', efforts: CLAUDE_EFFORTS, featured: true },
                { id: 'claude-opus-4-6', name: 'Opus 4.6', description: 'Previous generation', efforts: ['low', 'medium', 'high', 'max'] },
                { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', description: 'Small and quick, with no reasoning control' },
            ],
        },
        codex: {
            state: 'ok',
            fetchedAt: now,
            models: [
                { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', description: 'Frontier model for coding and agentic work', isDefault: true, efforts: CODEX_EFFORTS, defaultEffort: 'low' },
                { id: 'gpt-6-sol', name: 'GPT-6 Sol', description: 'The previous Sol', efforts: CODEX_EFFORTS, defaultEffort: 'medium' },
                { id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'Smaller and faster', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
                { id: 'gpt-6-mini', name: 'GPT-6 Mini', description: 'Quick answers, one reasoning level', efforts: ['medium'], defaultEffort: 'medium' },
                { id: 'gpt-6-codex', name: 'GPT-6 Codex', description: 'Tuned for long coding sessions', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
                { id: 'gpt-5.5', name: 'GPT-5.5', description: 'The generation before GPT-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
                { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini', description: 'Quick and light', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
                { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Kept for older work', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
            ],
        },
        cursor: {
            state: 'ok',
            fetchedAt: now,
            // Cursor's own order, and its models as families: Auto first, each family with the levels of its own option.
            models: [
                { id: 'default', name: 'Auto', description: 'Cursor picks the model for each request', isDefault: true },
                { id: 'grok-4.7', name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
                { id: 'grok-4.6', name: 'Grok 4.6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
                { id: 'composer-2.5', name: 'Composer 2.5' },
                { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
                { id: 'claude-opus-5', name: 'Claude Opus 5', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium' },
                { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'medium' },
                { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
                { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['none', 'low', 'medium', 'high', 'extra-high'], defaultEffort: 'medium' },
                { id: 'muse-wonder-1.0', name: 'Muse Wonder 1.0', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
            ],
        },
    };
}

/** The three built-in agents as a daemon on a developer's machine would list them: installed, signed in, with their plan limits. */
function fixtureAgents(now: number): AgentInfo[] {
    const inMinutes = (minutes: number) => now + minutes * MINUTE;
    const account = { email: 'dev@example.com', method: 'subscription' } as const;

    return [
        {
            id: 'claude',
            name: 'Claude Code',
            custom: false,
            enabled: true,
            status: 'ready',
            path: '/Users/dev/.local/bin/claude',
            version: '2.1.322',
            launch: 'bun x --bun @agentclientprotocol/claude-agent-acp@0.107.0',
            fetches: '@agentclientprotocol/claude-agent-acp@0.107.0',
            login: 'claude auth login',
            canSignIn: true,
            canCompact: true,
            signIn: { status: 'signed-in', account: { ...account, plan: 'Max' }, checkedAt: now },
            usage: {
                state: 'ok',
                fetchedAt: now,
                windows: [
                    { id: 'session', label: 'Session', usedPercent: 8, resetsAt: inMinutes(28) },
                    { id: 'weekly', label: 'Week', usedPercent: 20, resetsAt: inMinutes(6 * 24 * 60) },
                    { id: 'weekly:fable', label: 'Fable', usedPercent: 0, resetsAt: inMinutes(6 * 24 * 60) },
                ],
            },
            settings: [
                { id: 'memory', label: 'Memory', description: 'Let Claude Code read and write its own auto-memory in your runs', value: false, default: false },
                { id: 'connectors', label: 'claude.ai connectors', description: 'Load the connectors of your claude.ai account (Drive, Docs and so on) into every run', value: false, default: false },
                { id: 'subagents', label: 'Claude Code sub-agents', description: 'Let Claude Code start sub-agents of its own. Clowdy\'s agents are the better way to delegate work.', value: true, default: true },
                { id: 'longContext', label: '1M context window', description: 'Use the 1M-token context window on the models that have one', value: true, default: true },
            ],
        },
        {
            id: 'codex',
            name: 'Codex',
            custom: false,
            enabled: true,
            status: 'ready',
            path: '/opt/homebrew/bin/codex',
            version: '0.166.0',
            launch: 'bun x --bun @agentclientprotocol/codex-acp@2.6.0',
            fetches: '@agentclientprotocol/codex-acp@2.6.0',
            login: 'codex login',
            canSignIn: true,
            canCompact: true,
            signIn: { status: 'signed-in', account: { ...account, plan: 'Plus' }, checkedAt: now },
            usage: {
                state: 'ok',
                fetchedAt: now,
                windows: [
                    { id: 'codex:primary', label: 'Session', usedPercent: 0, resetsAt: inMinutes(4 * 60 + 59) },
                    { id: 'codex:secondary', label: 'Week', usedPercent: 17, resetsAt: inMinutes(24 * 60) },
                ],
            },
            settings: [],
        },
        {
            id: 'cursor',
            name: 'Cursor',
            custom: false,
            enabled: true,
            status: 'ready',
            path: '/Users/dev/.local/bin/cursor-agent',
            version: '2026.11.13-eacade1',
            launch: 'cursor-agent acp',
            login: 'cursor-agent login',
            canSignIn: true,
            signIn: { status: 'signed-in', account: { ...account, plan: 'Pro+' }, checkedAt: now },
            usage: {
                state: 'ok',
                fetchedAt: now,
                windows: [{ id: 'plan', label: 'Plan usage', usedPercent: 5, resetsAt: inMinutes(26 * 24 * 60) }],
            },
            settings: [],
        },
    ];
}

export const DEFAULT_STATUSES: TaskStatus[] = [
    { id: 'backlog', name: 'Backlog', category: 'backlog' },
    { id: 'todo', name: 'To do', category: 'todo' },
    { id: 'active', name: 'In progress', category: 'active' },
    { id: 'review', name: 'Review', category: 'review' },
    { id: 'done', name: 'Done', category: 'done' },
    { id: 'canceled', name: 'Canceled', category: 'canceled' },
];

export function docHash(content: string): string {
    let hash = 5381;

    for (let index = 0; index < content.length; index++) hash = ((hash * 33) ^ content.charCodeAt(index)) >>> 0;

    return `fx-${ hash.toString(16) }`;
}

const BOOKING_SKETCH = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#f3efe9"/><rect x="24" y="24" width="272" height="34" rx="8" fill="#fff" stroke="#d8d0c4"/><rect x="24" y="72" width="132" height="34" rx="8" fill="#fff" stroke="#d8d0c4"/><rect x="164" y="72" width="132" height="34" rx="8" fill="#fff" stroke="#d8d0c4"/><rect x="24" y="130" width="272" height="44" rx="10" fill="#fa8854"/></svg>';
const BOOKING_LOG = 'TypeError: Cannot read properties of undefined (reading \'price\')\n    at BookingForm (src/booking/BookingForm.tsx:42:18)\n';

const FIXTURE_ATTACHMENTS: FixtureAttachment[] = [
    { projectId: FIXTURE_PROJECT_ID, attachment: { id: 'a-sketch', name: 'booking-sketch.svg', mediaType: 'image/svg+xml', size: BOOKING_SKETCH.length }, content: BOOKING_SKETCH },
    { projectId: FIXTURE_PROJECT_ID, attachment: { id: 'a-log', name: 'booking-error.log', mediaType: 'text/plain', size: BOOKING_LOG.length }, content: BOOKING_LOG },
];

/** The docs folder of a folder that is in no fixture project, for a project of several folders. */
const API_DOCS: Record<string, string> = {
    'endpoints.md': '# Endpoints\n\n| Method | Path | Does |\n| --- | --- | --- |\n| GET | /availability | free cars in a date range |\n| POST | /bookings | books a car |\n',
    'decisions/rate-limits.md': '# Rate limits\n\nSixty requests a minute per partner key. A burst over it waits rather than fails.\n',
};

const FIXTURE_FILES = [
    'README.md',
    'package.json',
    'src/booking/index.tsx',
    'src/booking/BookingForm.tsx',
    'src/booking/price.ts',
    'src/booking/price.test.ts',
    'src/api/availability.ts',
    'src/mail/confirmation.ts',
    'src/db/schema.ts',
];

const API_FILES = [
    'README.md',
    'package.json',
    'src/routes/availability.ts',
    'src/routes/bookings.ts',
    'src/booking/price.ts',
    'src/limits.ts',
];

/** The docs tree as the daemon builds it: directories first, then files, each by name. */
export function docsTree(paths: string[]): DocNode[] {
    const root: DocNode[] = [];

    for (const path of paths) {
        const parts = path.split('/');
        let level = root;

        parts.forEach((name, index) => {
            const nodePath = parts.slice(0, index + 1).join('/');
            const isFile = index === parts.length - 1;
            let node = level.find(candidate => candidate.path === nodePath);

            if (!node) {
                node = isFile ? { path: nodePath, name, kind: 'file' } : { path: nodePath, name, kind: 'dir', children: [] };
                level.push(node);
            }

            level = node.children ?? [];
        });
    }

    const sort = (nodes: DocNode[]) => {
        nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
        nodes.forEach(node => node.children && sort(node.children));
    };

    sort(root);

    return root;
}

/** The favicon in Car Rental's folder: a car on a blue tile. */
const CAR_RENTAL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f6fed"/><path d="M9 14.5 11 10h10l2 4.5h1a1 1 0 0 1 1 1V21h-2.2a2.5 2.5 0 0 1-4.6 0h-4.4a2.5 2.5 0 0 1-4.6 0H7v-5.5a1 1 0 0 1 1-1z" fill="#fff"/></svg>';

export function createFixtureData(now = Date.now()): FixtureData {
    const ago = (minutes: number) => now - minutes * MINUTE;
    const projectId = FIXTURE_PROJECT_ID;

    // Seed order, not the list's: the transport answers with the personal space first, as the daemon does.
    const projects: Project[] = [
        {
            id: projectId,
            name: 'Car Rental',
            folders: [{ id: 'fld_car_rental', path: '/Users/dev/car-rental' }],
            taskPrefix: 'CAR',
            settings: { maxParallelRuns: 4, engine: 'claude', targetBranch: 'main' },
            createdAt: ago(60 * 24 * 12),
            position: 1,
        },
        {
            id: FIXTURE_EMPTY_PROJECT_ID,
            name: 'Clowdy',
            folders: [{ id: 'fld_clowdy', path: '/Users/dev/clowdy' }],
            taskPrefix: 'CLW',
            settings: {},
            createdAt: ago(60 * 24 * 3),
            position: 2,
        },
        {
            id: FIXTURE_PERSONAL_PROJECT_ID,
            name: 'Personal',
            folders: [{ id: 'fld_personal', path: '/Users/dev/Clowdy/Personal' }],
            taskPrefix: 'PER',
            settings: {},
            createdAt: ago(60 * 24 * 30),
            position: 0,
            personal: true,
        },
    ];

    const task = (number: number, title: string, statusId: string, rest: Partial<Task> = {}): Task => ({
        id: `t-${ number }`,
        projectId,
        number,
        key: `CAR-${ number }`,
        title,
        description: '',
        statusId,
        dependsOn: [],
        createdBy: { kind: 'user' },
        createdAt: ago(300 - number),
        updatedAt: ago(number),
        ...rest,
    });

    const tasks: Task[] = [
        task(20, 'Remove the legacy booking page', 'done', { description: 'The old three-step page is replaced by the single form.' }),
        task(21, 'Set up the booking schema', 'done', { createdBy: { kind: 'run', runId: 'r-orch-1' } }),
        task(22, 'Update the availability API', 'done', { dependsOn: ['t-21'], description: 'Return free cars for a date range in one call.' }),
        task(23, 'Weekend pricing rules', 'review', { dependsOn: ['t-22'], description: 'Weekend days cost 15% more. Cover the edge of a booking that spans a month end.' }),
        task(24, 'Update the booking form', 'active', {
            dependsOn: ['t-22'],
            createdBy: { kind: 'run', runId: 'r-orch-1' },
            description: 'One form instead of three steps.\n\n- pick dates and a car\n- show the total price while typing\n- confirm in the same view',
        }),
        task(25, 'Confirmation email template', 'active', { createdBy: { kind: 'run', runId: 'r-orch-1' }, description: 'A plain, short email with the booking summary.' }),
        task(26, 'Cancel a booking', 'todo', { dependsOn: ['t-24', 't-25'], description: 'Free until 24 hours before pickup.' }),
        task(27, 'Insurance options', 'todo', { dependsOn: ['t-24'] }),
        task(28, 'Search by location', 'backlog'),
        task(29, 'Print invoice as PDF', 'canceled', { description: 'Dropped: the email already carries the invoice.' }),
        task(30, 'Admin: fleet table', 'backlog', {
            createdBy: { kind: 'provider', provider: 'linear' },
            external: { provider: 'linear', externalId: 'ENG-412', url: 'https://linear.app/example/issue/ENG-412' },
        }),
    ];

    const chats: Chat[] = [
        { id: 'c-1', projectId, title: 'Simplify booking', mode: 'autopilot', orchestratorRunId: 'r-orch-1', createdAt: ago(95), updatedAt: ago(1) },
        { id: 'c-2', projectId, title: 'First version', mode: 'autopilot', orchestratorRunId: 'r-orch-2', createdAt: ago(60 * 24 * 5), updatedAt: ago(60 * 24 * 4) },
        { id: 'c-3', projectId, title: 'Architecture questions', mode: 'semi', orchestratorRunId: 'r-orch-3', createdAt: ago(40), updatedAt: ago(9) },
        { id: 'c-4', projectId, title: 'New chat', mode: 'autopilot', createdAt: ago(2), updatedAt: ago(2) },
    ];

    const worktree = (slug: string) => ({ path: `/Users/dev/.clowdy/worktrees/car-rental/${ slug }`, branch: `clowdy/${ slug }`, baseCommit: 'a1b2c3d' });
    const run = (id: string, name: string, role: Run['role'], status: Run['status'], rest: Partial<Run> = {}): Run => ({
        id,
        projectId,
        rootRunId: rest.parentRunId ? 'r-orch-1' : id,
        role,
        name,
        summary: '',
        status,
        engine: 'claude',
        model: 'claude-sonnet',
        createdAt: ago(60),
        ...rest,
    });

    const runs: Run[] = [
        run('r-orch-1', 'Orchestrator 01', 'orchestrator', 'running', { chatId: 'c-1', summary: 'Simplify booking', createdAt: ago(94), startedAt: ago(94), context: { used: 53000, size: 250000 } }),
        run('r-ex-07', 'Executor 07', 'executor', 'running', {
            parentRunId: 'r-orch-1',
            summary: 'Update the booking form',
            worktree: worktree('car-24-booking-form'),
            createdAt: ago(21),
            startedAt: ago(21),
        }),
        // Sub-agents of the orchestrator's own `Agent` calls (tc-agent-1, tc-agent-2 in its stream): cards there, not rows of the tree.
        run('r-na-01', 'Explore', 'executor', 'succeeded', {
            parentRunId: 'r-orch-1',
            origin: 'native',
            parentToolCallId: 'tc-agent-1',
            summary: 'Map the booking flow',
            result: 'Three step components in src/booking/steps.tsx share one context; the price is computed only on the last step.',
            createdAt: ago(93),
            startedAt: ago(93),
            finishedAt: ago(92),
        }),
        run('r-na-02', 'Explore', 'executor', 'running', {
            parentRunId: 'r-orch-1',
            origin: 'native',
            parentToolCallId: 'tc-agent-2',
            summary: 'Find where the price is computed',
            createdAt: ago(2),
            startedAt: ago(2),
        }),
        run('r-ver-02', 'Verifier 02', 'verifier', 'queued', {
            parentRunId: 'r-ex-07',
            summary: 'Check the form against the spec',
            statusReason: 'Waiting for a free slot (4 of 4 in use)',
            createdAt: ago(1),
        }),
        run('r-ex-08', 'Executor 08', 'executor', 'waiting_user', {
            parentRunId: 'r-orch-1',
            summary: 'Confirmation email and cancellation',
            statusReason: 'Asked which mail provider to use',
            worktree: worktree('car-25-confirmation-email'),
            createdAt: ago(21),
            startedAt: ago(21),
        }),
        run('r-ex-09', 'Executor 09', 'executor', 'succeeded', {
            parentRunId: 'r-orch-1',
            summary: 'Set up the booking schema',
            result: 'Added the `bookings` table and its migration. Typecheck and tests pass.',
            worktree: { ...worktree('car-21-booking-schema'), headCommit: 'f00dcafe' },
            createdAt: ago(80),
            startedAt: ago(80),
            finishedAt: ago(52),
        }),
        run('r-ex-10', 'Executor 10', 'executor', 'failed', {
            parentRunId: 'r-orch-1',
            summary: 'Weekend pricing rules',
            error: 'Typecheck failed in 3 files and the run could not repair them.',
            worktree: worktree('car-23-weekend-pricing'),
            createdAt: ago(70),
            startedAt: ago(70),
            finishedAt: ago(41),
        }),
        run('r-ex-12', 'Executor 12', 'executor', 'blocked', {
            parentRunId: 'r-orch-1',
            summary: 'Insurance options',
            statusReason: 'Blocked by CAR-24, which is still in progress',
            createdAt: ago(20),
        }),
        run('r-ex-13', 'Executor 13', 'executor', 'cancelled', {
            parentRunId: 'r-orch-1',
            summary: 'Print invoice as PDF',
            worktree: worktree('car-29-invoice-pdf'),
            createdAt: ago(75),
            startedAt: ago(75),
            finishedAt: ago(60),
        }),
        run('r-ex-14', 'Executor 14', 'executor', 'interrupted', {
            parentRunId: 'r-orch-1',
            summary: 'Search by location',
            statusReason: 'The daemon restarted while it was running',
            createdAt: ago(30),
            startedAt: ago(30),
            finishedAt: ago(25),
        }),
        run('r-orch-2', 'Orchestrator 02', 'orchestrator', 'succeeded', {
            chatId: 'c-2',
            summary: 'First version',
            result: 'The booking page, the fleet list and the price calculation are in.',
            createdAt: ago(60 * 24 * 5),
            startedAt: ago(60 * 24 * 5),
            finishedAt: ago(60 * 24 * 4),
        }),
        run('r-ex-15', 'Executor 15', 'executor', 'succeeded', {
            parentRunId: 'r-orch-2',
            rootRunId: 'r-orch-2',
            summary: 'Fleet list',
            createdAt: ago(60 * 24 * 5),
            startedAt: ago(60 * 24 * 5),
            finishedAt: ago(60 * 24 * 4 + 90),
        }),
        run('r-orch-3', 'Orchestrator 03', 'orchestrator', 'waiting_user', {
            chatId: 'c-3',
            summary: 'Architecture questions',
            statusReason: 'Asked how to store bookings',
            createdAt: ago(40),
            startedAt: ago(40),
        }),
        run('r-ex-17', 'Executor 17', 'executor', 'succeeded', {
            summary: 'Admin: fleet table',
            result: 'The table renders the fleet with sorting.',
            createdAt: ago(60 * 3),
            startedAt: ago(60 * 3),
            finishedAt: ago(60 * 2),
        }),
    ];

    const chatTaskLinks: ChatTaskLink[] = [20, 21, 22, 23, 24, 25, 26, 27].map(number => ({ chatId: 'c-1', taskId: `t-${ number }` }));

    chatTaskLinks.push({ chatId: 'c-2', taskId: 't-28' }, { chatId: 'c-2', taskId: 't-29' });

    const runTaskLinks: RunTaskLink[] = [
        { runId: 'r-orch-1', taskId: 't-24', relation: 'created' },
        { runId: 'r-orch-1', taskId: 't-25', relation: 'created' },
        { runId: 'r-orch-1', taskId: 't-21', relation: 'created' },
        { runId: 'r-ex-07', taskId: 't-24', relation: 'assigned' },
        { runId: 'r-ver-02', taskId: 't-24', relation: 'verifies' },
        // Two runs on one task, and one run on two tasks.
        { runId: 'r-ex-08', taskId: 't-25', relation: 'assigned' },
        { runId: 'r-ex-08', taskId: 't-26', relation: 'assigned' },
        { runId: 'r-ex-09', taskId: 't-21', relation: 'assigned' },
        { runId: 'r-ex-10', taskId: 't-23', relation: 'assigned' },
        { runId: 'r-ex-12', taskId: 't-27', relation: 'assigned' },
        { runId: 'r-ex-13', taskId: 't-29', relation: 'assigned' },
        { runId: 'r-ex-14', taskId: 't-28', relation: 'assigned' },
        { runId: 'r-ex-17', taskId: 't-30', relation: 'assigned' },
    ];

    const items: Record<string, StreamItem[]> = {};
    const stream = (runId: string, entries: Array<[number, StreamItemBody]>) => {
        items[runId] = entries.map(([minutesAgo, body], index) => ({ id: `${ runId }-${ index + 1 }`, runId, seq: index + 1, at: ago(minutesAgo), body }));
    };

    stream('r-orch-1', [
        [94, { kind: 'user', text: 'Simplify the booking flow: one form instead of three steps, and show the price while the person types.', attachments: FIXTURE_ATTACHMENTS.map(file => file.attachment) }],
        [94, { kind: 'assistant', done: true, text: 'I read the current flow. It has **three steps** and recalculates the price only on the last one.\n\nPlan:\n\n1. Move availability into one API call (`CAR-22`).\n2. Rebuild the form as one view (`CAR-24`).\n3. Send a short confirmation email (`CAR-25`).\n\nI will start the independent parts now.' }],
        [93, { kind: 'tool', toolCallId: 'tc-1', name: 'Grep', state: 'done', input: { pattern: 'BookingStep', path: 'src' }, output: 'src/booking/steps.tsx:12\nsrc/booking/steps.tsx:40\nsrc/booking/index.tsx:8' }],
        [93, {
            kind: 'tool',
            toolCallId: 'tc-agent-1',
            name: 'Agent',
            state: 'done',
            input: { subagent_type: 'Explore', description: 'Map the booking flow', prompt: 'Find the components of the booking flow and where each step keeps its state.' },
            output: 'Three step components in src/booking/steps.tsx share one context; the price is computed only on the last step.',
        }],
        [92, { kind: 'tool', toolCallId: 'tc-2', name: 'Read', state: 'done', input: { file_path: 'src/booking/index.tsx' }, output: 'export function Booking() {\n    return <Steps />;\n}' }],
        [90, { kind: 'tool', toolCallId: 'tc-3', name: 'create_task', state: 'done', input: { title: 'Update the booking form', dependsOn: ['CAR-22'] }, output: { key: 'CAR-24' } }],
        [89, { kind: 'note', text: '2 executors started' }],
        [60, { kind: 'assistant', done: true, text: 'Executor 09 finished the schema in `src/db/schema.ts`. Executor 10 failed on the pricing rules; I will look at its report before I retry.\n\n### What changed\n\n| File | Change |\n| --- | --- |\n| `src/db/schema.ts` | adds the `bookings` table |\n| `src/booking/price.ts` | weekend surcharge |\n\n```src/booking/price.ts\nexport const weekendRate = 1.15;\n```\n\n> The price must be visible before the person commits.\n\nSee [the decision](https://example.com/decision) and `CAR-23`.' }],
        [41, { kind: 'error', text: 'Executor 10 failed: Typecheck failed in 3 files and the run could not repair them.' }],
        // The result of `run_spawn` as agents hand it back: JSON text for the first, the tool's own object for the second.
        [21, {
            kind: 'tool',
            toolCallId: 'tc-spawn-07',
            name: 'run_spawn',
            state: 'done',
            input: { taskIds: ['CAR-24'], role: 'executor', prompt: 'Update the booking form: one view with dates, car and live price.', idempotencyKey: 'car-24-form' },
            output: JSON.stringify({ runId: 'r-ex-07', name: 'Executor 07', role: 'executor', status: 'running', duplicate: false }),
        }],
        [21, {
            kind: 'tool',
            toolCallId: 'tc-spawn-08',
            name: 'run_spawn',
            state: 'done',
            input: { taskIds: ['CAR-25', 'CAR-26'], role: 'executor', prompt: 'Write the confirmation email and the cancellation flow.', idempotencyKey: 'car-25-email' },
            output: { runId: 'r-ex-08', name: 'Executor 08', role: 'executor', status: 'running', duplicate: false },
        }],
        [21, { kind: 'note', text: '2 executors started' }],
        [20, { kind: 'assistant', done: true, text: 'Executor 07 is on the form, and Executor 08 asked which mail provider to use. I am waiting on you for that one.' }],
        [2, { kind: 'tool', toolCallId: 'tc-agent-2', name: 'Agent', state: 'running', input: { subagent_type: 'Explore', description: 'Find where the price is computed', prompt: 'Find where the booking price is computed and who calls it.' } }],
    ]);

    stream('r-na-01', [
        [93, { kind: 'tool', toolCallId: 'tc-1', name: 'Glob', state: 'done', input: { pattern: 'src/booking/**' }, output: 'src/booking/index.tsx\nsrc/booking/steps.tsx\nsrc/booking/price.ts' }],
        [93, { kind: 'tool', toolCallId: 'tc-2', name: 'Read', state: 'done', input: { file_path: 'src/booking/steps.tsx' }, output: 'export const steps = [Dates, Car, Confirm];' }],
        [92, { kind: 'assistant', done: true, text: 'Three step components in `src/booking/steps.tsx` share one context; the price is computed only on the last step.' }],
    ]);

    stream('r-na-02', [
        [2, { kind: 'assistant', done: true, text: 'Looking for the price helper and its callers.' }],
        [1, { kind: 'tool', toolCallId: 'tc-1', name: 'Grep', state: 'running', input: { pattern: 'useBookingPrice', path: 'src' } }],
    ]);

    stream('r-ex-07', [
        [21, { kind: 'user', text: 'Update the booking form (CAR-24): one view with dates, car and live price. Keep the existing validation messages.' }],
        [21, { kind: 'assistant', done: true, text: 'I will start by reading the current form and the price helper.' }],
        [20, { kind: 'tool', toolCallId: 'tc-1', name: 'Read', state: 'done', input: { file_path: 'src/booking/form.tsx' }, output: 'export function BookingForm() {\n    // ...\n}' }],
        [19, { kind: 'tool', toolCallId: 'tc-2', name: 'Grep', state: 'done', input: { pattern: 'useBookingPrice', path: 'src' }, output: 'src/booking/price.ts:4' }],
        [18, { kind: 'assistant', done: true, text: 'The form keeps its state per step. I will merge the steps into one component and call `useBookingPrice` on every change.' }],
        [16, {
            kind: 'tool',
            toolCallId: 'tc-3',
            name: 'Edit',
            state: 'done',
            input: { file_path: 'src/booking/form.tsx', old_string: 'const [step, setStep] = useState(0);\nconst next = () => setStep(step + 1);', new_string: 'const price = useBookingPrice(dates, car);\nconst canConfirm = dates.valid && car !== null;\nconst confirm = () => submit({ dates, car });' },
            output: 'The file was updated.',
        }],
        [14, { kind: 'tool', toolCallId: 'tc-4', name: 'Edit', state: 'done', input: { file_path: 'src/booking/steps.tsx' }, output: { added: 42, removed: 118 } }],
        [3, { kind: 'tool', toolCallId: 'tc-5', name: 'Bash', state: 'running', input: { command: 'bun run typecheck' } }],
        [1, { kind: 'assistant', done: false, text: 'Checking confirmation handling' }],
    ]);

    stream('r-ex-08', [
        [21, { kind: 'user', text: 'Write the confirmation email (CAR-25) and the cancellation flow (CAR-26).' }],
        [20, { kind: 'tool', toolCallId: 'tc-1', name: 'Glob', state: 'done', input: { pattern: 'src/**/mail*' }, output: [] }],
        [19, { kind: 'assistant', done: true, text: 'There is no mail code in the repository yet, so I need to know which provider to use.' }],
        [19, {
            kind: 'question',
            questionId: 'q-mail',
            text: 'Which mail provider should the confirmation email use?',
            options: [
                { id: 'smtp', label: 'Plain SMTP', consequence: 'No new dependency; you configure the host once.' },
                { id: 'resend', label: 'Resend', consequence: 'Adds an SDK and an API key to the setup.' },
                { id: 'postmark', label: 'Postmark', consequence: 'Adds an SDK; better delivery tracking.' },
            ],
            recommended: 'smtp',
        }],
    ]);

    stream('r-ex-09', [
        [80, { kind: 'user', text: 'Set up the booking schema (CAR-21).' }],
        [75, { kind: 'tool', toolCallId: 'tc-1', name: 'Write', state: 'done', input: { file_path: 'db/migrations/004_bookings.sql' }, output: { added: 18, removed: 0 } }],
        [60, { kind: 'tool', toolCallId: 'tc-2', name: 'Bash', state: 'done', input: { command: 'bun test' }, output: '12 pass\n0 fail' }],
        [52, { kind: 'assistant', done: true, text: 'Added the `bookings` table and its migration. Typecheck and tests pass.' }],
    ]);

    stream('r-ex-10', [
        [70, { kind: 'user', text: 'Weekend pricing rules (CAR-23).' }],
        [60, { kind: 'tool', toolCallId: 'tc-1', name: 'Bash', state: 'error', input: { command: 'bun run typecheck' }, error: 'src/booking/price.ts(31,9): error TS2322: Type string is not assignable to type number.' }],
        [41, { kind: 'error', text: 'Typecheck failed in 3 files and the run could not repair them.' }],
    ]);

    stream('r-orch-3', [
        [40, { kind: 'user', text: 'Should bookings live in SQLite or in plain files?' }],
        [39, { kind: 'assistant', done: true, text: 'Both work. The choice changes how reports are built, so I want your call before I continue.' }],
        [
            9,
            {
                kind: 'question',
                questionId: 'q-store',
                text: 'Where should bookings be stored?',
                options: [
                    { id: 'sqlite', label: 'SQLite', consequence: 'Queries and reports are simple; one file to back up.' },
                    { id: 'files', label: 'One JSON file per booking', consequence: 'Easy to read in git; slow to query past a few thousand.' },
                ],
                recommended: 'sqlite',
            },
        ],
    ]);

    stream('r-orch-2', [
        [60 * 24 * 5, { kind: 'user', text: 'Build the first version: fleet list, booking page, price calculation.' }],
        [60 * 24 * 5 - 1, { kind: 'assistant', done: true, text: 'I will start with the fleet list, then the booking page.' }],
        [60 * 24 * 5 - 2, { kind: 'tool', toolCallId: 'tc-o2-1', name: 'Read', state: 'done', input: { file_path: 'src/fleet/index.tsx' }, output: 'export function Fleet() {}' }],
        [60 * 24 * 5 - 9, { kind: 'tool', toolCallId: 'tc-o2-2', name: 'create_task', state: 'done', input: { title: 'Fleet list' }, output: { key: 'CAR-15' } }],
        [60 * 24 * 5 - 12, { kind: 'note', text: '1 executor started' }],
        [60 * 24 * 5 - 14, { kind: 'assistant', done: true, text: 'The booking page, the fleet list and the price calculation are in.' }],
        // Compact, pressed once the work was done: the agent's call with what it saved, as Claude reports it.
        [60 * 24 * 4 + 5, {
            kind: 'tool',
            toolCallId: 'tc-o2-compact',
            name: 'compact',
            state: 'done',
            input: { title: 'Compact conversation' },
            output: JSON.stringify({ trigger: 'manual', preTokens: 41_503, postTokens: 9_870, durationMs: 5_200 }),
        }],
    ]);

    const docs: Record<string, string> = {
        'README.md': '# Car Rental docs\n\nDecisions and specs for the booking service. Agents read this folder before they plan.\n',
        'decisions/booking-flow.md': '# Booking flow\n\nOne form, no steps.\n\n## Why\n\n- Three steps lost people on the second one.\n- The price must be visible before the person commits.\n\n## Rules\n\n- [x] Dates and car in one view\n- [x] Live price\n- [ ] Cancel up to 24 hours before pickup\n',
        'decisions/pricing.md': '# Pricing\n\nWeekend days cost 15% more. A booking that spans a month end is priced per day.\n',
        'specs/booking.md': '# Booking spec\n\n| Field | Type | Notes |\n| --- | --- | --- |\n| pickup | date | not in the past |\n| return | date | after pickup |\n| car | id | must be free in the range |\n',
    };

    const artifacts: Artifact[] = [
        { id: 'a-1', projectId, runId: 'r-ex-09', taskId: 't-21', kind: 'commit', title: 'Add the bookings table', ref: { sha: 'f00dcafe', branch: 'clowdy/car-21-booking-schema' }, createdAt: ago(52) },
        { id: 'a-2', projectId, runId: 'r-ex-07', taskId: 't-24', kind: 'diff', title: 'Changes in the booking form', ref: { files: 2, added: 42, removed: 118 }, createdAt: ago(14) },
        { id: 'a-3', projectId, runId: 'r-ex-10', taskId: 't-23', kind: 'check', title: 'Typecheck', ref: { command: 'bun run typecheck', exitCode: 2 }, createdAt: ago(41) },
    ];

    return {
        projects,
        git: {
            '/Users/dev/car-rental': { remoteUrl: 'git@github.com:acme/car-rental.git' },
            '/Users/dev/clowdy': { remoteUrl: 'https://github.com/acme/clowdy.git' },
            '/Users/dev/car-rental-api': { remoteUrl: 'git@github.com:acme/car-rental-api.git' },
        },
        statuses: { [projectId]: DEFAULT_STATUSES, [FIXTURE_EMPTY_PROJECT_ID]: DEFAULT_STATUSES, [FIXTURE_PERSONAL_PROJECT_ID]: DEFAULT_STATUSES },
        // As the daemon's migration leaves them: a chat that has an orchestrator records the engine and model it runs on.
        chats: chats.map((chat) => {
            const orchestrator = runs.find(candidate => candidate.id === chat.orchestratorRunId);

            return orchestrator ? { ...chat, engine: orchestrator.engine, ...(orchestrator.model && { model: orchestrator.model }) } : chat;
        }),
        tasks,
        runs,
        chatTaskLinks,
        runTaskLinks,
        items,
        artifacts,
        // `car-rental-api` belongs to no project yet: add it to Car Rental to see the documents, files and remotes of two folders.
        docs: { '/Users/dev/car-rental': docs, '/Users/dev/car-rental-api': API_DOCS },
        files: { '/Users/dev/car-rental': FIXTURE_FILES, '/Users/dev/car-rental-api': API_FILES },
        // Car Rental shows a favicon of its own; Clowdy has none, so it keeps the folder icon until one is uploaded.
        icons: { '/Users/dev/car-rental': CAR_RENTAL_ICON },
        attachments: structuredClone(FIXTURE_ATTACHMENTS),
        skills: fixtureSkills(projectId),
        skillWarnings: ['~/.claude/skills: Skipped "old-notes": it has no description'],
        agents: fixtureAgents(now),
        agentModels: fixtureAgentModels(now),
    };
}
