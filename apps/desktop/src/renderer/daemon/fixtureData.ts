import type {
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
    statuses: Record<string, TaskStatus[]>;
    chats: Chat[];
    tasks: Task[];
    runs: Run[];
    chatTaskLinks: ChatTaskLink[];
    runTaskLinks: RunTaskLink[];
    items: Record<string, StreamItem[]>;
    artifacts: Artifact[];
    /** Markdown files of each project's docs folder, by relative path. */
    docs: Record<string, Record<string, string>>;
    /** Paths of each project's files, relative to its folder, as the file search would list them. */
    files: Record<string, string[]>;
    /** Files sent with messages, by the fixture's seed data. */
    attachments: FixtureAttachment[];
    /** What the skills catalog lists; `projectId` marks a project's own skill. */
    skills: FixtureSkill[];
    skillWarnings: string[];
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
/** The run, and the two items of its stream, that the fixture timeline keeps changing. */
export const FIXTURE_LIVE_RUN_ID = 'r-ex-07';
export const FIXTURE_LIVE_TOOL_ID = 'r-ex-07-8';
export const FIXTURE_LIVE_TEXT_ID = 'r-ex-07-9';

const MINUTE = 60_000;

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

export function createFixtureData(now = Date.now()): FixtureData {
    const ago = (minutes: number) => now - minutes * MINUTE;
    const projectId = FIXTURE_PROJECT_ID;

    const projects: Project[] = [
        {
            id: projectId,
            name: 'Car Rental',
            path: '/Users/dev/car-rental',
            taskPrefix: 'CAR',
            settings: { maxParallelRuns: 4, engine: 'claude', targetBranch: 'main' },
            createdAt: ago(60 * 24 * 12),
        },
        {
            id: FIXTURE_EMPTY_PROJECT_ID,
            name: 'Clowdy',
            path: '/Users/dev/clowdy',
            taskPrefix: 'CLW',
            settings: {},
            createdAt: ago(60 * 24 * 3),
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
        run('r-orch-1', 'Orchestrator 01', 'orchestrator', 'running', { chatId: 'c-1', summary: 'Simplify booking', createdAt: ago(94), startedAt: ago(94) }),
        run('r-ex-07', 'Executor 07', 'executor', 'running', {
            parentRunId: 'r-orch-1',
            summary: 'Update the booking form',
            worktree: worktree('car-24-booking-form'),
            createdAt: ago(21),
            startedAt: ago(21),
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
        [92, { kind: 'tool', toolCallId: 'tc-2', name: 'Read', state: 'done', input: { file_path: 'src/booking/index.tsx' }, output: 'export function Booking() {\n    return <Steps />;\n}' }],
        [90, { kind: 'tool', toolCallId: 'tc-3', name: 'create_task', state: 'done', input: { title: 'Update the booking form', dependsOn: ['CAR-22'] }, output: { key: 'CAR-24' } }],
        [89, { kind: 'note', text: '2 executors started' }],
        [60, { kind: 'assistant', done: true, text: 'Executor 09 finished the schema in `src/db/schema.ts`. Executor 10 failed on the pricing rules; I will look at its report before I retry.\n\n### What changed\n\n| File | Change |\n| --- | --- |\n| `src/db/schema.ts` | adds the `bookings` table |\n| `src/booking/price.ts` | weekend surcharge |\n\n```src/booking/price.ts\nexport const weekendRate = 1.15;\n```\n\n> The price must be visible before the person commits.\n\nSee [the decision](https://example.com/decision) and `CAR-23`.' }],
        [41, { kind: 'error', text: 'Executor 10 failed: Typecheck failed in 3 files and the run could not repair them.' }],
        [21, { kind: 'note', text: '2 executors started' }],
        [20, { kind: 'assistant', done: true, text: 'Executor 07 is on the form, and Executor 08 asked which mail provider to use. I am waiting on you for that one.' }],
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
        statuses: { [projectId]: DEFAULT_STATUSES, [FIXTURE_EMPTY_PROJECT_ID]: DEFAULT_STATUSES },
        chats,
        tasks,
        runs,
        chatTaskLinks,
        runTaskLinks,
        items,
        artifacts,
        docs: { [projectId]: docs, [FIXTURE_EMPTY_PROJECT_ID]: {} },
        files: { [projectId]: FIXTURE_FILES, [FIXTURE_EMPTY_PROJECT_ID]: [] },
        attachments: structuredClone(FIXTURE_ATTACHMENTS),
        skills: fixtureSkills(projectId),
        skillWarnings: ['~/.claude/skills: Skipped "old-notes": it has no description'],
    };
}
