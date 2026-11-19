import { describe, expect, test } from 'bun:test';

import { UpdateMapper } from '../src/engine/acp/mapper';
import { UpdateMapperV2 } from '../src/engine/acp/mapper-v2';

import type { SessionUpdate as SessionUpdateV2, Usage } from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type { PromptResponse, SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import type { EngineEvent } from '../src/engine/types';

const chunk = (text: string, messageId?: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId && { messageId }) });

function run(updates: SessionUpdate[], options: Partial<ConstructorParameters<typeof UpdateMapper>[0]> = {}, response: PromptResponse = { stopReason: 'end_turn' }) {
    const mapper = new UpdateMapper({ toolNames: ['task_create', 'run_spawn', 'ask_user'], costBefore: 0, ...options });
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
        const { events, mapper } = run([chunk('Let me look.'), { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read file', kind: 'read' }, chunk('Found it.')]);

        expect(events.map(event => event.type)).toEqual(['text', 'text', 'tool', 'text', 'text']);
        expect(mapper.result()).toBe('Found it.');
    });

    test('a new message id is a new message even with no tool call between', () => {
        const { events, mapper } = run([chunk('one', 'm1'), chunk('two', 'm2')]);

        expect(events.map(event => event.type === 'text' && [event.delta, event.done])).toEqual([['one', false], ['', true], ['two', false], ['', true]]);
        expect(mapper.result()).toBe('two');
    });

    test('thoughts, plans and the rest are not shown', () => {
        const { events } = run([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }, { sessionUpdate: 'current_mode_update', currentModeId: 'x' }]);

        expect(events).toEqual([]);
    });
});

describe('tool calls', () => {
    test('the runtime\'s own tools keep their bare name whatever the agent calls them', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: '1', title: 'mcp__clowdy__task_create', _meta: { claudeCode: { toolName: 'mcp__clowdy__task_create' } } },
            { sessionUpdate: 'tool_call', toolCallId: '2', title: 'Tool: clowdy/run_spawn' },
            { sessionUpdate: 'tool_call', toolCallId: '3', title: 'clowdy.ask_user', kind: 'other' },
            { sessionUpdate: 'tool_call', toolCallId: '4', title: 'Tool: linear/task_create' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.name)).toEqual(['task_create', 'run_spawn', 'ask_user', 'Tool: linear/task_create']);
    });

    test('the name comes from Claude\'s tool name, then the agent\'s name, then the kind', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: '1', title: 'Run ls', kind: 'execute', _meta: { claudeCode: { toolName: 'Bash' } } },
            { sessionUpdate: 'tool_call', toolCallId: '2', title: 'List', name: 'shell', kind: 'execute' },
            { sessionUpdate: 'tool_call', toolCallId: '3', title: 'Run ls', kind: 'execute' },
            { sessionUpdate: 'tool_call', toolCallId: '4', title: 'Something odd', kind: 'other' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.name)).toEqual(['Bash', 'shell', 'Bash', 'Something odd']);
    });

    test('input is the raw input, or the title when the agent gave none', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: '1', title: 'Read a.ts', kind: 'read', rawInput: { file_path: 'a.ts' } },
            { sessionUpdate: 'tool_call', toolCallId: '2', title: 'Read b.ts', kind: 'read' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.input)).toEqual([{ file_path: 'a.ts' }, { title: 'Read b.ts' }]);
    });

    test('a call moves from running to done with its output, and an update that changes nothing is skipped', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: '1', title: 'Read', kind: 'read', status: 'pending' },
            { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'in_progress' },
            { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file text' } }] },
        ]);

        expect(tools(events)).toEqual([
            { type: 'tool', toolCallId: '1', name: 'Read', input: { title: 'Read' }, state: 'running' },
            { type: 'tool', toolCallId: '1', name: 'Read', input: { title: 'Read' }, state: 'done', output: 'file text' },
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
            { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', content: [{ type: 'diff', path: '/a.ts', oldText: 'a', newText: 'b' }] },
        ]);

        expect(tools(events).at(-1)).toMatchObject({ state: 'done', output: 'Changed /a.ts' });
    });
});

