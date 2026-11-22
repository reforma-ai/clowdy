import { agent, McpServer, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/experimental/v2/unstable';
/**
 * A scripted ACP v2 agent for tests: `bun test/fake-acp-agent-v2.ts`. It speaks the draft protocol: `session/prompt` only says the message was inserted
 * (`{ messageId }`), and the turn is `state_update` `running` until `idle` with a `stopReason` and the turn's `usage`. It takes the directives of
 * `fake-acp-agent.ts` that apply, each line of a prompt run in order (read its header for them):
 *
 *   say, tool, call, perm, usage, context, /compact, limit, info, capabilities, choice, prompt, env, fail, sleep, crash, title, echo, late
 *
 * `fail` ends the turn with `idle` and `stopReason: error` (the failure rides on the update, as v2 reports one after the message went in). The v1 `subagent`
 * directive is not spoken as it is: a sub-agent is a session of its own in v2, told in the shape Claude's adapter tells it (see `subagent` below). Directives only v2 has:
 *
 *   pause <ms>                  `requires_action` for that long, then `running` again, as an agent waiting for a person does
 *   stop <reason>               ends the turn at once with that stop reason (`max_tokens`, `max_turn_requests`, `refusal`, ...)
 *   subagent <ms> <title>       a foreground sub-agent, as Claude's adapter tells one: the parent never sees an `Agent` call, it announces the child with
 *                               `subagent_update` (kind `general-purpose`, the title, `cancel` capability, state `running`), the prompt is a `session_message`
 *                               (the parent's view with `recipientMessageId`, the child's with `senderMessageId`, its id the id of the call, which the
 *                               child's own calls name as their `parentToolUseId`), the child says a message and calls a `Bash` tool on its own session, and
 *                               <ms> after it began it sends its report as a `session_message`, `subagent_update` `idle` and its own `idle`. The parent's
 *                               turn goes on meanwhile and its state never lists the child. A cancel (`session/cancel`) of the parent ends it with `stopReason: cancelled`
 *                               (and the parent's turn too); a cancel of the child's own session ends that child alone (see `session/cancel` below)
 *   stray <text>                says <text> on a session that no `subagent_update` announced, which the client must not read
 *   outcome <reason>            how the next sub-agent ends: `end_turn` (default), `cancelled` or `error`; the last two send no report
 *   locked                      the next sub-agent is announced without the `cancel` capability: the client may not cancel it
 *   flap                        the next background sub-agent that ends is woken again at once, as one with a background command of its own is: its `idle`
 *                               and the list without it, then `running` and the list with it again a moment later, and the real end 150 ms after that
 *   background <kind> <ms> <title>   starts work that runs on after the turn and ends <ms> later, listed in `background` of every state until then:
 *                               `terminal` (a command: `terminal_update` with its command, a `Bash` call that completes at once), `subagent` (a child
 *                               session told as `subagent` above, listed in `background`, its calls and report coming after the parent's `idle`) or `workflow` (a
 *                               `Workflow` tool call that stays `in_progress`). When it ends the list says so (a repeated `idle` snapshot without a stop
 *                               reason, or `running` while a turn goes on) and, after the gap, the agent starts a turn of its own that reports it
 *   retitle <ms> <title>        <ms> from now gives the workflow started last a new title, with no state update after it, as a workflow's progress does
 *   report <directive>          a line of the script of that report turn (default: `say <title> finished`); `report none` ends work with no report turn
 *   gap <ms>                    how long after the work ended (and after the turn it ended in) the report turn begins; 40 ms by default
 *   twice [whole]               when a prompt was inserted into this turn, the turn ends as Claude's adapter ends one that took a steer: an `idle` with
 *                               zero usage, a `running`, the last message again under a new id (one `agent_message_chunk` with all the text, as the
 *                               adapter says it; `whole`: one `agent_message`), and an `idle` with the real usage
 *   die <ms>                    the agent's process exits that long from now, whatever it is doing
 *   monitor <timeout_ms> <tick_ms> <description>   a `Monitor` call as Claude Code's adapter says it (the name in the first update, the input
 *                               growing, `completed` with `Monitor started (task ..., expires in Ns ...)`), which the adapter does NOT list in `background`: every
 *                               <tick_ms> (0: none) a turn of the agent's own says `tick <n>`, and at <timeout_ms> one more says `Monitor <description> ended`
 *                               (or the lines of `onwake`). `monitor persistent <description>` is one that runs for the life of the session: no end, no turn
 *   wakeup <seconds> <reason>   a `ScheduleWakeup` call (`Next wakeup scheduled for 11:15:00 (in <seconds>s)`) whose turn begins <seconds> later and says
 *                               `woke: <reason>`, or the lines of `onwake`; a turn of it may call `wakeup` again (a loop)
 *   onwake <directive>          a line of the script of the turn that the next `monitor` (its end) or `wakeup` starts
 *   ending <how>                how the next `monitor` or `wakeup` call ends: `completed` (default), `failed`, `cancelled`, or `plain` (completed with a
 *                               result that says nothing of when, so the client falls back on the delay it was asked for); the last three start no timer
 *   listed                      the next `monitor` is listed in `background` as a `tool_call` until its time, as a newer adapter lists one; the turn at its end
 *                               is the report turn of that work
 *
 * FAKE_ACP_STORE is a folder where the agent keeps every session's conversation (the messages it said, with the ids it named them by, and the prompts it was
 * given), as the real adapters keep theirs on disk, so a session lives past the process and another process can fork it. Without it nothing is kept. Session ids are
 * then random, since two processes would both call their first session `fake-1`. The directive `history` says the session's conversation so far, as `user: <text>
 * | assistant: <text> | ...`. FAKE_ACP_FORK=1 gives the agent `session.fork` and the vendor fork point of the adapters: `session/fork` with `_meta.jetbrains.air.fork`
 * (`{ version: 1, messageId }`) copies the stored conversation through the message with that id, inclusive, into a new session that is open at once, and refuses
 * a point or a session it does not have (`-32602` and "Session not found"); `session/close` is taken. FAKE_ACP_FORK=hang never answers a fork. FAKE_ACP_LOG gets
 * `fork-request <json of what the request carried>` and `fork-process <pid>` for every `session/fork` (and `fork-bridge <url> <token> <status>`, the tool bridge's answer
 * to the request's own credential, when the request names the bridge's MCP server), `fork <session> <message> <new session>` for one that made a copy, and
 * `close <session>` for every `session/close`.
 *
 * `session/cancel` of a sub-agent's session, as Claude's adapter takes it, ends that sub-agent and nothing else: its terminal gets an exit status, its call is
 * `cancelled`, the parent mirrors it in `subagent_update` (`idle`, stop reason `cancelled`, no report), the child says the same on its own session, and the
 * parent's state lists the work without it (a repeated `idle` snapshot, or `running` while a turn goes on); the parent and the other sub-agents are
 * untouched, and a work that ended on its own, or a repeat, is not touched again. A background sub-agent that was stopped is reported by the report turn
 * like any work that ended (`<title> stopped` by default). A `session/cancel` of the parent while only background work runs does nothing.
 *
 * FAKE_ACP_LOG is a file that gets a line for every `session/cancel`, `steer <text>` for every prompt that comes while a turn runs (v2 has no steering
 * method: a prompt is inserted into the turn), `steering <text>` for every `_session/steering` request, `terminal-cancel <terminal>` for every `terminal/cancel`, `tool-call-cancel <call>` for every `tool_call/cancel`,
 * and `title <session> <title>` for every `session/set_title`. A prompt during a turn is taken, inserted into the turn (Claude's adapter does that), unless
 * FAKE_ACP_QUEUE holds it. FAKE_ACP_STEERING=1 makes the agent an adapter like Codex's: its `initialize` says `_meta.steering.supported`, and a
 * `_session/steering` request while a turn runs is answered `{ outcome: 'injected' }` (the message is echoed as a `user_message_chunk` and its lines run in
 * that turn, after the line in progress, as a prompt's do), and `{ outcome: 'promptRequired', reason: 'noRunningTurn' }` when none runs. Without the switch
 * the agent still answers the method, so a test can see that the client did not ask. FAKE_ACP_TERMINAL_CANCEL=1 gives every background terminal and every `Workflow` call the
 * `cancel` capability and lets `terminal/cancel` and `tool_call/cancel` stop it: its terminal gets an exit status and the list loses it, and, as with a real adapter, the agent
 * owes no report of it; a terminal that is unknown, has ended, or cannot be cancelled is refused with `-32602`. `FAKE_ACP_TERMINAL_CANCEL=refuse`
 * advertises the capability and refuses every request with `-32602`, as an adapter does for a terminal that ended a moment before. FAKE_ACP_RESUME is `resume` (default) or `none` (`session/resume` is answered as an unknown method; FAKE_ACP_LOST=1
 * refuses it with "Session not found"). A resume replays two messages and `replay_complete` only when it asks for it (`replayFrom`);
 * FAKE_ACP_REPLAY=always replays whether asked or not, with a stale `idle` among them, as an agent that does not wait to be asked. FAKE_ACP_SNAPSHOT=1 starts every
 * turn with an `idle` that carries no stop reason, before `running`, as a snapshot of the state the session was in (`FAKE_ACP_SNAPSHOT=reason`: one
 * that carries the last stop reason, which a repeated snapshot may). FAKE_ACP_BLOCKED=1 starts every turn with `requires_action` instead of `running`, as
 * foreground work that begins blocked does. FAKE_ACP_REJECT=1 refuses every prompt with an error response, as an agent does that cannot take the message in (`later`: those after the first turn began). FAKE_ACP_QUEUE=1 holds a prompt that comes while a turn runs until that turn's `idle`, then runs it as a turn
 * of its own and only then answers it, as Codex does (a prompt answered after the `idle` that came before it; `refuse`: it refuses the held prompt then instead). FAKE_ACP_SLOW=<ms>
 * answers every prompt after the first turn began that much later. FAKE_ACP_NOECHO=1 does not echo the prompts it is given back as `user_message`. FAKE_ACP_ECHO_LATE=1 echoes a prompt that begins a turn after the turn's
 * `running`, as Codex's adapter does (Claude's echoes it first). FAKE_ACP_WHOLE=1 says every message
 * as two whole-message upserts, the second with all the text. FAKE_ACP_SYSTEM_PROMPT=0 drops the system prompt capability; FAKE_ACP_DIRECTORIES=1 advertises
 * `session.additionalDirectories` (the `info` directive shows the list a session got either way); FAKE_ACP_TITLES=1 gives the agent `session.title` and
 * `session/set_title`; FAKE_ACP_AUTH=1 makes `session/new` ask for authentication; FAKE_ACP_EFFORT is `1` (a reasoning option that follows the model)
 * or `thinking` (the same, behind an option of another kind); FAKE_ACP_RESUME_WARNING=1 makes a resumed session warn, at the start of its first turn,
 * that it was recorded with another model, as Codex does.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import type { AgentContext, SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2/unstable';

interface FakeSession {
    cwd: string;
    /** The `additionalDirectories` of the request that opened the session, absent when it had none. */
    directories?: string[];
    mcpServers: McpServer[];
    systemPrompt?: string;
    meta?: unknown;
    /** The `replayFrom` the session was resumed with. */
    replayFrom?: unknown;
    /** The session was resumed, not new. */
    resumed: boolean;
    model: string;
    /** The reasoning level, when `FAKE_ACP_EFFORT` gives the agent a reasoning option. */
    effort: string;
    /** The permission mode `session/set_config_option` set (`FAKE_ACP_MODES=1`); absent until one was. */
    mode?: string;
    /** How many `session/set_config_option` requests the session took. */
    sets: number;
    cancel: AbortController;
    count: number;
    cost: number;
    /** A turn is running, so a prompt is inserted into it. */
    prompting: boolean;
    /** Prompts inserted into the running turn and not yet run, as text. */
    steers: string[];
    /** Prompts held until the turn ends (`FAKE_ACP_QUEUE`), each waiting for its turn to come. */
    queue: (() => void)[];
    /** The title the client gave with `session/set_title`; the agent names the session only while it has none. */
    title?: string;
    id: string;
    /** The connection the agent talks to the client on, kept to speak when no request is open: a report turn begins on the agent's own. */
    client?: AgentContext;
    /** Background work that was started and has not ended, and what is owed a report turn once the agent is free to give one. */
    work: Work[];
    reports: Work[];
    /** The lines of the report turn (`report`), `false` for no report turn at all (`report none`). */
    reportLines: string[] | false;
    /** How long after the work ended the report turn begins. */
    gap: number;
    /** A report turn is waiting to begin. */
    reporting: boolean;
    /** A prompt was inserted into the turn that runs. */
    landed: boolean;
    /** How the next sub-agent ends (`outcome`), and whether it is woken again at once (`flap`). */
    outcome: 'end_turn' | 'cancelled' | 'error';
    flap: boolean;
    /** The next sub-agent is announced without the `cancel` capability (`locked`). */
    locked: boolean;
    /** The lines of the agent-started turns that have come due and wait for the agent to be free: a monitor's tick or notice, a wakeup. */
    events: string[][];
    draining: boolean;
    /** What `onwake` gave the next scheduled turn. */
    wakeLines: string[];
    /** How the next `monitor` or `wakeup` call ends (`ending`), and whether the next monitor is listed (`listed`). */
    ending: 'completed' | 'failed' | 'cancelled' | 'plain';
    listing: boolean;
}

