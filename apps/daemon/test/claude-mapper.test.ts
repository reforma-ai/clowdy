import { describe, expect, test } from 'bun:test';

import { assistant, delta, init, mapAll, message, newMapper, result, streamEvent, toolResult, types } from './claude-fakes';
import followUp from './fixtures/claude/follow-up.json';
import nativeSubagent from './fixtures/claude/native-subagent.json';
import notLoggedIn from './fixtures/claude/not-logged-in.json';
import textStream from './fixtures/claude/text-stream.json';
import toolCall from './fixtures/claude/tool-call.json';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Totals } from '../src/engine/claude/mapper';
import type { EngineEvent } from '../src/engine/types';

// Recordings of real runs (haiku, Claude Code 2.1.325), reduced to the fields the adapter reads.
const recorded = (fixture: unknown) => fixture as SDKMessage[];

const text = (events: EngineEvent[], agentId?: string) => events.flatMap(event => (event.type === 'text' && event.agentId === agentId ? [event.delta] : [])).join('');

describe('recorded sessions', () => {
    test('a streamed reply is one growing message that ends once, and the complete message does not repeat it', () => {
        const events = mapAll(recorded(textStream));

        expect(types(events)).toEqual(['session', 'text', 'text', 'limit', 'usage', 'done']);
        expect(events[0]).toEqual({ type: 'session', sessionId: '445c5240-4393-43ad-a3e4-2a4da258a6d8' });
        expect(events[1]).toEqual({ type: 'text', delta: 'PONG', done: false });
        expect(events[2]).toEqual({ type: 'text', delta: '', done: true });
        expect(events[5]).toEqual({ type: 'done', result: 'PONG' });
    });

    test('a fresh session reports what it used: the prompt including cached parts, the output, and the cost', () => {
        const usage = mapAll(recorded(textStream)).find(event => event.type === 'usage');

        expect(usage).toEqual({ type: 'usage', inputTokens: 2 + 16768, outputTokens: 5, costUsd: 0.0033563000000000004 });
    });

    test('the subscription quota warning passes through exactly as received', () => {
        expect(mapAll(recorded(textStream)).find(event => event.type === 'limit')).toEqual({ type: 'limit', status: 'warning', kind: 'seven_day', utilization: 0.81, resetsAt: 1794927600 });
    });

    test('a call to the runtime\'s tool is one tool item that runs and then finishes, under the runtime\'s own name', () => {
        const tools = mapAll(recorded(toolCall)).filter(event => event.type === 'tool');

        expect(tools).toHaveLength(2);
        expect(tools[0]).toMatchObject({ name: 'echo', input: { text: 'hello-bridge' }, state: 'running' });
        expect(tools[1]).toMatchObject({ toolCallId: tools[0].type === 'tool' ? tools[0].toolCallId : '', name: 'echo', input: { text: 'hello-bridge' }, state: 'done', output: '{"echoed":"hello-bridge"}' });
    });

    test('a message sent mid-turn is folded in: one reply, one done', () => {
        const events = mapAll(recorded(followUp));

        expect(events.filter(event => event.type === 'done')).toHaveLength(1);
        expect(text(events)).toBe('The slow_note tool returned: "the sky is blue"\n\nBANANA');
    });

    test('not being logged in is one precise error, and the CLI\'s own notice is not shown as a chat message', () => {
        const events = mapAll(recorded(notLoggedIn));

        expect(text(events)).toBe('');
        expect(events.at(-1)).toEqual({
            type: 'error',
            code: 'not_logged_in',
            retryable: false,
            message: 'Claude is not signed in. Run `claude auth login` in a terminal, then start again.',
        });
    });

    test('a background sub-agent is a child that runs, speaks with its own id, and ends; the session is done only after the parent has reported it', () => {
        const events = mapAll(recorded(nativeSubagent));
        const agentId = 'a905c885837c16da5';
        const states = events.flatMap(event => (event.type === 'subagent' ? [event.state] : []));

        expect(events.find(event => event.type === 'subagent')).toEqual({
            type: 'subagent',
            agentId,
            parentToolCallId: 'toolu_01ESZcfB6ZZMYmpFG3rYJ9fQ',
            name: 'general-purpose',
            description: 'Reply with PONG',
            state: 'running',
        });
        expect(states).toEqual(['running', 'done', 'done']);
        expect(events.find(event => event.type === 'subagent' && event.summary)).toMatchObject({ state: 'done', summary: 'PONG' });
        expect(text(events, agentId)).toBe('PONG');
        // The first result came while the sub-agent still worked: usage, but no done. The report after its end is the second.
        expect(events.filter(event => event.type === 'done')).toEqual([{ type: 'done', result: 'The agent replied: **PONG**' }]);
        expect(events.filter(event => event.type === 'usage')).toHaveLength(2);
        expect(text(events)).toContain('The agent replied: **PONG**');
    });

    test('usage of the turns adds up to the session total because each event is a share', () => {
        const events = mapAll(recorded(nativeSubagent));
        const usages = events.flatMap(event => (event.type === 'usage' ? [event] : []));
        const total = usages.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
        const last = recorded(nativeSubagent).filter(item => item.type === 'result').at(-1);

        expect(total).toBeCloseTo((last as unknown as { total_cost_usd: number }).total_cost_usd, 8);
    });
});

