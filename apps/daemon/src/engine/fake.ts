import { errorMessage } from '../errors';

import type { AgentEngine, EngineEvent, EngineFork, EngineForkOptions, EngineSession, EngineStartOptions } from './types';

const WORD_MS = 35;
const TOOL_MS = 700;
const THINK_MS = 400;
/** The window the fake agent reports, the fill before its first turn and what each turn adds: a plausible context ring for the demo. */
const CONTEXT_SIZE = 200_000;
const CONTEXT_BASE = 6_000;
const CONTEXT_PER_TURN = 4_000;

/**
 * A scripted engine for building the UI and testing the runtime without spending a subscription. It follows the contract of the real engines and the
 * system skills: an orchestrator plans three tasks (the third depends on the first) and does them itself, one after another, each with one sub-agent
 * inside its session, moving each task through In progress and Review to Done. A chat started from a task reads it with `task_get` and does that one.
 * `speed` scales every delay; 0 removes them.
 */
export class FakeEngine implements AgentEngine {
    readonly id = 'fake';
    /** Turns started per session id, so a conversation's reading grows from one turn to the next. */
    private turns = new Map<string, number>();

    /** `canFork`: the app may offer Fork and Edit for its chats (the fake agent names its messages and forks a session at one, like a real one). */
    constructor(private speed: number, readonly canFork = true) {}

    /** A copy of a session is a new id that goes on from the same turn; the fake agent keeps nothing else of a conversation, so there is nothing to cut. */
    async fork({ sessionId }: EngineForkOptions): Promise<EngineFork> {
        const forked = `fake-${ crypto.randomUUID() }`;

        this.turns.set(forked, this.turns.get(sessionId) ?? 0);

        return { sessionId: forked };
    }

    start(options: EngineStartOptions): EngineSession {
        const sessionId = options.resumeSessionId ?? `fake-${ crypto.randomUUID() }`;
        const turn = (this.turns.get(sessionId) ?? 0) + 1;

        this.turns.set(sessionId, turn);

        return new FakeSession(options, this.speed, sessionId, turn);
    }
}

type Step<T = void> = AsyncGenerator<EngineEvent, T>;

interface CreatedTask {
    task: { id: string; key: string; title: string };
}

interface TaskList {
    tasks: { key: string; category: string }[];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();

        const finish = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        const onAbort = () => {
            clearTimeout(timer);
            clearImmediate(immediate);
            reject(signal.reason);
        };
        const timer = ms > 0 ? setTimeout(finish, ms) : undefined;
        const immediate = ms > 0 ? undefined : setImmediate(finish);

        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** The first words of the user's message, as a topic for the scripted prose. */
function topicOf(prompt: string): string {
    const message = prompt.replace(/^(?:Follow )?\/?clowdy:\S+ Mode: \S+\s*/, '').replace(/^(Complete task|Task) \S+: /m, '');
    const words = message.split(/\s+/).filter(Boolean).slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '');

    return words || 'the request';
}

const joinKeys = (keys: string[]) => (keys.length > 1 ? `${ keys.slice(0, -1).join(', ') } and ${ keys.at(-1) }` : keys.join());

function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'change';
}

function hash(text: string): number {
    return [...text].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7);
}

class FakeSession implements EngineSession {
    /** Steers taken and not yet answered; the script's checkpoint answers them. */
    private inbox: string[] = [];
    /** The script has its checkpoint still ahead, so a steer will be answered: every script has one, and runs it once. */
    private listening = true;
    private closing = new AbortController();
    private signal: AbortSignal;
    private calls = 0;
    private messages = 0;
    private words = 0;
    /** Tool call ids stay unique across the turns of one run, as real engines make them. */
    private tag = crypto.randomUUID().slice(0, 8);

    constructor(private options: EngineStartOptions, private speed: number, private sessionId: string, private turn: number) {
        this.signal = AbortSignal.any([options.signal, this.closing.signal]);
    }

    /** Takes a steer while the script has not passed its checkpoint, which answers it; after that the runtime keeps the message for the next turn. */
    async steer(text: string): Promise<boolean> {
        if (!this.listening || this.signal.aborted) {
            return false;
        }

        this.inbox.push(text);

        return true;
    }

    close(): void {
        this.closing.abort();
    }

    [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        return this.script();
    }

