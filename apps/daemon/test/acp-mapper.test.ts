import { describe, expect, test } from 'bun:test';

import { UpdateMapper } from '../src/engine/acp/mapper';

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

describe('numbers', () => {
    const cost = (amount: number): SessionUpdate => ({ sessionUpdate: 'usage_update', used: 1, size: 100, cost: { amount, currency: 'USD' } });

    test('tokens come from the prompt response and cost is the rise over the session\'s earlier total', () => {
        const { events } = run([cost(1.5)], { costBefore: 1 }, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedReadTokens: 6 } });

        expect(events).toEqual([{ type: 'usage', inputTokens: 16, outputTokens: 4, costUsd: 0.5 }]);
    });

    test('a resumed session this daemon never measured reports tokens without a cost', () => {
        const { events } = run([cost(9)], { costBefore: undefined }, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

        expect(events).toEqual([{ type: 'usage', inputTokens: 1, outputTokens: 1 }]);
    });

    test('nothing is reported when the agent reports nothing', () => {
        expect(run([]).events).toEqual([]);
    });

    test('a cost in another currency is ignored', () => {
        const { events } = run([{ sessionUpdate: 'usage_update', used: 1, size: 1, cost: { amount: 5, currency: 'EUR' } }]);

        expect(events).toEqual([]);
    });

    test('rate limits: warnings and rejections are signals, repeats and "allowed" are not', () => {
        const limit = (status: string, resetsAt?: number): SessionUpdate => ({ sessionUpdate: 'usage_update', used: 1, size: 1, _meta: { '_claude/rateLimit': { status, rateLimitType: 'seven_day', utilization: 0.8, resetsAt } } });
        const { events } = run([limit('allowed'), limit('allowed_warning', 100), limit('allowed_warning', 100), limit('rejected', 200)]);

        expect(events).toEqual([
            { type: 'limit', status: 'warning', kind: 'seven_day', utilization: 0.8, resetsAt: 100 },
            { type: 'limit', status: 'rejected', kind: 'seven_day', utilization: 0.8, resetsAt: 200 },
        ]);
    });
});