/** One piece of background work. */
interface Work {
    title: string;
    /** What `background` lists for it. */
    item: Record<string, unknown>;
    done: boolean;
    kind: 'terminal' | 'subagent' | 'workflow' | 'monitor';
    /** The id the work is known by: a terminal's, a child session's, a tool call's. */
    ref: string;
    /** A sub-agent's: what it asked of the child (the id of the call too), how the child ends, and whether it wakes again. */
    callId?: string;
    outcome?: FakeSession['outcome'];
    flap?: boolean;
    /** A sub-agent's call has begun and has not ended, so a stop cancels it. */
    calling?: boolean;
    /** The client stopped the sub-agent: its report says so. */
    stopped?: boolean;
}

const sessions = new Map<string, FakeSession>();
/** The foreground sub-agents that work now, by their session id: a cancel of one ends it alone. */
const stoppable = new Map<string, AbortController>();
/** What the client said it can do in `initialize`, for the `capabilities` directive. */
let clientCapabilities: unknown;
let counter = 0;
const resumeMode = process.env.FAKE_ACP_RESUME ?? 'resume';

/** FAKE_ACP_LOST=1: the agent no longer has any session it is asked to resume, as Cursor does with a folder it has not seen. */
function lose(): void {
    if (process.env.FAKE_ACP_LOST === '1') {
        throw new RequestError(-32002, 'Session not found');
    }
}

function systemText(content: unknown): string | undefined {
    return Array.isArray(content) ? content.map(block => (block as { text?: string }).text ?? '').join('') : undefined;
}

