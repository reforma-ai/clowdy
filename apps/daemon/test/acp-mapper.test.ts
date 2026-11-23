import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { STOPPED_TOOL } from '@clowdy/protocol';

import { UpdateMapper } from '../src/engine/acp/mapper';
import { UpdateMapperV2 } from '../src/engine/acp/mapper-v2';

import type {
    BackgroundWork,
    SessionUpdate as SessionUpdateV2,
    Usage,
} from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { PromptResponse, SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import type { BackgroundItem } from '@clowdy/protocol';
import type { EngineEvent } from '../src/engine/types';

const chunk = (text: string, messageId?: string): SessionUpdate => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(messageId && { messageId }),
});

function run(
    updates: SessionUpdate[],
    options: Partial<ConstructorParameters<typeof UpdateMapper>[0]> = {},
    response: PromptResponse = { stopReason: 'end_turn' }
) {
    const mapper = new UpdateMapper({
        toolNames: ['task_create', 'task_update', 'ask_user'],
        costBefore: 0,
        ...options,
    });
    const events: EngineEvent[] = [];

    for (const update of updates) {
        events.push(...mapper.update(update));
    }

    events.push(...mapper.stop(response));

    return { mapper, events };
}

const tools = (events: EngineEvent[]) => events.filter(event => event.type === 'tool');

describe('messages', () => {
    test('chunks stream as they come and the message closes when the prompt ends', () => {
        const { events, mapper } = run([chunk('Hel'), chunk('lo')]);

        expect(events).toEqual([
            { type: 'text', delta: 'Hel', done: false },
            { type: 'text', delta: 'lo', done: false },
            { type: 'text', delta: '', done: true },
        ]);
        expect(mapper.result()).toBe('Hello');
    });

    test('a tool call ends the message before it, and the result is the last message only', () => {
        const { events, mapper } = run([
            chunk('Let me look.'),
            { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read file', kind: 'read' },
            chunk('Found it.'),
        ]);

        expect(events.map(event => event.type)).toEqual(['text', 'text', 'tool', 'text', 'text']);
        expect(mapper.result()).toBe('Found it.');
    });

    test('a new message id is a new message even with no tool call between', () => {
        const { events, mapper } = run([chunk('one', 'm1'), chunk('two', 'm2')]);

        expect(events.map(event => event.type === 'text' && [event.delta, event.done])).toEqual([
            ['one', false],
            ['', true],
            ['two', false],
            ['', true],
        ]);
        expect(mapper.result()).toBe('two');
    });

    test('modes and the rest are not shown', () => {
        const { events } = run([{ sessionUpdate: 'current_mode_update', currentModeId: 'x' }]);

        expect(events).toEqual([]);
    });
});

describe('tool calls', () => {
    test("the runtime's own tools keep their bare name whatever the agent calls them", () => {
        const { events } = run([
            {
                sessionUpdate: 'tool_call',
                toolCallId: '1',
                title: 'mcp__clowdy__task_create',
                _meta: { claudeCode: { toolName: 'mcp__clowdy__task_create' } },
            },
            { sessionUpdate: 'tool_call', toolCallId: '2', title: 'Tool: clowdy/task_update' },
            { sessionUpdate: 'tool_call', toolCallId: '3', title: 'clowdy.ask_user', kind: 'other' },
            { sessionUpdate: 'tool_call', toolCallId: '4', title: 'Tool: linear/task_create' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.name)).toEqual([
            'task_create',
            'task_update',
            'ask_user',
            'Tool: linear/task_create',
        ]);
    });

    test("the name comes from Claude's tool name, then the agent's name, then the kind", () => {
        const { events } = run([
            {
                sessionUpdate: 'tool_call',
                toolCallId: '1',
                title: 'Run ls',
                kind: 'execute',
                _meta: { claudeCode: { toolName: 'Bash' } },
            },
            { sessionUpdate: 'tool_call', toolCallId: '2', title: 'List', name: 'shell', kind: 'execute' },
            { sessionUpdate: 'tool_call', toolCallId: '3', title: 'Run ls', kind: 'execute' },
            { sessionUpdate: 'tool_call', toolCallId: '4', title: 'Something odd', kind: 'other' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.name)).toEqual([
            'Bash',
            'shell',
            'Bash',
            'Something odd',
        ]);
    });

    test('input is the raw input, or the title when the agent gave none', () => {
        const { events } = run([
            {
                sessionUpdate: 'tool_call',
                toolCallId: '1',
                title: 'Read a.ts',
                kind: 'read',
                rawInput: { file_path: 'a.ts' },
            },
            { sessionUpdate: 'tool_call', toolCallId: '2', title: 'Read b.ts', kind: 'read' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.input)).toEqual([
            { file_path: 'a.ts' },
            { title: 'Read b.ts' },
        ]);
    });

    test('a call moves from running to done with its output, and an update that changes nothing is skipped', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: '1', title: 'Read', kind: 'read', status: 'pending' },
            { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'in_progress' },
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: '1',
                status: 'completed',
                content: [{ type: 'content', content: { type: 'text', text: 'file text' } }],
            },
        ]);

        expect(tools(events)).toEqual([
            { type: 'tool', toolCallId: '1', name: 'Read', input: { title: 'Read' }, state: 'running' },
            {
                type: 'tool',
                toolCallId: '1',
                name: 'Read',
                input: { title: 'Read' },
                state: 'done',
                output: 'file text',
            },
        ]);
    });

    test('a failed call carries its text as the error, and a long output is cut', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: '1', title: 'Run', kind: 'execute' },
            { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'failed', rawOutput: 'exit 1' },
            { sessionUpdate: 'tool_call', toolCallId: '2', title: 'Cat', kind: 'read' },
            { sessionUpdate: 'tool_call_update', toolCallId: '2', status: 'completed', rawOutput: 'x'.repeat(30_000) },
        ]);
        const [, failed, , long] = tools(events);

        expect(failed).toMatchObject({ state: 'error', error: 'exit 1' });
        expect(long.type === 'tool' && long.output).toMatch(/^x{20000}\n\[cut: 10000 more characters\]$/);
    });

    test('a diff shows as the file it changed', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: '1', title: 'Edit', kind: 'edit' },
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: '1',
                status: 'completed',
                content: [{ type: 'diff', path: '/a.ts', oldText: 'a', newText: 'b' }],
            },
        ]);

        expect(tools(events).at(-1)).toMatchObject({ state: 'done', output: 'Changed /a.ts' });
    });
});

describe('compaction', () => {
    const facts = { trigger: 'manual', preTokens: 22_062, postTokens: 6_111, durationMs: 4_200 };

    test("Claude's compaction call is `compact`, with the counts as its output", () => {
        const meta = { claudeCode: { toolName: 'compact' } };
        const { events } = run([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'c1',
                title: 'Compact conversation',
                kind: 'think',
                status: 'in_progress',
                _meta: meta,
            },
            { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: facts, _meta: meta },
        ]);

        expect(tools(events)).toEqual([
            {
                type: 'tool',
                toolCallId: 'c1',
                name: 'compact',
                input: { title: 'Compact conversation' },
                state: 'running',
            },
            {
                type: 'tool',
                toolCallId: 'c1',
                name: 'compact',
                input: { title: 'Compact conversation' },
                state: 'done',
                output: JSON.stringify(facts),
            },
        ]);
    });

    test("Codex's, a `think` call it names only by its title, is `compact` too, and keeps the name through updates that carry no title", () => {
        const { events } = run([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'x1',
                title: 'Compact conversation',
                kind: 'think',
                status: 'in_progress',
            },
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'x1',
                title: 'Compact conversation',
                status: 'in_progress',
                _meta: { note: 'progress' },
            },
            { sessionUpdate: 'tool_call_update', toolCallId: 'x1', kind: 'think', status: 'completed' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && [event.name, event.state])).toEqual([
            ['compact', 'running'],
            ['compact', 'done'],
        ]);
    });

    test('another `think` call keeps the name of its kind', () => {
        const { events } = run([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Reasoning', kind: 'think' }]);

        expect(tools(events).map(event => event.type === 'tool' && event.name)).toEqual(['Think']);
    });
});

