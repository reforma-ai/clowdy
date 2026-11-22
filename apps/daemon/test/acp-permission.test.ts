import { describe, expect, test } from 'bun:test';

import { classify, optionFor, paramsOfV2 } from '../src/engine/acp/permission';

import type { PermissionOption } from '../src/engine/acp/permission';

const OPTIONS: PermissionOption[] = [
    { optionId: 'reject', kind: 'reject_once' },
    { optionId: 'always', kind: 'allow_always' },
    { optionId: 'once', kind: 'allow_once' },
];

describe('classify', () => {
    test('a command is its text, from a string or a list of words, with the folder it runs in', () => {
        expect(classify({ toolCall: { toolCallId: 'c1', title: 'Run ls', kind: 'execute', rawInput: { command: 'ls -la', cwd: '/work' } }, options: OPTIONS })).toEqual({
            toolCallId: 'c1',
            title: 'Run ls',
            subject: { kind: 'command', command: 'ls -la', cwd: '/work' },
            decisions: ['allow_once', 'allow_always', 'reject'],
            key: 'command:ls -la',
        });
        expect(classify({ toolCall: { title: 'Run', kind: 'execute', rawInput: { command: ['git', 'status', '--short'] } }, options: OPTIONS }).subject).toEqual({ kind: 'command', command: 'git status --short' });
        expect(classify({ toolCall: { title: 'Run', kind: 'execute', rawInput: { cmd: 'pwd' } }, options: OPTIONS }).subject).toEqual({ kind: 'command', command: 'pwd' });
    });

    test('a command that says nothing of its text is shown by the title the agent gave it', () => {
        expect(classify({ toolCall: { title: 'bun test', kind: 'execute' }, options: OPTIONS }).subject).toEqual({ kind: 'command', command: 'bun test' });
    });

    test('a change to files is its paths, from the locations, the diffs and the input, each once', () => {
        const request = classify({
            toolCall: {
                title: 'Edit',
                kind: 'edit',
                locations: [{ path: '/work/a.ts' }, { path: '/work/b.ts' }],
                content: [{ type: 'diff', path: '/work/b.ts', oldText: 'x', newText: 'y' }, { type: 'diff', path: '/work/c.ts', newText: 'z' }, { type: 'content', content: { type: 'text', text: 'hi' } }],
                rawInput: { file_path: '/work/a.ts' },
            },
            options: OPTIONS,
        });

        expect(request.subject).toEqual({ kind: 'file_change', paths: ['/work/a.ts', '/work/b.ts', '/work/c.ts'] });
        expect(request.key).toBe('file:/work/a.ts\n/work/b.ts\n/work/c.ts');
        expect(classify({ toolCall: { title: 'Move', kind: 'move', locations: [{ path: '/b' }, { path: '/a' }] }, options: OPTIONS }).key).toBe('file:/a\n/b');
    });

    test('a change that names no path is a tool like any other', () => {
        expect(classify({ toolCall: { title: 'Write', kind: 'edit' }, options: OPTIONS }).subject).toEqual({ kind: 'tool_use', tool: 'Write' });
    });

    test('any other call is a tool: the name the agent gives (its own field, or Claude\'s adapter), else the title, with a short input as detail', () => {
        expect(classify({ toolCall: { title: 'Fetch https://example.com', kind: 'fetch', name: 'WebFetch', rawInput: { url: 'https://example.com' } }, options: OPTIONS })).toMatchObject({
            title: 'Fetch https://example.com',
            subject: { kind: 'tool_use', tool: 'WebFetch', detail: '{"url":"https://example.com"}' },
            key: 'tool:WebFetch:Fetch https://example.com',
        });
        expect(classify({ toolCall: { title: 'Ask', _meta: { claudeCode: { toolName: 'mcp__docs__read' } } }, options: OPTIONS }).subject).toEqual({ kind: 'tool_use', tool: 'mcp__docs__read' });
        expect(classify({ toolCall: { title: 'Do it', rawInput: {} }, options: OPTIONS }).subject).toEqual({ kind: 'tool_use', tool: 'Do it' });
    });

    test('a long input is not carried as detail', () => {
        const { subject } = classify({ toolCall: { title: 'Big', kind: 'other', rawInput: { text: 'x'.repeat(400) } }, options: OPTIONS });

        expect(subject).toEqual({ kind: 'tool_use', tool: 'Big' });
    });

    test('the decisions are the kinds the agent\'s options have, a refusal of either kind being one', () => {
        const only = (...kinds: string[]) => classify({ toolCall: { title: 'T' }, options: kinds.map((kind, index) => ({ optionId: `o${ index }`, kind })) }).decisions;

        expect(only('allow_once', 'reject_once')).toEqual(['allow_once', 'reject']);
        expect(only('reject_always', 'allow_always')).toEqual(['allow_always', 'reject']);
        expect(only('allow_once', 'allow_always', 'reject_once', 'reject_always')).toEqual(['allow_once', 'allow_always', 'reject']);
        expect(only('allow_once')).toEqual(['allow_once']);
    });

    test('a request with no title is titled by what it asks', () => {
        expect(classify({ toolCall: { kind: 'execute', rawInput: { command: 'make' } }, options: OPTIONS }).title).toBe('make');
        expect(classify({ toolCall: {}, options: OPTIONS }).title).toBe('tool');
    });
});

