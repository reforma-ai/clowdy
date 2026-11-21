import { describe, expect, test } from 'bun:test';

import { conversationRecord } from '../src/runs/history';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';

const stream = (...bodies: StreamItemBody[]): StreamItem[] => bodies.map((body, index) => ({ id: `itm_${ index }`, runId: 'run_1', seq: index + 1, at: index, body }));
const person = (text: string): StreamItemBody => ({ kind: 'user', text });
const agent = (text: string): StreamItemBody => ({ kind: 'assistant', text, done: true });
const inside = (record: string | undefined) => record!.split('<earlier_conversation>\n')[1]!.split('\n</earlier_conversation>')[0]!;

describe('conversationRecord', () => {
    test('tells the conversation in order: the person, the agent, its tools and the notes', () => {
        const record = conversationRecord(stream(
            person('Add a footer'),
            agent('I will look at the layout first.'),
            { kind: 'tool', toolCallId: 't1', name: 'Read', input: { path: 'src/App.tsx' }, state: 'done', output: 'export function App() {}' },
            { kind: 'tool', toolCallId: 't2', name: 'task_create', input: { title: 'x' }, state: 'error', error: 'no slot' },
            { kind: 'note', text: 'Background command finished: bun test' },
            { kind: 'question', questionId: 'q1', text: 'Which colour?', options: [], answer: 'Blue' },
            { kind: 'error', text: 'The agent stopped' }
        ), []);

        expect(inside(record)).toBe([
            'Person: Add a footer',
            'You: I will look at the layout first.',
            'Tool Read (done): {"path":"src/App.tsx"} → export function App() {}',
            'Tool task_create (error): {"title":"x"} → failed: no slot',
            'Clowdy: Background command finished: bun test',
            'You asked the person: Which colour? They answered: Blue',
            'Error: The agent stopped',
        ].join('\n'));
        expect(record).toContain('could not be opened again');
    });

    test('leaves out what the agent thought: it is no part of the story it is told again', () => {
        const record = conversationRecord(stream(person('Add a footer'), { kind: 'reasoning', text: 'The layout is in App.tsx.', done: true, durationMs: 2000 }, agent('Done.')), []);

        expect(inside(record)).toBe('Person: Add a footer\nYou: Done.');
    });

    test('names the files of a message and keeps a message that is only files', () => {
        const record = conversationRecord(stream({ kind: 'user', text: '', attachments: [{ id: 'att_1', name: 'spec.pdf', mediaType: 'application/pdf', size: 10 }] }, agent('Read it.')), []);

        expect(inside(record)).toBe('Person: [files: spec.pdf]\nYou: Read it.');
    });

    test('leaves out the last messages of the person that this turn sends anyway, and only those', () => {
        const items = stream(person('Add a footer'), agent('Done.'), person('And the header?'), person('Also dark mode'));

        expect(inside(conversationRecord(items, ['And the header?', 'Also dark mode']))).toBe('Person: Add a footer\nYou: Done.');
        expect(inside(conversationRecord(items, ['Follow clowdy:orchestrate. Mode: autopilot\n\nAlso dark mode']))).toBe('Person: Add a footer\nYou: Done.\nPerson: And the header?');
        // A message sent earlier that the prompt happens to repeat stays: only the trailing run is the news.
        expect(inside(conversationRecord(stream(person('Add a footer'), agent('Done.')), ['Add a footer']))).toBe('Person: Add a footer\nYou: Done.');
    });

    test('has nothing to tell for a stream with only the message that is being sent, or with nothing', () => {
        expect(conversationRecord(stream(person('Add a footer')), ['Add a footer'])).toBeUndefined();
        expect(conversationRecord([], ['x'])).toBeUndefined();
        expect(conversationRecord(stream(agent('   ')), [])).toBeUndefined();
    });

    test('shortens a long message to its start and its end, and a tool to a line', () => {
        const long = `${ 'a'.repeat(3000) }${ 'z'.repeat(3000) }`;
        const record = inside(conversationRecord(stream(
            person(long),
            { kind: 'tool', toolCallId: 't1', name: 'Bash', input: { command: 'echo '.repeat(100) }, state: 'done', output: 'x\n'.repeat(500) }
        ), []));
        const [first, second] = record.split('\nTool ');

        expect(first!.length).toBeLessThan(3400);
        expect(first).toContain('[…]');
        expect(first!.endsWith('z'.repeat(800))).toBe(true);
        expect(second!.length).toBeLessThan(500);
        expect(second).toContain('…');
        expect(second).not.toContain('\n');
    });

    test('keeps the first entries and the newest ones of a conversation over the budget, and says how many are left out', () => {
        const bodies: StreamItemBody[] = [person('Build the booking page')];

        for (let n = 1; n <= 60; n++) {
            bodies.push(agent(`${ n } ${ 'w'.repeat(1500) }`));
        }

        const record = inside(conversationRecord(stream(...bodies), []));
        const lines = record.split('\n');

        expect(lines[0]).toBe('Person: Build the booking page');
        expect(lines[1]).toMatch(/^You: 1 w+$/);
        expect(lines[2]).toMatch(/^\[\d+ entries in between are left out\]$/);
        expect(lines.at(-1)).toMatch(/^You: 60 w+$/);
        expect(record.length).toBeLessThan(45_000);

        const left = Number(/^\[(\d+) entries/.exec(lines[2]!)![1]);

        // Every entry is either shown or counted.
        expect(lines.length - 1 + left).toBe(61);
    });
});