describe("sub-agents, as Claude's adapter reports them without child sessions", () => {
    const stamp = (parentToolUseId: string, toolName?: string) => ({
        claudeCode: { parentToolUseId, ...(toolName && { toolName }) },
    });
    const agentCall = (
        toolCallId: string,
        input: unknown = { subagent_type: 'Explore', description: 'Map the router', prompt: 'Find every route.' }
    ): SessionUpdate => ({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Map the router',
        kind: 'think',
        status: 'in_progress',
        rawInput: input,
        _meta: { claudeCode: { toolName: 'Agent' } },
    });
    const childChunk = (parentToolUseId: string, text: string, messageId?: string): SessionUpdate => ({
        ...chunk(text, messageId),
        _meta: stamp(parentToolUseId),
    });
    const subagents = (events: EngineEvent[]) => events.filter(event => event.type === 'subagent');

    test('a stamped update goes to the sub-agent, which its first one announces with the name and brief of the call that started it', () => {
        const { events, mapper } = run([
            chunk('Let me delegate.', 'p1'),
            agentCall('agent-1'),
            childChunk('agent-1', 'Looking ', 'c1'),
            childChunk('agent-1', 'around.', 'c1'),
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'read-1',
                title: 'Read a.ts',
                kind: 'read',
                status: 'in_progress',
                rawInput: { file_path: 'a.ts' },
                _meta: stamp('agent-1', 'Read'),
            },
            chunk('Still mine.', 'p2'),
        ]);

        expect(events).toEqual([
            { type: 'text', delta: 'Let me delegate.', done: false },
            { type: 'text', delta: '', done: true },
            {
                type: 'tool',
                toolCallId: 'agent-1',
                name: 'Agent',
                input: { subagent_type: 'Explore', description: 'Map the router', prompt: 'Find every route.' },
                state: 'running',
            },
            {
                type: 'subagent',
                agentId: 'agent-1',
                parentToolCallId: 'agent-1',
                name: 'Explore',
                description: 'Map the router',
                state: 'running',
            },
            { type: 'text', delta: 'Looking ', done: false, agentId: 'agent-1' },
            { type: 'text', delta: 'around.', done: false, agentId: 'agent-1' },
            // The sub-agent's call ends its own message, not the session's.
            { type: 'text', delta: '', done: true, agentId: 'agent-1' },
            {
                type: 'tool',
                toolCallId: 'read-1',
                name: 'Read',
                input: { file_path: 'a.ts' },
                state: 'running',
                agentId: 'agent-1',
            },
            { type: 'text', delta: 'Still mine.', done: false },
            { type: 'text', delta: '', done: true },
        ]);
        expect(mapper.result()).toBe('Still mine.');
    });

    test("the session's open message stays open through the sub-agent's text and calls, and is the result", () => {
        const { events, mapper } = run([
            agentCall('agent-1'),
            chunk('Waiting ', 'p1'),
            childChunk('agent-1', 'Busy.', 'c1'),
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'grep-1',
                title: 'Grep',
                kind: 'search',
                _meta: stamp('agent-1'),
            },
            chunk('on it.', 'p1'),
        ]);
        const own = events.filter(event => event.type === 'text' && event.agentId === undefined);

        expect(own).toEqual([
            { type: 'text', delta: 'Waiting ', done: false },
            { type: 'text', delta: 'on it.', done: false },
            { type: 'text', delta: '', done: true },
        ]);
        expect(mapper.result()).toBe('Waiting on it.');
    });

    test("a later update of the sub-agent's call that lost the stamp stays with the sub-agent", () => {
        const { events } = run([
            agentCall('agent-1'),
            { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', kind: 'read', _meta: stamp('agent-1') },
            { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: 'text' },
        ]);

        expect(tools(events).at(-1)).toEqual({
            type: 'tool',
            toolCallId: 'read-1',
            name: 'Read',
            input: { title: 'Read' },
            state: 'done',
            output: 'text',
            agentId: 'agent-1',
        });
    });

    test("the call that started it ends it: done with the call's result as its report, or failed with its error", () => {
        const { events } = run([
            agentCall('agent-1'),
            childChunk('agent-1', 'Half a sentence', 'c1'),
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'agent-1',
                status: 'completed',
                content: [{ type: 'content', content: { type: 'text', text: 'Three routes.' } }],
            },
            agentCall('agent-2', { subagent_type: 'Plan' }),
            childChunk('agent-2', 'Planning'),
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'agent-2',
                status: 'failed',
                rawOutput: 'The sub-agent stopped',
            },
        ]);

        expect(events.slice(3, 6)).toEqual([
            {
                type: 'tool',
                toolCallId: 'agent-1',
                name: 'Agent',
                input: { subagent_type: 'Explore', description: 'Map the router', prompt: 'Find every route.' },
                state: 'done',
                output: 'Three routes.',
            },
            { type: 'text', delta: '', done: true, agentId: 'agent-1' },
            {
                type: 'subagent',
                agentId: 'agent-1',
                parentToolCallId: 'agent-1',
                name: 'Explore',
                state: 'done',
                summary: 'Three routes.',
            },
        ]);
        expect(subagents(events)).toEqual([
            {
                type: 'subagent',
                agentId: 'agent-1',
                parentToolCallId: 'agent-1',
                name: 'Explore',
                description: 'Map the router',
                state: 'running',
            },
            {
                type: 'subagent',
                agentId: 'agent-1',
                parentToolCallId: 'agent-1',
                name: 'Explore',
                state: 'done',
                summary: 'Three routes.',
            },
            { type: 'subagent', agentId: 'agent-2', parentToolCallId: 'agent-2', name: 'Plan', state: 'running' },
            {
                type: 'subagent',
                agentId: 'agent-2',
                parentToolCallId: 'agent-2',
                name: 'Plan',
                state: 'error',
                summary: 'The sub-agent stopped',
            },
        ]);
    });

    test('what a sub-agent reports after its call ended is dropped, and so is one first heard of then', () => {
        const { events } = run([
            agentCall('agent-1'),
            childChunk('agent-1', 'Working'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed', rawOutput: 'Done' },
            childChunk('agent-1', 'A late beat'),
            agentCall('agent-2'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-2', status: 'completed', rawOutput: 'Done' },
            childChunk('agent-2', 'Too late'),
        ]);

        expect(
            events.filter(
                event => event.type === 'text' && (event.delta === 'A late beat' || event.delta === 'Too late')
            )
        ).toEqual([]);
        expect(subagents(events).map(event => event.type === 'subagent' && [event.agentId, event.state])).toEqual([
            ['agent-1', 'running'],
            ['agent-1', 'done'],
        ]);
    });

    test('a call a sub-agent makes after its own call ended is dropped with its later updates, even those that lost the stamp', () => {
        const { events } = run([
            agentCall('agent-1'),
            childChunk('agent-1', 'Working'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed', rawOutput: 'Done' },
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'late-read',
                title: 'Read',
                kind: 'read',
                _meta: stamp('agent-1', 'Read'),
            },
            { sessionUpdate: 'tool_call_update', toolCallId: 'late-read', status: 'completed', rawOutput: 'text' },
            // One first heard of after its call ended (a background sub-agent): its calls stay out of the session's stream too.
            agentCall('agent-2'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-2', status: 'completed', rawOutput: 'Launched' },
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'bg-grep',
                title: 'Grep',
                kind: 'search',
                _meta: stamp('agent-2', 'Grep'),
            },
            { sessionUpdate: 'tool_call_update', toolCallId: 'bg-grep', status: 'completed', rawOutput: 'match' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.toolCallId)).toEqual([
            'agent-1',
            'agent-1',
            'agent-2',
            'agent-2',
        ]);
    });

    test('a sub-agent heard of before its call is named by default; the brief falls back to the first line of the prompt', () => {
        const long = 'word '.repeat(40).trim();
        const { events } = run([
            childChunk('ghost', 'Boo'),
            agentCall('agent-2', { prompt: `${long}\nMore detail` }),
            childChunk('agent-2', 'Hi'),
        ]);

        expect(subagents(events)).toEqual([
            { type: 'subagent', agentId: 'ghost', parentToolCallId: 'ghost', name: 'Sub-agent', state: 'running' },
            {
                type: 'subagent',
                agentId: 'agent-2',
                parentToolCallId: 'agent-2',
                name: 'Sub-agent',
                description: `${long.slice(0, 120)}…`,
                state: 'running',
            },
        ]);
    });

    test("a sub-agent call of an agent that stamps nothing stays a plain call, with the traffic in the session's stream", () => {
        const { events } = run([
            agentCall('agent-1'),
            chunk('child words'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed', rawOutput: 'Done' },
        ]);

        expect(subagents(events)).toEqual([]);
        expect(events.every(event => !('agentId' in event))).toBe(true);
    });

    test("a nested sub-agent is announced on its own, and its call in the outer sub-agent's stream ends it", () => {
        const { events } = run([
            agentCall('outer'),
            { ...agentCall('inner'), _meta: stamp('outer', 'Agent') },
            childChunk('inner', 'Deep'),
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'inner',
                status: 'completed',
                rawOutput: 'Inner done',
                _meta: stamp('outer', 'Agent'),
            },
        ]);

        expect(
            tools(events).map(event => event.type === 'tool' && [event.toolCallId, event.state, event.agentId])
        ).toEqual([
            ['outer', 'running', undefined],
            ['inner', 'running', 'outer'],
            ['inner', 'done', 'outer'],
        ]);
        expect(subagents(events).map(event => event.type === 'subagent' && [event.agentId, event.state])).toEqual([
            ['outer', 'running'],
            ['inner', 'running'],
            ['inner', 'done'],
        ]);
    });
});

describe('numbers', () => {
    const cost = (amount: number): SessionUpdate => ({
        sessionUpdate: 'usage_update',
        used: 1,
        size: 100,
        cost: { amount, currency: 'USD' },
    });

    test("tokens come from the prompt response and cost is the rise over the session's earlier total", () => {
        const { events } = run(
            [cost(1.5)],
            { costBefore: 1 },
            {
                stopReason: 'end_turn',
                usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedReadTokens: 6 },
            }
        );

        expect(events.filter(event => event.type === 'usage')).toEqual([
            { type: 'usage', inputTokens: 16, outputTokens: 4, costUsd: 0.5 },
        ]);
    });

    test('a resumed session this daemon never measured reports tokens without a cost', () => {
        const { events } = run(
            [cost(9)],
            { costBefore: undefined },
            { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
        );

        expect(events.filter(event => event.type === 'usage')).toEqual([
            { type: 'usage', inputTokens: 1, outputTokens: 1 },
        ]);
    });

    test('nothing is reported when the agent reports nothing', () => {
        expect(run([]).events).toEqual([]);
    });

    test('a cost in another currency is ignored', () => {
        const { events, mapper } = run([
            { sessionUpdate: 'usage_update', used: 1, size: 1, cost: { amount: 5, currency: 'EUR' } },
        ]);

        expect(mapper.cost).toBeUndefined();
        expect(events.filter(event => event.type === 'usage')).toEqual([]);
    });

    test('rate limits: warnings and rejections are signals, repeats and "allowed" are not', () => {
        const limit = (status: string, resetsAt?: number): SessionUpdate => ({
            sessionUpdate: 'usage_update',
            used: 1,
            size: 1,
            _meta: { '_claude/rateLimit': { status, rateLimitType: 'seven_day', utilization: 0.8, resetsAt } },
        });
        const { events } = run([
            limit('allowed'),
            limit('allowed_warning', 100),
            limit('allowed_warning', 100),
            limit('rejected', 200),
        ]);

        expect(events.filter(event => event.type === 'limit')).toEqual([
            { type: 'limit', status: 'warning', kind: 'seven_day', utilization: 0.8, resetsAt: 100 },
            { type: 'limit', status: 'rejected', kind: 'seven_day', utilization: 0.8, resetsAt: 200 },
        ]);
    });
});

describe('the context window', () => {
    const fill = (used: number, size: number): SessionUpdate => ({ sessionUpdate: 'usage_update', used, size });
    const contexts = (events: EngineEvent[]) => events.filter(event => event.type === 'context');

    test('a usage update reports how full the window is, and the same reading again is not repeated', () => {
        const { events } = run([
            fill(21269, 1_000_000),
            fill(21269, 1_000_000),
            fill(21491, 1_000_000),
            fill(21491, 200_000),
        ]);

        expect(contexts(events)).toEqual([
            { type: 'context', used: 21269, size: 1_000_000 },
            { type: 'context', used: 21491, size: 1_000_000 },
            { type: 'context', used: 21491, size: 200_000 },
        ]);
    });

    test('comes with the cost and the rate limit of the same update, each in its own event', () => {
        const update: SessionUpdate = {
            sessionUpdate: 'usage_update',
            used: 5,
            size: 100,
            cost: { amount: 1, currency: 'USD' },
            _meta: { '_claude/rateLimit': { status: 'rejected', rateLimitType: 'five_hour' } },
        };

        expect(run([update]).events.map(event => event.type)).toEqual(['context', 'limit', 'usage']);
    });

    test('a reading that makes no sense is ignored', () => {
        const { events } = run([fill(5, 0), fill(-1, 100), fill(Number.NaN, 100), fill(5, Number.POSITIVE_INFINITY)]);

        expect(contexts(events)).toEqual([]);
    });
});

const think = (text: string, messageId?: string): SessionUpdate => ({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
    ...(messageId && { messageId }),
});
const thoughts = (events: EngineEvent[]) =>
    events
        .filter(event => event.type === 'thought' || event.type === 'text')
        .map(event =>
            event.type === 'thought' ? ['thought', event.delta, event.done] : ['text', event.delta, event.done]
        );

describe('thoughts', () => {
    test('chunks stream as they come, and the thought closes when the message begins', () => {
        const { events } = run([think('Let me '), think('see.'), chunk('Hello')]);

        expect(thoughts(events)).toEqual([
            ['thought', 'Let me ', false],
            ['thought', 'see.', false],
            ['thought', '', true],
            ['text', 'Hello', false],
            ['text', '', true],
        ]);
    });

    test('a tool call ends the thought before it, and a thought after it is a new one', () => {
        const { events } = run([
            think('First.'),
            { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read file', kind: 'read' },
            think('Second.'),
        ]);

        expect(events.map(event => event.type)).toEqual(['thought', 'thought', 'tool', 'thought', 'thought']);
        expect(thoughts(events)).toEqual([
            ['thought', 'First.', false],
            ['thought', '', true],
            ['thought', 'Second.', false],
            ['thought', '', true],
        ]);
    });

    test('a new message id is a new thought even with nothing between, and the prompt ending closes the open one', () => {
        const { events } = run([think('one', 't1'), think('two', 't2')]);

        expect(thoughts(events)).toEqual([
            ['thought', 'one', false],
            ['thought', '', true],
            ['thought', 'two', false],
            ['thought', '', true],
        ]);
    });

    test('says nothing for an empty chunk, a thought that is not text, or a prompt with no thought', () => {
        const { events } = run([
            think(''),
            { sessionUpdate: 'agent_thought_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } },
        ]);

        expect(events.filter(event => event.type === 'thought')).toEqual([]);
    });

    test('is no part of the result, which is the last message', () => {
        const { mapper } = run([chunk('Done.'), think('Afterthought.')]);

        expect(mapper.result()).toBe('Done.');
    });

    test("a sub-agent's thoughts go to its own stream under its agentId, apart from the session's own", () => {
        const claude = { claudeCode: { parentToolUseId: 'agent-1' } };
        const { events } = run([
            think('Session thinks.'),
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'agent-1',
                title: 'Agent',
                rawInput: { subagent_type: 'Explore', description: 'Look' },
            },
            { ...think('Child thinks.'), _meta: claude } as SessionUpdate,
            { ...chunk('Child says.'), _meta: claude } as SessionUpdate,
        ]);

        expect(
            events
                .filter(event => event.type === 'thought' || event.type === 'text')
                .map(event =>
                    event.type === 'thought'
                        ? ['thought', event.delta, event.done, event.agentId]
                        : ['text', event.delta, event.done, event.agentId]
                )
        ).toEqual([
            ['thought', 'Session thinks.', false, undefined],
            ['thought', '', true, undefined],
            ['thought', 'Child thinks.', false, 'agent-1'],
            ['thought', '', true, 'agent-1'],
            ['text', 'Child says.', false, 'agent-1'],
        ]);
    });
});

describe('updates of ACP v2', () => {
    const chunk2 = (text: string, messageId = 'm1'): SessionUpdateV2 => ({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text },
    });
    const whole = (text: string, messageId = 'm1'): SessionUpdateV2 => ({
        sessionUpdate: 'agent_message',
        messageId,
        content: [{ type: 'text', text }],
    });
    const call = (
        update: Omit<Extract<SessionUpdateV2, { sessionUpdate: 'tool_call_update' }>, 'sessionUpdate'>
    ): SessionUpdateV2 => ({ sessionUpdate: 'tool_call_update', ...update });

    function run2(
        updates: SessionUpdateV2[],
        options: Partial<ConstructorParameters<typeof UpdateMapperV2>[0]> = {},
        usage?: Usage
    ) {
        const mapper = new UpdateMapperV2({
            toolNames: ['task_create', 'task_update', 'ask_user'],
            costBefore: 0,
            ...options,
        });
        const events: EngineEvent[] = [];

        for (const update of updates) {
            events.push(...mapper.update(update));
        }

        events.push(...mapper.stop(usage));

        return { mapper, events };
    }

    describe('thoughts', () => {
        const think2 = (text: string, messageId = 't1'): SessionUpdateV2 => ({
            sessionUpdate: 'agent_thought_chunk',
            messageId,
            content: { type: 'text', text },
        });
        const wholeThought = (text: string, messageId = 't1'): SessionUpdateV2 => ({
            sessionUpdate: 'agent_thought',
            messageId,
            content: [{ type: 'text', text }],
        });

        test('chunks of a thought append, a thought with another id is another thought, and a message ends the open one', () => {
            const { events } = run2([think2('Hel'), think2('lo'), think2('Bye', 't2'), chunk2('Answer')]);

            expect(thoughts(events)).toEqual([
                ['thought', 'Hel', false],
                ['thought', 'lo', false],
                ['thought', '', true],
                ['thought', 'Bye', false],
                ['thought', '', true],
                ['text', 'Answer', false],
                ['text', '', true],
            ]);
        });

        test('a thought sent whole shows what the stream lacks of it, and one it showed already shows nothing again', () => {
            const { events } = run2([
                think2('Hel'),
                wholeThought('Hello'),
                wholeThought('Hello'),
                wholeThought('Other', 't2'),
                wholeThought('Other', 't2'),
            ]);

            expect(thoughts(events)).toEqual([
                ['thought', 'Hel', false],
                ['thought', 'lo', false],
                ['thought', '', true],
                ['thought', 'Other', false],
                ['thought', '', true],
            ]);
        });

        test('a whole thought that does not continue the open one adds nothing, and one with no content leaves it as it is', () => {
            const { events } = run2([
                think2('Hello'),
                wholeThought('Different'),
                { sessionUpdate: 'agent_thought', messageId: 't1', content: null },
            ]);

            expect(thoughts(events)).toEqual([
                ['thought', 'Hello', false],
                ['thought', '', true],
            ]);
        });

        test('a whole message ends the open thought before it, and a thought that ended and comes again whole adds nothing', () => {
            const { events } = run2([think2('Hmm'), whole('Answer'), wholeThought('Hmm')]);

            expect(thoughts(events)).toEqual([
                ['thought', 'Hmm', false],
                ['thought', '', true],
                ['text', 'Answer', false],
                ['text', '', true],
            ]);
        });

        test('a tool call ends the thought before it', () => {
            const { events } = run2([
                think2('Hmm.'),
                call({ toolCallId: 'a', title: 'Read file', kind: 'read', status: 'in_progress' }),
            ]);

            expect(events.map(event => event.type)).toEqual(['thought', 'thought', 'tool']);
            expect(thoughts(events)).toEqual([
                ['thought', 'Hmm.', false],
                ['thought', '', true],
            ]);
        });

        test('is no part of the result, which is the last message', () => {
            const { mapper } = run2([chunk2('Done.'), think2('Afterthought.')]);

            expect(mapper.result()).toBe('Done.');
        });
    });

    describe('messages', () => {
        test('chunks of a message append, and a message with another id is another message', () => {
            const { events, mapper } = run2([chunk2('Hel'), chunk2('lo'), chunk2('Bye', 'm2')]);

            expect(events.map(event => event.type === 'text' && [event.delta, event.done])).toEqual([
                ['Hel', false],
                ['lo', false],
                ['', true],
                ['Bye', false],
                ['', true],
            ]);
            expect(mapper.result()).toBe('Bye');
        });

        test('a message sent whole shows what the stream lacks of it, and one it showed already shows nothing again', () => {
            const { events, mapper } = run2([
                chunk2('Hel'),
                whole('Hello'),
                whole('Hello'),
                whole('Other', 'm2'),
                whole('Other', 'm2'),
            ]);

            expect(events.map(event => event.type === 'text' && [event.delta, event.done])).toEqual([
                ['Hel', false],
                ['lo', false],
                ['', true],
                ['Other', false],
                ['', true],
            ]);
            expect(mapper.result()).toBe('Other');
        });

        test('a whole message that was closed and comes again, or that rewrites what was shown, adds nothing', () => {
            const { events } = run2([
                chunk2('Hello'),
                call({ toolCallId: 'a', title: 'Read file' }),
                whole('Hello'),
                chunk2('Hi there', 'm2'),
                whole('Howdy there', 'm2'),
            ]);

            expect(
                events.filter(event => event.type === 'text').map(event => event.type === 'text' && event.delta)
            ).toEqual(['Hello', '', 'Hi there', '']);
        });

        test("the event that ends a message says the agent's id of it, whether it came in chunks or whole, and the pieces say none", () => {
            const { events } = run2([chunk2('Hel'), chunk2('lo'), chunk2('Bye', 'm2'), whole('Whole', 'm3')]);

            expect(events.filter(event => event.type === 'text' && event.done)).toEqual([
                { type: 'text', delta: '', done: true, messageId: 'm1' },
                { type: 'text', delta: '', done: true, messageId: 'm2' },
                { type: 'text', delta: '', done: true, messageId: 'm3' },
            ]);
            expect(
                events
                    .filter(event => event.type === 'text' && !event.done)
                    .every(event => event.type === 'text' && event.messageId === undefined)
            ).toBe(true);
        });

        test('a message a tool call ended is closed with its id too, so the message that ends the turn is the last one with an id', () => {
            const { events } = run2([
                chunk2('Let me look.', 'a1'),
                call({ toolCallId: 'a', title: 'Read file', kind: 'read' }),
                chunk2('Found it.', 'a2'),
            ]);

            expect(
                events
                    .filter(event => event.type === 'text' && event.done)
                    .map(event => event.type === 'text' && event.messageId)
            ).toEqual(['a1', 'a2']);
        });

        test('an agent speaking v1 gets no ids on its messages: only a v2 agent is cut at one', () => {
            const { events } = run([chunk('Hello', 'm1')]);

            expect(events).toEqual([
                { type: 'text', delta: 'Hello', done: false },
                { type: 'text', delta: '', done: true },
            ]);
        });

        test('a message with no content, plans, user messages and unknown kinds are not shown', () => {
            const { events } = run2([
                { sessionUpdate: 'agent_message', messageId: 'm1' },
                { sessionUpdate: 'user_message', messageId: 'u1', content: [{ type: 'text', text: 'hi' }] },
                { sessionUpdate: 'plan_update', planId: 'p', plan: { type: 'items', entries: [] } },
                { sessionUpdate: 'state_update', state: 'running' },
                { sessionUpdate: '_vendor_thing', anything: 1 },
            ] as SessionUpdateV2[]);

            expect(events).toEqual([]);
        });
    });

    describe('tool calls', () => {
        test('the first update of an id is the call, and it ends the message before it', () => {
            const { events, mapper } = run2([
                chunk2('Let me look.'),
                call({
                    toolCallId: 'a',
                    title: 'Read file',
                    kind: 'read',
                    status: 'in_progress',
                    rawInput: { file_path: 'x' },
                }),
                chunk2('Found it.', 'm2'),
            ]);

            expect(events.map(event => event.type)).toEqual(['text', 'text', 'tool', 'text', 'text']);
            expect(tools(events)).toEqual([
                { type: 'tool', toolCallId: 'a', name: 'Read', input: { file_path: 'x' }, state: 'running' },
            ]);
            expect(mapper.result()).toBe('Found it.');
        });

        test('an update patches the call: what it leaves out is what an earlier one said, and null clears it', () => {
            const { events } = run2([
                call({
                    toolCallId: 'a',
                    title: 'List files',
                    kind: 'execute',
                    status: 'in_progress',
                    rawInput: { command: 'ls' },
                    rawOutput: 'a.ts\nb.ts',
                }),
                // Nothing but the status: the input, the name and the output it said before stay.
                call({ toolCallId: 'a', status: 'completed' }),
            ]);

            expect(tools(events)).toEqual([
                { type: 'tool', toolCallId: 'a', name: 'Bash', input: { command: 'ls' }, state: 'running' },
                {
                    type: 'tool',
                    toolCallId: 'a',
                    name: 'Bash',
                    input: { command: 'ls' },
                    state: 'done',
                    output: 'a.ts\nb.ts',
                },
            ]);
        });

        test("the name comes from Claude's tool name kept from the first update, the runtime's own tools keep their bare name", () => {
            const { events } = run2([
                call({
                    toolCallId: 'a',
                    title: 'Tool: clowdy/task_create',
                    kind: 'other',
                    status: 'in_progress',
                    rawInput: { title: 'x' },
                }),
                call({
                    toolCallId: 'b',
                    title: 'git status',
                    kind: 'execute',
                    status: 'in_progress',
                    _meta: { claudeCode: { toolName: 'Bash' } },
                }),
                call({ toolCallId: 'b', status: 'completed', _meta: { other: 1 } }),
            ]);

            expect(
                tools(events).map(event => event.type === 'tool' && [event.toolCallId, event.name, event.state])
            ).toEqual([
                ['a', 'task_create', 'running'],
                ['b', 'Bash', 'running'],
                ['b', 'Bash', 'done'],
            ]);
        });

        test('content chunks add to what the call showed, and a call shows the output of the terminal it displays', () => {
            const { events } = run2([
                call({
                    toolCallId: 'a',
                    title: 'Run tests',
                    kind: 'execute',
                    status: 'in_progress',
                    content: [{ type: 'terminal', terminalId: 't1' }],
                }),
                {
                    sessionUpdate: 'terminal_output_chunk',
                    terminalId: 't1',
                    data: Buffer.from('ok 1\n').toString('base64'),
                },
                {
                    sessionUpdate: 'terminal_output_chunk',
                    terminalId: 't1',
                    data: Buffer.from('ok 2\n').toString('base64'),
                },
                call({ toolCallId: 'a', status: 'completed' }),
                call({ toolCallId: 'b', title: 'Edit', kind: 'edit', status: 'in_progress' }),
                {
                    sessionUpdate: 'tool_call_content_chunk',
                    toolCallId: 'b',
                    content: { type: 'diff', changes: [{ operation: 'modify', path: '/work/a.ts' }] },
                },
                {
                    sessionUpdate: 'tool_call_content_chunk',
                    toolCallId: 'b',
                    content: { type: 'content', content: { type: 'text', text: 'done' } },
                },
                call({ toolCallId: 'b', status: 'completed' }),
            ] as SessionUpdateV2[]);

            expect(
                tools(events)
                    .filter(event => event.type === 'tool' && event.state === 'done')
                    .map(event => event.type === 'tool' && event.output)
            ).toEqual(['ok 1\nok 2\n', 'Changed /work/a.ts\ndone']);
        });

        test('a failed call carries its text as the error, a cancelled one reads as stopped, and a paused one is still running', () => {
            const { events } = run2([
                call({ toolCallId: 'a', title: 'Run', status: 'failed', rawOutput: 'exit 1' }),
                call({ toolCallId: 'b', title: 'Run', status: 'cancelled' }),
                call({ toolCallId: 'c', title: 'Run', status: 'paused' }),
            ]);

            expect(tools(events).map(event => event.type === 'tool' && [event.state, event.error])).toEqual([
                ['error', 'exit 1'],
                ['error', 'Stopped before it finished'],
                ['running', undefined],
            ]);
        });

        test('a compaction is `compact` however the agent reports it: a call, or a compaction update', () => {
            const { events } = run2([
                call({
                    toolCallId: 'k',
                    title: 'Compact conversation',
                    kind: 'think',
                    status: 'in_progress',
                    _meta: { claudeCode: { toolName: 'compact' } },
                }),
                call({
                    toolCallId: 'k',
                    status: 'completed',
                    rawOutput: { trigger: 'manual', preTokens: 100, postTokens: 10, durationMs: 5 },
                }),
                { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' },
                {
                    sessionUpdate: 'compaction_update',
                    compactionId: 'c1',
                    status: 'completed',
                    summary: [{ type: 'text', text: 'a long summary' }],
                },
                { sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'failed', error: 'too short' },
            ]);

            expect(
                tools(events).map(
                    event =>
                        event.type === 'tool' && [
                            event.toolCallId,
                            event.name,
                            event.state,
                            event.output ?? event.error,
                        ]
                )
            ).toEqual([
                ['k', 'compact', 'running', undefined],
                [
                    'k',
                    'compact',
                    'done',
                    JSON.stringify({ trigger: 'manual', preTokens: 100, postTokens: 10, durationMs: 5 }),
                ],
                ['compaction-c1', 'compact', 'running', undefined],
                ['compaction-c1', 'compact', 'done', undefined],
                ['compaction-c2', 'compact', 'error', 'too short'],
            ]);
        });
    });

    describe('background work', () => {
        const listed = (updates: SessionUpdateV2[], work: BackgroundWork[]) => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            for (const update of updates) {
                mapper.update(update);
            }

            return mapper.background(work);
        };

        test('a terminal is a command named by what it ran, a sub-agent a sub-agent named by its title, and a call a task named by its title', () => {
            const items = listed(
                [
                    { sessionUpdate: 'terminal_update', terminalId: 'term-1', command: 'sleep 60 && echo done' },
                    {
                        sessionUpdate: 'subagent_update',
                        sessionId: 'child-1',
                        title: 'Map the docs',
                        description: 'Reads every page',
                    },
                    call({ toolCallId: 'wf-1', title: 'Workflow: verify', kind: 'other', status: 'in_progress' }),
                    call({
                        toolCallId: 'mon-1',
                        status: 'in_progress',
                        _meta: { claudeCode: { toolName: 'Monitor' } },
                    }),
                ],
                [
                    { type: 'terminal', terminalId: 'term-1' },
                    { type: 'subagent', sessionId: 'child-1' },
                    { type: 'tool_call', toolCallId: 'wf-1' },
                    { type: 'tool_call', toolCallId: 'mon-1' },
                ]
            );

            expect(items).toEqual([
                { id: 'term-1', kind: 'command', title: 'sleep 60 && echo done' },
                { id: 'child-1', kind: 'subagent', title: 'Map the docs' },
                { id: 'wf-1', kind: 'task', title: 'Workflow: verify' },
                { id: 'mon-1', kind: 'task', title: 'Monitor' },
            ]);
        });

        test('an item the mapper heard nothing of is named for its kind, a sub-agent falls back to its description, and a title the agent clears is gone', () => {
            const items = listed(
                [
                    { sessionUpdate: 'subagent_update', sessionId: 'child-1', description: 'Reads every page' },
                    { sessionUpdate: 'subagent_update', sessionId: 'child-2', title: 'Named' },
                    { sessionUpdate: 'subagent_update', sessionId: 'child-2', title: null },
                ],
                [
                    { type: 'terminal', terminalId: 'unknown' },
                    { type: 'subagent', sessionId: 'child-1' },
                    { type: 'subagent', sessionId: 'child-2' },
                    { type: 'tool_call', toolCallId: 'never-seen' },
                ]
            );

            expect(items.map(item => item.title)).toEqual([
                'Background command',
                'Reads every page',
                'Sub-agent',
                'Background task',
            ]);
        });

        test('a title is one line, cut at 200 characters, and a kind of work the draft adds later is left out', () => {
            const items = listed(
                [{ sessionUpdate: 'terminal_update', terminalId: 't', command: `echo\n  ${'y'.repeat(400)}` }],
                [{ type: 'terminal', terminalId: 't' }, { type: '_vendor', id: 'x' } as unknown as BackgroundWork]
            );

            expect(items).toHaveLength(1);
            expect(items[0].title).toHaveLength(200);
            expect(items[0].title.startsWith('echo yyy')).toBe(true);
        });

        test('a terminal named later by its command is named by it from then on', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });
            const work: BackgroundWork[] = [{ type: 'terminal', terminalId: 't' }];

            expect(mapper.background(work)[0].title).toBe('Background command');
            mapper.update({ sessionUpdate: 'terminal_update', terminalId: 't', command: 'npm test' });
            expect(mapper.background(work)[0].title).toBe('npm test');
        });
    });

    describe('calls that hold the session until a time they named', () => {
        const MONITOR_RESULT =
            'Monitor started (task b8ryzofob, expires in 40s unless the source ends first; you get one notice at expiry — re-arm if you still need the watch).';
        const WAKEUP_RESULT =
            'Next wakeup scheduled for 11:15:00 (in 96s). If you owe the user a status update this tick, write it now.';
        const CRON_RESULT =
            'Scheduled one-shot task 1d51d840 (7 11 20 11 *). Next run: Nov 20 11:07am. Session-only (not written to disk, dies when Claude exits).';

        /** A call as Claude's adapter tells it: the name in the first update, the input as it is completed, then the result. */
        const scheduled = (
            toolCallId: string,
            name: string,
            input: Record<string, unknown>,
            result: string,
            status: 'completed' | 'failed' | 'cancelled' = 'completed'
        ): SessionUpdateV2[] => [
            call({ toolCallId, name, rawInput: {}, status: 'pending', title: name, kind: 'other', content: [] }),
            call({ toolCallId, rawInput: input }),
            call({
                toolCallId,
                status,
                rawOutput: result,
                content: [{ type: 'content', content: { type: 'text', text: result } }],
            }),
        ];
        const monitor = (
            id = 'mon-1',
            input: Record<string, unknown> = { command: 'echo tick', description: 'Tick monitor', timeout_ms: 40_000 }
        ) => scheduled(id, 'Monitor', input, MONITOR_RESULT);

        function mapped(updates: SessionUpdateV2[]) {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            for (const update of updates) {
                mapper.update(update);
            }

            return mapper;
        }

        afterEach(() => setSystemTime());

        test('a completed Monitor is a task item named by its description, told once with how long it holds, and gone when its time lapses', () => {
            const mapper = mapped(monitor());

            expect(mapper.armed()).toEqual([{ id: 'mon-1', title: 'Monitor · Tick monitor', ms: 40_000 }]);
            expect(mapper.armed()).toEqual([]);
            expect(mapper.background([])).toEqual([{ id: 'mon-1', kind: 'task', title: 'Monitor · Tick monitor' }]);
            expect(mapper.lapse('mon-1')).toBe(true);
            expect(mapper.background([])).toEqual([]);
            expect(mapper.lapse('mon-1')).toBe(false);
        });

        test('a wakeup is a task item named by its reason, due when its result says', () => {
            const mapper = mapped(
                scheduled(
                    'wake-1',
                    'ScheduleWakeup',
                    { delaySeconds: 60, prompt: 'p', reason: 'Wake probe\nrequested', noop: false },
                    WAKEUP_RESULT
                )
            );

            expect(mapper.armed()).toEqual([{ id: 'wake-1', title: 'Wakeup · Wake probe requested', ms: 96_000 }]);
            expect(mapper.background([])).toEqual([
                { id: 'wake-1', kind: 'task', title: 'Wakeup · Wake probe requested' },
            ]);
        });

        test('a one-shot cron job is a wakeup due when its cron next comes, and one that repeats is not held', () => {
            setSystemTime(new Date(2026, 10, 20, 11, 5, 40));

            const once = mapped(
                scheduled(
                    'cron-1',
                    'CronCreate',
                    { cron: '7 11 20 11 *', prompt: 'cron-probe', recurring: false },
                    CRON_RESULT
                )
            );
            const repeating = mapped(
                scheduled(
                    'cron-2',
                    'CronCreate',
                    { cron: '*/5 * * * *', prompt: 'cron-probe', recurring: true },
                    'Scheduled recurring task 8f2a1c3d (*/5 * * * *). Next run: Nov 20 11:10am.'
                )
            );

            expect(once.armed()).toEqual([{ id: 'cron-1', title: 'Wakeup · cron-probe', ms: 140_000 }]);
            expect(repeating.armed()).toEqual([]);
            expect(repeating.background([])).toEqual([]);
        });

        test("the item comes after the agent's own list, whose entries keep their order", () => {
            const mapper = mapped([
                { sessionUpdate: 'terminal_update', terminalId: 'term-1', command: 'sleep 9' },
                ...monitor(),
            ]);

            expect(mapper.background([{ type: 'terminal', terminalId: 'term-1' }]).map(item => item.id)).toEqual([
                'term-1',
                'mon-1',
            ]);
        });

        test('nothing is held for a call that has not completed, failed, or was cancelled', () => {
            expect(mapped(monitor().slice(0, 2)).armed()).toEqual([]);
            expect(
                mapped(
                    scheduled('mon-1', 'Monitor', { description: 'x', timeout_ms: 1000 }, 'refused', 'failed')
                ).armed()
            ).toEqual([]);
            expect(
                mapped(
                    scheduled('mon-1', 'Monitor', { description: 'x', timeout_ms: 1000 }, 'stopped', 'cancelled')
                ).armed()
            ).toEqual([]);
            expect(
                mapped(
                    scheduled('mon-1', 'Monitor', { description: 'x', timeout_ms: 1000 }, 'refused', 'failed')
                ).background([])
            ).toEqual([]);
        });

        test('nothing is held for a monitor that runs for the life of the session, another tool, or a call a sub-agent made', () => {
            expect(
                mapped(monitor('mon-1', { command: 'tail -f log', description: 'log', persistent: true })).armed()
            ).toEqual([]);
            expect(mapped(scheduled('bash-1', 'Bash', { command: 'sleep 1' }, 'done')).armed()).toEqual([]);

            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update({ sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Child' });

            for (const update of monitor()) {
                mapper.update(update, 'child-1');
            }

            expect(mapper.armed()).toEqual([]);
            expect(mapper.background([])).toEqual([]);
        });

        test('the completed call is looked at once: a later update of it holds nothing more', () => {
            const mapper = mapped(monitor());

            mapper.armed();
            mapper.lapse('mon-1');
            mapper.update(call({ toolCallId: 'mon-1', title: 'Monitor again' }));
            expect(mapper.armed()).toEqual([]);
            expect(mapper.background([])).toEqual([]);
        });

        test("a call the agent lists itself is its entry's: the mapper holds no item of its own for it, whether the list named it before or after the call completed", () => {
            const work: BackgroundWork[] = [{ type: 'tool_call', toolCallId: 'mon-1' }];

            // Told as ours first, then named by the list: one item, with the name the mapper gave, and the list losing it ends it.
            const after = mapped(monitor());

            expect(after.armed()).toHaveLength(1);
            expect(after.background(work)).toEqual([{ id: 'mon-1', kind: 'task', title: 'Monitor · Tick monitor' }]);
            expect(after.background([])).toEqual([]);
            expect(after.lapse('mon-1')).toBe(false);

            // Named by the list before the call completed.
            const before = mapped(monitor().slice(0, 2));

            expect(before.background(work)).toEqual([{ id: 'mon-1', kind: 'task', title: 'Monitor' }]);
            before.update(monitor()[2]);
            expect(before.armed()).toEqual([]);
            expect(before.background(work)).toEqual([{ id: 'mon-1', kind: 'task', title: 'Monitor · Tick monitor' }]);
            expect(before.background([])).toEqual([]);
        });
    });

    describe('a command that can be stopped alone', () => {
        const work: BackgroundWork[] = [{ type: 'terminal', terminalId: 't' }];
        const mapperWith = (...updates: SessionUpdateV2[]) => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            for (const update of updates) {
                mapper.update(update);
            }

            return mapper;
        };

        test('is a terminal that said the client may cancel it: its item says so, and the mapper says it may be asked', () => {
            const mapper = mapperWith({
                sessionUpdate: 'terminal_update',
                terminalId: 't',
                command: 'sleep 60',
                capabilities: { cancel: {} },
            });

            expect(mapper.background(work)).toEqual([
                { id: 't', kind: 'command', title: 'sleep 60', canStopAlone: true },
            ]);
            expect(mapper.stoppableCommand('t')).toBe(true);
        });

        test('is not a terminal that said nothing of it, or took the permission away, or has exited', () => {
            expect(
                mapperWith({ sessionUpdate: 'terminal_update', terminalId: 't', command: 'sleep 60' }).background(work)
            ).toEqual([{ id: 't', kind: 'command', title: 'sleep 60' }]);
            expect(
                mapperWith(
                    { sessionUpdate: 'terminal_update', terminalId: 't', capabilities: { cancel: {} } },
                    { sessionUpdate: 'terminal_update', terminalId: 't', capabilities: null }
                ).stoppableCommand('t')
            ).toBe(false);
            // An update that omits `capabilities` leaves what was said; one that names others and not `cancel` takes it away.
            expect(
                mapperWith(
                    { sessionUpdate: 'terminal_update', terminalId: 't', capabilities: { cancel: {} } },
                    { sessionUpdate: 'terminal_update', terminalId: 't', output: { data: 'aGk=' } }
                ).stoppableCommand('t')
            ).toBe(true);
            expect(
                mapperWith(
                    { sessionUpdate: 'terminal_update', terminalId: 't', capabilities: { cancel: {} } },
                    { sessionUpdate: 'terminal_update', terminalId: 't', capabilities: {} }
                ).stoppableCommand('t')
            ).toBe(false);
            // Exited: cancelled or over, whatever the agent still advertises.
            expect(
                mapperWith(
                    { sessionUpdate: 'terminal_update', terminalId: 't', capabilities: { cancel: {} } },
                    { sessionUpdate: 'terminal_update', terminalId: 't', exitStatus: { exitCode: 0 } }
                ).stoppableCommand('t')
            ).toBe(false);
            expect(
                mapperWith(
                    { sessionUpdate: 'terminal_update', terminalId: 't', capabilities: { cancel: {} } },
                    { sessionUpdate: 'terminal_update', terminalId: 't', exitStatus: {} }
                ).stoppableCommand('t')
            ).toBe(false);
        });

        test('belongs to the session: a terminal of a sub-agent is its own, and does not make an item of the session stoppable', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update({ sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Child' });
            mapper.update(
                { sessionUpdate: 'terminal_update', terminalId: 't', command: 'ls', capabilities: { cancel: {} } },
                'child-1'
            );
            expect(mapper.stoppableCommand('t')).toBe(false);
        });
    });

    describe('a task that can be stopped alone', () => {
        const work: BackgroundWork[] = [{ type: 'tool_call', toolCallId: 'wf-1' }];
        const workflow = (...updates: SessionUpdateV2[]) => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            for (const update of [
                call({ toolCallId: 'wf-1', title: 'Workflow: verify', kind: 'other', status: 'in_progress' }),
                ...updates,
            ]) {
                mapper.update(update);
            }

            return mapper;
        };

        test('is a call that said the client may cancel it: its item says so, and the mapper says it may be asked', () => {
            const mapper = workflow(call({ toolCallId: 'wf-1', capabilities: { cancel: {} } }));

            expect(mapper.background(work)).toEqual([
                { id: 'wf-1', kind: 'task', title: 'Workflow: verify', canStopAlone: true },
            ]);
            expect(mapper.stoppableTask('wf-1')).toBe(true);
        });

        test('is not a call that said nothing, took the permission away, or ended', () => {
            expect(workflow().background(work)).toEqual([{ id: 'wf-1', kind: 'task', title: 'Workflow: verify' }]);
            expect(
                workflow(
                    call({ toolCallId: 'wf-1', capabilities: { cancel: {} } }),
                    call({ toolCallId: 'wf-1', capabilities: null })
                ).stoppableTask('wf-1')
            ).toBe(false);
            // An update that leaves `capabilities` out leaves what was said; a call that ended cannot be cancelled, whatever the agent still advertises.
            expect(
                workflow(
                    call({ toolCallId: 'wf-1', capabilities: { cancel: {} } }),
                    call({ toolCallId: 'wf-1', title: 'Workflow: verify 2' })
                ).stoppableTask('wf-1')
            ).toBe(true);
            expect(
                workflow(
                    call({ toolCallId: 'wf-1', capabilities: { cancel: {} } }),
                    call({ toolCallId: 'wf-1', status: 'cancelled' })
                ).stoppableTask('wf-1')
            ).toBe(false);
            expect(
                workflow(call({ toolCallId: 'wf-1', capabilities: { cancel: {} }, status: 'completed' })).stoppableTask(
                    'wf-1'
                )
            ).toBe(false);
        });

        test('belongs to the session: a call of a sub-agent is its own', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update({ sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Child' });
            mapper.update(call({ toolCallId: 'wf-1', status: 'in_progress', capabilities: { cancel: {} } }), 'child-1');
            expect(mapper.stoppableTask('wf-1')).toBe(false);
        });
    });

    describe('the calls that stand for a command', () => {
        const terminal = (id: string): BackgroundWork[] => [{ type: 'terminal', terminalId: id }];

        test('a call that shows a listed terminal and has not ended is open, as Codex keeps the call of a command that outlived its turn; one that ended is not', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update({ sessionUpdate: 'terminal_update', terminalId: 't', command: 'sleep 40' });
            mapper.update(
                call({
                    toolCallId: 'exec-1',
                    name: 'exec_command',
                    kind: 'execute',
                    status: 'in_progress',
                    content: [{ type: 'terminal', terminalId: 't' }],
                })
            );
            expect(mapper.openCalls(terminal('t'))).toEqual(['exec-1']);
            // The terminal is not listed (the command was never background work), or the call ended (Claude's `Bash` call completes at once).
            expect(mapper.openCalls([])).toEqual([]);
            expect(mapper.openCalls(terminal('other'))).toEqual([]);
            mapper.update(call({ toolCallId: 'exec-1', status: 'completed' }));
            expect(mapper.openCalls(terminal('t'))).toEqual([]);
        });
    });

    describe('turns after the first', () => {
        test("each turn's cost is the rise over where the turn before it left the session's, and a turn that says nothing has no result of its own", () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 1 });
            const cost = (amount: number) =>
                mapper.update({ sessionUpdate: 'usage_update', used: 1, size: 10, cost: { amount, currency: 'USD' } });

            mapper.update(chunk2('first'));
            cost(1.5);
            expect(mapper.stop({ inputTokens: 10, outputTokens: 2 }).filter(event => event.type === 'usage')).toEqual([
                { type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
            ]);
            expect(mapper.result()).toBe('first');

            mapper.next();
            expect(mapper.result()).toBeUndefined();
            cost(2);
            expect(mapper.stop({ inputTokens: 1, outputTokens: 1 }).filter(event => event.type === 'usage')).toEqual([
                { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
            ]);
        });

        test('the turn after a steer that landed may say the answer again as a whole message under a new id, and it is not written twice', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });
            const shown = (updates: SessionUpdateV2[]) =>
                updates
                    .flatMap(update => mapper.update(update))
                    .filter(event => event.type === 'text' && event.delta)
                    .map(event => event.type === 'text' && event.delta);

            expect(shown([chunk2('The answer', 'a')])).toEqual(['The answer']);
            mapper.close();
            mapper.expectRepeat();
            // The same text under another id adds nothing, and does not when it comes again. Another text is a message.
            expect(shown([whole('The answer', 'b'), whole('The answer', 'b'), whole('More words', 'c')])).toEqual([
                'More words',
            ]);
        });

        test("the repeat that Claude's adapter says as one chunk, or as several, is held back until it ends and is not written twice", () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });
            const shown = (updates: SessionUpdateV2[]) =>
                updates
                    .flatMap(update => mapper.update(update))
                    .filter(event => event.type === 'text' && event.delta)
                    .map(event => event.type === 'text' && event.delta);

            expect(shown([chunk2('The ', 'a'), chunk2('answer', 'a')])).toEqual(['The ', 'answer']);
            mapper.close();
            mapper.expectRepeat();
            // All the text in one chunk, then the same in pieces under another id: nothing shows, and what ends them closes no message that was shown.
            expect(shown([chunk2('The answer', 'b')])).toEqual([]);
            expect(shown([chunk2('The ', 'c'), chunk2('ans', 'c'), chunk2('wer', 'c')])).toEqual([]);
            expect(mapper.close()).toEqual([]);
            expect(mapper.result()).toBe('The answer');
            // Another text is a message, shown whole the moment it is no longer the start of the last one, with what was held.
            expect(
                shown([chunk2('The ', 'd'), chunk2('ans', 'd'), chunk2('wers are many', 'd'), chunk2('!', 'd')])
            ).toEqual(['The answers are many', '!']);
        });

        test('what a held repeat is followed by settles it: a new message, a tool call, the end of the turn', () => {
            const text = (events: ReturnType<UpdateMapperV2['update']>) =>
                events
                    .filter(event => event.type === 'text' && event.delta)
                    .map(event => event.type === 'text' && event.delta);
            const fresh = () => {
                const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

                mapper.update(chunk2('The answer', 'a'));
                mapper.close();
                mapper.expectRepeat();

                return mapper;
            };

            // A different message after it: the repeat is dropped, the message shows.
            const next = fresh();

            expect(text(next.update(chunk2('The answer', 'b')))).toEqual([]);
            expect(text(next.update(chunk2('More words', 'c')))).toEqual(['More words']);

            // A tool call after it ends it as well.
            const tool = fresh();

            tool.update(chunk2('The answer', 'b'));
            expect(
                tool
                    .update({
                        sessionUpdate: 'tool_call_update',
                        toolCallId: 't1',
                        name: 'Bash',
                        status: 'in_progress',
                    })
                    .map(event => event.type)
            ).toEqual(['tool']);
            expect(tool.close()).toEqual([]);

            // A start that is only the beginning of the last message, when the turn ends, was a message after all.
            const cut = fresh();

            expect(text(cut.update(chunk2('The', 'b')))).toEqual([]);
            expect(text(cut.close())).toEqual(['The']);
        });

        test('with no steer to repeat, nothing is held back: a message that says what the last one said is a message, and its chunks show as they come', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });
            const shown = (update: SessionUpdateV2) =>
                mapper
                    .update(update)
                    .filter(event => event.type === 'text' && event.delta)
                    .map(event => event.type === 'text' && event.delta);

            mapper.update(chunk2('Same', 'a'));
            mapper.close();
            expect(shown(whole('Same', 'b'))).toEqual(['Same']);
            mapper.close();
            expect(shown(chunk2('Sa', 'c'))).toEqual(['Sa']);
            expect(shown(chunk2('me', 'c'))).toEqual(['me']);
        });

        test('the repeat is expected only until the next turn begins', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update(chunk2('Same', 'a'));
            mapper.close();
            mapper.expectRepeat();
            mapper.next();
            expect(
                mapper.update(whole('Same', 'b')).filter(event => event.type === 'text' && event.delta)
            ).toHaveLength(1);
            mapper.close();
            // A message that begins as the last one did streams at once too, now that no repeat is expected.
            expect(mapper.update(chunk2('Sa', 'c')).filter(event => event.type === 'text' && event.delta)).toHaveLength(
                1
            );
        });
    });

    describe('numbers', () => {
        test("tokens come from the idle update and cost is the rise over the session's earlier total", () => {
            const { events } = run2(
                [{ sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount: 0.75, currency: 'USD' } }],
                { costBefore: 0.25 },
                { inputTokens: 100, outputTokens: 20, totalTokens: 150, cachedReadTokens: 25, cachedWriteTokens: 5 }
            );

            expect(events.filter(event => event.type === 'usage')).toEqual([
                { type: 'usage', inputTokens: 130, outputTokens: 20, costUsd: 0.5 },
            ]);
        });

        test('nothing is reported when the agent reports nothing, and a session this daemon never measured reports tokens without a cost', () => {
            expect(run2([chunk2('hi')]).events.map(event => event.type)).toEqual(['text', 'text']);
            expect(
                run2(
                    [{ sessionUpdate: 'usage_update', used: 1, size: 10, cost: { amount: 5, currency: 'USD' } }],
                    { costBefore: undefined },
                    { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
                ).events.filter(event => event.type === 'usage')
            ).toEqual([{ type: 'usage', inputTokens: 3, outputTokens: 4 }]);
        });

        test("the window's fill becomes a context event once per reading, and a rate limit signal a limit event", () => {
            const { events } = run2([
                { sessionUpdate: 'usage_update', used: 21269, size: 1_000_000 },
                { sessionUpdate: 'usage_update', used: 21269, size: 1_000_000 },
                { sessionUpdate: 'usage_update', used: 0, size: 0 },
                {
                    sessionUpdate: 'usage_update',
                    used: 22062,
                    size: 1_000_000,
                    _meta: {
                        '_claude/rateLimit': {
                            status: 'rejected',
                            rateLimitType: 'five_hour',
                            utilization: 0.95,
                            resetsAt: 1_900_000_000,
                        },
                    },
                },
            ]);

            expect(events).toEqual([
                { type: 'context', used: 21269, size: 1_000_000 },
                { type: 'context', used: 22062, size: 1_000_000 },
                { type: 'limit', status: 'rejected', kind: 'five_hour', utilization: 0.95, resetsAt: 1_900_000_000 },
            ]);
        });
    });
});

