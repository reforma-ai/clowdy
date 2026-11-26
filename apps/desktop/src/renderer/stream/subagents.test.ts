import { STOPPED_TOOL } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import {
    activityOf,
    agentActivityLine,
    agentOutcome,
    agentReport,
    beginsWithPrompt,
    callPrompt,
    childOfCall,
    isSubagentTool,
    latestActivity,
    promptItemOf,
    subagentLabel,
    subagentName,
    subagentTitle,
    toolActivity,
} from './subagents';

import type { Run, StreamItem, StreamItemBody } from '@clowdy/protocol';

const run = (id: string, rest: Partial<Run> = {}): Run => ({
    id,
    projectId: 'p',
    rootRunId: 'orch',
    role: 'executor',
    name: id,
    summary: '',
    status: 'running',
    engine: 'claude',
    createdAt: 1,
    ...rest,
});
const item = (seq: number, body: StreamItemBody): StreamItem => ({ id: `i-${seq}`, runId: 'r', seq, at: seq, body });

describe('what a sub-agent call is called', () => {
    it('knows the sub-agent tools of the agents, and nothing else', () => {
        expect(['Agent', 'Task', 'spawnAgent', 'spawn_subagent'].every(isSubagentTool)).toBe(true);
        expect(['agent', 'Read'].some(isSubagentTool)).toBe(false);
    });

    it('labels the type the call asks for, capitalized, and a known id the way people say it', () => {
        expect(subagentLabel(subagentName({ subagent_type: 'Explore', description: 'Map it' }))).toBe('Explore');
        expect(subagentLabel(subagentName({ subagent_type: 'statusline-setup' }))).toBe('Statusline-setup');
        expect(subagentLabel(subagentName({ subagent_type: 'general-purpose' }))).toBe('General');
        expect(subagentLabel(subagentName({ agent_type: 'reviewer' }))).toBe('Reviewer');
        expect(subagentLabel(subagentName({ prompt: 'Do it' }))).toBeUndefined();
    });

    it('works with a verb and is done with its type as a name', () => {
        expect(subagentTitle('Explore', true)).toBe('Exploring');
        expect(subagentTitle('Plan', true)).toBe('Planning');
        expect(subagentTitle('Reviewer', true)).toBe('Running Reviewer agent');
        expect(subagentTitle('General', true)).toBe('Running General agent');
        expect(subagentTitle('Sub-agent', true)).toBe('Running Sub-agent');
        expect(subagentTitle('Sub-agent', false)).toBe('Sub-agent');
        expect(subagentTitle(undefined, true)).toBe('Running agent');
        expect(subagentTitle('Explore', false)).toBe('Explore agent');
        expect(subagentTitle(undefined, false)).toBe('Agent');
    });

    it('says what it does while it works, and that it is starting before its first step', () => {
        expect(agentActivityLine()).toBe('Starting…');
        expect(agentActivityLine('Reading a.ts')).toBe('Reading a.ts');
    });
});

describe('how a sub-agent ended', () => {
    const call = (state: 'running' | 'done' | 'error', error?: string) => ({ state, ...(error && { error }) });

    it('says it with the words of a thread that stopped', () => {
        expect(agentOutcome(call('running'), undefined, false)).toBeUndefined();
        expect(agentOutcome(call('done'), undefined, false)).toBe('finished');
        expect(agentOutcome(call('error', 'Typecheck failed'), undefined, false)).toBe('failed');
    });

    it('is interrupted when the call never ended, or the person stopped it, whatever the call says', () => {
        expect(agentOutcome(call('running'), undefined, true)).toBe('interrupted');
        expect(agentOutcome(call('error', STOPPED_TOOL), undefined, false)).toBe('interrupted');
        expect(
            agentOutcome(call('error', 'The sub-agent was cancelled'), run('c', { status: 'cancelled' }), false)
        ).toBe('interrupted');
        expect(agentOutcome(call('error', 'Failed'), run('c', { status: 'failed' }), false)).toBe('failed');
    });

    it('reports the last words of one that finished and why one that failed did, and nothing more for one that was interrupted', () => {
        expect(agentReport('finished', call('done'), run('c', { result: ' Found it. ' }))).toBe('Found it.');
        expect(agentReport('finished', call('done'), undefined)).toBeUndefined();
        expect(agentReport('failed', call('error', 'Call error'), run('c', { error: 'Run error' }))).toBe('Run error');
        expect(agentReport('failed', call('error', 'Call error'), undefined)).toBe('Call error');
        expect(agentReport('failed', call('error'), run('c', {}))).toBeUndefined();
        expect(agentReport('interrupted', call('error', STOPPED_TOOL), run('c', { result: 'Half' }))).toBeUndefined();
        expect(agentReport(undefined, call('running'), run('c', { result: 'Half' }))).toBeUndefined();
    });
});

