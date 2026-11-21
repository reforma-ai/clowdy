import { describe, expect, it } from 'vitest';

import { activityOf, agentStatusLine, childOfCall, isSubagentTool, latestActivity, subagentLabel, subagentName, subagentTitle, toolActivity } from './subagents';

import type { Run, StreamItem, StreamItemBody } from '@clowdy/protocol';

const run = (id: string, rest: Partial<Run> = {}): Run => ({ id, projectId: 'p', rootRunId: 'orch', role: 'executor', name: id, summary: '', status: 'running', engine: 'claude', createdAt: 1, ...rest });
const item = (seq: number, body: StreamItemBody): StreamItem => ({ id: `i-${ seq }`, runId: 'r', seq, at: seq, body });

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

    it('works with a verb and is done with `Ran <Label> agent`', () => {
        expect(subagentTitle('Explore', true)).toBe('Exploring');
        expect(subagentTitle('Plan', true)).toBe('Planning');
        expect(subagentTitle('Reviewer', true)).toBe('Running Reviewer');
        expect(subagentTitle(undefined, true)).toBe('Running agent');
        expect(subagentTitle('Explore', false)).toBe('Ran Explore agent');
        expect(subagentTitle(undefined, false)).toBe('Ran agent');
    });

    it('says what it does while it works, then Finished, and nothing for a failed or unfinished call', () => {
        expect(agentStatusLine({ live: true, failed: false })).toBe('Starting…');
        expect(agentStatusLine({ live: true, failed: false, activity: 'Reading a.ts' })).toBe('Reading a.ts');
        expect(agentStatusLine({ live: false, failed: false })).toBe('Finished');
        expect(agentStatusLine({ live: false, failed: true })).toBeUndefined();
        expect(agentStatusLine({ live: false, failed: false, stalled: true })).toBeUndefined();
    });
});

describe('a working agent\'s activity', () => {
    it('reads a tool call the way the stream names it, with the file\'s name rather than its path', () => {
        expect(toolActivity('Read', { file_path: 'apps/desktop/src/renderer/stream/StreamView.tsx' })).toBe('Reading StreamView.tsx');
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
        expect(activityOf({ kind: 'reasoning', text: 'Hm.', done: false })).toBe('Thinking…');
        expect(activityOf({ kind: 'reasoning', text: 'Hm.', done: true })).toBe('Thinking…');
        expect(activityOf({ kind: 'question', questionId: 'q', text: 'Which?', options: [] })).toBe('Waiting for you');
        expect(activityOf({ kind: 'question', questionId: 'q', text: 'Which?', options: [], answer: 'a' })).toBeUndefined();
        expect(activityOf(undefined)).toBeUndefined();
    });

    it('comes from the latest thing the agent did, past the notes about it, and from nothing before its first step', () => {
        expect(latestActivity([item(1, { kind: 'user', text: 'Go' }), item(2, { kind: 'tool', toolCallId: 't', name: 'Read', input: { path: 'a.ts' }, state: 'running' }), item(3, { kind: 'note', text: 'Noted' })])).toBe('Reading a.ts');
        // A thought after a call is what the agent does now.
        expect(latestActivity([item(1, { kind: 'tool', toolCallId: 't', name: 'Read', input: { path: 'a.ts' }, state: 'done' }), item(2, { kind: 'reasoning', text: 'Hm.', done: false })])).toBe('Thinking…');
        expect(latestActivity([item(1, { kind: 'user', text: 'Go' })])).toBeUndefined();
        expect(latestActivity([])).toBeUndefined();
    });
});

describe('the sub-agent a call started', () => {
    it('finds the native child of a call by its parent tool call id', () => {
        const runs = [run('a', { parentToolCallId: 'call-1', createdAt: 1 }), run('b', { parentToolCallId: 'call-2' }), run('c', { parentToolCallId: 'call-1', createdAt: 5 })];

        expect(childOfCall(runs, 'call-2')?.id).toBe('b');
        // Two runs never share a call in practice; should they, the newest is the one that is going.
        expect(childOfCall(runs, 'call-1')?.id).toBe('c');
        expect(childOfCall(runs, 'call-3')).toBeUndefined();
    });
});