function open(id: string, params: { cwd: string; additionalDirectories?: string[]; mcpServers?: McpServer[]; systemPrompt?: { content?: unknown } | null; replayFrom?: unknown; _meta?: unknown }, resumed: boolean): FakeSession {
    const session: FakeSession = { cwd: params.cwd, directories: params.additionalDirectories, mcpServers: params.mcpServers ?? [], systemPrompt: systemText(params.systemPrompt?.content), meta: params._meta, replayFrom: params.replayFrom ?? undefined, resumed, model: 'fast', effort: 'high', sets: 0, cancel: new AbortController(), count: 0, cost: 0, prompting: false, steers: [], queue: [], id, work: [], reports: [], reportLines: [], gap: 40, reporting: false, landed: false, outcome: 'end_turn', flap: false, locked: false, events: [], draining: false, wakeLines: [], ending: 'completed', listing: false };

    sessions.set(id, session);

    return session;
}

/** The levels a model offers: `smart` has more than `fast`, so a level that is valid for one is not for the other. */
const LEVELS: Record<string, string[]> = { fast: ['low', 'high'], smart: ['low', 'medium', 'high', 'xhigh', 'max'] };

/** A level the agent shows under another name than its value (Claude's `xhigh` is "Extra high"). */
const LEVEL_NAMES: Record<string, string> = { xhigh: 'Extra high' };

/** The options an agent reports: the model, and with `FAKE_ACP_EFFORT=1` a reasoning level that follows the model (as Claude's and Codex's do). */
const modelOptions = (model: string, effort = 'high', mode = 'default') => [
    {
        configId: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: model,
        options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }],
    },
    ...(process.env.FAKE_ACP_EFFORT === 'thinking'
        ? [{
            configId: 'thinking',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: 'on',
            options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }],
        }]
        : []),
    ...(process.env.FAKE_ACP_EFFORT === '1' || process.env.FAKE_ACP_EFFORT === 'thinking'
        ? [{
            configId: 'effort',
            name: 'Effort',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: effort,
            options: (LEVELS[model] ?? LEVELS.fast).map(value => ({ value, name: LEVEL_NAMES[value] ?? value })),
        }]
        : []),
    // `FAKE_ACP_MODES=1`: the permission modes Claude's adapter offers, as one option of category `mode`.
    ...(process.env.FAKE_ACP_MODES === '1'
        ? [{
            configId: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select' as const,
            currentValue: mode,
            options: ['default', 'acceptEdits', 'auto', 'bypassPermissions'].map(value => ({ value, name: value })),
        }]
        : []),
];

const log = (line: string) => {
    if (process.env.FAKE_ACP_LOG) {
        appendFileSync(process.env.FAKE_ACP_LOG, `${ line }\n`);
    }
};

/** One thing said in a session: a prompt it was given, or a message it said with the id it named it by. */
interface Said {
    role: 'user' | 'assistant';
    id?: string;
    text: string;
}

const storeFile = (sessionId: string) => (process.env.FAKE_ACP_STORE ? join(process.env.FAKE_ACP_STORE, `${ sessionId }.json`) : undefined);

/** The conversation of a stored session, or `undefined` for one the store does not have. */
function recall(sessionId: string): Said[] | undefined {
    const file = storeFile(sessionId);

    return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Said[] : undefined;
}

function keep(sessionId: string, said: Said[]): void {
    const file = storeFile(sessionId);

    if (file) {
        mkdirSync(process.env.FAKE_ACP_STORE as string, { recursive: true });
        writeFileSync(file, JSON.stringify(said));
    }
}

/** Adds one thing to the conversation of a session. */
function remember(sessionId: string, said: Said): void {
    keep(sessionId, [...recall(sessionId) ?? [], said]);
}

/** What the agent says of a resume: its history, as the updates it keeps. */
async function replay(client: AgentContext, sessionId: string): Promise<void> {
    const send = (update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update });

    for (const text of ['replayed one', 'replayed two']) {
        await send({ sessionUpdate: 'agent_message', messageId: `replayed-${ text }`, content: [{ type: 'text', text }] });
    }

    // A stale end of an earlier turn, among the history.
    await send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    await send({ sessionUpdate: 'replay_complete' });
}

/** What `background` lists now. */
const listed = (session: FakeSession) => session.work.filter(work => !work.done).map(work => work.item);

/** A `state_update` that carries the session's background list, as an agent that reports background work puts it on every state. */
const state = (session: FakeSession, fields: Record<string, unknown>) => ({ sessionUpdate: 'state_update', background: listed(session), ...fields }) as SessionUpdate;

/** What an `idle` reports for a turn that spent nothing: Claude's adapter says so when a turn ends without a result of its own. */
const NOTHING_SPENT = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };

let works = 0;

type Send = (update: SessionUpdate, sessionId?: string) => Promise<unknown>;

/**
 * What the parent says when it starts a sub-agent, as Claude's adapter says it: the announcement, the child's first state on its own session, and the
 * prompt as a `session_message`, once as the parent sends it and once as the child gets it. The parent is never shown an `Agent` call.
 */
async function announceChild(session: FakeSession, send: Send, ref: string, title: string): Promise<void> {
    const callId = `toolu-${ ref }`;
    const content = [{ type: 'text' as const, text: `Do this: ${ title }` }];

    const capabilities = session.locked ? {} : { cancel: {} };

    session.locked = false;
    await send({ sessionUpdate: 'subagent_update', sessionId: ref, title, description: 'general-purpose', capabilities, state: { state: 'running', background: [] } });
    await send({ sessionUpdate: 'state_update', state: 'running', background: [] }, ref);
    await send({ sessionUpdate: 'session_message', messageId: callId, senderSessionId: session.id, recipientSessionId: ref, content, recipientMessageId: callId });
    await send({ sessionUpdate: 'session_message', messageId: callId, senderSessionId: session.id, recipientSessionId: ref, content, senderMessageId: callId }, ref);
    await send({ sessionUpdate: 'agent_message_chunk', messageId: `m-${ ref }`, content: { type: 'text', text: `Looking into ${ title }` } }, ref);
}

/** The `Bash` call a child makes on its own session: it names the parent's call as its parent, the way Claude Code stamps a sub-agent's calls. */
async function childCall(send: Send, ref: string, title: string, step: 'start' | 'end' | 'cancel'): Promise<void> {
    const toolCallId = `${ ref }-bash`;
    const terminalId = `${ ref }-term`;

    if (step === 'start') {
        await send({ sessionUpdate: 'terminal_update', terminalId, command: `echo ${ title }` }, ref);
        await send({ sessionUpdate: 'tool_call_update', toolCallId, name: 'Bash', title: `echo ${ title }`, kind: 'execute', status: 'pending', rawInput: JSON.stringify({ command: `echo ${ title }` }), content: [{ type: 'terminal', terminalId }], _meta: { claudeCode: { parentToolUseId: `toolu-${ ref }` } } }, ref);
    }
    else if (step === 'end') {
        await send({ sessionUpdate: 'terminal_update', terminalId, output: { data: Buffer.from(`${ title }\n`).toString('base64') } }, ref);
        await send({ sessionUpdate: 'terminal_update', terminalId, exitStatus: { exitCode: 0 } }, ref);
        await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }, ref);
    }
    else {
        await send({ sessionUpdate: 'terminal_update', terminalId, exitStatus: {} }, ref);
        await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'cancelled' }, ref);
    }
}

/**
 * A child's run is over: its report goes to the parent (a cancelled or failed one sends none), the parent mirrors its state in `subagent_update`, and the
 * child says it on its own session. The parent's own state is the caller's.
 */