    private async *script(): Step {
        try {
            yield { type: 'session', sessionId: this.sessionId };

            let result: string;

            if (!this.options.resumeSessionId) {
                const bound = /Complete task (\S+-\d+): /.exec(this.options.prompt)?.[1];

                result = yield* bound ? this.orchestrateBound(bound) : this.orchestrate();
            }
            else {
                result = yield* this.followUp();
            }

            yield { type: 'context', used: Math.min(CONTEXT_SIZE, CONTEXT_BASE + CONTEXT_PER_TURN * this.turn), size: CONTEXT_SIZE };
            yield { type: 'usage', inputTokens: this.options.prompt.length, outputTokens: this.words };
            yield { type: 'done', result };
        }
        catch (error) {
            if (!this.signal.aborted) {
                yield { type: 'error', message: errorMessage(error) };
            }
        }
    }

    /* --------------------------------- Scripts -------------------------------- */

    /** Plans three tasks and does them itself, the dependency first, then checks that all are done. */
    private async *orchestrate(): Step<string> {
        const topic = topicOf(this.options.prompt);

        yield* this.say(`I'll look at the project before planning "${ topic }".`);
        yield* this.tool('read_file', { path: 'README.md' }, async () => ({ path: 'README.md', lines: 84 }));
        yield* this.say('The work splits into three tasks: groundwork, the implementation, and a final check that builds on the groundwork.');

        if (this.has('ask_user')) {
            const { answer } = yield* this.call<{ answer: string }>('ask_user', {
                question: `How should I split "${ topic }"?`,
                options: [
                    { id: 'small', label: 'Small, focused tasks', consequence: 'Easier to review, one at a time' },
                    { id: 'single', label: 'One larger task', consequence: 'Fewer moving parts, harder to review' },
                ],
                recommended: 'small',
            });

            yield* this.say(`Understood, going with: ${ answer }.`);
        }

        const { task: groundwork } = yield* this.call<CreatedTask>('task_create', { title: `Lay the groundwork for ${ topic }`, description: 'Prepare the structure the implementation builds on.' });
        const { task: implementation } = yield* this.call<CreatedTask>('task_create', { title: `Implement ${ topic }`, description: 'The main change, independent of the groundwork.' });
        const { task: check } = yield* this.call<CreatedTask>('task_create', { title: `Verify and document ${ topic }`, description: 'Check the result and write it down.', dependsOn: [groundwork.key] });

        yield* this.say(`Created ${ groundwork.key }, ${ implementation.key } and ${ check.key }. ${ check.key } depends on ${ groundwork.key }, so ${ groundwork.key } goes first. I'll do them myself.`);
        yield* this.checkpoint();

        for (const task of [groundwork, implementation, check]) {
            yield* this.work(task.key, task.title);
        }

        const { tasks } = yield* this.call<TaskList>('task_list', {});
        const open = tasks.filter(task => task.category !== 'done');
        const summary = open.length > 0 ? `${ joinKeys(open.map(task => task.key)) } ${ open.length > 1 ? 'are' : 'is' } still open.` : `Done: ${ joinKeys(tasks.map(task => task.key)) } are complete and checked.`;

        yield* this.say(summary);

        return summary;
    }

    /** A chat started from a task: the task is the request, and the orchestrator does it itself. */
    private async *orchestrateBound(key: string): Step<string> {
        yield* this.say(`This chat is bound to ${ key }. Let me read it.`);

        const { task } = yield* this.call<{ task: { title: string } }>('task_get', { taskId: key });

        yield* this.say(`"${ task.title }" is one piece of work, so I'll do it myself.`);
        yield* this.checkpoint();

        return yield* this.work(key, task.title);
    }

    /** Does one task: moves it to In progress, reads, checks the callers with a sub-agent, edits, moves it to Review, runs the checks, and marks it Done. */
    private async *work(key: string, title: string): Step<string> {
        const path = `src/${ slug(title) }.ts`;
        const seed = hash(title);
        const added = 12 + (seed % 60);
        const removed = seed % 20;

        yield* this.call('task_update', { taskId: key, status: 'active' });
        yield* this.say(`Starting on ${ key }: "${ title }". I'll read the relevant code first.`);
        yield* this.tool('read_file', { path }, async () => ({ path, lines: 80 + (seed % 200) }));
        yield* this.subagent(path);
        yield* this.say('The change is contained. Editing now.');
        yield* this.tool('edit_file', { path }, async () => ({ path, added, removed }));
        yield* this.call('task_update', { taskId: key, status: 'review' });
        yield* this.tool('bash', { command: 'bun run typecheck' }, async () => ({ command: 'bun run typecheck', exitCode: 0 }));

        const result = `${ key } is done: edited ${ path } (+${ added } -${ removed }) and the typecheck passes.`;

        yield* this.say(result);
        yield* this.call('task_update', { taskId: key, status: 'done' });

        return result;
    }