describe('text', () => {
    test('a message that never streamed arrives whole, closed in the same event', () => {
        const events = mapAll([init(), assistant('m1', [{ type: 'text', text: 'Hello there' }])]);

        expect(events.slice(1)).toEqual([{ type: 'text', delta: 'Hello there', done: true }]);
    });

    test('blank text blocks are dropped', () => {
        expect(mapAll([assistant('m1', [{ type: 'text', text: '\n\n' }])])).toEqual([]);
    });

    test('hidden reasoning never leaves the adapter, in complete messages or in the stream', () => {
        const events = mapAll([
            streamEvent({ type: 'message_start', message: { id: 'm1' } }),
            streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
            streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret plan' } }),
            streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
            streamEvent({ type: 'content_block_stop', index: 0 }),
            assistant('m1', [{ type: 'thinking', thinking: 'secret plan', signature: 'sig' }, { type: 'redacted_thinking', data: 'x' }]),
        ]);

        expect(events).toEqual([]);
        expect(JSON.stringify(events)).not.toContain('secret');
    });

    test('two text blocks of one message are two messages', () => {
        const events = mapAll([
            streamEvent({ type: 'message_start', message: { id: 'm1' } }),
            streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
            delta('one', 0),
            streamEvent({ type: 'content_block_stop', index: 0 }),
            streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
            delta('two', 1),
            streamEvent({ type: 'content_block_stop', index: 1 }),
        ]);

        expect(events).toEqual([
            { type: 'text', delta: 'one', done: false },
            { type: 'text', delta: '', done: true },
            { type: 'text', delta: 'two', done: false },
            { type: 'text', delta: '', done: true },
        ]);
    });

    test('tool input deltas are not text', () => {
        const events = mapAll([
            streamEvent({ type: 'message_start', message: { id: 'm1' } }),
            streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } }),
            streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"com' } }),
            streamEvent({ type: 'content_block_stop', index: 0 }),
        ]);

        expect(events).toEqual([]);
    });

    test('a session id is announced once, however many turns repeat the init message', () => {
        expect(types(mapAll([init('s1'), init('s1'), init('s2')]))).toEqual(['session', 'session']);
    });
});