async function stopChild(session: FakeSession, send: Send, ref: string, title: string, outcome: FakeSession['outcome'], tag = ''): Promise<void> {
    const reportId = `report${ tag }-${ ref }`;
    const idle = outcome === 'error' ? { state: 'idle', stopReason: 'error', error: { code: -32000, message: 'The sub-agent failed' }, background: [] } : { state: 'idle', stopReason: outcome, background: [] };

    if (outcome === 'end_turn') {
        const content = [{ type: 'text' as const, text: `${ title } finished` }];

        await send({ sessionUpdate: 'session_message', messageId: reportId, senderSessionId: ref, recipientSessionId: session.id, content, recipientMessageId: reportId }, ref);
        await send({ sessionUpdate: 'session_message', messageId: reportId, senderSessionId: ref, recipientSessionId: session.id, content, senderMessageId: reportId });
    }

    await send({ sessionUpdate: 'subagent_update', sessionId: ref, state: idle } as SessionUpdate);
    await send({ sessionUpdate: 'state_update', ...idle } as SessionUpdate, ref);
}

/**
 * A foreground sub-agent: the turn goes on while it works, and its state never lists it. Settles with `false` when a cancel of the parent ended it, which
 * ends the turn too; a cancel of the child's own session ends it alone and the turn goes on (`true`).
 */
async function foreground(session: FakeSession, client: AgentContext, ms: number, title: string): Promise<boolean> {
    const send: Send = (update, sessionId = session.id) => client.notify(methods.client.session.update, { sessionId, update }).catch(() => undefined);
    const ref = `child-${ ++works }`;
    const { signal } = session.cancel;
    const own = new AbortController();
    const outcome = session.outcome;
    const cancelled = () => signal.aborted || own.signal.aborted;
    const nap = (wait: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        const stop = () => {
            clearTimeout(timer);
            resolve();
        };

        signal.addEventListener('abort', stop, { once: true });
        own.signal.addEventListener('abort', stop, { once: true });
    });

    session.outcome = 'end_turn';
    stoppable.set(ref, own);

    try {
        await announceChild(session, send, ref, title);
        await childCall(send, ref, title, 'start');
        await nap(ms / 2);

        if (cancelled()) {
            await childCall(send, ref, title, 'cancel');
            await stopChild(session, send, ref, title, 'cancelled');

            return !signal.aborted;
        }

        await childCall(send, ref, title, 'end');
        await nap(ms / 2);

        if (cancelled()) {
            await stopChild(session, send, ref, title, 'cancelled');

            return !signal.aborted;
        }

        await stopChild(session, send, ref, title, outcome);

        return true;
    }
    finally {
        stoppable.delete(ref);
    }
}

/** Starts a piece of background work that ends `ms` from now. */
async function startWork(session: FakeSession, client: AgentContext, kind: Exclude<Work['kind'], 'monitor'>, ms: number, title: string): Promise<void> {
    // A client that has gone is not an error of the work.
    const send = (update: SessionUpdate, sessionId = session.id) => client.notify(methods.client.session.update, { sessionId, update }).catch(() => undefined);
    const n = ++works;
    let ref: string;
    let item: Record<string, unknown>;

    if (kind === 'terminal') {
        ref = `term-${ n }`;
        item = { type: 'terminal', terminalId: ref };
        // The command comes with the terminal, before any list that names it; the `Bash` call that started it completes at once.
        await send({ sessionUpdate: 'terminal_update', terminalId: ref, command: title, ...(process.env.FAKE_ACP_TERMINAL_CANCEL && { capabilities: { cancel: {} } }) });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: `bash-${ n }`, title, kind: 'execute', status: 'completed', rawInput: { command: title, run_in_background: true }, content: [{ type: 'terminal', terminalId: ref }] });
    }
    else if (kind === 'subagent') {
        ref = `child-${ n }`;
        item = { type: 'subagent', sessionId: ref };
        await announceChild(session, send, ref, title);
    }
    else {
        ref = `wf-${ n }`;
        item = { type: 'tool_call', toolCallId: ref };
        await send({ sessionUpdate: 'tool_call_update', toolCallId: ref, title: `Workflow: ${ title }`, kind: 'other', status: 'in_progress', ...(process.env.FAKE_ACP_TERMINAL_CANCEL && { capabilities: { cancel: {} } }), _meta: { claudeCode: { toolName: 'Workflow' } } });
    }

    const work: Work = { title, item, done: false, kind, ref, ...(kind === 'subagent' && { callId: `toolu-${ ref }`, outcome: session.outcome, flap: session.flap }) };

    if (kind === 'subagent') {
        session.outcome = 'end_turn';
        session.flap = false;

        // The child's call starts soon after, and ends while it works: its traffic is on its own session, after the parent's turn is over. A child that was
        // stopped (or ended) before then makes no call.
        setTimeout(() => {
            if (!work.done) {
                work.calling = true;
                void childCall(send, ref, title, 'start');
            }
        }, Math.min(30, ms / 4));
        setTimeout(() => {
            if (!work.done && work.calling) {
                work.calling = false;
                void childCall(send, ref, title, 'end');
            }
        }, ms / 2);
    }

    session.work.push(work);
    await send(state(session, { state: session.prompting ? 'running' : 'idle' }));
    setTimeout(() => void endWork(session, work), ms);
}

/** The work ends: its card says so, the list drops it, and the agent owes a report of it. */
async function endWork(session: FakeSession, work: Work): Promise<void> {
    const { client } = session;

    if (!client || work.done) {
        return;
    }

    const send = (update: SessionUpdate, sessionId = session.id) => client.notify(methods.client.session.update, { sessionId, update }).catch(() => undefined);

    work.done = true;
    work.calling = false;

    if (work.kind === 'terminal') {
        await send({ sessionUpdate: 'terminal_update', terminalId: work.ref, exitStatus: { exitCode: 0 } });
    }
    else if (work.kind === 'subagent') {
        if (work.flap) {
            // The child stops and is out of the list; its own command wakes it before anything else is said, and it is listed again.
            await stopChild(session, send, work.ref, work.title, 'end_turn', '-first');
            await send(state(session, { state: session.prompting ? 'running' : 'idle' }));
            work.done = false;
            await send({ sessionUpdate: 'subagent_update', sessionId: work.ref, state: { state: 'running', background: [] } });
            await send({ sessionUpdate: 'state_update', state: 'running', background: [] }, work.ref);
            await send(state(session, { state: session.prompting ? 'running' : 'idle' }));
            await Bun.sleep(150);
            work.done = true;
        }

        await stopChild(session, send, work.ref, work.title, work.outcome ?? 'end_turn');
    }
    else if (work.kind === 'workflow') {
        await send({ sessionUpdate: 'tool_call_update', toolCallId: work.ref, status: 'completed' });
    }

    // While a turn goes on the list rides on its state; with none, on a repeated `idle` that carries no stop reason (it is no new completion).
    await send(state(session, { state: session.prompting ? 'running' : 'idle' }));

    if (session.reportLines !== false) {
        session.reports.push(work);
        report(session);
    }
}

/**
 * The client asked a background sub-agent to stop (`session/cancel` on its session): its call is cancelled, it and its parent say it stopped, the list loses it,
 * and the agent owes a report of it. Nothing else is touched. A sub-agent that has ended already, and a repeat, are not touched again.
 */
async function stopWork(session: FakeSession, work: Work): Promise<void> {
    const { client } = session;

    if (!client || work.done) {
        return;
    }

    const send = (update: SessionUpdate, sessionId = session.id) => client.notify(methods.client.session.update, { sessionId, update }).catch(() => undefined);

    work.done = true;
    work.stopped = true;

    if (work.calling) {
        work.calling = false;
        await childCall(send, work.ref, work.title, 'cancel');
    }

    await stopChild(session, send, work.ref, work.title, 'cancelled');
    await send(state(session, { state: session.prompting ? 'running' : 'idle' }));

    if (session.reportLines !== false) {
        session.reports.push(work);
        report(session);
    }
}