    /**
     * A sub-agent inside the session that looks at the callers of the change, started by an `Agent` call the way Claude's is: the call is in the
     * session's own stream, the sub-agent is known by the call's id, and the call's result is its report.
     */
    private async *subagent(path: string): Step {
        const agentId = `fake-call-${ this.tag }-${ ++this.calls }`;
        const input = { subagent_type: 'Explore', description: `Check the callers of ${ path }`, prompt: `Find the callers of ${ path } and say whether the change affects them.` };
        const summary = `Three callers of ${ path }, none affected by the change.`;

        yield { type: 'tool', toolCallId: agentId, name: 'Agent', input, state: 'running' };
        yield { type: 'subagent', agentId, parentToolCallId: agentId, name: 'Explore', description: input.description, state: 'running' };
        yield* this.say('Checking the callers in a sub-agent.', agentId);
        yield* this.tool('grep', { pattern: path }, async () => ({ matches: 3 }), agentId);
        yield { type: 'tool', toolCallId: agentId, name: 'Agent', input, state: 'done', output: summary };
        yield { type: 'subagent', agentId, parentToolCallId: agentId, name: 'Explore', state: 'done', summary };
    }

    private async *followUp(): Step<string> {
        const text = this.options.prompt.length > 80 ? `${ this.options.prompt.slice(0, 80) }...` : this.options.prompt;

        yield* this.say(`Got it: "${ text }". Let me check the current state.`);
        yield* this.tool('read_file', { path: 'README.md' }, async () => ({ path: 'README.md', lines: 84 }));
        yield* this.checkpoint();

        const answer = 'Nothing else is needed right now. Tell me if you want a change.';

        yield* this.say(answer);

        return answer;
    }

    /* --------------------------------- Helpers -------------------------------- */

    private async pause(ms: number): Promise<void> {
        await sleep(ms * this.speed, this.signal);
    }

    private has(tool: string): boolean {
        return this.options.tools.some(candidate => candidate.name === tool);
    }

    /** Streams `text` word by word as one assistant message (of a sub-agent when `agentId` is given). */
    private async *say(text: string, agentId?: string): Step {
        await this.pause(THINK_MS);

        for (const word of text.split(/(?<=\s)/)) {
            this.words++;
            yield { type: 'text', delta: word, done: false, agentId };
            await this.pause(WORD_MS);
        }

        // The session's own messages come with the agent's id of them, as a real agent's do; a sub-agent's do not.
        yield { type: 'text', delta: '', done: true, agentId, ...(agentId === undefined && { messageId: `fake-msg-${ this.tag }-${ ++this.messages }` }) };
    }

    /** A tool item that runs, then ends done or error. Returns what `work` returned. */
    private async *tool<T>(name: string, input: unknown, work: () => Promise<T>, agentId?: string): Step<T> {
        const toolCallId = `fake-call-${ this.tag }-${ ++this.calls }`;

        yield { type: 'tool', toolCallId, name, input, state: 'running', agentId };
        await this.pause(TOOL_MS);

        try {
            const output = await work();

            yield { type: 'tool', toolCallId, name, input, state: 'done', output, agentId };

            return output;
        }
        catch (error) {
            yield { type: 'tool', toolCallId, name, input, state: 'error', error: errorMessage(error), agentId };
            throw error;
        }
    }

    /** Calls one of the runtime's tools. */
    private call<T>(name: string, input: unknown): Step<T> {
        const definition = this.options.tools.find(tool => tool.name === name);

        if (!definition) {
            throw new Error(`The fake engine was not given the ${ name } tool`);
        }

        return this.tool(name, input, () => definition.execute(input, this.signal) as Promise<T>);
    }

    /** Answers the steers the person sent while the session was working. A steer that comes later goes to the next turn. */
    private async *checkpoint(): Step {
        this.listening = false;

        for (const text of this.inbox.splice(0)) {
            yield* this.say(`Noted: "${ text }". I'll take that into account.`);
        }
    }
}