describe('tools', () => {
    test('a result finishes the call it answers, keyed by the tool call id, with the call\'s name and input', () => {
        const events = mapAll([
            assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
            toolResult('t1', [{ type: 'text', text: 'a.txt\nb.txt' }]),
        ]);

        expect(events).toEqual([
            { type: 'tool', toolCallId: 't1', name: 'Bash', input: { command: 'ls' }, state: 'running' },
            { type: 'tool', toolCallId: 't1', name: 'Bash', input: { command: 'ls' }, state: 'done', output: 'a.txt\nb.txt' },
        ]);
    });

    test('a failing tool is an error item with the message', () => {
        const events = mapAll([
            assistant('m1', [{ type: 'tool_use', id: 't1', name: 'mcp__clowdy__create_task', input: {} }]),
            toolResult('t1', 'Invalid input for create_task', { is_error: true }),
        ]);

        expect(events[1]).toEqual({ type: 'tool', toolCallId: 't1', name: 'create_task', input: {}, state: 'error', error: 'Invalid input for create_task' });
    });

    test('tools of other MCP servers keep their full name', () => {
        const events = mapAll([assistant('m1', [{ type: 'tool_use', id: 't1', name: 'mcp__github__list_issues', input: {} }])]);

        expect(events[0]).toMatchObject({ name: 'mcp__github__list_issues' });
    });

    test('images and other non-text results are named, not dumped', () => {
        const events = mapAll([
            assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
            toolResult('t1', [{ type: 'text', text: 'see:' }, { type: 'image', source: { data: 'AAAA' } }]),
        ]);

        expect(events[1]).toMatchObject({ output: 'see:\n[image]' });
    });

    test('a huge output is cut before it reaches the event log', () => {
        const events = mapAll([
            assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
            toolResult('t1', 'x'.repeat(50_000)),
        ]);
        const output = (events[1] as { output: string }).output;

        expect(output.length).toBeLessThan(20_100);
        expect(output).toEndWith('... (30000 more characters)');
    });

    test('a result for a call nobody announced is ignored', () => {
        expect(mapAll([toolResult('unknown', 'x')])).toEqual([]);
    });
});

describe('sub-agents', () => {
    const started = (taskId: string, extra: Record<string, unknown> = {}) => message({
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: `call-${ taskId }`,
        description: `Work of ${ taskId }`,
        subagent_type: 'Explore',
        task_type: 'local_agent',
        ...extra,
    });

    test('what a sub-agent says and does carries its id, also when only the tool call id is known', () => {
        const events = mapAll([
            started('a1'),
            assistant('s1', [{ type: 'tool_use', id: 'u1', name: 'Grep', input: { pattern: 'x' } }], { parent_tool_use_id: 'call-a1', agent_id: 'a1' }),
            toolResult('u1', 'match'),
            streamEvent({ type: 'message_start', message: { id: 's2' } }, 'call-a1'),
            streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'call-a1'),
            delta('found it', 0, 'call-a1'),
            streamEvent({ type: 'content_block_stop', index: 0 }, 'call-a1'),
            assistant('s2', [{ type: 'text', text: 'found it' }], { parent_tool_use_id: 'call-a1', agent_id: 'a1' }),
        ]);

        expect(events.slice(1)).toEqual([
            { type: 'tool', toolCallId: 'u1', name: 'Grep', input: { pattern: 'x' }, state: 'running', agentId: 'a1' },
            { type: 'tool', toolCallId: 'u1', name: 'Grep', input: { pattern: 'x' }, state: 'done', output: 'match', agentId: 'a1' },
            { type: 'text', delta: 'found it', done: false, agentId: 'a1' },
            { type: 'text', delta: '', done: true, agentId: 'a1' },
        ]);
    });

    test('the main agent\'s text keeps no agent id while a sub-agent runs', () => {
        const events = mapAll([started('a1'), assistant('m1', [{ type: 'text', text: 'main speaking' }])]);

        expect(events[1]).toEqual({ type: 'text', delta: 'main speaking', done: true });
    });

    test('progress summaries, and the way a sub-agent ends, update the same child', () => {
        const events = mapAll([
            started('a1'),
            message({ type: 'system', subtype: 'task_progress', task_id: 'a1', summary: 'Reading the router' }),
            message({ type: 'system', subtype: 'task_progress', task_id: 'a1', summary: 'Reading the router' }),
            message({ type: 'system', subtype: 'task_progress', task_id: 'a1', description: 'no summary here' }),
            message({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'failed', error: 'boom' } }),
            message({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'failed', summary: 'Could not read the router' }),
        ]);

        expect(events.map(event => event.type === 'subagent' ? [event.state, event.summary] : event.type)).toEqual([
            ['running', undefined],
            ['running', 'Reading the router'],
            ['error', 'boom'],
            ['error', 'Could not read the router'],
        ]);
    });

    test('stopping a sub-agent ends it as cancelled', () => {
        const events = mapAll([started('a1'), message({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'killed' } })]);

        expect(events.at(-1)).toMatchObject({ type: 'subagent', agentId: 'a1', state: 'cancelled' });
    });

    test('shells, monitors and housekeeping tasks are not children', () => {
        const events = mapAll([
            started('b1', { task_type: 'local_bash' }),
            started('m1', { task_type: 'monitor' }),
            started('h1', { ambient: true }),
            started('h2', { skip_transcript: true }),
            message({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'done' }),
        ]);

        expect(events).toEqual([]);
    });

    test('a workflow is a child named after its script', () => {
        const events = mapAll([started('w1', { task_type: 'local_workflow', workflow_name: 'spec', subagent_type: undefined })]);

        expect(events[0]).toMatchObject({ type: 'subagent', name: 'spec', state: 'running' });
    });

    test('messages of a sub-agent nobody announced are dropped instead of being passed off as the main agent\'s', () => {
        const events = mapAll([assistant('s1', [{ type: 'text', text: 'who am I' }], { parent_tool_use_id: 'call-unknown' }), delta('who', 0, 'call-unknown')]);

        expect(events).toEqual([]);
    });

    test('children still running when the turn fails are closed as cancelled, before the error', () => {
        const events = mapAll([started('a1'), result({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] })]);

        expect(types(events)).toEqual(['subagent', 'subagent', 'usage', 'error']);
        expect(events[1]).toMatchObject({ type: 'subagent', agentId: 'a1', state: 'cancelled' });
    });
});

