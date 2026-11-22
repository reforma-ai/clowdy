import { DOC_SOURCES, PERMISSION_PRESET_NAMES, PERMISSION_PRESETS } from '@clowdy/protocol';

import type {
    AgentInfo,
    AgentModels,
    AgentPermissions,
    Artifact,
    Attachment,
    Chat,
    ChatTaskLink,
    DocNode,
    DocsSource,
    FolderGit,
    PermissionPresetId,
    Project,
    ProjectId,
    Run,
    RunTaskLink,
    SkillEngine,
    SkillEntry,
    StreamItem,
    StreamItemBody,
    Task,
    TaskComment,
    TaskStatus,
} from '@clowdy/protocol';

/** Everything the fixture daemon holds. Plain data: the transport mutates it and announces the changes. */
export interface FixtureData {
    projects: Project[];
    /** What `git` says in each folder, by the folder's path: the `origin` address and the branch (a short hash with `detached`); a folder without an entry has neither. */
    git: Record<string, { remoteUrl?: string; branch?: string; detached?: true }>;
    statuses: Record<string, TaskStatus[]>;
    chats: Chat[];
    /** Every task of every project, the archived ones too: the snapshot leaves those out, and `getTaskDetail` and the archive's pages read them. */
    tasks: Task[];
    /** The comments of the tasks, in no order: the transport sorts what it answers. */
    comments: TaskComment[];
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
    /**
     * Markdown files of each folder's `.briefback`, by the folder's path, then by the path under it: the plans, research pages and handoffs the work is done from. A
     * folder that is not listed has no `.briefback`.
     */
    briefback: Record<string, Record<string, string>>;
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
        skill('system', 'clowdy:orchestrate', 'Entry skill of every chat: classify the message, plan a task graph, do the work yourself or with your own sub-agents, verify the result with commands, and report briefly.'),
        skill('system', 'clowdy:scaffold', 'Start a new application from nothing: product statement, stack, one verified skeleton, then the first task graph.'),
        skill('system', 'clowdy:semi-manual', 'Involve the user in the decisions that matter through question cards, then build with autopilot discipline.'),
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
/** The run (a native sub-agent), and the two items of its stream, that the fixture timeline keeps changing. */
export const FIXTURE_LIVE_RUN_ID = 'r-na-03';
export const FIXTURE_LIVE_TOOL_ID = 'r-na-03-7';
export const FIXTURE_LIVE_TEXT_ID = 'r-na-03-8';

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

/** The presets of an agent whose provider has modes of its own, in the words of the real Claude Code and Codex providers; none chosen, `auto` is the default. */
function modePresets(descriptions: Record<PermissionPresetId, string>): AgentPermissions {
    return { presets: PERMISSION_PRESETS.map(id => ({ id, name: PERMISSION_PRESET_NAMES[id], description: descriptions[id] })), default: 'auto' };
}

/** The pair of an agent whose provider declares none: Clowdy asks, or allows everything; `full` is the default, as such an agent has always run. */
function clientPresets(): AgentPermissions {
    return {
        presets: [
            { id: 'ask', name: PERMISSION_PRESET_NAMES.ask, description: 'Clowdy asks you before the agent does anything it asks permission for' },
            { id: 'full', name: PERMISSION_PRESET_NAMES.full, description: 'Clowdy allows everything the agent asks permission for' },
        ],
        default: 'full',
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
            permissions: modePresets({
                'ask': 'Asks before every edit and command',
                'accept-edits': 'Applies file edits, asks before commands and anything else',
                'auto': 'Approves what its own check finds safe, asks about the rest',
                'full': 'Never asks, edits any file and runs any command',
            }),
        },
        {
            id: 'codex',
            name: 'Codex',
            custom: false,
            enabled: true,
            status: 'ready',
            path: '/opt/homebrew/bin/codex',
            version: '0.166.0',
            launch: 'bun x --bun @agentclientprotocol/codex-acp@2.8.0',
            fetches: '@agentclientprotocol/codex-acp@2.8.0',
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
            permissions: modePresets({
                'ask': 'Asks before editing files or using the network',
                'accept-edits': 'Edits workspace files, asks before going outside them or using the network',
                'auto': 'Reviews risky actions itself, asks about the rest',
                'full': 'No sandbox, never asks',
            }),
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
            permissions: clientPresets(),
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

const BOOKING_SKETCH = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#f3efe9"/><rect x="24" y="24" width="272" height="34" rx="8" fill="#fff" stroke="#d8d0c4"/><rect x="24" y="72" width="132" height="34" rx="8" fill="#fff" stroke="#d8d0c4"/><rect x="164" y="72" width="132" height="34" rx="8" fill="#fff" stroke="#d8d0c4"/><rect x="24" y="130" width="272" height="44" rx="10" fill="#fa8854"/></svg>';
const BOOKING_LOG = 'TypeError: Cannot read properties of undefined (reading \'price\')\n    at BookingForm (src/booking/BookingForm.tsx:42:18)\n';

const FIXTURE_ATTACHMENTS: FixtureAttachment[] = [
    { projectId: FIXTURE_PROJECT_ID, attachment: { id: 'a-sketch', name: 'booking-sketch.svg', mediaType: 'image/svg+xml', size: BOOKING_SKETCH.length }, content: BOOKING_SKETCH },
    { projectId: FIXTURE_PROJECT_ID, attachment: { id: 'a-log', name: 'booking-error.log', mediaType: 'text/plain', size: BOOKING_LOG.length }, content: BOOKING_LOG },
];

/** What the threads of Ship the checkout said last: their streams end with it, and the notices their parents were told carry it. */
const CURRENCY_ANSWER = 'Every currency in the table has two decimals except JPY, which has none.';
const REFUND_ANSWER = 'The refund tests are in `src/payments/refund.test.ts`: 14 cases, all passing.';
const MIGRATION_FAILURE = 'The migration stopped: the column amount_cents already exists in staging';
const LOAD_ANSWER = 'The short run held 120 requests a second with no errors. The long run is still going.';

/** The `.briefback` of Car Rental: one feature that has all three kinds of page, a plan, a handoff and a research page. */
const BRIEFBACK: Record<string, string> = {
    'weekend-pricing/plan.md': '# Weekend pricing\n\n> Keep this plan current during implementation.\n\n**Goal:** Weekend days cost 15% more, and the person sees it before they commit.\n\n## Stage 1 \u2014 The rate\n\n- [x] Complete\n  - [x] `weekendRate` in `src/booking/price.ts`\n  - [x] tests for a booking that spans a month end\n\n## Stage 2 \u2014 The form\n\n- [ ] Complete\n  - [ ] show the surcharge as its own line\n',
    'weekend-pricing/handoff.md': '# Handoff: weekend pricing\n\nStage 1 is committed. Next: Stage 2, the surcharge line in `BookingForm.tsx`. The rate is a constant, not a setting.\n',
    'weekend-pricing/research/competitors.md': '# How others show a weekend surcharge\n\nTwo of the five rental sites show it as a separate line; the others fold it into the daily rate.\n',
};

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

/**
 * What `GET git` answers for a fixture folder: no repository when `git` says nothing of it, else the branch it has checked out, a few more branches (local and
 * `origin`'s), `origin/main` as the default one, and two worktrees: the folder itself and one Clowdy made for a chat, with changes in it.
 */
export function fixtureFolderGit(path: string, head: { branch?: string; detached?: true } | undefined): FolderGit {
    if (!head?.branch) return { isRepository: false };

    const name = path.split('/').filter(Boolean).at(-1) ?? 'folder';
    const locals = [...new Set([...(head.detached ? [] : [head.branch]), 'main', 'dev', 'feature/payments'])];

    return {
        isRepository: true,
        branch: head.branch,
        ...(head.detached && { detached: true as const }),
        defaultBranch: 'origin/main',
        branches: [...locals.map(branch => ({ name: branch, remote: false })), ...['origin/main', 'origin/dev'].map(branch => ({ name: branch, remote: true }))],
        worktrees: [
            { path, ...(!head.detached && { branch: head.branch }), head: 'a1b2c3d', main: true, dirty: false },
            { path: `/Users/dev/Clowdy/workspaces/${ name }/ab12cd34/${ name }`, branch: 'clowdy/ab12cd34', head: '9f8e7d6', main: false, dirty: true },
        ],
    };
}

/**
 * The document sources of a folder as the daemon lists them: those of the registry that have files here, in its order, each with its tree. `files` is by the id of the
 * source, then by the path under its root.
 */
export function docsSources(files: Record<string, Record<string, string> | undefined>): DocsSource[] {
    return DOC_SOURCES.flatMap(({ id, label, root }) => {
        const paths = Object.keys(files[id] ?? {});

        return paths.length > 0 ? [{ id, label, root, nodes: docsTree(paths) }] : [];
    });
}

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

export const FIXTURE_FORK_CHAT_ID = 'c-7';
export const FIXTURE_FORK_RUN_ID = 'r-orch-7';

/**
 * Adds to `data` a chat that is a fork of First version (`c-2`) at its final answer, and gives it back: the history copied through that answer (the same
 * words, times and flags, new ids), then a turn of its own, so the divider of a fork has something on each side. Not in `createFixtureData`, because
 * a chat more in the car project moves the counts and the order that other screens' tests read; a test or a build that wants a fork asks for it. A
 * fork made by `chat.fork` on `c-2` in a running fixture is the same thing made live.
 */
export function withFixtureFork(data: FixtureData, now = Date.now()): FixtureData {
    const ago = (minutes: number) => now - minutes * MINUTE;
    const source = data.items['r-orch-2'].slice(0, 6);
    const own: Array<[number, StreamItemBody]> = [
        [60 * 24 * 3 - 1, { kind: 'user', text: 'Add the weekend surcharge to the price.' }],
        [60 * 24 * 3 - 4, { kind: 'assistant', done: true, text: 'The weekend surcharge is in `src/booking/price.ts`.' }],
    ];
    const items: StreamItem[] = [
        ...source.map(item => ({ ...structuredClone(item), id: `${ FIXTURE_FORK_RUN_ID }-${ item.seq }`, runId: FIXTURE_FORK_RUN_ID })),
        ...own.map(([minutes, body], index): StreamItem => ({ id: `${ FIXTURE_FORK_RUN_ID }-${ source.length + index + 1 }`, runId: FIXTURE_FORK_RUN_ID, seq: source.length + index + 1, at: ago(minutes), body })),
    ];
    const orchestrator = data.runs.find(run => run.id === 'r-orch-2') as Run;

    // The first message of a turn can be edited, and the answer that ends one forked: the copy keeps the first turn's flags, and the second turn has its own.
    Object.assign(items[6], { canEdit: true });
    Object.assign(items[7], { canFork: true });
    data.items[FIXTURE_FORK_RUN_ID] = items;
    data.runs.push({
        id: FIXTURE_FORK_RUN_ID,
        projectId: orchestrator.projectId,
        rootRunId: FIXTURE_FORK_RUN_ID,
        chatId: FIXTURE_FORK_CHAT_ID,
        role: 'orchestrator',
        name: 'Orchestrator 12',
        summary: '(1) First version',
        status: 'succeeded',
        engine: orchestrator.engine,
        ...(orchestrator.model && { model: orchestrator.model }),
        sessionId: 'fake-session-7',
        result: 'The weekend surcharge is in `src/booking/price.ts`.',
        createdAt: ago(60 * 24 * 3 + 1),
        startedAt: ago(60 * 24 * 3 + 1),
        finishedAt: ago(60 * 24 * 3 - 5),
    });
    data.chats.push({
        id: FIXTURE_FORK_CHAT_ID,
        projectId: orchestrator.projectId,
        title: '(1) First version',
        mode: 'autopilot',
        engine: orchestrator.engine,
        ...(orchestrator.model && { model: orchestrator.model }),
        orchestratorRunId: FIXTURE_FORK_RUN_ID,
        forkedFrom: { chatId: 'c-2', atSeq: 6 },
        createdAt: ago(60 * 24 * 3 + 1),
        updatedAt: ago(60 * 24 * 3 - 5),
    });

    return data;
}

export const FIXTURE_APPROVALS_CHAT_ID = 'c-8';
export const FIXTURE_APPROVALS_RUN_ID = 'r-orch-8';

/**
 * Adds to `data` a chat whose agent waits for the person's permission, and gives it back: one request already answered ("for the session"), then three that
 * are open, a command long enough to be cut, a change to files and a tool, so every body of the approval card has a place on the screen. Not in
 * `createFixtureData`, for the reason `withFixtureFork` gives: a chat more in the car project moves the counts and the order other screens' tests read.
 */
export function withFixtureApprovals(data: FixtureData, now = Date.now()): FixtureData {
    const ago = (minutes: number) => now - minutes * MINUTE;
    const orchestrator = data.runs.find(run => run.id === 'r-orch-3') as Run;
    const approval = (id: number, fields: Pick<Extract<StreamItemBody, { kind: 'approval' }>, 'title' | 'subject'> & Partial<Extract<StreamItemBody, { kind: 'approval' }>>): StreamItemBody => ({
        kind: 'approval',
        approvalId: `apv-${ id }`,
        decisions: ['allow_once', 'allow_always', 'reject'],
        state: 'open',
        ...fields,
    });
    const checks = 'set -e\ncd src/booking\nbun run test -- --coverage\nbun run typecheck\ngit diff --stat\necho "all checks passed"';
    const paths = ['src/booking/price.ts', 'src/booking/steps/confirmation/summary.tsx', 'src/booking/__tests__/price.test.ts'];
    const entries: Array<[number, StreamItemBody]> = [
        [20, { kind: 'user', text: 'Run the booking tests and the type check, then update the price helper and publish the rules.' }],
        [19, { kind: 'assistant', done: true, text: 'I will ask before anything that changes your files or leaves this machine.' }],
        // A call comes first, as the daemon writes it, and the request about it after it; the call of an open request is still running.
        [18, { kind: 'tool', toolCallId: 'tc-o8-1', name: 'Bash', state: 'done', input: { command: 'bun run test src/booking' }, output: '12 pass, 0 fail' }],
        [18, approval(1, { toolCallId: 'tc-o8-1', title: 'bun run test src/booking', subject: { kind: 'command', command: 'bun run test src/booking' }, state: 'decided', decision: 'allow_always' })],
        [5, { kind: 'tool', toolCallId: 'tc-o8-2', name: 'Bash', state: 'running', input: { command: checks } }],
        [5, approval(2, { toolCallId: 'tc-o8-2', title: 'Run the checks', subject: { kind: 'command', command: checks, cwd: '/Users/dev/car-rental' } })],
        [4, { kind: 'tool', toolCallId: 'tc-o8-3', name: 'Edit', state: 'running', input: { file_path: paths[0], old_string: 'const SURCHARGE = 0.1', new_string: 'const SURCHARGE = 0.15' } }],
        [4, approval(3, { toolCallId: 'tc-o8-3', title: 'Edit src/booking/price.ts', subject: { kind: 'file_change', paths } })],
        [3, { kind: 'tool', toolCallId: 'tc-o8-4', name: 'mcp__docs__publish', state: 'running', input: { title: 'Booking rules' } }],
        [3, approval(4, { toolCallId: 'tc-o8-4', title: 'Publish the booking rules', subject: { kind: 'tool_use', tool: 'mcp__docs__publish', detail: 'Publish "Booking rules" to the shared docs' }, decisions: ['allow_once', 'reject'] })],
    ];

    data.items[FIXTURE_APPROVALS_RUN_ID] = entries.map(([minutes, body], index): StreamItem => ({ id: `${ FIXTURE_APPROVALS_RUN_ID }-${ index + 1 }`, runId: FIXTURE_APPROVALS_RUN_ID, seq: index + 1, at: ago(minutes), body }));
    data.runs.push({
        id: FIXTURE_APPROVALS_RUN_ID,
        projectId: orchestrator.projectId,
        rootRunId: FIXTURE_APPROVALS_RUN_ID,
        chatId: FIXTURE_APPROVALS_CHAT_ID,
        role: 'orchestrator',
        name: 'Orchestrator 08',
        summary: 'Run the booking checks',
        status: 'waiting_user',
        statusReason: 'Waiting for your approval',
        engine: orchestrator.engine,
        ...(orchestrator.model && { model: orchestrator.model }),
        createdAt: ago(20),
        startedAt: ago(20),
    });
    data.chats.push({
        id: FIXTURE_APPROVALS_CHAT_ID,
        projectId: orchestrator.projectId,
        title: 'Run the booking checks',
        mode: 'autopilot',
        engine: orchestrator.engine,
        ...(orchestrator.model && { model: orchestrator.model }),
        orchestratorRunId: FIXTURE_APPROVALS_RUN_ID,
        createdAt: ago(20),
        updatedAt: ago(3),
    });

    return data;
}

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

    // A closed task has the time it closed, as the daemon's migration gives a task that was already closed (its last change).
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
        ...(['done', 'canceled'].includes(statusId) && { closedAt: ago(number) }),
        ...rest,
    });
    // One archive batch, as `task.archive` writes it: every task of it carries the same time.
    const archivedAt = ago(60 * 24 * 2);

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
        // A tree of tasks, as `task create --parent` makes it: Payments holds four tasks and one of them holds two, over most of the workflow, and the canceled
        // one is left out of the roll-up. Refund flow carries a checklist in its description, Card checkout the comments.
        task(31, 'Payments', 'active', { description: 'Take card payments at checkout, and give the money back.\n\nThe tasks inside it are the stages.' }),
        task(32, 'Card checkout', 'active', { parentId: 't-31', createdBy: { kind: 'run', runId: 'r-orch-1' }, description: 'The card form and the payment call.' }),
        task(33, 'Tokenize the card in the browser', 'done', { parentId: 't-32' }),
        task(34, 'Handle a declined card', 'todo', { parentId: 't-32', dependsOn: ['t-33'], description: 'Show the reason and keep what the person typed.' }),
        task(35, 'Refund flow', 'todo', {
            parentId: 't-31',
            description: 'Steps to cover:\n\n- [x] Refund a whole booking\n- [x] Refund after a cancel\n- [ ] Refund part of a booking\n- [ ] Tell the person by email\n- [ ] Show the refund in the booking list',
        }),
        task(36, 'Payment receipts by email', 'review', { parentId: 't-31' }),
        task(37, 'Split a payment between two cards', 'canceled', { parentId: 't-31', description: 'Dropped: nobody asked for it.' }),
        // An archived piece: a finished task with two tasks inside it, archived together. The snapshot leaves them out; the archive's page lists them.
        task(38, 'Clean up the admin pages', 'done', { archivedAt }),
        task(39, 'Remove the old reports page', 'done', { parentId: 't-38', archivedAt }),
        task(40, 'Drop the admin theme switch', 'canceled', { parentId: 't-38', archivedAt }),
    ];

    const comments: TaskComment[] = [
        { id: 'cmt_A001', taskId: 't-32', author: { kind: 'user' }, body: 'Use the sandbox keys until the checkout is reviewed.', createdAt: ago(60 * 5) },
        {
            id: 'cmt_A002',
            taskId: 't-32',
            author: { kind: 'run', runId: 'r-orch-1' },
            body: 'The form posts to `/api/pay`.\n\n- the card number never reaches our server\n- a declined card answers `402`\n\nNext: the declined state (`CAR-34`).',
            createdAt: ago(60 * 4),
        },
        { id: 'cmt_A003', taskId: 't-32', author: { kind: 'user' }, body: 'Looks right. Keep the amount in cents.', createdAt: ago(60 * 3), editedAt: ago(60 * 2) },
    ];

    const chats: Chat[] = [
        { id: 'c-1', projectId, title: 'Simplify booking', mode: 'autopilot', orchestratorRunId: 'r-orch-1', createdAt: ago(95), updatedAt: ago(1) },
        { id: 'c-2', projectId, title: 'First version', mode: 'autopilot', orchestratorRunId: 'r-orch-2', createdAt: ago(60 * 24 * 5), updatedAt: ago(60 * 24 * 4) },
        { id: 'c-3', projectId, title: 'Architecture questions', mode: 'semi', orchestratorRunId: 'r-orch-3', createdAt: ago(40), updatedAt: ago(9) },
        { id: 'c-4', projectId, title: 'New chat', mode: 'autopilot', createdAt: ago(2), updatedAt: ago(2) },
        // Its orchestrator started two commands in the background and waits for them: the strip above the message box counts them.
        { id: 'c-5', projectId, title: 'Check the booking changes', mode: 'autopilot', orchestratorRunId: 'r-orch-5', createdAt: ago(30), updatedAt: ago(5) },
        /*
         * A chat whose agent handed the work to threads (`clowdy thread spawn`) and rests while they work, so its dot is green for them: Fix the price
         * rounding works and has a thread of its own, which finished while it worked (the notice waits in its queue); Write the refund tests finished and
         * Migrate the payments table failed, both told in the parent's stream with Load test the checkout, which waits for its background work.
         */
        { id: 'c-6', projectId, title: 'Ship the checkout', mode: 'autopilot', orchestratorRunId: 'r-orch-6', createdAt: ago(50), updatedAt: ago(3) },
        {
            id: 'c-6a',
            projectId,
            title: 'Fix the price rounding',
            mode: 'autopilot',
            parentChatId: 'c-6',
            orchestratorRunId: 'r-orch-6a',
            queue: [{
                id: 'q-notice-6a',
                mode: 'queue',
                text: 'Thread "Check the currency table" finished',
                content: 'Thread "Check the currency table" finished.',
                from: { kind: 'threadNotice', threads: [{ chatId: 'c-6a1', title: 'Check the currency table', outcome: 'finished', text: CURRENCY_ANSWER }] },
                createdAt: ago(25),
            }],
            createdAt: ago(48),
            updatedAt: ago(2),
        },
        { id: 'c-6a1', projectId, title: 'Check the currency table', mode: 'autopilot', parentChatId: 'c-6a', orchestratorRunId: 'r-orch-6a1', createdAt: ago(46), updatedAt: ago(25) },
        { id: 'c-6b', projectId, title: 'Write the refund tests', mode: 'autopilot', parentChatId: 'c-6', orchestratorRunId: 'r-orch-6b', createdAt: ago(47.5), updatedAt: ago(20) },
        { id: 'c-6c', projectId, title: 'Migrate the payments table', mode: 'autopilot', parentChatId: 'c-6', orchestratorRunId: 'r-orch-6c', createdAt: ago(47), updatedAt: ago(20) },
        { id: 'c-6e', projectId, title: 'Load test the checkout', mode: 'autopilot', parentChatId: 'c-6', orchestratorRunId: 'r-orch-6e', createdAt: ago(46.5), updatedAt: ago(20) },
    ];

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
        // Sub-agents of the orchestrator's own `Agent` calls (tc-agent-1 to tc-agent-4 in its stream): cards there, never rows of the Agents list.
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
            // Its session can end it alone (Claude Code over ACP v2): the row has a Stop of its own.
            canStopAlone: true,
            summary: 'Find where the price is computed',
            createdAt: ago(2),
            startedAt: ago(2),
        }),
        // The one the timeline plays: it types the form while the app is open (its stream is the long one).
        run('r-na-03', 'general-purpose', 'executor', 'running', {
            parentRunId: 'r-orch-1',
            origin: 'native',
            parentToolCallId: 'tc-agent-3',
            canStopAlone: true,
            summary: 'Update the booking form',
            createdAt: ago(21),
            startedAt: ago(21),
        }),
        run('r-na-04', 'general-purpose', 'executor', 'failed', {
            parentRunId: 'r-orch-1',
            origin: 'native',
            parentToolCallId: 'tc-agent-4',
            summary: 'Weekend pricing rules',
            error: 'Typecheck failed in 3 files and the run could not repair them.',
            createdAt: ago(70),
            startedAt: ago(70),
            finishedAt: ago(41),
        }),
        run('r-orch-2', 'Orchestrator 02', 'orchestrator', 'succeeded', {
            chatId: 'c-2',
            summary: 'First version',
            result: 'The booking page, the fleet list and the price calculation are in.',
            createdAt: ago(60 * 24 * 5),
            startedAt: ago(60 * 24 * 5),
            finishedAt: ago(60 * 24 * 4),
        }),
        run('r-na-06', 'general-purpose', 'executor', 'succeeded', {
            parentRunId: 'r-orch-2',
            rootRunId: 'r-orch-2',
            origin: 'native',
            parentToolCallId: 'tc-o2-agent',
            summary: 'Fleet list',
            result: 'The fleet list renders every car with its status.',
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
        run('r-orch-5', 'Orchestrator 05', 'orchestrator', 'waiting_background', {
            chatId: 'c-5',
            summary: 'Check the booking changes',
            statusReason: 'Waiting for background work',
            background: [
                // The first can be stopped alone (a terminal the agent lets the client cancel): its row has a Stop of its own. The second only ends with the run.
                { id: 'bg-1', kind: 'command', title: 'bun run test', canStopAlone: true },
                { id: 'bg-2', kind: 'command', title: 'bun run typecheck' },
            ],
            createdAt: ago(30),
            startedAt: ago(30),
            context: { used: 31000, size: 250000 },
        }),
        // The orchestrators of Ship the checkout and of its threads: a thread's orchestrator is a root run of its own chat, never a child run.
        run('r-orch-6', 'Orchestrator 06', 'orchestrator', 'succeeded', { chatId: 'c-6', summary: 'Ship the checkout', createdAt: ago(50), startedAt: ago(50), finishedAt: ago(9) }),
        run('r-orch-6a', 'Orchestrator 07', 'orchestrator', 'running', { chatId: 'c-6a', summary: 'Fix the price rounding', createdAt: ago(48), startedAt: ago(48) }),
        run('r-orch-6a1', 'Orchestrator 08', 'orchestrator', 'succeeded', { chatId: 'c-6a1', summary: 'Check the currency table', createdAt: ago(46), startedAt: ago(46), finishedAt: ago(25) }),
        run('r-orch-6b', 'Orchestrator 09', 'orchestrator', 'succeeded', { chatId: 'c-6b', summary: 'Write the refund tests', createdAt: ago(47.5), startedAt: ago(47.5), finishedAt: ago(20) }),
        run('r-orch-6c', 'Orchestrator 10', 'orchestrator', 'failed', {
            chatId: 'c-6c',
            summary: 'Migrate the payments table',
            error: MIGRATION_FAILURE,
            createdAt: ago(47),
            startedAt: ago(47),
            finishedAt: ago(20),
        }),
        run('r-orch-6e', 'Orchestrator 11', 'orchestrator', 'waiting_background', {
            chatId: 'c-6e',
            summary: 'Load test the checkout',
            engine: 'codex',
            model: 'gpt-6.2-sol',
            statusReason: 'Waiting for background work',
            background: [{ id: 'bg-k6', kind: 'command', title: 'k6 run checkout-long.js' }],
            createdAt: ago(46.5),
            startedAt: ago(46.5),
        }),
    ];

    const chatTaskLinks: ChatTaskLink[] = [20, 21, 22, 23, 24, 25, 26, 27].map(number => ({ chatId: 'c-1', taskId: `t-${ number }` }));

    chatTaskLinks.push({ chatId: 'c-2', taskId: 't-28' }, { chatId: 'c-2', taskId: 't-29' });

    // The runs on a task are the orchestrators of the chats working on it: two runs on one task, and one run on two tasks.
    const runTaskLinks: RunTaskLink[] = [
        { runId: 'r-orch-1', taskId: 't-24', relation: 'created' },
        { runId: 'r-orch-1', taskId: 't-25', relation: 'created' },
        { runId: 'r-orch-1', taskId: 't-21', relation: 'created' },
        { runId: 'r-orch-1', taskId: 't-24', relation: 'assigned' },
        { runId: 'r-orch-1', taskId: 't-25', relation: 'assigned' },
        { runId: 'r-orch-5', taskId: 't-24', relation: 'assigned' },
        { runId: 'r-orch-2', taskId: 't-20', relation: 'assigned' },
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
        [70, {
            kind: 'tool',
            toolCallId: 'tc-agent-4',
            name: 'Agent',
            state: 'error',
            input: { subagent_type: 'general-purpose', description: 'Weekend pricing rules', prompt: 'Add the weekend surcharge to the price helper and keep the typecheck green.' },
            error: 'Typecheck failed in 3 files and the run could not repair them.',
        }],
        [60, { kind: 'assistant', done: true, text: 'The schema is in `src/db/schema.ts`. The pricing rules failed the typecheck; I will look at the report before I retry.\n\n### What changed\n\n| File | Change |\n| --- | --- |\n| `src/db/schema.ts` | adds the `bookings` table |\n| `src/booking/price.ts` | weekend surcharge |\n\n```src/booking/price.ts\nexport const weekendRate = 1.15;\n```\n\n> The price must be visible before the person commits.\n\nSee [the decision](https://example.com/decision) and `CAR-23`.' }],
        [41, { kind: 'note', text: 'Background command finished: bun run typecheck' }],
        [41, { kind: 'error', text: 'The agent stopped and was started again' }],
        [21, {
            kind: 'tool',
            toolCallId: 'tc-agent-3',
            name: 'Agent',
            state: 'running',
            input: { subagent_type: 'general-purpose', description: 'Update the booking form', prompt: 'Update the booking form (CAR-24): one view with dates, car and live price. Keep the existing validation messages.' },
        }],
        [20, { kind: 'assistant', done: true, text: 'A sub-agent is on the form. I will check what it hands back before I move on.' }],
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

    stream('r-na-03', [
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

    stream('r-na-04', [
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

    // The turn ended with two commands still running in the background: the session stays open, and their results arrive as a turn of the agent's own.
    stream('r-orch-5', [
        [30, { kind: 'user', text: 'Run the tests and the type check, and tell me when both are done.' }],
        [29, { kind: 'assistant', done: true, text: 'Both take a few minutes, so I will start them in the background.' }],
        [29, { kind: 'tool', toolCallId: 'tc-o5-1', name: 'Bash', state: 'done', input: { command: 'bun run test', run_in_background: true }, output: 'Command running in background with ID: bg-1' }],
        [29, { kind: 'tool', toolCallId: 'tc-o5-2', name: 'Bash', state: 'done', input: { command: 'bun run typecheck', run_in_background: true }, output: 'Command running in background with ID: bg-2' }],
        [28, { kind: 'assistant', done: true, text: 'Both are running. I will report here when they finish.' }],
    ]);

    // The parent: it started four threads, was told when three of them stopped, and answered the one that asked it something.
    const fromParent = { kind: 'thread', chatId: 'c-6', title: 'Ship the checkout' } as const;

    stream('r-orch-6', [
        [50, { kind: 'user', text: 'Ship the new checkout: fix the price rounding, write the refund tests, migrate the payments table and load test the whole flow.' }],
        [49, { kind: 'assistant', done: true, text: 'Four parts that do not depend on each other, so each gets a thread of its own. I will stay here and put the results together.' }],
        [48, { kind: 'tool', toolCallId: 'tc-o6-1', name: 'Bash', state: 'done', input: { command: 'clowdy thread spawn --title "Fix the price rounding" --prompt-file rounding.md', description: 'Start a thread for the price rounding' }, output: 'c-6a' }],
        [47.5, { kind: 'tool', toolCallId: 'tc-o6-2', name: 'Bash', state: 'done', input: { command: 'clowdy thread spawn --title "Write the refund tests" --prompt-file refunds.md', description: 'Start a thread for the refund tests' }, output: 'c-6b' }],
        [47, { kind: 'tool', toolCallId: 'tc-o6-3', name: 'Bash', state: 'done', input: { command: 'clowdy thread spawn --title "Migrate the payments table" --prompt-file migration.md', description: 'Start a thread for the migration' }, output: 'c-6c' }],
        [46.5, { kind: 'tool', toolCallId: 'tc-o6-4', name: 'Bash', state: 'done', input: { command: 'clowdy thread spawn --title "Load test the checkout" --engine codex --prompt-file load.md', description: 'Start a thread for the load test' }, output: 'c-6e' }],
        [46, { kind: 'assistant', done: true, text: 'Four threads are working. I will report what each of them finds.' }],
        [20, {
            kind: 'user',
            text: '',
            from: {
                kind: 'threadNotice',
                threads: [
                    { chatId: 'c-6b', title: 'Write the refund tests', outcome: 'finished', text: REFUND_ANSWER },
                    { chatId: 'c-6c', title: 'Migrate the payments table', outcome: 'failed', text: MIGRATION_FAILURE },
                    { chatId: 'c-6e', title: 'Load test the checkout', outcome: 'finished', text: LOAD_ANSWER, background: ['k6 run checkout-long.js'] },
                ],
            },
        }],
        [19, { kind: 'assistant', done: true, text: 'The refund tests are in. The migration failed because staging already has the column, so I will not touch staging without you. The long load run is still going.' }],
        [10, { kind: 'user', text: 'The rounding helper is shared with the invoices. Should I change both, or only the checkout?', from: { kind: 'thread', chatId: 'c-6a', title: 'Fix the price rounding' } }],
        [9, { kind: 'tool', toolCallId: 'tc-o6-5', name: 'Bash', state: 'done', input: { command: 'clowdy thread tell c-6a "Change both, and add a test for the invoice total."', description: 'Answer the price rounding thread' }, output: 'Sent' }],
        [9, { kind: 'assistant', done: true, text: 'I told the rounding thread to change both and to cover the invoice total with a test.' }],
    ]);

    stream('r-orch-6a', [
        [48, { kind: 'user', text: 'Fix the price rounding in the checkout: totals are off by a cent on some weekend bookings. Keep the existing tests green.', from: fromParent }],
        [47, { kind: 'assistant', done: true, text: 'I will find where the total is rounded, and have a thread check the currency table meanwhile.' }],
        [46, { kind: 'tool', toolCallId: 'tc-o6a-1', name: 'Bash', state: 'done', input: { command: 'clowdy thread spawn --title "Check the currency table" --prompt "List the decimals of every currency"', description: 'Start a thread for the currency table' }, output: 'c-6a1' }],
        [40, { kind: 'tool', toolCallId: 'tc-o6a-2', name: 'Read', state: 'done', input: { file_path: 'src/booking/price.ts' }, output: 'export const total = (days: number[]) => round(sum(days));' }],
        [11, { kind: 'assistant', done: true, text: 'The helper is shared with the invoices, so I asked which of them to change.' }],
        [10, { kind: 'tool', toolCallId: 'tc-o6a-3', name: 'Bash', state: 'done', input: { command: 'clowdy thread tell --parent "The rounding helper is shared with the invoices. Should I change both, or only the checkout?"', description: 'Ask the parent' }, output: 'Sent' }],
        [9, { kind: 'user', text: 'Change both, and add a test for the invoice total.', from: fromParent }],
        [8, { kind: 'assistant', done: true, text: 'Changing both now.' }],
        [2, { kind: 'tool', toolCallId: 'tc-o6a-4', name: 'Bash', state: 'running', input: { command: 'bun test src/checkout' } }],
    ]);

    stream('r-orch-6a1', [
        [46, { kind: 'user', text: 'List the decimals of every currency in the rates table and flag any that is not two.', from: { kind: 'thread', chatId: 'c-6a', title: 'Fix the price rounding' } }],
        [44, { kind: 'tool', toolCallId: 'tc-o6a1-1', name: 'Grep', state: 'done', input: { pattern: 'decimals', path: 'src/db' }, output: 'src/db/currencies.ts:3' }],
        [25, { kind: 'assistant', done: true, text: CURRENCY_ANSWER }],
    ]);

    stream('r-orch-6b', [
        [47.5, { kind: 'user', text: 'Write tests for the refund rules: a full refund until 24 hours before pickup, half after that, none once the car is out.', from: fromParent }],
        [30, { kind: 'tool', toolCallId: 'tc-o6b-1', name: 'Write', state: 'done', input: { file_path: 'src/payments/refund.test.ts' }, output: 'The file was written.' }],
        [21, { kind: 'tool', toolCallId: 'tc-o6b-2', name: 'Bash', state: 'done', input: { command: 'bun test src/payments' }, output: '14 pass, 0 fail' }],
        [20, { kind: 'assistant', done: true, text: REFUND_ANSWER }],
    ]);

    stream('r-orch-6c', [
        [47, { kind: 'user', text: 'Add an amount_cents column to payments and move the data over. Run it against staging once it works locally.', from: fromParent }],
        [25, { kind: 'tool', toolCallId: 'tc-o6c-1', name: 'Bash', state: 'error', input: { command: 'bun run migrate --env staging' }, error: 'column "amount_cents" of relation "payments" already exists' }],
        [20, { kind: 'error', text: MIGRATION_FAILURE }],
    ]);

    stream('r-orch-6e', [
        [46.5, { kind: 'user', text: 'Load test the checkout: a short run first, then a long one, and report the error rate.', from: fromParent }],
        [40, { kind: 'tool', toolCallId: 'tc-o6e-1', name: 'Bash', state: 'done', input: { command: 'k6 run checkout-short.js' }, output: 'http_reqs: 7200 (120/s), http_req_failed: 0.00%' }],
        [21, { kind: 'tool', toolCallId: 'tc-o6e-2', name: 'Bash', state: 'done', input: { command: 'k6 run checkout-long.js', run_in_background: true }, output: 'Command running in background with ID: bg-k6' }],
        [20, { kind: 'assistant', done: true, text: LOAD_ANSWER }],
    ]);

    stream('r-orch-2', [
        [60 * 24 * 5, { kind: 'user', text: 'Build the first version: fleet list, booking page, price calculation.' }],
        [60 * 24 * 5 - 1, { kind: 'assistant', done: true, text: 'I will start with the fleet list, then the booking page.' }],
        [60 * 24 * 5 - 2, { kind: 'tool', toolCallId: 'tc-o2-1', name: 'Read', state: 'done', input: { file_path: 'src/fleet/index.tsx' }, output: 'export function Fleet() {}' }],
        [60 * 24 * 5 - 9, { kind: 'tool', toolCallId: 'tc-o2-2', name: 'create_task', state: 'done', input: { title: 'Fleet list' }, output: { key: 'CAR-15' } }],
        [60 * 24 * 5 - 12, {
            kind: 'tool',
            toolCallId: 'tc-o2-agent',
            name: 'Agent',
            state: 'done',
            input: { subagent_type: 'general-purpose', description: 'Fleet list', prompt: 'Build the fleet list page from the cars table.' },
            output: 'The fleet list renders every car with its status.',
        }],
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

    /*
     * What the daemon says a client may offer, set by hand on the items that stand for the two kinds of turn (`StreamItem.canEdit`, `canFork`): Edit on the
     * message that starts a turn, Fork on the final answer that ends one, and neither on anything else. Simplify booking is running, which is where Edit shows
     * its disabled hint; First version rests, with its first message and its final answer (item 6; item 7 is the agent's own compact turn).
     */
    const flag = (runId: string, seq: number, flags: Pick<StreamItem, 'canFork' | 'canEdit'>) => Object.assign(items[runId][seq - 1], flags);

    flag('r-orch-1', 1, { canEdit: true });
    flag('r-orch-2', 1, { canEdit: true });
    flag('r-orch-2', 6, { canFork: true });

    const docs: Record<string, string> = {
        'README.md': '# Car Rental docs\n\nDecisions and specs for the booking service. Agents read this folder before they plan.\n',
        'decisions/booking-flow.md': '# Booking flow\n\nOne form, no steps.\n\n## Why\n\n- Three steps lost people on the second one.\n- The price must be visible before the person commits.\n\n## Rules\n\n- [x] Dates and car in one view\n- [x] Live price\n- [ ] Cancel up to 24 hours before pickup\n',
        'decisions/pricing.md': '# Pricing\n\nWeekend days cost 15% more. A booking that spans a month end is priced per day.\n',
        'specs/booking.md': '# Booking spec\n\n| Field | Type | Notes |\n| --- | --- | --- |\n| pickup | date | not in the past |\n| return | date | after pickup |\n| car | id | must be free in the range |\n',
    };

    const artifacts: Artifact[] = [
        { id: 'a-1', projectId, runId: 'r-orch-1', taskId: 't-21', kind: 'commit', title: 'Add the bookings table', ref: { sha: 'f00dcafe', branch: 'clowdy/car-21-booking-schema' }, createdAt: ago(52) },
        { id: 'a-2', projectId, runId: 'r-na-03', taskId: 't-24', kind: 'diff', title: 'Changes in the booking form', ref: { files: 2, added: 42, removed: 118 }, createdAt: ago(14) },
        { id: 'a-3', projectId, runId: 'r-na-04', taskId: 't-23', kind: 'check', title: 'Typecheck', ref: { command: 'bun run typecheck', exitCode: 2 }, createdAt: ago(41) },
    ];

    return {
        projects,
        git: {
            '/Users/dev/car-rental': { remoteUrl: 'git@github.com:acme/car-rental.git', branch: 'main' },
            '/Users/dev/clowdy': { remoteUrl: 'https://github.com/acme/clowdy.git', branch: 'next' },
            '/Users/dev/car-rental-api': { remoteUrl: 'git@github.com:acme/car-rental-api.git', branch: 'feature/payments' },
        },
        statuses: { [projectId]: DEFAULT_STATUSES, [FIXTURE_EMPTY_PROJECT_ID]: DEFAULT_STATUSES, [FIXTURE_PERSONAL_PROJECT_ID]: DEFAULT_STATUSES },
        // As the daemon's migration leaves them: a chat that has an orchestrator records the engine and model it runs on.
        chats: chats.map((chat) => {
            const orchestrator = runs.find(candidate => candidate.id === chat.orchestratorRunId);

            return orchestrator ? { ...chat, engine: orchestrator.engine, ...(orchestrator.model && { model: orchestrator.model }) } : chat;
        }),
        tasks,
        comments,
        runs,
        chatTaskLinks,
        runTaskLinks,
        items,
        artifacts,
        // `car-rental-api` belongs to no project yet: add it to Car Rental to see the documents, files and remotes of two folders.
        docs: { '/Users/dev/car-rental': docs, '/Users/dev/car-rental-api': API_DOCS },
        briefback: { '/Users/dev/car-rental': BRIEFBACK },
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