describe('sub-agents of ACP v2', () => {
    /** What Claude's adapter said, recorded from real runs (`fixtures/subagent-wire-v2.jsonl`): the session the engine talks to and its sub-agents' sessions. */
    interface Line {
        scenario: string;
        main: boolean;
        sessionId: string;
        update: SessionUpdateV2;
    }

    const wire = readFileSync(new URL('./fixtures/subagent-wire-v2.jsonl', import.meta.url), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Line);

    /**
     * Feeds a recorded scenario to a mapper the way the layer does: the session's own updates as they come (its `state_update`s only for the list of background
     * work they carry), a sub-agent's updates with its session id once the session has announced it.
     */
    function replay(scenario: string) {
        const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });
        const events: EngineEvent[] = [];
        const lists: BackgroundItem[][] = [];

        for (const line of wire.filter(candidate => candidate.scenario === scenario)) {
            const { update } = line;

            if (!line.main) {
                if (mapper.knows(line.sessionId)) {
                    events.push(...mapper.update(update, line.sessionId));
                }
            } else if (update.sessionUpdate === 'state_update') {
                if (Array.isArray(update.background)) {
                    events.push(...mapper.listed(update.background));
                    lists.push(mapper.background(update.background));
                }
            } else {
                events.push(...mapper.update(update));
            }
        }

        return { mapper, events, lists };
    }

    const subagents = (events: EngineEvent[]) => events.filter(event => event.type === 'subagent');
    const agentCard = (events: EngineEvent[]) =>
        events.filter(event => event.type === 'tool' && event.name === 'Agent' && event.agentId === undefined);
    const ofChild = (events: EngineEvent[]) =>
        events.filter(event => 'agentId' in event && event.agentId !== undefined);

    test("a foreground sub-agent: the parent is shown no call, so the card is made from the announcement and the prompt, and the child's calls and report are its own", () => {
        const { events } = replay('foreground');
        const id = 'aa54305126ff66ee2';
        const call = 'toolu_01MkbchBAesZkmNaiqpoCGBp';
        const input = {
            subagent_type: 'general-purpose',
            description: 'Run echo ONE and TWO',
            prompt: 'Use the Bash tool to run `echo ONE`. Then use the Bash tool again to run `echo TWO`. Report both outputs in one sentence.',
        };

        expect(agentCard(events)).toEqual([
            { type: 'tool', toolCallId: call, name: 'Agent', input, state: 'running' },
            {
                type: 'tool',
                toolCallId: call,
                name: 'Agent',
                input,
                state: 'done',
                output: 'Ran `echo ONE` and `echo TWO` with the Bash tool; the outputs were ONE and TWO.',
            },
        ]);
        expect(subagents(events)).toEqual([
            {
                type: 'subagent',
                agentId: id,
                parentToolCallId: call,
                name: 'general-purpose',
                description: 'Run echo ONE and TWO',
                state: 'running',
                stoppable: true,
            },
            {
                type: 'subagent',
                agentId: id,
                parentToolCallId: call,
                name: 'general-purpose',
                state: 'done',
                summary: 'Ran `echo ONE` and `echo TWO` with the Bash tool; the outputs were ONE and TWO.',
            },
        ]);
        // Two `Bash` calls, each running and done, with the terminal's output; the report is the child's last message; the session's own words are none of it.
        expect(
            ofChild(events)
                .filter(event => event.type === 'tool')
                .map(event => event.type === 'tool' && [event.name, event.input, event.state, event.output])
        ).toEqual([
            ['Bash', { command: 'echo ONE', description: 'Print ONE' }, 'running', undefined],
            ['Bash', { command: 'echo TWO', description: 'Print TWO' }, 'running', undefined],
            ['Bash', { command: 'echo TWO', description: 'Print TWO' }, 'done', 'TWO'],
            ['Bash', { command: 'echo ONE', description: 'Print ONE' }, 'done', 'ONE'],
        ]);
        expect(
            ofChild(events)
                .filter(event => event.type === 'text')
                .map(event => event.type === 'text' && [event.delta, event.done])
        ).toEqual([
            ['Ran `echo ONE` and `echo TWO` with the Bash tool; the outputs were ONE and TWO.', false],
            ['', true],
        ]);
        // The fixture keeps the first chunk of each message.
        expect(
            events
                .filter(event => event.type === 'text' && event.agentId === undefined)
                .map(event => event.type === 'text' && event.delta)
                .join('')
        ).toBe('The s');
    });

    test('a background sub-agent: the card is running until the parent no longer lists it, and the layer does not end the child run', () => {
        const { events, lists } = replay('background');
        const cards = agentCard(events);

        expect(cards.map(event => event.type === 'tool' && event.state)).toEqual(['running', 'done']);
        expect(cards[0]).toMatchObject({
            toolCallId: 'toolu_017o2xvBFmdbsE9ybkR2fAwe',
            input: { subagent_type: 'general-purpose', description: 'Run echo ONE and sleep TWO' },
        });
        expect(cards[1]).toMatchObject({ output: expect.stringContaining('ONE') });
        // The run ends when the item leaves the list (the runtime reads that), not on the child's `idle`: a child may be woken a moment after it.
        expect(subagents(events).map(event => event.type === 'subagent' && event.state)).toEqual(['running']);
        // What the lists called it: the title the parent gave the task, and the id of the call that started it, which is its child run's `parentToolCallId`.
        expect(lists.map(items => items.map(item => [item.id, item.kind, item.title]))).toContainEqual([
            ['toolu_017o2xvBFmdbsE9ybkR2fAwe', 'subagent', 'Run echo ONE and sleep TWO'],
        ]);
        // Its calls came after the parent's turn was over, and are still the child's.
        expect(ofChild(events).filter(event => event.type === 'tool')).toHaveLength(4);
    });

    test('two background sub-agents are two cards and two child runs, told apart by their sessions', () => {
        const { events } = replay('two-background');
        const [first, second] = subagents(events);

        expect(subagents(events)).toHaveLength(2);
        expect(first).toMatchObject({ description: 'Run sleep 6 and echo AAA', state: 'running' });
        expect(second).toMatchObject({ description: 'Run sleep 10 and echo BBB', state: 'running' });
        expect(first.type === 'subagent' && first.agentId).not.toBe(second.type === 'subagent' && second.agentId);
        expect(agentCard(events).map(event => event.type === 'tool' && [event.toolCallId, event.state])).toHaveLength(
            4
        );
        expect(
            ofChild(events).filter(
                event => event.type === 'tool' && event.agentId === (first.type === 'subagent' ? first.agentId : '')
            ).length
        ).toBeGreaterThan(0);
    });

    test('a sub-agent that was cancelled ends its run and its card as cancelled', () => {
        const { events } = replay('foreground-cancelled');

        expect(subagents(events).map(event => event.type === 'subagent' && [event.state, event.summary])).toEqual([
            ['running', undefined],
            ['cancelled', undefined],
        ]);
        expect(agentCard(events).map(event => event.type === 'tool' && [event.state, event.error])).toEqual([
            ['running', undefined],
            ['error', STOPPED_TOOL],
        ]);
        // Its call was cancelled with it.
        expect(
            ofChild(events)
                .filter(event => event.type === 'tool')
                .at(-1)
        ).toMatchObject({ state: 'error', error: STOPPED_TOOL });
    });

    test('an `Agent` call that failed before it started a child is a plain tool call: nothing was announced', () => {
        const { events } = replay('agent-call-failed');

        expect(subagents(events)).toEqual([]);
        expect(events.filter(event => event.type === 'tool')).toEqual([
            expect.objectContaining({ name: 'Agent', state: 'error' }),
        ]);
    });

    test('a message sent to the parent while a background sub-agent works does not touch the child', () => {
        const { events } = replay('message-while-background');

        expect(subagents(events)).toHaveLength(1);
        expect(
            events
                .filter(event => event.type === 'text' && event.agentId === undefined)
                .map(event => event.type === 'text' && event.delta)
        ).toContain('4');
    });

    /**
     * Sub-agents of a sub-agent, as the real adapter told them (Claude Code 2.1.312, claude-agent-acp 0.107.0; `nested-foreground`, `nested-background`): the
     * middle sub-agent M starts two of its own, G1 and G2. Their `subagent_update` comes on M's session, not the main one's, with the `session_message`s on both
     * sessions' views and their calls stamped with their prompt's message; the main session's list names only M, which stays in it while any of its own work is open.
     */
    describe('a sub-agent of a sub-agent', () => {
        const starter = (events: EngineEvent[], agentId: string) =>
            events.find(event => event.type === 'subagent' && event.agentId === agentId && event.state === 'running');

        test('foreground: the grandchildren are announced by the middle sub-agent, so their runs are named below it, their cards are in its stream, and each ends with its own report', () => {
            const { events } = replay('nested-foreground');
            const [middle, first, second] = subagents(events).filter(
                event => event.type === 'subagent' && event.state === 'running'
            );

            expect(middle).toMatchObject({
                type: 'subagent',
                name: 'general-purpose',
                description: 'Run nested sleep sub-agents',
                stoppable: true,
            });
            expect(middle).not.toHaveProperty('parentAgentId');
            expect([first, second].map(event => event.type === 'subagent' && event.parentAgentId)).toEqual([
                middle.type === 'subagent' && middle.agentId,
                middle.type === 'subagent' && middle.agentId,
            ]);
            expect([first, second].map(event => event.type === 'subagent' && event.stoppable)).toEqual([true, true]);

            // The card of a grandchild's call is in the middle sub-agent's stream (it carries its id), the middle's own is in the session's.
            const middleId = middle.type === 'subagent' ? middle.agentId : '';
            const cards = events.filter(event => event.type === 'tool' && event.name === 'Agent');

            expect(cards.filter(event => event.type === 'tool' && event.agentId === middleId)).toHaveLength(4);
            expect(cards.filter(event => event.type === 'tool' && event.agentId === undefined)).toHaveLength(2);

            // Each ends done with its own report, the grandchildren before the one that started them.
            const ends = subagents(events).flatMap(event =>
                event.type === 'subagent' && event.state !== 'running'
                    ? [[event.agentId === middleId ? 'middle' : 'grandchild', event.state, event.summary]]
                    : []
            );

            expect(ends.map(([who, state]) => [who, state])).toEqual([
                ['grandchild', 'done'],
                ['grandchild', 'done'],
                ['middle', 'done'],
            ]);
            expect(
                ends
                    .slice(0, 2)
                    .map(([, , summary]) => summary)
                    .sort()
            ).toEqual(['DONE-G1', 'DONE-G2']);
        });

        test('background: the main list names the middle sub-agent only, and each grandchild ends by itself when it stops, not by the list', () => {
            const { events, lists } = replay('nested-background');
            const running = subagents(events).filter(event => event.type === 'subagent' && event.state === 'running');
            const [middle, ...grand] = running;
            const middleId = middle.type === 'subagent' ? middle.agentId : '';

            expect(grand).toHaveLength(2);
            expect(grand.map(event => event.type === 'subagent' && event.parentAgentId)).toEqual([middleId, middleId]);
            expect(starter(events, middleId)).toBe(middle);

            // The only item the main session's list ever has is the middle sub-agent, by the call that started it.
            const items = new Set(lists.flat().map(item => `${item.kind}:${item.id}`));

            expect([...items]).toEqual([`subagent:${middle.type === 'subagent' && middle.parentToolCallId}`]);

            // The grandchildren end `done` with their reports at their own `idle`; the middle one is left to the list, which loses it when its own work is over.
            expect(
                subagents(events).flatMap(event =>
                    event.type === 'subagent' && event.state !== 'running'
                        ? [[event.agentId === middleId ? 'middle' : 'grandchild', event.state]]
                        : []
                )
            ).toEqual([
                ['grandchild', 'done'],
                ['grandchild', 'done'],
            ]);
        });
    });

    describe("a sub-agent's thoughts", () => {
        const announce = (): SessionUpdateV2 => ({
            sessionUpdate: 'subagent_update',
            sessionId: 'child-1',
            title: 'Look around',
            description: 'Explore',
        });
        const kinds = (events: EngineEvent[]) =>
            events
                .filter(event => event.type === 'thought' || event.type === 'text')
                .map(event =>
                    event.type === 'thought'
                        ? ['thought', event.delta, event.done, event.agentId]
                        : ['text', event.delta, event.done, event.agentId]
                );

        test('go to its own stream under its session id: a message ends the open one, a whole thought shows what the stream lacks', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update(announce());

            const events = [
                ...mapper.update(
                    { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: 'Hel' } },
                    'child-1'
                ),
                ...mapper.update(
                    { sessionUpdate: 'agent_thought', messageId: 't1', content: [{ type: 'text', text: 'Hello' }] },
                    'child-1'
                ),
                ...mapper.update(
                    {
                        sessionUpdate: 'agent_message_chunk',
                        messageId: 'm1',
                        content: { type: 'text', text: 'Found it' },
                    },
                    'child-1'
                ),
            ];

            expect(kinds(events)).toEqual([
                ['thought', 'Hel', false, 'child-1'],
                ['thought', 'lo', false, 'child-1'],
                ['thought', '', true, 'child-1'],
                ['text', 'Found it', false, 'child-1'],
            ]);
        });

        test("are apart from the session's own, and the sub-agent's end closes the one it has open", () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update(announce());

            const events = [
                ...mapper.update({
                    sessionUpdate: 'agent_thought_chunk',
                    messageId: 'own',
                    content: { type: 'text', text: 'Session' },
                }),
                ...mapper.update(
                    { sessionUpdate: 'agent_thought_chunk', messageId: 'c', content: { type: 'text', text: 'Child' } },
                    'child-1'
                ),
                ...mapper.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }, 'child-1'),
            ];

            expect(kinds(events)).toEqual([
                ['thought', 'Session', false, undefined],
                ['thought', 'Child', false, 'child-1'],
                ['thought', '', true, 'child-1'],
            ]);
        });
    });

    describe('what the layer cannot know', () => {
        const announce = (
            extra: Partial<Extract<SessionUpdateV2, { sessionUpdate: 'subagent_update' }>> = {}
        ): SessionUpdateV2 => ({
            sessionUpdate: 'subagent_update',
            sessionId: 'child-1',
            title: 'Look around',
            description: 'Explore',
            ...extra,
        });

        test('a sub-agent that is announced and says nothing of its call is told to the runtime at its first call, named by the call it stamps', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            expect(mapper.update(announce())).toEqual([]);

            const events = mapper.update(
                {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'x1',
                    name: 'Read',
                    status: 'in_progress',
                    _meta: { claudeCode: { parentToolUseId: 'call-9' } },
                },
                'child-1'
            );

            expect(events.map(event => event.type)).toEqual(['tool', 'subagent', 'tool']);
            expect(events[1]).toEqual({
                type: 'subagent',
                agentId: 'child-1',
                parentToolCallId: 'call-9',
                name: 'Explore',
                description: 'Look around',
                state: 'running',
            });
            expect(events[2]).toMatchObject({ type: 'tool', toolCallId: 'x1', name: 'Read', agentId: 'child-1' });
        });

        test('an agent that sends no message between sessions (Codex) has its sub-agents known by their session id and no card', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update(announce({ description: undefined }));

            const events = [
                ...mapper.update(
                    {
                        sessionUpdate: 'agent_message_chunk',
                        messageId: 'm',
                        content: { type: 'text', text: 'Looking' },
                    },
                    'child-1'
                ),
                ...mapper.update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }, 'child-1'),
            ];

            expect(events).toEqual([
                {
                    type: 'subagent',
                    agentId: 'child-1',
                    name: 'Sub-agent',
                    description: 'Look around',
                    state: 'running',
                },
                { type: 'text', delta: 'Looking', done: false, agentId: 'child-1' },
                { type: 'text', delta: '', done: true, agentId: 'child-1' },
                { type: 'subagent', agentId: 'child-1', name: 'Sub-agent', state: 'done', summary: 'Looking' },
            ]);
        });

        test("a session that was never announced says nothing the mapper takes, and the session's window and cost are not a child's", () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            expect(mapper.knows('stranger')).toBe(false);
            expect(
                mapper.update(
                    { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'hi' } },
                    'stranger'
                )
            ).toEqual([]);

            mapper.update(announce());
            expect(mapper.knows('child-1')).toBe(true);
            expect(
                mapper.update(
                    { sessionUpdate: 'usage_update', used: 5, size: 10, cost: { amount: 3, currency: 'USD' } },
                    'child-1'
                )
            ).toEqual([]);
            expect(mapper.cost).toBeUndefined();
        });

        test('a sub-agent that stopped for a reason other than an answer failed, and one that stopped for good cannot be woken', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update(announce());
            mapper.update(
                { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'a' } },
                'child-1'
            );

            const failed = mapper.update(
                { sessionUpdate: 'state_update', state: 'idle', stopReason: 'max_tokens' },
                'child-1'
            );

            expect(failed.at(-1)).toEqual({
                type: 'subagent',
                agentId: 'child-1',
                name: 'Explore',
                state: 'error',
                summary: 'The sub-agent stopped: max tokens',
            });
            expect(mapper.update({ sessionUpdate: 'state_update', state: 'running' }, 'child-1')).toEqual([]);
        });

        test("the id of a sub-agent's item does not change once the lists have said it, even when the call that started it becomes known later", () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });
            const list: BackgroundWork[] = [{ type: 'subagent', sessionId: 'child-1' }];

            mapper.update(announce());
            expect(mapper.background(list)[0].id).toBe('child-1');
            mapper.update(
                {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'x1',
                    name: 'Read',
                    status: 'in_progress',
                    _meta: { claudeCode: { parentToolUseId: 'call-9' } },
                },
                'child-1'
            );
            expect(mapper.background(list)[0].id).toBe('child-1');
        });

        test("a sub-agent of a sub-agent is announced by the child that started it, and its card is in that child's stream", () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update(announce());
            mapper.update({
                sessionUpdate: 'session_message',
                messageId: 'call-1',
                senderSessionId: 'main',
                recipientSessionId: 'child-1',
                content: [{ type: 'text', text: 'go' }],
            });

            const events = [
                ...mapper.update(
                    {
                        sessionUpdate: 'subagent_update',
                        sessionId: 'grandchild',
                        title: 'Deeper',
                        description: 'Explore',
                    },
                    'child-1'
                ),
                ...mapper.update(
                    {
                        sessionUpdate: 'session_message',
                        messageId: 'call-2',
                        senderSessionId: 'child-1',
                        recipientSessionId: 'grandchild',
                        content: [{ type: 'text', text: 'dig' }],
                    },
                    'child-1'
                ),
            ];

            expect(events).toEqual([
                {
                    type: 'tool',
                    toolCallId: 'call-2',
                    name: 'Agent',
                    input: { subagent_type: 'Explore', description: 'Deeper', prompt: 'dig' },
                    state: 'running',
                    agentId: 'child-1',
                },
                {
                    type: 'subagent',
                    agentId: 'grandchild',
                    parentAgentId: 'child-1',
                    parentToolCallId: 'call-2',
                    name: 'Explore',
                    description: 'Deeper',
                    state: 'running',
                },
            ]);
        });

        test('a sub-agent its parent lets the client cancel is stoppable, and said so, until it ends; one announced without that permission never is', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });
            const hear = (sessionId: string) =>
                mapper.update(
                    {
                        sessionUpdate: 'agent_message_chunk',
                        messageId: `m-${sessionId}`,
                        content: { type: 'text', text: 'hi' },
                    },
                    sessionId
                );

            mapper.update(announce({ capabilities: { cancel: {} } }));
            mapper.update(announce({ sessionId: 'child-2' }));
            mapper.update(announce({ sessionId: 'child-3', capabilities: { cancel: null } }));

            expect([
                mapper.stoppable('child-1'),
                mapper.stoppable('child-2'),
                mapper.stoppable('child-3'),
                mapper.stoppable('stranger'),
            ]).toEqual([true, false, false, false]);
            expect(hear('child-1')[0]).toMatchObject({
                type: 'subagent',
                agentId: 'child-1',
                state: 'running',
                stoppable: true,
            });
            expect(hear('child-2')[0]).toEqual({
                type: 'subagent',
                agentId: 'child-2',
                name: 'Explore',
                description: 'Look around',
                state: 'running',
            });

            // What the parent permits is replaced by what it says last: `null` takes the permission away, and a later word that omits it keeps it.
            mapper.update({ sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Renamed' });
            expect(mapper.stoppable('child-1')).toBe(true);
            mapper.update({ sessionUpdate: 'subagent_update', sessionId: 'child-1', capabilities: null });
            expect(mapper.stoppable('child-1')).toBe(false);
            mapper.update({ sessionUpdate: 'subagent_update', sessionId: 'child-1', capabilities: { cancel: {} } });
            expect(mapper.stoppable('child-1')).toBe(true);

            // Stopped, it is over: nothing more is asked of it.
            const ended = mapper.update(
                { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' },
                'child-1'
            );

            expect(ended.at(-1)).toEqual({ type: 'subagent', agentId: 'child-1', name: 'Explore', state: 'cancelled' });
            expect(mapper.stoppable('child-1')).toBe(false);
        });

        test('the same message seen from both sessions is told once', () => {
            const mapper = new UpdateMapperV2({ toolNames: [], costBefore: 0 });

            mapper.update(announce());

            const message = (view: Record<string, string>): SessionUpdateV2 => ({
                sessionUpdate: 'session_message',
                messageId: 'r1',
                senderSessionId: 'child-1',
                recipientSessionId: 'main',
                content: [{ type: 'text', text: 'Found it' }],
                ...view,
            });
            const texts = [
                ...mapper.update(message({ recipientMessageId: 'r1' }), 'child-1'),
                ...mapper.update(message({ senderMessageId: 'r1' })),
            ].filter(event => event.type === 'text' && event.delta);

            expect(texts).toEqual([{ type: 'text', delta: 'Found it', done: false, agentId: 'child-1' }]);
        });
    });
});