/**
 * The client asked to cancel a background terminal (`terminal/cancel`): its process ends, the terminal gets an exit status, and the list loses it. A real
 * adapter gives the agent no report of it, so none is owed. Refused with `-32602` when the terminal is unknown, has ended, or cannot be cancelled.
 */
async function cancelTerminal(terminalId: string): Promise<void> {
    log(`terminal-cancel ${ terminalId }`);

    for (const session of sessions.values()) {
        const work = session.work.find(candidate => candidate.kind === 'terminal' && candidate.ref === terminalId);

        if (work && !work.done && process.env.FAKE_ACP_TERMINAL_CANCEL === '1' && session.client) {
            const { client } = session;
            const send = (update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId: session.id, update }).catch(() => undefined);

            work.done = true;
            work.stopped = true;
            await send({ sessionUpdate: 'terminal_update', terminalId, exitStatus: { exitCode: -1 } });
            await send(state(session, { state: session.prompting ? 'running' : 'idle' }));

            return;
        }
    }

    throw new RequestError(-32602, 'Unknown, exited or not cancellable terminal');
}

/** The client asked to cancel a background tool call (`tool_call/cancel`, a `Workflow`): as a terminal's cancel, the call ends `cancelled` and the list loses it; no report is owed. */
async function cancelCall(toolCallId: string): Promise<void> {
    log(`tool-call-cancel ${ toolCallId }`);

    for (const session of sessions.values()) {
        const work = session.work.find(candidate => candidate.kind === 'workflow' && candidate.ref === toolCallId);

        if (work && !work.done && process.env.FAKE_ACP_TERMINAL_CANCEL === '1' && session.client) {
            const { client } = session;
            const send = (update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId: session.id, update }).catch(() => undefined);

            work.done = true;
            work.stopped = true;
            await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'cancelled', capabilities: null });
            await send(state(session, { state: session.prompting ? 'running' : 'idle' }));

            return;
        }
    }

    throw new RequestError(-32602, 'Tool call is not running in the background, so it cannot be cancelled');
}

/**
 * An agent-started turn at its time, as Claude Code's own timers start one (a monitor's output line or its notice, a wakeup): it begins when the agent is free,
 * after the gap, with no marker before its `running`.
 */
function wake(session: FakeSession, ms: number, lines: string[]): void {
    setTimeout(() => {
        session.events.push(lines);
        drain(session);
    }, ms);
}

/** Begins the next turn that has come due, unless a turn runs by then: its end tries again. */
function drain(session: FakeSession): void {
    if (session.draining || session.events.length === 0) {
        return;
    }

    session.draining = true;
    setTimeout(() => {
        session.draining = false;

        if (session.prompting || session.events.length === 0 || !session.client) {
            return;
        }

        session.prompting = true;
        void turn(session, session.id, (session.events.shift() as string[]).join('\n'), session.client);
    }, session.gap);
}

/**
 * A call of a tool that schedules something inside the agent (`monitor`, `wakeup`), in the shape Claude Code's adapter reports one: the name in the first update
 * (the input still empty), the input as it is completed, then `completed` with the tool's own words, before the turn's `idle`. The adapter lists none of them
 * in `background` (0.107.0), so the timers that follow are the agent's alone; `listed` makes a monitor the exception, as a newer adapter lists one.
 */
async function scheduled(session: FakeSession, send: Send, tool: 'Monitor' | 'ScheduleWakeup', rest: string[]): Promise<void> {
    const n = ++works;
    const toolCallId = `toolu-${ tool === 'Monitor' ? 'monitor' : 'wakeup' }-${ n }`;
    const { ending, listing } = session;
    const onwake = session.wakeLines.splice(0);
    let input: Record<string, unknown>;
    let output: string;
    let timers: () => void = () => undefined;

    session.ending = 'completed';
    session.listing = false;

    if (tool === 'Monitor') {
        const persistent = rest[0] === 'persistent';
        const [timeout, tick, ...words] = persistent ? ['0', '0', ...rest.slice(1)] : rest;
        const description = words.join(' ');
        const ms = Number(timeout);

        input = persistent
            ? { command: 'tail -f build.log', description, persistent: true }
            : { command: 'for i in 1 2 3; do echo "tick $i"; sleep 5; done', description, timeout_ms: ms };
        output = persistent
            ? `Monitor started (task mon-${ n }, persistent until you stop it). You will be notified on each event.`
            : `Monitor started (task mon-${ n }, expires in ${ Math.ceil(ms / 1000) }s unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep.`;
        timers = () => {
            if (persistent) {
                return;
            }

            for (let tickAt = Number(tick), count = 1; Number(tick) > 0 && tickAt < ms; tickAt += Number(tick), count++) {
                wake(session, tickAt, [`say tick ${ count }`]);
            }

            if (!listing) {
                wake(session, ms, onwake.length > 0 ? onwake : [`say Monitor ${ description } ended`]);

                return;
            }

            // A monitor the adapter lists is work like any: the list loses it when it ends, and the agent reports it.
            const work: Work = { title: description, item: { type: 'tool_call', toolCallId }, done: false, kind: 'monitor', ref: toolCallId };

            session.work.push(work);
            setTimeout(() => void endWork(session, work), ms);
        };
    }
    else {
        const [seconds, ...words] = rest;
        const reason = words.join(' ');

        input = { delaySeconds: Number(seconds), prompt: `wake: ${ reason }`, reason, noop: false };
        output = ending === 'plain'
            ? 'Wakeup scheduled.'
            : `Next wakeup scheduled for 11:15:00 (in ${ seconds }s). If you owe the user a status update this tick, write it now as ordinary response text; then end the turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`;
        timers = () => wake(session, Number(seconds) * 1000, onwake.length > 0 ? onwake : [`say woke: ${ reason }`]);
    }

    const result = ending === 'failed' ? 'The tool failed' : ending === 'cancelled' ? 'The tool was cancelled' : output;
    const status = ending === 'failed' ? 'failed' : ending === 'cancelled' ? 'cancelled' : 'completed';

    await send({ sessionUpdate: 'tool_call_update', toolCallId, name: tool, rawInput: {}, status: 'pending', title: tool, kind: 'other', content: [] });
    await send({ sessionUpdate: 'tool_call_update', toolCallId, rawInput: input });
    await send({ sessionUpdate: 'tool_call_update', toolCallId, status, rawOutput: result, content: [{ type: 'content', content: { type: 'text', text: result } }] });

    if (status === 'completed') {
        timers();

        // The adapter lists none of these, so no state follows the call; a monitor it lists says so in the state that names it.
        if (listing) {
            await send(state(session, { state: 'running' }));
        }
    }
}

/** Begins the report turn of finished work after the gap, unless a turn runs by then: that turn reports it when it ends. */
function report(session: FakeSession): void {
    if (session.reporting || session.reports.length === 0) {
        return;
    }

    session.reporting = true;
    setTimeout(() => {
        session.reporting = false;

        if (session.prompting || session.reports.length === 0 || !session.client || session.reportLines === false) {
            return;
        }

        const finished = session.reports.splice(0);
        const said = finished.some(work => work.stopped) ? finished.map(work => `${ work.title } ${ work.stopped ? 'stopped' : 'finished' }`).join(', ') : `${ finished.map(work => work.title).join(', ') } finished`;
        const lines = session.reportLines.length > 0 ? session.reportLines : [`say ${ said }`];

        session.reportLines = [];
        session.prompting = true;
        void turn(session, session.id, lines.join('\n'), session.client);
    }, session.gap);
}

