import type { Database } from 'bun:sqlite';

export interface Migration {
    /** Becomes `PRAGMA user_version` once applied. Versions are consecutive from 1. */
    version: number;
    up(db: Database): void;
}

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        up(db) {
            db.run(`
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    task_prefix TEXT NOT NULL,
                    settings TEXT NOT NULL DEFAULT '{}',
                    next_task_number INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE task_statuses (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    position INTEGER NOT NULL
                );
                CREATE INDEX task_statuses_project ON task_statuses(project_id, position);

                CREATE TABLE chats (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    orchestrator_run_id TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX chats_project ON chats(project_id, updated_at);

                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    number INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status_id TEXT NOT NULL REFERENCES task_statuses(id),
                    created_by TEXT NOT NULL,
                    external TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE (project_id, number)
                );

                CREATE TABLE task_deps (
                    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    PRIMARY KEY (task_id, depends_on_id)
                );
                CREATE INDEX task_deps_reverse ON task_deps(depends_on_id);

                CREATE TABLE chat_task_links (
                    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    PRIMARY KEY (chat_id, task_id)
                );
                CREATE INDEX chat_task_links_task ON chat_task_links(task_id);

                CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    parent_run_id TEXT REFERENCES runs(id),
                    root_run_id TEXT NOT NULL,
                    chat_id TEXT REFERENCES chats(id),
                    role TEXT NOT NULL,
                    name TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    status_reason TEXT,
                    engine TEXT NOT NULL,
                    model TEXT,
                    session_id TEXT,
                    worktree TEXT,
                    result TEXT,
                    error TEXT,
                    usage TEXT,
                    created_at INTEGER NOT NULL,
                    started_at INTEGER,
                    finished_at INTEGER
                );
                CREATE INDEX runs_project ON runs(project_id, created_at);
                CREATE INDEX runs_status ON runs(status);
                CREATE INDEX runs_parent ON runs(parent_run_id);

                CREATE TABLE run_task_links (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    relation TEXT NOT NULL,
                    PRIMARY KEY (run_id, task_id, relation)
                );
                CREATE INDEX run_task_links_task ON run_task_links(task_id);

                CREATE TABLE stream_items (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    at INTEGER NOT NULL,
                    body TEXT NOT NULL,
                    UNIQUE (run_id, seq)
                );

                CREATE TABLE artifacts (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
                    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    ref TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX artifacts_task ON artifacts(task_id);

                CREATE TABLE events (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                    at INTEGER NOT NULL,
                    project_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE INDEX events_project ON events(project_id, cursor);

                CREATE TABLE commands (
                    request_id TEXT PRIMARY KEY,
                    result TEXT NOT NULL,
                    at INTEGER NOT NULL
                );
            `);
        },
    },
    {
        version: 2,
        up(db) {
            db.run(`
                ALTER TABLE runs ADD COLUMN origin TEXT;
                ALTER TABLE runs ADD COLUMN idempotency_key TEXT;
                ALTER TABLE runs ADD COLUMN cwd TEXT;
                ALTER TABLE runs ADD COLUMN next_prompt TEXT;
                ALTER TABLE runs ADD COLUMN outcome TEXT;
                ALTER TABLE runs ADD COLUMN pid INTEGER;
                ALTER TABLE runs ADD COLUMN pgid INTEGER;
                ALTER TABLE runs ADD COLUMN process_started_at INTEGER;
                CREATE UNIQUE INDEX runs_idempotency ON runs(parent_run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

                CREATE TABLE run_mailbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    child_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    delivered_at INTEGER,
                    UNIQUE (run_id, child_run_id)
                );
                CREATE INDEX run_mailbox_pending ON run_mailbox(run_id) WHERE delivered_at IS NULL;

                CREATE TABLE engine_pauses (
                    engine TEXT PRIMARY KEY,
                    until INTEGER NOT NULL
                );
            `);
        },
    },
    {
        version: 3,
        up(db) {
            db.run('ALTER TABLE chats ADD COLUMN archived_at INTEGER');
        },
    },
    {
        version: 4,
        up(db) {
            // Files the person attached to a message. The bytes live in <dataDir>/attachments/<id>/<name>. A file is unsent
            // (chat_id and run_id NULL) from its upload until a chat.send claims it; the rows of a deleted chat go with it.
            db.run(`
                CREATE TABLE attachments (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
                    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX attachments_project ON attachments(project_id);
                CREATE INDEX attachments_chat ON attachments(chat_id) WHERE chat_id IS NOT NULL;
                CREATE INDEX attachments_unsent ON attachments(created_at) WHERE chat_id IS NULL;
            `);
        },
    },
    {
        version: 5,
        up(db) {
            // A chat is bound to an agent, a model and a reasoning level (see `Chat`); the run carries the level its next turn applies.
            // A chat that already has an orchestrator takes the agent and model that orchestrator runs on.
            db.run(`
                ALTER TABLE chats ADD COLUMN engine TEXT;
                ALTER TABLE chats ADD COLUMN model TEXT;
                ALTER TABLE chats ADD COLUMN effort TEXT;
                ALTER TABLE runs ADD COLUMN effort TEXT;
                UPDATE chats SET
                    engine = (SELECT engine FROM runs WHERE runs.id = chats.orchestrator_run_id),
                    model = (SELECT model FROM runs WHERE runs.id = chats.orchestrator_run_id)
                WHERE orchestrator_run_id IS NOT NULL;
            `);
        },
    },
    {
        version: 6,
        up(db) {
            // The context window of a run's session, as `{ used, size }` in tokens (see `Run.context`).
            db.run('ALTER TABLE runs ADD COLUMN context TEXT');
        },
    },
    {
        version: 7,
        up(db) {
            // The personal space is a project flagged `personal` (at most one); `position` is the person's order of the others.
            // Projects that exist keep the order they were made in.
            db.run(`
                ALTER TABLE projects ADD COLUMN personal INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
                UPDATE projects SET position = ordered.position
                FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS position FROM projects) AS ordered
                WHERE projects.id = ordered.id;
                CREATE UNIQUE INDEX projects_personal ON projects(personal) WHERE personal = 1;
            `);
        },
    },
    {
        version: 8,
        up(db) {
            // A native sub-agent keeps the id of its parent's tool call that started it (see `Run.parentToolCallId`).
            db.run('ALTER TABLE runs ADD COLUMN parent_tool_call_id TEXT');
        },
    },
    {
        version: 9,
        up(db) {
            // Messages waiting for a chat's busy orchestrator, as a JSON array of `QueuedMessage`, and why the queue holds (see `Chat.queue`).
            db.run(`
                ALTER TABLE chats ADD COLUMN queue TEXT;
                ALTER TABLE chats ADD COLUMN queue_paused TEXT;
            `);
        },
    },
];
