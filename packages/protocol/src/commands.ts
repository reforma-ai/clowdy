import { z } from 'zod';

/**
 * Everything a client may ask the daemon to do. Each command carries a `requestId`; sending the same id again
 * returns the first result instead of acting twice, so a retry after a dropped response is safe.
 */
const base = { requestId: z.string().min(8).max(100) };

const chatMode = z.enum(['autopilot', 'semi']);
const engine = z.string().min(1).max(64);
const actor = z.object({ kind: z.literal('user') });

export const commandSchema = z.discriminatedUnion('type', [
    /* Projects */
    z.object({ ...base, type: z.literal('project.open'), path: z.string().min(1), name: z.string().min(1).optional() }),
    z.object({ ...base, type: z.literal('project.create'), name: z.string().min(1), path: z.string().min(1).optional() }),
    z.object({
        ...base,
        type: z.literal('project.update'),
        projectId: z.string(),
        name: z.string().min(1).optional(),
        settings: z.object({
            maxParallelRuns: z.number().int().min(1).max(1000).optional(),
            engine: engine.optional(),
            model: z.string().optional(),
            chatMode: chatMode.optional(),
            targetBranch: z.string().optional(),
        }).optional(),
    }),

    /* Chats */
    z.object({ ...base, type: z.literal('chat.create'), projectId: z.string(), title: z.string().optional(), mode: chatMode.optional() }),
    z.object({ ...base, type: z.literal('chat.rename'), chatId: z.string(), title: z.string().min(1) }),
    z.object({ ...base, type: z.literal('chat.setMode'), chatId: z.string(), mode: chatMode }),
    /** Hides the chat from the lists without deleting anything (refused while any of its runs is active), or brings it back. */
    z.object({ ...base, type: z.literal('chat.setArchived'), chatId: z.string(), archived: z.boolean() }),
    /** Removes the chat with its orchestrator's conversation and every run below it; the tasks stay. Refused while any of its runs is active. */
    z.object({ ...base, type: z.literal('chat.delete'), chatId: z.string() }),
    z.object({ ...base, type: z.literal('chat.send'), chatId: z.string(), text: z.string().min(1) }),

    /* Tasks */
    z.object({
        ...base,
        type: z.literal('task.create'),
        projectId: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
        statusId: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        /** Link the new task to this chat, as if the orchestrator had created it there. */
        chatId: z.string().optional(),
    }),
    z.object({
        ...base,
        type: z.literal('task.update'),
        taskId: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        statusId: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
    }),
    z.object({ ...base, type: z.literal('task.delete'), taskId: z.string() }),
    /** Opens a new chat bound to the task, with an orchestrator run that starts on it now; answers `{ runId, chatId }`. One active run per task unless `force`. */
    z.object({ ...base, type: z.literal('task.start'), taskId: z.string(), engine: engine.optional(), force: z.boolean().optional() }),

    /* Runs */
    z.object({ ...base, type: z.literal('run.cancel'), runId: z.string() }),
    /** Answers a `question` stream item of a run in `waiting_user`. */
    z.object({ ...base, type: z.literal('run.answer'), runId: z.string(), questionId: z.string(), answer: z.string() }),

    /* Documents */
    z.object({
        ...base,
        type: z.literal('docs.write'),
        projectId: z.string(),
        path: z.string().min(1),
        content: z.string(),
        /** Hash of the version the edit started from; `null` creates a new file. A mismatch answers `conflict`. */
        baseHash: z.string().nullable(),
    }),

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
    }),
    /** Removes an agent that was added; the built-in ones can only be switched off. */
    z.object({ ...base, type: z.literal('agent.remove'), id: z.string().min(1) }),
    /** Looks for the agents' programs again, for after the user installed one. */
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