describe('quota signals', () => {
    const limit = (info: Record<string, unknown>) => message({ type: 'rate_limit_event', rate_limit_info: info });

    test('allowed is silent', () => {
        expect(mapAll([limit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 })])).toEqual([]);
    });

    test('a warning and a rejection carry utilization and the reset exactly as received', () => {
        const events = mapAll([
            limit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.93, resetsAt: 1794927600 }),
            limit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 12345.5 }),
        ]);

        expect(events).toEqual([
            { type: 'limit', status: 'warning', kind: 'five_hour', utilization: 0.93, resetsAt: 1794927600 },
            { type: 'limit', status: 'rejected', kind: 'seven_day', resetsAt: 12345.5 },
        ]);
    });

    test('the raw event goes to the debug log', () => {
        const lines: string[] = [];
        const mapper = newMapper({ log: line => lines.push(line) });

        mapper.map(limit({ status: 'allowed', resetsAt: 7 }));

        expect(lines).toEqual(['rate_limit_event {"status":"allowed","resetsAt":7}']);
    });
});

describe('how a turn ends', () => {
    test('success is usage and done with the final report', () => {
        expect(mapAll([result({ result: 'All finished' })]).map(event => event.type === 'done' ? event.result : event.type)).toEqual(['usage', 'All finished']);
    });

    test('an API failure reported as a successful result is an error, classified', () => {
        const events = mapAll([
            assistant('m1', [{ type: 'text', text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }], { error: 'overloaded' }),
            result({ is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }),
        ]);

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'overloaded', retryable: true });
        expect(text(events)).toBe('');
    });

    test('a usage limit names when it resets and can be retried later', () => {
        const events = mapAll([
            assistant('m1', [{ type: 'text', text: 'You\'ve hit your limit · resets 3pm (Europe/Berlin)' }], { error: 'rate_limit' }),
            result({ is_error: true, result: 'You\'ve hit your limit · resets 3pm (Europe/Berlin)' }),
        ]);

        expect(events.at(-1)).toEqual({ type: 'error', code: 'usage_limit', retryable: true, message: 'Claude usage limit reached; it resets 3pm (Europe/Berlin).' });
    });

    test('a failed execution is an error carrying what the CLI listed', () => {
        const events = mapAll([result({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: abc'] })]);

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'session_not_found', retryable: false });
    });

    test('a failure with nothing to read still says that it stopped, and why', () => {
        const events = mapAll([result({ subtype: 'error_max_turns', is_error: true, errors: [] })]);

        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'unknown', message: 'Claude stopped without an answer (error_max_turns).' });
    });

    test('an execution error after the run was cancelled is a cancellation, not an error', () => {
        const mapper = newMapper();

        mapper.interrupted = true;

        const events = mapAll([result({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted'] })], mapper);

        expect(events.filter(event => event.type === 'error' || event.type === 'done')).toEqual([]);
    });

    test('the same execution error without a cancellation is an error', () => {
        expect(mapAll([result({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted'] })]).at(-1)?.type).toBe('error');
    });

    test('a queued message gets its own turn: this one reports usage and the session goes on', () => {
        expect(types(mapAll([result({ queued_turn_count: 1 })]))).toEqual(['usage']);
    });
});

describe('usage', () => {
    const turn = (cost: number, input: number, output: number) => result({}, { cost, model: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
    const usages = (events: EngineEvent[]) => events.flatMap(event => (event.type === 'usage' ? [[event.inputTokens, event.outputTokens, event.costUsd]] : []));

    test('each result reports its share of the cumulative totals', () => {
        const events = mapAll([init(), turn(0.01, 100, 10), turn(0.025, 250, 30)]);

        expect(usages(events)).toEqual([[100, 10, 0.01], [150, 20, expect.closeTo(0.015, 8)]]);
    });

    test('a session resumed in the same daemon continues from the totals measured before', () => {
        const totals = new Map<string, Totals>([['session-1', { inputTokens: 1000, outputTokens: 100, costUsd: 0.2 }]]);
        const events = mapAll([init('session-1'), turn(0.23, 1300, 120)], newMapper({ resumed: true, totals }));

        expect(usages(events)).toEqual([[300, 20, expect.closeTo(0.03, 8)]]);
        expect(totals.get('session-1')).toEqual({ inputTokens: 1300, outputTokens: 120, costUsd: 0.23 });
    });

    test('a resumed session this daemon never measured reports the turn\'s own tokens and no cost, because its totals include earlier runs', () => {
        const events = mapAll([init('session-9'), turn(5, 90_000, 4_000)], newMapper({ resumed: true }));

        // `result.usage` is the turn's own main-loop usage: 10 + 20 + 100 input, 5 output.
        expect(events.find(event => event.type === 'usage')).toEqual({ type: 'usage', inputTokens: 130, outputTokens: 5 });
    });

    test('totals that went down (a cleared conversation) never become negative usage', () => {
        const totals = new Map<string, Totals>([['session-1', { inputTokens: 1000, outputTokens: 100, costUsd: 0.2 }]]);
        const events = mapAll([init('session-1'), turn(0.01, 50, 5)], newMapper({ resumed: true, totals }));

        expect(usages(events)).toEqual([[0, 0, 0]]);
    });
});

describe('ignored messages', () => {
    test('status, retries, progress and the rest produce nothing', () => {
        const events = mapAll([
            message({ type: 'system', subtype: 'status', status: 'requesting' }),
            message({ type: 'system', subtype: 'api_retry', attempt: 1, error: 'overloaded' }),
            message({ type: 'system', subtype: 'compact_boundary' }),
            message({ type: 'tool_progress', tool_use_id: 't1' }),
            message({ type: 'auth_status', isAuthenticating: false, output: [] }),
            message({ type: 'prompt_suggestion' }),
        ]);

        expect(events).toEqual([]);
    });
});