/** Runs one turn of a prompt: the directives of its text, and those of every prompt inserted into it. Ends with the `idle` that says why. */
async function turn(session: FakeSession, sessionId: string, text: string, client: AgentContext): Promise<void> {
    // A client that has gone (a cancelled turn closes the agent's input) is not an error of the turn.
    const send = (update: SessionUpdate, on = sessionId) => client.notify(methods.client.session.update, { sessionId: on, update }).catch(() => undefined);
    let said = '';
    let twice: false | 'chunk' | 'whole' = false;
    const say = async (what: string) => {
        const middle = Math.ceil(what.length / 2);
        const messageId = crypto.randomUUID();

        said = what;
        remember(session.id, { role: 'assistant', id: messageId, text: what });

        if (process.env.FAKE_ACP_WHOLE === '1') {
            await send({ sessionUpdate: 'agent_message', messageId, content: [{ type: 'text', text: what.slice(0, middle) }] });
            await send({ sessionUpdate: 'agent_message', messageId, content: [{ type: 'text', text: what }] });

            return;
        }

        for (const part of [what.slice(0, middle), what.slice(middle)]) {
            if (part) {
                await send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: part } });
            }
        }
    };
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    let calls = 0;
    let echoed = false;
    let stopReason = 'end_turn';
    let error: { code: number; message: string } | undefined;
    const later: { ms: number; title: string }[] = [];
    const lines = text.split('\n');

    session.cancel = new AbortController();
    session.count += 1;
    session.landed = false;
    remember(session.id, { role: 'user', text });

    if (process.env.FAKE_ACP_SNAPSHOT) {
        await send(state(session, { state: 'idle', ...(process.env.FAKE_ACP_SNAPSHOT === 'reason' && { stopReason: 'end_turn' }) }));
    }

    await send(state(session, { state: process.env.FAKE_ACP_BLOCKED === '1' ? 'requires_action' : 'running' }));

    if (session.resumed && session.count === 1 && process.env.FAKE_ACP_RESUME_WARNING === '1') {
        await send({ sessionUpdate: 'agent_message_chunk', messageId: crypto.randomUUID(), content: { type: 'text', text: 'Warning: This session was recorded with model `gpt-5.6-luna` but is resuming with `gpt-6-sol`.\n\n' } });
    }

    try {
        for (let index = 0; ; index++) {
            // A prompt inserted into the turn runs where the agent took it: after the line that was running, before the rest of the prompt.
            // One that came before the first line began waits for the first to end.
            if (index > 0) {
                lines.splice(index, 0, ...session.steers.splice(0).flatMap(steer => steer.split('\n')));
            }

            if (index >= lines.length) {
                break;
            }

            const line = lines[index];
            const [command, ...rest] = line.trim().split(' ');
            const argument = rest.join(' ');

            switch (command) {
                case 'say':
                    await say(argument);
                    break;
                case 'tool': {
                    const [name, ...json] = rest;
                    const toolCallId = `t${ session.count }-${ ++calls }`;
                    const input = json.length > 0 ? JSON.parse(json.join(' ')) : {};

                    // There is no `tool_call` in v2: the first update of an id creates the call.
                    await send({ sessionUpdate: 'tool_call_update', toolCallId, title: name, kind: 'read', status: 'in_progress', rawInput: input });
                    await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { output: `${ name } finished` } });
                    break;
                }
                case 'call': {
                    const [tool, ...json] = rest;
                    const server = session.mcpServers[0];

                    if (!server || !McpServer.isStdio(server)) {
                        await say('no mcp server');
                        break;
                    }

                    const toolCallId = `c${ session.count }-${ ++calls }`;
                    const input = json.length > 0 ? JSON.parse(json.join(' ')) : {};
                    const mcp = new Client({ name: 'fake-agent', version: '1' });

                    await send({ sessionUpdate: 'tool_call_update', toolCallId, title: `Tool: ${ server.name }/${ tool }`, kind: 'other', status: 'in_progress', rawInput: input });
                    await mcp.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) }));

                    const result = await mcp.callTool({ name: tool, arguments: input });
                    const content = result.content as { type: string; text?: string }[];

                    await mcp.close();
                    await send({ sessionUpdate: 'tool_call_update', toolCallId, status: result.isError ? 'failed' : 'completed', rawOutput: content.map(block => block.text).join('') });
                    await say(`${ result.isError ? 'error' : 'result' }: ${ content.map(block => block.text).join('') }`);
                    break;
                }
                case 'perm': {
                    // The foreground work waits on a person until the client answers. `perm [kind [json]]`: the optional kind of the call it asks about, and extra fields of it (title, rawInput, locations, content) as JSON.
                    const [kind, ...extra] = rest;

                    await send(state(session, { state: 'requires_action' }));

                    const answer = await client.request(methods.client.session.requestPermission, {
                        sessionId,
                        title: 'Run a command',
                        subject: { type: 'tool_call', toolCall: { toolCallId: `p${ ++calls }`, title: 'Run a command', ...(kind && { kind: kind as 'execute' }), ...(extra.length > 0 ? JSON.parse(extra.join(' ')) as Record<string, unknown> : {}) } },
                        options: [
                            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                        ],
                    });

                    await send(state(session, { state: 'running' }));
                    await say(`permission: ${ answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome }`);
                    break;
                }
                case 'perm2': {
                    // Two requests at once, as an agent that runs two tools in parallel sends them; the second is a command subject, the other kind a v2 request carries.
                    const options = [
                        { optionId: 'reject', name: 'Reject', kind: 'reject_once' as const },
                        { optionId: 'once', name: 'Allow once', kind: 'allow_once' as const },
                    ];

                    await send(state(session, { state: 'requires_action' }));

                    const answers = await Promise.all([
                        client.request(methods.client.session.requestPermission, { sessionId, title: 'first', subject: { type: 'tool_call', toolCall: { toolCallId: `p${ ++calls }`, title: 'first', kind: 'execute', rawInput: { command: 'first' } } }, options }),
                        client.request(methods.client.session.requestPermission, { sessionId, title: 'second', subject: { type: 'command', command: 'second', cwd: '/work' }, options }),
                    ]);

                    await send(state(session, { state: 'running' }));
                    await say(`permissions: ${ answers.map(answer => (answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome)).join(',') }`);
                    break;
                }
                case 'pause':
                    await send(state(session, { state: 'requires_action' }));
                    await Bun.sleep(Number(argument));
                    await send(state(session, { state: 'running' }));
                    break;
                case 'subagent': {
                    const [ms, ...title] = rest;

                    if (!await foreground(session, client, Number(ms), title.join(' '))) {
                        stopReason = 'cancelled';

                        return;
                    }

                    break;
                }
                case 'stray':
                    await send({ sessionUpdate: 'agent_message_chunk', messageId: 'stray', content: { type: 'text', text: argument } }, 'stranger');
                    break;
                case 'outcome':
                    session.outcome = argument as FakeSession['outcome'];
                    break;
                case 'flap':
                    session.flap = true;
                    break;
                case 'locked':
                    session.locked = true;
                    break;
                case 'background': {
                    const [kind, ms, ...title] = rest;

                    await startWork(session, client, kind as Exclude<Work['kind'], 'monitor'>, Number(ms), title.join(' '));
                    break;
                }
                case 'monitor':
                    await scheduled(session, send, 'Monitor', rest);
                    break;
                case 'wakeup':
                    await scheduled(session, send, 'ScheduleWakeup', rest);
                    break;
                case 'onwake':
                    session.wakeLines.push(argument);
                    break;
                case 'ending':
                    session.ending = argument as FakeSession['ending'];
                    break;
                case 'listed':
                    session.listing = true;
                    break;
                case 'retitle': {
                    const [ms, ...title] = rest;
                    const work = session.work.filter(candidate => candidate.kind === 'workflow' && !candidate.done).at(-1);

                    if (work) {
                        setTimeout(() => void send({ sessionUpdate: 'tool_call_update', toolCallId: work.ref, title: title.join(' ') }), Number(ms));
                    }

                    break;
                }
                case 'report':
                    session.reportLines = argument === 'none' ? false : [...(session.reportLines || []), argument];
                    break;
                case 'gap':
                    session.gap = Number(argument);
                    break;
                case 'twice':
                    twice = argument === 'whole' ? 'whole' : 'chunk';
                    break;
                case 'die':
                    setTimeout(() => {
                        process.stderr.write('boom: the fake agent was told to die\n');
                        process.exit(4);
                    }, Number(argument));
                    break;
                case 'stop':
                    stopReason = argument;

                    return;
                case 'usage': {
                    const [input, output, cost] = rest.map(Number);

                    usage = { inputTokens: (usage?.inputTokens ?? 0) + input, outputTokens: (usage?.outputTokens ?? 0) + output, totalTokens: (usage?.totalTokens ?? 0) + input + output };
                    session.cost += cost;
                    await send({ sessionUpdate: 'usage_update', used: input + output, size: 200_000, cost: { amount: session.cost, currency: 'USD' } });
                    break;
                }
                case 'context': {
                    const [used, size] = rest;

                    await send({ sessionUpdate: 'usage_update', used: Number(used), size: Number(size) });
                    break;
                }
                case '/compact': {
                    // What Claude's adapter reports for its own command: a tool call with the counts, a smaller window, and no words.
                    const toolCallId = `k${ session.count }`;
                    const rawOutput = { trigger: 'manual', preTokens: 22_062, postTokens: 6111, durationMs: 4200 };

                    await send({ sessionUpdate: 'tool_call_update', toolCallId, title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: { claudeCode: { toolName: 'compact' } } });
                    await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput, _meta: { claudeCode: { toolName: 'compact' } } });
                    await send({ sessionUpdate: 'usage_update', used: 6111, size: 1_000_000 });
                    break;
                }
                case 'limit': {
                    const [status, resetsAt] = rest;

                    await send({ sessionUpdate: 'usage_update', used: 1, size: 200_000, _meta: { '_claude/rateLimit': { status, rateLimitType: 'five_hour', utilization: 0.95, resetsAt: Number(resetsAt) } } });
                    break;
                }
                case 'title':
                    // An agent names a session only when the client has not.
                    if (session.title === undefined) {
                        await send({ sessionUpdate: 'session_info_update', title: argument });
                    }

                    break;
                case 'echo':
                    echoed = true;
                    break;
                case 'late':
                    later.push({ ms: Number(rest[0]), title: rest.slice(1).join(' ') });
                    break;
                case 'info':
                    await say(JSON.stringify({ title: session.title, cwd: session.cwd, directories: session.directories, servers: session.mcpServers.map(server => server.name), systemPrompt: session.systemPrompt, meta: session.meta, replayFrom: session.replayFrom, model: session.model, prompts: session.count }));
                    break;
                case 'history':
                    await say(`history: ${ (recall(session.id) ?? []).map(entry => `${ entry.role }: ${ entry.text }`).join(' | ') }`);
                    break;
                case 'capabilities':
                    await say(JSON.stringify(clientCapabilities));
                    break;
                case 'choice':
                    await say(JSON.stringify({ model: session.model, effort: session.effort, sets: session.sets, ...(session.mode && { mode: session.mode }) }));
                    break;
                case 'prompt':
                    await say(JSON.stringify(text));
                    break;
                case 'env':
                    await say(`${ argument }=${ process.env[argument] ?? '' }`);
                    break;
                case 'fail': {
                    const [code, ...message] = rest;

                    error = { code: Number(code), message: message.join(' ') };
                    stopReason = 'error';

                    return;
                }
                case 'sleep': {
                    const { signal } = session.cancel;

                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, Number(argument));

                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            resolve();
                        }, { once: true });
                    });

                    if (signal.aborted) {
                        stopReason = 'cancelled';

                        return;
                    }

                    break;
                }
                case 'crash':
                    process.stderr.write('boom: the fake agent crashed\n');
                    process.exit(3);
                    break;
                default:
                    if (line.trim()) {
                        await say('ok');
                    }
            }
        }
    }
    finally {
        if (twice && session.landed && stopReason === 'end_turn') {
            // A prompt that landed in the turn was queued by the agent behind it: the turn ends without a result of its own, and the prompt's turn
            // follows, which gives the answer again as a whole message under a new id, and the usage.
            await send(state(session, { state: 'idle', stopReason, usage: NOTHING_SPENT }));
            await Bun.sleep(session.gap);
            await send(state(session, { state: 'running' }));

            if (said) {
                const messageId = crypto.randomUUID();

                await send(twice === 'whole'
                    ? { sessionUpdate: 'agent_message', messageId, content: [{ type: 'text', text: said }] }
                    : { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: said } });
            }

            session.prompting = false;
            await send(state(session, { state: 'idle', stopReason, ...(usage && { usage }) }));
        }
        else {
            session.prompting = false;
            await send(state(session, { state: 'idle', stopReason, ...(error && { error }), ...(usage && { usage }) }));
        }

        // A prompt held for this turn's end (`FAKE_ACP_QUEUE`) runs next; work that ended meanwhile is reported once the agent is free.
        session.queue.shift()?.();
        report(session);
        drain(session);

        // What an agent gives once the turn is over: its first message as the title, then a name of its own a moment later.
        if (session.title === undefined) {
            if (echoed) {
                setTimeout(() => void send({ sessionUpdate: 'session_info_update', title: text.replace(/\s+/g, ' ').trim() }), 5);
            }

            for (const { ms, title } of later) {
                setTimeout(() => void send({ sessionUpdate: 'session_info_update', title }), ms);
            }
        }
    }
}