describe('compaction', () => {
    const facts = { trigger: 'manual', preTokens: 22_062, postTokens: 6_111, durationMs: 4_200 };

    test('Claude\'s compaction call is `compact`, with the counts as its output', () => {
        const meta = { claudeCode: { toolName: 'compact' } };
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: meta },
            { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: facts, _meta: meta },
        ]);

        expect(tools(events)).toEqual([
            { type: 'tool', toolCallId: 'c1', name: 'compact', input: { title: 'Compact conversation' }, state: 'running' },
            { type: 'tool', toolCallId: 'c1', name: 'compact', input: { title: 'Compact conversation' }, state: 'done', output: JSON.stringify(facts) },
        ]);
    });

    test('Codex\'s, a `think` call it names only by its title, is `compact` too, and keeps the name through updates that carry no title', () => {
        const { events } = run([
            { sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'Compact conversation', kind: 'think', status: 'in_progress' },
            { sessionUpdate: 'tool_call_update', toolCallId: 'x1', title: 'Compact conversation', status: 'in_progress', _meta: { note: 'progress' } },
            { sessionUpdate: 'tool_call_update', toolCallId: 'x1', kind: 'think', status: 'completed' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && [event.name, event.state])).toEqual([['compact', 'running'], ['compact', 'done']]);
    });

    test('another `think` call keeps the name of its kind', () => {
        const { events } = run([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Reasoning', kind: 'think' }]);

        expect(tools(events).map(event => event.type === 'tool' && event.name)).toEqual(['Think']);
    });
});

describe('sub-agents, as Claude\'s adapter reports them without child sessions', () => {
    const stamp = (parentToolUseId: string, toolName?: string) => ({ claudeCode: { parentToolUseId, ...(toolName && { toolName }) } });
    const agentCall = (toolCallId: string, input: unknown = { subagent_type: 'Explore', description: 'Map the router', prompt: 'Find every route.' }): SessionUpdate => ({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Map the router',
        kind: 'think',
        status: 'in_progress',
        rawInput: input,
        _meta: { claudeCode: { toolName: 'Agent' } },
    });
    const childChunk = (parentToolUseId: string, text: string, messageId?: string): SessionUpdate => ({ ...chunk(text, messageId), _meta: stamp(parentToolUseId) });
    const subagents = (events: EngineEvent[]) => events.filter(event => event.type === 'subagent');

    test('a stamped update goes to the sub-agent, which its first one announces with the name and brief of the call that started it', () => {
        const { events, mapper } = run([
            chunk('Let me delegate.', 'p1'),
            agentCall('agent-1'),
            childChunk('agent-1', 'Looking ', 'c1'),
            childChunk('agent-1', 'around.', 'c1'),
            { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read a.ts', kind: 'read', status: 'in_progress', rawInput: { file_path: 'a.ts' }, _meta: stamp('agent-1', 'Read') },
            chunk('Still mine.', 'p2'),
        ]);

        expect(events).toEqual([
            { type: 'text', delta: 'Let me delegate.', done: false },
            { type: 'text', delta: '', done: true },
            { type: 'tool', toolCallId: 'agent-1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Map the router', prompt: 'Find every route.' }, state: 'running' },
            { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'agent-1', name: 'Explore', description: 'Map the router', state: 'running' },
            { type: 'text', delta: 'Looking ', done: false, agentId: 'agent-1' },
            { type: 'text', delta: 'around.', done: false, agentId: 'agent-1' },
            // The sub-agent's call ends its own message, not the session's.
            { type: 'text', delta: '', done: true, agentId: 'agent-1' },
            { type: 'tool', toolCallId: 'read-1', name: 'Read', input: { file_path: 'a.ts' }, state: 'running', agentId: 'agent-1' },
            { type: 'text', delta: 'Still mine.', done: false },
            { type: 'text', delta: '', done: true },
        ]);
        expect(mapper.result()).toBe('Still mine.');
    });

    test('the session\'s open message stays open through the sub-agent\'s text and calls, and is the result', () => {
        const { events, mapper } = run([agentCall('agent-1'), chunk('Waiting ', 'p1'), childChunk('agent-1', 'Busy.', 'c1'), { sessionUpdate: 'tool_call', toolCallId: 'grep-1', title: 'Grep', kind: 'search', _meta: stamp('agent-1') }, chunk('on it.', 'p1')]);
        const own = events.filter(event => event.type === 'text' && event.agentId === undefined);

        expect(own).toEqual([{ type: 'text', delta: 'Waiting ', done: false }, { type: 'text', delta: 'on it.', done: false }, { type: 'text', delta: '', done: true }]);
        expect(mapper.result()).toBe('Waiting on it.');
    });

    test('a later update of the sub-agent\'s call that lost the stamp stays with the sub-agent', () => {
        const { events } = run([
            agentCall('agent-1'),
            { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', kind: 'read', _meta: stamp('agent-1') },
            { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: 'text' },
        ]);

        expect(tools(events).at(-1)).toEqual({ type: 'tool', toolCallId: 'read-1', name: 'Read', input: { title: 'Read' }, state: 'done', output: 'text', agentId: 'agent-1' });
    });

    test('the call that started it ends it: done with the call\'s result as its report, or failed with its error', () => {
        const { events } = run([
            agentCall('agent-1'),
            childChunk('agent-1', 'Half a sentence', 'c1'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Three routes.' } }] },
            agentCall('agent-2', { subagent_type: 'Plan' }),
            childChunk('agent-2', 'Planning'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-2', status: 'failed', rawOutput: 'The sub-agent stopped' },
        ]);

        expect(events.slice(3, 6)).toEqual([
            { type: 'tool', toolCallId: 'agent-1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Map the router', prompt: 'Find every route.' }, state: 'done', output: 'Three routes.' },
            { type: 'text', delta: '', done: true, agentId: 'agent-1' },
            { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'agent-1', name: 'Explore', state: 'done', summary: 'Three routes.' },
        ]);
        expect(subagents(events)).toEqual([
            { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'agent-1', name: 'Explore', description: 'Map the router', state: 'running' },
            { type: 'subagent', agentId: 'agent-1', parentToolCallId: 'agent-1', name: 'Explore', state: 'done', summary: 'Three routes.' },
            { type: 'subagent', agentId: 'agent-2', parentToolCallId: 'agent-2', name: 'Plan', state: 'running' },
            { type: 'subagent', agentId: 'agent-2', parentToolCallId: 'agent-2', name: 'Plan', state: 'error', summary: 'The sub-agent stopped' },
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

        expect(events.filter(event => event.type === 'text' && (event.delta === 'A late beat' || event.delta === 'Too late'))).toEqual([]);
        expect(subagents(events).map(event => event.type === 'subagent' && [event.agentId, event.state])).toEqual([['agent-1', 'running'], ['agent-1', 'done']]);
    });

    test('a call a sub-agent makes after its own call ended is dropped with its later updates, even those that lost the stamp', () => {
        const { events } = run([
            agentCall('agent-1'),
            childChunk('agent-1', 'Working'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed', rawOutput: 'Done' },
            { sessionUpdate: 'tool_call', toolCallId: 'late-read', title: 'Read', kind: 'read', _meta: stamp('agent-1', 'Read') },
            { sessionUpdate: 'tool_call_update', toolCallId: 'late-read', status: 'completed', rawOutput: 'text' },
            // One first heard of after its call ended (a background sub-agent): its calls stay out of the session's stream too.
            agentCall('agent-2'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'agent-2', status: 'completed', rawOutput: 'Launched' },
            { sessionUpdate: 'tool_call', toolCallId: 'bg-grep', title: 'Grep', kind: 'search', _meta: stamp('agent-2', 'Grep') },
            { sessionUpdate: 'tool_call_update', toolCallId: 'bg-grep', status: 'completed', rawOutput: 'match' },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && event.toolCallId)).toEqual(['agent-1', 'agent-1', 'agent-2', 'agent-2']);
    });

    test('a sub-agent heard of before its call is named by default; the brief falls back to the first line of the prompt', () => {
        const long = 'word '.repeat(40).trim();
        const { events } = run([childChunk('ghost', 'Boo'), agentCall('agent-2', { prompt: `${ long }\nMore detail` }), childChunk('agent-2', 'Hi')]);

        expect(subagents(events)).toEqual([
            { type: 'subagent', agentId: 'ghost', parentToolCallId: 'ghost', name: 'Sub-agent', state: 'running' },
            { type: 'subagent', agentId: 'agent-2', parentToolCallId: 'agent-2', name: 'Sub-agent', description: `${ long.slice(0, 120) }…`, state: 'running' },
        ]);
    });

    test('a sub-agent call of an agent that stamps nothing stays a plain call, with the traffic in the session\'s stream', () => {
        const { events } = run([agentCall('agent-1'), chunk('child words'), { sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed', rawOutput: 'Done' }]);

        expect(subagents(events)).toEqual([]);
        expect(events.every(event => !('agentId' in event))).toBe(true);
    });

    test('a nested sub-agent is announced on its own, and its call in the outer sub-agent\'s stream ends it', () => {
        const { events } = run([
            agentCall('outer'),
            { ...agentCall('inner'), _meta: stamp('outer', 'Agent') },
            childChunk('inner', 'Deep'),
            { sessionUpdate: 'tool_call_update', toolCallId: 'inner', status: 'completed', rawOutput: 'Inner done', _meta: stamp('outer', 'Agent') },
        ]);

        expect(tools(events).map(event => event.type === 'tool' && [event.toolCallId, event.state, event.agentId])).toEqual([['outer', 'running', undefined], ['inner', 'running', 'outer'], ['inner', 'done', 'outer']]);
        expect(subagents(events).map(event => event.type === 'subagent' && [event.agentId, event.state])).toEqual([['outer', 'running'], ['inner', 'running'], ['inner', 'done']]);
    });
});

describe('numbers', () => {
    const cost = (amount: number): SessionUpdate => ({ sessionUpdate: 'usage_update', used: 1, size: 100, cost: { amount, currency: 'USD' } });

    test('tokens come from the prompt response and cost is the rise over the session\'s earlier total', () => {
        const { events } = run([cost(1.5)], { costBefore: 1 }, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedReadTokens: 6 } });

        expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 16, outputTokens: 4, costUsd: 0.5 }]);
    });

    test('a resumed session this daemon never measured reports tokens without a cost', () => {
        const { events } = run([cost(9)], { costBefore: undefined }, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

        expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 1, outputTokens: 1 }]);
    });

    test('nothing is reported when the agent reports nothing', () => {
        expect(run([]).events).toEqual([]);
    });

    test('a cost in another currency is ignored', () => {
        const { events, mapper } = run([{ sessionUpdate: 'usage_update', used: 1, size: 1, cost: { amount: 5, currency: 'EUR' } }]);

        expect(mapper.cost).toBeUndefined();
        expect(events.filter(event => event.type === 'usage')).toEqual([]);
    });

    test('rate limits: warnings and rejections are signals, repeats and "allowed" are not', () => {
        const limit = (status: string, resetsAt?: number): SessionUpdate => ({ sessionUpdate: 'usage_update', used: 1, size: 1, _meta: { '_claude/rateLimit': { status, rateLimitType: 'seven_day', utilization: 0.8, resetsAt } } });
        const { events } = run([limit('allowed'), limit('allowed_warning', 100), limit('allowed_warning', 100), limit('rejected', 200)]);

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
        const { events } = run([fill(21269, 1_000_000), fill(21269, 1_000_000), fill(21491, 1_000_000), fill(21491, 200_000)]);

        expect(contexts(events)).toEqual([
            { type: 'context', used: 21269, size: 1_000_000 },
            { type: 'context', used: 21491, size: 1_000_000 },
            { type: 'context', used: 21491, size: 200_000 },
        ]);
    });

    test('comes with the cost and the rate limit of the same update, each in its own event', () => {
        const update: SessionUpdate = { sessionUpdate: 'usage_update', used: 5, size: 100, cost: { amount: 1, currency: 'USD' }, _meta: { '_claude/rateLimit': { status: 'rejected', rateLimitType: 'five_hour' } } };

        expect(run([update]).events.map(event => event.type)).toEqual(['context', 'limit', 'usage']);
    });

    test('a reading that makes no sense is ignored', () => {
        const { events } = run([fill(5, 0), fill(-1, 100), fill(Number.NaN, 100), fill(5, Number.POSITIVE_INFINITY)]);

        expect(contexts(events)).toEqual([]);
    });
});

describe('updates of ACP v2', () => {
    const chunk2 = (text: string, messageId = 'm1'): SessionUpdateV2 => ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
    const whole = (text: string, messageId = 'm1'): SessionUpdateV2 => ({ sessionUpdate: 'agent_message', messageId, content: [{ type: 'text', text }] });
    const call = (update: Omit<Extract<SessionUpdateV2, { sessionUpdate: 'tool_call_update' }>, 'sessionUpdate'>): SessionUpdateV2 => ({ sessionUpdate: 'tool_call_update', ...update });

    function run2(updates: SessionUpdateV2[], options: Partial<ConstructorParameters<typeof UpdateMapperV2>[0]> = {}, usage?: Usage) {
        const mapper = new UpdateMapperV2({ toolNames: ['task_create', 'run_spawn', 'ask_user'], costBefore: 0, ...options });
        const events: EngineEvent[] = [];

        for (const update of updates) {
            events.push(...mapper.update(update));
        }

        events.push(...mapper.stop(usage));

        return { mapper, events };
    }

    describe('messages', () => {
        test('chunks of a message append, and a message with another id is another message', () => {
            const { events, mapper } = run2([chunk2('Hel'), chunk2('lo'), chunk2('Bye', 'm2')]);

            expect(events.map(event => event.type === 'text' && [event.delta, event.done])).toEqual([['Hel', false], ['lo', false], ['', true], ['Bye', false], ['', true]]);
            expect(mapper.result()).toBe('Bye');
        });

        test('a message sent whole shows what the stream lacks of it, and one it showed already shows nothing again', () => {
            const { events, mapper } = run2([chunk2('Hel'), whole('Hello'), whole('Hello'), whole('Other', 'm2'), whole('Other', 'm2')]);

            expect(events.map(event => event.type === 'text' && [event.delta, event.done])).toEqual([['Hel', false], ['lo', false], ['', true], ['Other', false], ['', true]]);
            expect(mapper.result()).toBe('Other');
        });

        test('a whole message that was closed and comes again, or that rewrites what was shown, adds nothing', () => {
            const { events } = run2([chunk2('Hello'), call({ toolCallId: 'a', title: 'Read file' }), whole('Hello'), chunk2('Hi there', 'm2'), whole('Howdy there', 'm2')]);

            expect(events.filter(event => event.type === 'text').map(event => event.type === 'text' && event.delta)).toEqual(['Hello', '', 'Hi there', '']);
        });

        test('a message with no content, thoughts, plans, user messages and unknown kinds are not shown', () => {
            const { events } = run2([
                { sessionUpdate: 'agent_message', messageId: 'm1' },
                { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: 'hmm' } },
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
            const { events, mapper } = run2([chunk2('Let me look.'), call({ toolCallId: 'a', title: 'Read file', kind: 'read', status: 'in_progress', rawInput: { file_path: 'x' } }), chunk2('Found it.', 'm2')]);

            expect(events.map(event => event.type)).toEqual(['text', 'text', 'tool', 'text', 'text']);
            expect(tools(events)).toEqual([{ type: 'tool', toolCallId: 'a', name: 'Read', input: { file_path: 'x' }, state: 'running' }]);
            expect(mapper.result()).toBe('Found it.');
        });

        test('an update patches the call: what it leaves out is what an earlier one said, and null clears it', () => {
            const { events } = run2([
                call({ toolCallId: 'a', title: 'List files', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' }, rawOutput: 'a.ts\nb.ts' }),
                // Nothing but the status: the input, the name and the output it said before stay.
                call({ toolCallId: 'a', status: 'completed' }),
            ]);

            expect(tools(events)).toEqual([
                { type: 'tool', toolCallId: 'a', name: 'Bash', input: { command: 'ls' }, state: 'running' },
                { type: 'tool', toolCallId: 'a', name: 'Bash', input: { command: 'ls' }, state: 'done', output: 'a.ts\nb.ts' },
            ]);
        });

        test('the name comes from Claude\'s tool name kept from the first update, the runtime\'s own tools keep their bare name', () => {
            const { events } = run2([
                call({ toolCallId: 'a', title: 'Tool: clowdy/task_create', kind: 'other', status: 'in_progress', rawInput: { title: 'x' } }),
                call({ toolCallId: 'b', title: 'git status', kind: 'execute', status: 'in_progress', _meta: { claudeCode: { toolName: 'Bash' } } }),
                call({ toolCallId: 'b', status: 'completed', _meta: { other: 1 } }),
            ]);

            expect(tools(events).map(event => event.type === 'tool' && [event.toolCallId, event.name, event.state])).toEqual([['a', 'task_create', 'running'], ['b', 'Bash', 'running'], ['b', 'Bash', 'done']]);
        });

        test('content chunks add to what the call showed, and a call shows the output of the terminal it displays', () => {
            const { events } = run2([
                call({ toolCallId: 'a', title: 'Run tests', kind: 'execute', status: 'in_progress', content: [{ type: 'terminal', terminalId: 't1' }] }),
                { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: Buffer.from('ok 1\n').toString('base64') },
                { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: Buffer.from('ok 2\n').toString('base64') },
                call({ toolCallId: 'a', status: 'completed' }),
                call({ toolCallId: 'b', title: 'Edit', kind: 'edit', status: 'in_progress' }),
                { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'b', content: { type: 'diff', changes: [{ operation: 'modify', path: '/work/a.ts' }] } },
                { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'b', content: { type: 'content', content: { type: 'text', text: 'done' } } },
                call({ toolCallId: 'b', status: 'completed' }),
            ] as SessionUpdateV2[]);

            expect(tools(events).filter(event => event.type === 'tool' && event.state === 'done').map(event => event.type === 'tool' && event.output)).toEqual(['ok 1\nok 2\n', 'Changed /work/a.ts\ndone']);
        });

        test('a failed call carries its text as the error, a cancelled one reads as stopped, and a paused one is still running', () => {
            const { events } = run2([
                call({ toolCallId: 'a', title: 'Run', status: 'failed', rawOutput: 'exit 1' }),
                call({ toolCallId: 'b', title: 'Run', status: 'cancelled' }),
                call({ toolCallId: 'c', title: 'Run', status: 'paused' }),
            ]);

            expect(tools(events).map(event => event.type === 'tool' && [event.state, event.error])).toEqual([['error', 'exit 1'], ['error', 'Stopped before it finished'], ['running', undefined]]);
        });

        test('a compaction is `compact` however the agent reports it: a call, or a compaction update', () => {
            const { events } = run2([
                call({ toolCallId: 'k', title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: { claudeCode: { toolName: 'compact' } } }),
                call({ toolCallId: 'k', status: 'completed', rawOutput: { trigger: 'manual', preTokens: 100, postTokens: 10, durationMs: 5 } }),
                { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' },
                { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed', summary: [{ type: 'text', text: 'a long summary' }] },
                { sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'failed', error: 'too short' },
            ]);

            expect(tools(events).map(event => event.type === 'tool' && [event.toolCallId, event.name, event.state, event.output ?? event.error])).toEqual([
                ['k', 'compact', 'running', undefined],
                ['k', 'compact', 'done', JSON.stringify({ trigger: 'manual', preTokens: 100, postTokens: 10, durationMs: 5 })],
                ['compaction-c1', 'compact', 'running', undefined],
                ['compaction-c1', 'compact', 'done', undefined],
                ['compaction-c2', 'compact', 'error', 'too short'],
            ]);
        });
    });

    describe('numbers', () => {
        test('tokens come from the idle update and cost is the rise over the session\'s earlier total', () => {
            const { events } = run2([{ sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount: 0.75, currency: 'USD' } }], { costBefore: 0.25 }, { inputTokens: 100, outputTokens: 20, totalTokens: 150, cachedReadTokens: 25, cachedWriteTokens: 5 });

            expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 130, outputTokens: 20, costUsd: 0.5 }]);
        });

        test('nothing is reported when the agent reports nothing, and a session this daemon never measured reports tokens without a cost', () => {
            expect(run2([chunk2('hi')]).events.map(event => event.type)).toEqual(['text', 'text']);
            expect(run2([{ sessionUpdate: 'usage_update', used: 1, size: 10, cost: { amount: 5, currency: 'USD' } }], { costBefore: undefined }, { inputTokens: 3, outputTokens: 4, totalTokens: 7 }).events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 3, outputTokens: 4 }]);
        });

        test('the window\'s fill becomes a context event once per reading, and a rate limit signal a limit event', () => {
            const { events } = run2([
                { sessionUpdate: 'usage_update', used: 21269, size: 1_000_000 },
                { sessionUpdate: 'usage_update', used: 21269, size: 1_000_000 },
                { sessionUpdate: 'usage_update', used: 0, size: 0 },
                { sessionUpdate: 'usage_update', used: 22062, size: 1_000_000, _meta: { '_claude/rateLimit': { status: 'rejected', rateLimitType: 'five_hour', utilization: 0.95, resetsAt: 1_900_000_000 } } },
            ]);

            expect(events).toEqual([
                { type: 'context', used: 21269, size: 1_000_000 },
                { type: 'context', used: 22062, size: 1_000_000 },
                { type: 'limit', status: 'rejected', kind: 'five_hour', utilization: 0.95, resetsAt: 1_900_000_000 },
            ]);
        });
    });
});