describe('optionFor', () => {
    test('is the first option of the kind the decision names', () => {
        expect(optionFor(OPTIONS, 'allow_once')).toBe('once');
        expect(optionFor(OPTIONS, 'allow_always')).toBe('always');
        expect(optionFor(OPTIONS, 'reject')).toBe('reject');
        expect(optionFor([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'b', kind: 'allow_once' }], 'allow_once')).toBe('a');
    });

    test('makes up for a missing kind with the other allow, or the other refusal', () => {
        expect(optionFor([{ optionId: 'once', kind: 'allow_once' }], 'allow_always')).toBe('once');
        expect(optionFor([{ optionId: 'always', kind: 'allow_always' }], 'allow_once')).toBe('always');
        expect(optionFor([{ optionId: 'no', kind: 'reject_always' }], 'reject')).toBe('no');
    });

    test('is nothing when the agent has no option that fits, which the agent is told as a cancel', () => {
        expect(optionFor([{ optionId: 'once', kind: 'allow_once' }], 'reject')).toBeUndefined();
        expect(optionFor([{ optionId: 'no', kind: 'reject_once' }], 'allow_once')).toBeUndefined();
        expect(optionFor([], 'allow_once')).toBeUndefined();
    });
});

describe('paramsOfV2', () => {
    test('a tool call subject is the tool call, titled by the request when the call has no title', () => {
        const params = paramsOfV2({ title: 'Run it', subject: { type: 'tool_call', toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } } }, options: OPTIONS });

        expect(params.toolCall).toMatchObject({ toolCallId: 'c1', title: 'Run it', kind: 'execute' });
        expect(classify(params).subject).toEqual({ kind: 'command', command: 'ls' });
    });

    test('a command subject is a command with its folder', () => {
        const request = classify(paramsOfV2({ title: 'Run it', subject: { type: 'command', command: 'bun test', cwd: '/work', toolCallId: 'c2' }, options: OPTIONS }));

        expect(request).toMatchObject({ toolCallId: 'c2', title: 'Run it', subject: { kind: 'command', command: 'bun test', cwd: '/work' }, key: 'command:bun test' });
    });

    test('a request with no subject, or one it does not know, is a tool with the request\'s title', () => {
        expect(classify(paramsOfV2({ title: 'Allow it?', options: OPTIONS })).subject).toEqual({ kind: 'tool_use', tool: 'Allow it?' });
        expect(classify(paramsOfV2({ title: 'Allow it?', subject: { type: '_vendor', x: 1 }, options: OPTIONS })).subject).toEqual({ kind: 'tool_use', tool: 'Allow it?' });
    });
});