const app = agent({ name: 'fake-acp-agent-v2' })
    .onRequest(methods.agent.initialize, ({ params }) => {
        clientCapabilities = params.capabilities;

        return {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: 'fake-acp-agent-v2', version: '1.0.0' },
            capabilities: {
                session: {
                    mcp: { stdio: {} },
                    ...(process.env.FAKE_ACP_SYSTEM_PROMPT !== '0' && { systemPrompt: {} }),
                    ...(process.env.FAKE_ACP_DIRECTORIES === '1' && { additionalDirectories: {} }),
                    ...(process.env.FAKE_ACP_TITLES === '1' && { title: {} }),
                    ...(process.env.FAKE_ACP_FORK && { fork: {} }),
                },
            },
            ...(process.env.FAKE_ACP_STEERING === '1' && { _meta: { steering: { supported: true } } }),
        };
    })
    .onRequest('_session/steering', params => params as { sessionId: string; prompt: { type: string; text?: string }[] }, async ({ params, client }) => {
        const session = sessions.get(params.sessionId);
        const text = params.prompt.map(block => block.text ?? '').join('\n');

        log(`steering ${ text.replaceAll('\n', ' | ') }`);

        if (!session?.prompting) {
            return { outcome: 'promptRequired', reason: 'noRunningTurn' };
        }

        // Taken into the running turn: echoed at once, and its lines run in that turn.
        session.steers.push(text);
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'user_message_chunk', messageId: crypto.randomUUID(), content: { type: 'text', text } } });

        return { outcome: 'injected' };
    })
    .onRequest(methods.agent.terminal.cancel, async ({ params }) => {
        await cancelTerminal(params.terminalId);

        return {};
    })
    .onRequest(methods.agent.toolCall.cancel, async ({ params }) => {
        await cancelCall(params.toolCallId);

        return {};
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
        if (process.env.FAKE_ACP_AUTH === '1') {
            throw new RequestError(-32000, 'Authentication required');
        }

        // Two processes of a stored agent would both name their first session `fake-1`.
        const id = process.env.FAKE_ACP_STORE ? `fake-${ crypto.randomUUID().slice(0, 8) }` : `fake-${ ++counter }`;

        open(id, params, false);
        keep(id, []);

        return { sessionId: id, configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
        if (resumeMode === 'none') {
            throw RequestError.methodNotFound(methods.agent.session.resume);
        }

        lose();
        open(params.sessionId, params, true);

        if (params.replayFrom || process.env.FAKE_ACP_REPLAY === 'always') {
            await replay(client, params.sessionId);
        }

        // The agent says what state the session is in before it answers, with or without a replay.
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });

        return { configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.fork, async ({ params }) => {
        log(`fork-request ${ JSON.stringify({ cwd: params.cwd, directories: params.additionalDirectories, servers: (params.mcpServers ?? []).map(server => server.name), systemPrompt: systemText(params.systemPrompt?.content), meta: params._meta }) }`);
        log(`fork-process ${ process.pid }`);

        // The tool bridge's credential of the request, tried while the fork runs, so a test can tell it worked then and not after.
        const env = Object.fromEntries(((params.mcpServers ?? []) as { env?: { name: string; value: string }[] }[]).flatMap(server => (server.env ?? []).map(entry => [entry.name, entry.value])));

        if (env.CLOWDY_BRIDGE_URL) {
            log(`fork-bridge ${ env.CLOWDY_BRIDGE_URL } ${ env.CLOWDY_BRIDGE_TOKEN } ${ (await fetch(`${ env.CLOWDY_BRIDGE_URL }/tools`, { headers: { authorization: `Bearer ${ env.CLOWDY_BRIDGE_TOKEN }` } })).status }`);
        }

        // FAKE_ACP_FORK=hang: the adapter takes the request and never answers, as one that copies a huge transcript seems to.
        if (process.env.FAKE_ACP_FORK === 'hang') {
            await new Promise<never>(() => undefined);
        }

        const point = (params._meta as { jetbrains?: { air?: { fork?: { version?: number; messageId?: string } } } } | null | undefined)?.jetbrains?.air?.fork;
        const source = recall(params.sessionId);

        if (!source) {
            throw RequestError.sessionNotFound(params.sessionId);
        }

        if (point?.version !== 1 || !point.messageId?.trim()) {
            throw RequestError.invalidParams(undefined, 'The fork point is not { version: 1, messageId }');
        }

        const at = source.findIndex(entry => entry.role === 'assistant' && entry.id === point.messageId);

        if (at < 0) {
            throw RequestError.invalidParams({ messageId: point.messageId }, `Fork point message ${ point.messageId } was not found in session ${ params.sessionId }`);
        }

        const id = `fork-${ crypto.randomUUID().slice(0, 8) }`;

        // The copy ends with the message, inclusive; the session is open at once, so the client could prompt it.
        keep(id, source.slice(0, at + 1));
        open(id, params, true);
        log(`fork ${ params.sessionId } ${ point.messageId } ${ id }`);

        return { sessionId: id, configOptions: modelOptions('fast') };
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
        log(`close ${ params.sessionId }`);

        return {};
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        const session = sessions.get(params.sessionId);

        if (session && params.type === 'id' && typeof params.value === 'string') {
            session.sets++;

            if (params.configId === 'effort') {
                session.effort = params.value;
            }
            else if (params.configId === 'model') {
                session.model = params.value;
                // A model keeps the level when it has it, and goes back to its own default when it has not.
                session.effort = (LEVELS[session.model] ?? LEVELS.fast).includes(session.effort) ? session.effort : 'high';
            }
            else if (params.configId === 'mode') {
                session.mode = params.value;
            }
        }

        return { configOptions: modelOptions(session?.model ?? 'fast', session?.effort, session?.mode) };
    })
    .onRequest(methods.agent.session.setTitle, async ({ params, client }) => {
        const session = sessions.get(params.sessionId);

        if (!session) {
            throw RequestError.sessionNotFound(params.sessionId);
        }

        log(`title ${ params.sessionId } ${ params.title }`);
        session.title = params.title;
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update', title: params.title } });

        return { title: params.title };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
        log(`cancel ${ params.sessionId }`);

        const session = sessions.get(params.sessionId);

        if (session) {
            session.cancel.abort();

            return;
        }

        // A sub-agent's own session: it alone is cancelled, whether it works in the foreground or the background.
        stoppable.get(params.sessionId)?.abort();

        for (const parent of sessions.values()) {
            const work = parent.work.find(candidate => candidate.kind === 'subagent' && candidate.ref === params.sessionId);

            if (work) {
                void stopWork(parent, work);
            }
        }
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        const session = sessions.get(params.sessionId);

        if (!session) {
            throw RequestError.sessionNotFound(params.sessionId);
        }

        session.client = client;

        if (process.env.FAKE_ACP_REJECT === '1' || (process.env.FAKE_ACP_REJECT === 'later' && session.count > 0)) {
            throw new RequestError(-32000, 'Authentication required');
        }

        if (process.env.FAKE_ACP_SLOW && session.count > 0) {
            await Bun.sleep(Number(process.env.FAKE_ACP_SLOW));
        }

        const text = params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('\n');
        const messageId = crypto.randomUUID();
        let starting = !session.prompting;

        if (starting) {
            session.prompting = true;
        }
        else if (process.env.FAKE_ACP_QUEUE === '1' || process.env.FAKE_ACP_QUEUE === 'refuse') {
            // Held, answered and echoed only when the turn before it is over, and run as a turn of its own (or refused then).
            log(`queued ${ text.replaceAll('\n', ' | ') }`);
            await new Promise<void>(resolve => session.queue.push(resolve));

            if (process.env.FAKE_ACP_QUEUE === 'refuse') {
                throw new RequestError(-32000, 'Authentication required');
            }

            session.prompting = true;
            starting = true;
        }
        else {
            // Inserted into the running turn: its lines run as directives of that same turn, after the line in progress.
            log(`steer ${ text.replaceAll('\n', ' | ') }`);
            session.steers.push(text);
            session.landed = true;
        }

        // FAKE_ACP_ECHO_LATE=1: the turn that this prompt begins says `running` before the message is echoed.
        const late = starting && process.env.FAKE_ACP_ECHO_LATE === '1';

        if (late) {
            setImmediate(() => void turn(session, params.sessionId, text, client));
            await Bun.sleep(40);
        }

        // FAKE_ACP_NOECHO=1: the agent takes the prompt in and says nothing of it, as an agent that does not echo the messages it is given.
        if (process.env.FAKE_ACP_NOECHO !== '1') {
            await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'user_message', messageId, content: [{ type: 'text', text }] } });
        }

        if (starting && !late) {
            // The turn goes on after the answer: the message is inserted, nothing more.
            setImmediate(() => void turn(session, params.sessionId, text, client));
        }

        return { messageId };
    });

app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