describe('the first message of a sub-agent page', () => {
    const chat = { id: 'c-1', title: 'Simplify booking' };
    const child = run('r-child', { parentToolCallId: 'call-1', startedAt: 7 });
    const call = (input: unknown, id = 'call-1'): StreamItem =>
        item(2, { kind: 'tool', toolCallId: id, name: 'Agent', input, state: 'running' });

    it("reads the prompt of a call as Claude's and the v2 card's `prompt`, or the `message` of Codex's", () => {
        expect(
            callPrompt({
                subagent_type: 'Explore',
                description: 'Map it',
                prompt: ' Find the steps.\nThen list them. ',
            })
        ).toBe('Find the steps.\nThen list them.');
        expect(callPrompt({ message: 'Look around' })).toBe('Look around');
        expect(callPrompt({ description: 'Only a name' })).toBeUndefined();
        expect(callPrompt({ prompt: '  ' })).toBeUndefined();
        expect(callPrompt('prompt')).toBeUndefined();
        expect(callPrompt(undefined)).toBeUndefined();
    });

    it('knows a stream that begins with what its parent asked, which is the first message of a thread', () => {
        const thread = item(1, { kind: 'user', text: 'Do it', from: { kind: 'thread', chatId: 'c', title: 'T' } });

        expect(beginsWithPrompt([thread, item(2, { kind: 'assistant', done: true, text: 'Done' })])).toBe(true);
        expect(beginsWithPrompt([item(1, { kind: 'user', text: 'Do it' })])).toBe(false);
        expect(beginsWithPrompt([item(1, { kind: 'assistant', done: true, text: 'Done' }), thread])).toBe(false);
        expect(beginsWithPrompt([])).toBe(false);
    });

    it('is made from the prompt of the call that started the sub-agent, as the message of the chat that runs it', () => {
        expect(promptItemOf(child, [call({ prompt: 'Find the callers.' })], chat)).toEqual({
            id: 'r-child-prompt',
            runId: 'r-child',
            seq: 0,
            at: 7,
            body: {
                kind: 'user',
                text: 'Find the callers.',
                from: { kind: 'thread', chatId: 'c-1', title: 'Simplify booking' },
            },
        });
    });

    it('is nothing when the call, its prompt or the chat is not there', () => {
        expect(promptItemOf(child, [call({ prompt: 'Find them' }, 'call-9')], chat)).toBeUndefined();
        expect(promptItemOf(child, [call({ description: 'No prompt' })], chat)).toBeUndefined();
        expect(promptItemOf(child, [], chat)).toBeUndefined();
        expect(promptItemOf(child, [call({ prompt: 'Find them' })], undefined)).toBeUndefined();
        expect(
            promptItemOf({ ...child, parentToolCallId: undefined }, [call({ prompt: 'Find them' })], chat)
        ).toBeUndefined();
        // An item that only has the same id as a call is not one.
        expect(promptItemOf(child, [item(1, { kind: 'note', text: 'call-1' })], chat)).toBeUndefined();
    });
});

describe("a working agent's activity", () => {
    it("reads a tool call the way the stream names it, with the file's name rather than its path", () => {
        expect(toolActivity('Read', { file_path: 'apps/desktop/src/renderer/stream/StreamView.tsx' })).toBe(
            'Reading StreamView.tsx'
        );
        expect(toolActivity('Edit', { file_path: 'src/a.ts' })).toBe('Editing a.ts');
        expect(toolActivity('Write', {})).toBe('Writing file');
        expect(toolActivity('Grep', { pattern: 'useBookingPrice' })).toBe('Searching useBookingPrice');
        expect(toolActivity('Glob', { pattern: 'src/**/mail*' })).toBe('Finding src/**/mail*');
        expect(toolActivity('Bash', { command: 'bun run typecheck' })).toBe('Running bun run typecheck');
        expect(toolActivity('Bash', {})).toBe('Running a command');
        expect(toolActivity('task_get', { taskId: 'CAR-1' })).toBe('Using Task get');
        expect(toolActivity('compact', { title: 'Compact conversation' })).toBe('Compacting context');
    });

    it('says the agent writes or thinks without printing its words, and waits on an open question', () => {
        expect(activityOf({ kind: 'assistant', text: 'Half a', done: false })).toBe('Finishing reply');
        expect(activityOf({ kind: 'assistant', text: 'Done thinking.', done: true })).toBe('Thinking…');
        // What it thinks is for its own stream, not the card's line.
        expect(activityOf({ kind: 'reasoning', text: 'Hm.', done: false })).toBeUndefined();
        expect(activityOf({ kind: 'question', questionId: 'q', text: 'Which?', options: [] })).toBe('Waiting for you');
        expect(
            activityOf({ kind: 'question', questionId: 'q', text: 'Which?', options: [], answer: 'a' })
        ).toBeUndefined();
        expect(activityOf(undefined)).toBeUndefined();
    });

    it('comes from the latest thing the agent did, past the notes about it, and from nothing before its first step', () => {
        expect(
            latestActivity([
                item(1, { kind: 'user', text: 'Go' }),
                item(2, { kind: 'tool', toolCallId: 't', name: 'Read', input: { path: 'a.ts' }, state: 'running' }),
                item(3, { kind: 'note', text: 'Noted' }),
            ])
        ).toBe('Reading a.ts');
        // A thought after a call changes nothing: the card says the call, not the musing.
        expect(
            latestActivity([
                item(1, { kind: 'tool', toolCallId: 't', name: 'Read', input: { path: 'a.ts' }, state: 'running' }),
                item(2, { kind: 'reasoning', text: 'Hm.', done: false }),
            ])
        ).toBe('Reading a.ts');
        expect(latestActivity([item(1, { kind: 'user', text: 'Go' })])).toBeUndefined();
        expect(latestActivity([])).toBeUndefined();
    });
});

describe('the sub-agent a call started', () => {
    it('finds the native child of a call by its parent tool call id', () => {
        const runs = [
            run('a', { parentToolCallId: 'call-1', createdAt: 1 }),
            run('b', { parentToolCallId: 'call-2' }),
            run('c', { parentToolCallId: 'call-1', createdAt: 5 }),
        ];

        expect(childOfCall(runs, 'call-2')?.id).toBe('b');
        // Two runs never share a call in practice; should they, the newest is the one that is going.
        expect(childOfCall(runs, 'call-1')?.id).toBe('c');
        expect(childOfCall(runs, 'call-3')).toBeUndefined();
    });
});
