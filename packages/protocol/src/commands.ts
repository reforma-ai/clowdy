import { z } from 'zod';

import { PERMISSION_PRESETS } from './agents';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_PROJECT_FOLDERS, MAX_PROJECT_ICON_LENGTH } from './api';
import { LAST_USED, NO_PROJECT_ICON } from './domain';

/**
 * Everything a client may ask the daemon to do. Each command carries a `requestId`; sending the same id again
 * returns the first result instead of acting twice, so a retry after a dropped response is safe.
 */
const base = { requestId: z.string().min(8).max(100) };

const chatMode = z.enum(['autopilot', 'semi']);
const engine = z.string().min(1).max(64);
const model = z.string().min(1).max(200);
const chatWorkspaceChoice = z.union([
    z.object({ mode: z.literal('new'), base: z.string().min(1).max(300).optional() }).strict(),
    z.object({ mode: z.literal('existing'), path: z.string().min(1) }).strict(),
]);
const effort = z.string().min(1).max(64);
const actor = z.object({ kind: z.literal('user') });
const queuedMode = z.enum(['steer', 'queue']);

export const commandSchema = z.discriminatedUnion('type', [
    /* Projects */
    /**
     * Adds a project of `folders`: absolute paths of existing folders, repositories or not, the first being the main one. Without folders a new
     * folder `<projectsDir>/<kebab-name>` is made with `git init`, and `name` is required; with them `name` defaults to the main folder's name.
     * The same set of folders as a project already has, in any order, answers that project with `existing: true` and adds nothing.
     * A folder cannot be listed twice or inside another listed folder. Answers `{ project, existing? }`.
     */
    z.object({ ...base, type: z.literal('project.add'), name: z.string().min(1).optional(), folders: z.array(z.string().min(1)).max(MAX_PROJECT_FOLDERS).optional() }),
    /**
     * `folders` is the project's whole new list, in order: `{ id }` keeps a folder it has, `{ path }` adds one (the checks of `project.add`).
     * A new main folder waits until no run of the project is unfinished. `name`, `folders` and an icon are refused for the personal space. A
     * settings field set to `null` is cleared, so the project follows the daemon's own choice again (and `icon: null` shows the found icon or the
     * folder icon again; `NO_PROJECT_ICON` shows the folder icon).
     */
    z.object({
        ...base,
        type: z.literal('project.update'),
        projectId: z.string(),
        name: z.string().min(1).optional(),
        folders: z.array(z.union([z.object({ id: z.string().min(1) }).strict(), z.object({ path: z.string().min(1) }).strict()])).min(1).max(MAX_PROJECT_FOLDERS).optional(),
        settings: z.object({
            maxParallelRuns: z.number().int().min(1).max(1000).nullable().optional(),
            engine: engine.nullable().optional(),
            model: z.string().nullable().optional(),
            chatMode: z.union([chatMode, z.literal(LAST_USED)]).nullable().optional(),
            targetBranch: z.string().nullable().optional(),
            icon: z.union([z.literal(NO_PROJECT_ICON), z.string().max(MAX_PROJECT_ICON_LENGTH).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, 'The icon must be a PNG data URL')]).nullable().optional(),
        }).optional(),
    }),
    /**
     * Sets what the worktrees made from one folder of the project need (`FolderSettings`): the branch they start from and a setup. The settings belong to this folder of this
     * project, so the same path in another project has its own. A field that is left out stays, one set to `null` is cleared (the folder's default branch and no setup again);
     * `setup` is replaced whole. `setup.files` are paths below the folder written with `/`, or with a `*` in the last segment (`.env*`): none absolute, with a drive, a `\`,
     * a `.` or `..` or `.git` segment or an empty one, at most `MAX_SETUP_FILES` of at most 500 characters; a setup with no files and no command is no setup. `command` is at
     * most `MAX_SETUP_COMMAND_LENGTH` characters, `baseBranch` a name of at most `MAX_BASE_BRANCH_LENGTH` that does not start with `-`. The daemon trims the text and then checks
     * these limits, so the schema holds the shapes only and the refusal (`invalid`) says which limit it is; `not_found` for a folder the project does not have and `conflict` for
     * the personal space. Answers `{ project }`.
     */
    z.object({
        ...base,
        type: z.literal('project.updateFolder'),
        projectId: z.string(),
        folderId: z.string().min(1),
        settings: z.object({
            baseBranch: z.string().nullable().optional(),
            setup: z.object({ files: z.array(z.string()), command: z.string().optional() }).nullable().optional(),
        }),
    }),
    /** Removes the project with its chats, tasks, runs, streams and attachments; its folder and the files in it stay. Refused for the personal space and while any run of the project is unfinished. */
    z.object({ ...base, type: z.literal('project.delete'), projectId: z.string() }),
    /** Puts the projects in this order, after the personal space. A project that is not listed keeps its place below the listed ones; an unknown id is refused. */
    z.object({ ...base, type: z.literal('project.reorder'), projectIds: z.array(z.string()).max(1000) }),

    /* Chats */
    /**
     * `engine`, `model` and `effort` bind the chat to an agent, a model and a reasoning level (see `Chat`); left out, the first message takes the project's or the daemon's.
     * `folderId` is a folder of the project the chat works in; left out, the chat works in the main folder. A folder the project does not have is refused.
     * `workspace` has the chat work in a worktree of that folder (`ChatWorkspaceChoice`): a new one, which the chat's first turn makes, or one `git worktree list` names for
     * the folder; left out, in the folder itself. Refused for a folder that is not the root of a repository, a base that is not a ref of it, or a path that is not one of its worktrees.
     */
    z.object({ ...base, type: z.literal('chat.create'), projectId: z.string(), title: z.string().optional(), mode: chatMode.optional(), engine: engine.optional(), model: model.optional(), effort: effort.optional(), folderId: z.string().min(1).optional(), workspace: chatWorkspaceChoice.optional() }),
    z.object({ ...base, type: z.literal('chat.rename'), chatId: z.string(), title: z.string().min(1) }),
    z.object({ ...base, type: z.literal('chat.setMode'), chatId: z.string(), mode: chatMode }),
    /**
     * Changes what a chat runs on, from its next turn. `model` and `effort` change at any time (`null` clears one, leaving the agent's own
     * choice); `engine` only while the chat has no orchestrator yet, and a new `engine` without a `model` clears both.
     */
    z.object({ ...base, type: z.literal('chat.setModel'), chatId: z.string(), engine: engine.optional(), model: model.nullable().optional(), effort: effort.nullable().optional() }),
    /**
     * Asks the chat's agent to compact its context (its own `/compact`) as a turn of the orchestrator, which the stream shows. An orchestrator that works
     * gets it later: it joins the chat's queue as a compact item (`QueuedMessage.command`), which runs once the orchestrator has finished, and
     * asking again while one waits or runs does nothing more. Refused (`invalid`) for a chat that has not started or whose agent has no such command.
     * It is not activity: the chat keeps its place in the order.
     */
    z.object({ ...base, type: z.literal('chat.compact'), chatId: z.string() }),
    /** Hides the chat from the lists without deleting anything (refused while any of its runs is active), or brings it back. */
    z.object({ ...base, type: z.literal('chat.setArchived'), chatId: z.string(), archived: z.boolean() }),
    /**
     * Removes the chat with its orchestrator's conversation and every run below it; the tasks stay. Refused while any of its runs is active. `removeWorkspace` also removes
     * the chat's worktree and its branch, which only a worktree that `GET /v1/chats/:id/workspace` calls `removable` allows (`conflict` otherwise, and nothing is deleted).
     */
    z.object({ ...base, type: z.literal('chat.delete'), chatId: z.string(), removeWorkspace: z.boolean().optional() }),
    /**
     * `text` may be empty when `attachmentIds` (files uploaded to the chat's project, not sent yet) name at least one file. A chat at rest (no orchestrator yet,
     * a finished one, or one waiting for background work) gets the message at once, whatever `mode` says. A busy orchestrator gets it later: `mode` puts it in the
     * chat's queue as a steer of the running turn or as a next turn (`queue` when left out), and it shows in the stream once the agent has it.
     */
    z.object({ ...base, type: z.literal('chat.send'), chatId: z.string(), text: z.string(), attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(), mode: queuedMode.optional() }),
    /**
     * Takes a message out of the chat's queue. Its files are deleted with it, or, with `keepFiles`, go back to being uploaded and not sent, so a message box
     * can take them again (the person edits the message).
     */
    z.object({ ...base, type: z.literal('chat.removeQueued'), chatId: z.string(), itemId: z.string(), keepFiles: z.boolean().optional() }),
    /** Moves a queued message to `index` among the messages of its own kind (the steers, or the next turns); a larger index puts it last. */
    z.object({ ...base, type: z.literal('chat.moveQueued'), chatId: z.string(), itemId: z.string(), index: z.number().int().min(0) }),
    /**
     * Sends a queued message now. While the orchestrator works it becomes a steer of the running turn (it stays a steer when the agent cannot take it, and goes
     * first when the turn ends); at rest it goes out at once as the next turn and lets a paused queue flow again. A compact item cannot steer: while the
     * orchestrator works it stays where it is, and at rest it is refused like `chat.compact` until the orchestrator can compact.
     */
    z.object({ ...base, type: z.literal('chat.sendQueued'), chatId: z.string(), itemId: z.string() }),
    /**
     * Forks a chat at a final answer: a new chat of the same project, agent, model, level and mode that holds the conversation through that answer (`itemId`, a
     * stream item with `canFork` in the chat's own stream) and goes on from there on its own, with the answer's session copied by the agent. The new chat is
     * titled `(n) <title>`, is no thread, has no queue and no usage, and says where it came from in `Chat.forkedFrom`. The source need not be at rest: only the
     * turn the answer ends has to be finished. The agent is asked first, and when it cannot fork nothing is created. Answers `{ chat }`. Refused (`invalid`) for
     * an item that cannot be forked or a chat that has no conversation yet, `unavailable` while the agent is switched off or when the agent's fork failed.
     */
    z.object({ ...base, type: z.literal('chat.fork'), chatId: z.string(), itemId: z.string() }),
    /**
     * Rewrites a chat from a message of the person's: the stream from `itemId` (a `user` item with `canEdit` in the chat's own stream) on is dropped, with the
     * sub-agent runs and the files under it, the agent's session goes back to the point before that message (a fresh session for the first message of the
     * chat), and `text` is sent as an ordinary new turn on it. `attachmentIds` are the files the new message carries: files uploaded to the chat's project and
     * not sent yet, and files of the messages being dropped, which survive when named here (the others go with their messages). `text` may be empty when files
     * are named. Only for a chat at rest: refused (`conflict`) while the orchestrator works, waits for the person or waits for background work, and when the chat
     * changed while the agent was asked (a message sent meanwhile, another edit). Refused (`invalid`) for an item that cannot be edited, a chat with no
     * conversation and an empty message, `unavailable` while the agent is switched off or when the agent's fork failed (nothing changes then). Queued messages,
     * threads, tasks, usage and the files the agent changed stay as they are. Answers `{ chatId, runId }` like `chat.send`.
     */
    z.object({ ...base, type: z.literal('chat.edit'), chatId: z.string(), itemId: z.string(), text: z.string(), attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional() }),

    /* Tasks */
    z.object({
        ...base,
        type: z.literal('task.create'),
        projectId: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
        statusId: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        /** The task the new one is part of (same project, at most `MAX_TASK_DEPTH` levels deep, not an archived task: restore it first). */
        parentId: z.string().optional(),
        /** Link the new task to this chat, as if the orchestrator had created it there. */
        chatId: z.string().optional(),
    }),
    z.object({
        ...base,
        type: z.literal('task.update'),
        taskId: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        /** Refused (`invalid`) for an open status on an archived task, which stays closed until it is restored. */
        statusId: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        /**
         * Moves the task, with everything inside it, under this task; `null` makes it a root. Refused (`invalid`) for a task of another project, the task
         * itself, one of its own descendants, a result deeper than `MAX_TASK_DEPTH` levels, counting the task's own subtree, and an archived parent for a task
         * that is not archived.
         */
        parentId: z.string().nullable().optional(),
    }),
    /** Deletes the task; the tasks inside it move up to its own parent (a root's become roots). */
    z.object({ ...base, type: z.literal('task.delete'), taskId: z.string() }),
    /**
     * Archives the task with everything inside it, all with one `archivedAt`; answers `{ task, archived, canceled }`: the task, the ids of the tasks that went
     * into the archive with this call (the task first, then those inside it; none for a task that was archived already, which changes nothing) and the
     * ids among them that `cancel` moved to Canceled. Only closed tasks (`done`, `canceled`) can be archived: a task with an open task inside it is refused
     * (`invalid`, the message names them) unless `cancel` is set, which moves the task and every open task inside it to the project's first Canceled status
     * and archives them together, one `task.upserted` each. A task with an active run, or with a task inside it that has one, is refused (`conflict`) whatever
     * `cancel` says: stop the run first. Dependencies are left as they are, and a task that waited for an archived one is already free, since a closed task
     * resolves its dependents.
     */
    z.object({ ...base, type: z.literal('task.archive'), taskId: z.string(), cancel: z.boolean().optional() }),
    /**
     * Brings an archived task back, with the tasks inside it that were archived with it (the ones with the same `archivedAt`; a task inside it that was
     * archived on its own earlier stays archived). Answers `{ task, restored }`: the task and the ids of every task that came back (none for a task that is
     * not archived, which changes nothing). Refused (`invalid`) while the task's own parent is archived: restore the parent first.
     */
    z.object({ ...base, type: z.literal('task.unarchive'), taskId: z.string() }),
    /** Opens a new chat bound to the task, with an orchestrator run that starts on it now; answers `{ runId, chatId }`. One active run per task unless `force`. Refused (`invalid`) for an archived task: restore it first. */
    z.object({ ...base, type: z.literal('task.start'), taskId: z.string(), engine: engine.optional(), force: z.boolean().optional() }),
    /** Adds a Markdown comment from the person to the task; answers `{ comment }`. Refused (`invalid`) for a body with nothing in it but whitespace. */
    z.object({ ...base, type: z.literal('task.comment.add'), taskId: z.string(), body: z.string() }),
    /**
     * Replaces the body of one of the task's comments and sets its `editedAt`; a body that is the same changes nothing. Answers `{ comment }`. Refused
     * (`invalid`) for a body with nothing in it, `not_found` for a comment the task does not have. Any comment may be edited, an agent's included.
     */
    z.object({ ...base, type: z.literal('task.comment.edit'), taskId: z.string(), commentId: z.string(), body: z.string() }),
    /** Deletes one of the task's comments (`not_found` when the task has no such one); answers `{ taskId, commentId }`. */
    z.object({ ...base, type: z.literal('task.comment.delete'), taskId: z.string(), commentId: z.string() }),

    /* Runs */
    z.object({ ...base, type: z.literal('run.cancel'), runId: z.string() }),
    /**
     * Stops the sub-agents of the run `runId` (a chat's orchestrator) and lets the run go on, knowing they were stopped: every sub-agent in its session that
     * can be stopped alone (`Run.canStopAlone`) is asked to stop; the run is not cancelled and its chat's queue is not held. Answers `{ stopped: RunId[] }`,
     * what it asked to stop.
     */
    z.object({ ...base, type: z.literal('run.stopAgents'), runId: z.string() }),
    /**
     * Stops one background item of the run `runId` (a chat's orchestrator) and nothing else: the item is one of `Run.background` that says
     * `canStopAlone` (a command whose terminal can be cancelled), the run and its other work go on and its chat's queue is not held, and the agent is told
     * the user stopped it, since a stopped command gives it no report of its own. Answers `{ stopped: boolean }`: whether the request was made. An item that
     * is gone, or cannot be stopped alone, or a session that is not live, answers `false`, and a repeat of the request for an item that is being stopped
     * is one request.
     */
    z.object({ ...base, type: z.literal('run.stopBackground'), runId: z.string(), itemId: z.string() }),
    /** Answers a `question` stream item of a run in `waiting_user`. */
    z.object({ ...base, type: z.literal('run.answer'), runId: z.string(), questionId: z.string(), answer: z.string() }),
    /** Decides an `approval` stream item that is `open`: the run goes on when none is left. `allow_always` makes Clowdy answer the same request for the rest of the run without asking; the agent itself is told to allow it once. */
    z.object({ ...base, type: z.literal('run.decide'), runId: z.string(), approvalId: z.string(), decision: z.enum(['allow_once', 'allow_always', 'reject']) }),

    /* Agents */
    /** Adds an agent the daemon can run: any command that speaks the Agent Client Protocol on stdio. */
    z.object({ ...base, type: z.literal('agent.add'), id: z.string().min(1).max(32), name: z.string().min(1).max(80), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
    /** Changes an agent, built in or added. `path: null` goes back to looking for the program; `name`, `command` and `args` apply to added agents only. */
    z.object({
        ...base,
        type: z.literal('agent.update'),
        id: z.string().min(1),
        enabled: z.boolean().optional(),
        path: z.string().min(1).nullable().optional(),
        env: z.record(z.string(), z.string()).optional(),
        name: z.string().min(1).max(80).optional(),
        command: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
        /** Turns the agent's own settings (`AgentInfo.settings`) on or off by id; settings left out keep their value. */
        settings: z.record(z.string(), z.boolean()).optional(),
        /** Picks one of the agent's permission presets (`AgentInfo.permissions`); `null` goes back to the agent's default. Left out, the choice stays. */
        permission: z.enum(PERMISSION_PRESETS).nullable().optional(),
    }),
    /** Starts the agent's own login for the person (also to sign in again as someone else). Answers at once; the progress is `AgentInfo.signInSession`. Refused when one is running. */
    z.object({ ...base, type: z.literal('agent.signIn'), id: z.string().min(1) }),
    /** Stops a sign-in in progress. */
    z.object({ ...base, type: z.literal('agent.cancelSignIn'), id: z.string().min(1) }),
    /** Removes an agent that was added; the built-in ones can only be switched off. */
    z.object({ ...base, type: z.literal('agent.remove'), id: z.string().min(1) }),
    /** Looks for the agents' programs again, for after the user installed one, and reads accounts and usage anew. */
    z.object({ ...base, type: z.literal('agents.refresh') }),

    /* Skills */
    /** Switches a user skill on or off for every run. `name` is the entry's name from `GET /v1/skills` (`user:deploy`). */
    z.object({ ...base, type: z.literal('skills.setEnabled'), name: z.string().min(1), enabled: z.boolean() }),
]);

export type Command = z.infer<typeof commandSchema>;
export type CommandType = Command['type'];

export { actor as userActorSchema };

export type CommandResult<T = unknown> =
    | { ok: true; requestId: string; data: T }
    | { ok: false; requestId: string; error: { code: ErrorCode; message: string; details?: unknown } };

export type ErrorCode =
    | 'invalid'
    | 'not_found'
    | 'conflict'
    | 'already_running'
    | 'unavailable'
    | 'unauthorized'
    | 'internal';
