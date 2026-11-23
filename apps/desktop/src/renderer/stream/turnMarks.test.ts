import { describe, expect, it } from 'vitest';

import { turnMarks } from './turnMarks';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';

const item = (id: string, body: StreamItemBody): StreamItem => ({ id, runId: 'r', seq: 1, at: 0, body });
const user = (
    id: string,
    text: string,
    attachments?: { id: string; name: string; mediaType: string; size: number }[]
) => item(id, { kind: 'user', text, attachments });
const assistant = (id: string, text: string, done = true) => item(id, { kind: 'assistant', text, done });

describe('turnMarks', () => {
    it('makes one mark per message, with the latest reply of that turn', () => {
        const marks = turnMarks([
            user('u1', 'Fix the form'),
            assistant('a1', 'Looking.'),
            item('t1', { kind: 'tool', toolCallId: 'c', name: 'Read', input: {}, state: 'done' }),
            assistant('a2', 'The form is fixed.'),
            item('n1', { kind: 'note', text: 'Saved' }),
            user('u2', 'And the button'),
            assistant('a3', 'Done.'),
        ]);

        expect(marks).toEqual([
            { id: 'u1', title: 'Fix the form', reply: 'The form is fixed.' },
            { id: 'u2', title: 'And the button', reply: 'Done.' },
        ]);
    });

    it('keeps a reply that is still arriving, and ignores an empty one after it', () => {
        const marks = turnMarks([user('u1', 'Go'), assistant('a1', 'Hel', false), assistant('a2', '   ')]);

        expect(marks).toEqual([{ id: 'u1', title: 'Go', reply: 'Hel' }]);
    });

    it('names a message of only files by those files', () => {
        const marks = turnMarks([
            user('u1', '  ', [
                { id: 'f1', name: 'shot.png', mediaType: 'image/png', size: 4 },
                { id: 'f2', name: 'log.txt', mediaType: 'text/plain', size: 2 },
            ]),
        ]);

        expect(marks[0]?.title).toBe('shot.png, log.txt');
        expect(marks[0]?.reply).toBe('');
    });

    it('shows the words of a message, not its markdown marks', () => {
        const marks = turnMarks([
            user('u1', 'See [the form](https://example.com) and `src/a.ts`'),
            assistant('a1', '## Done\n\n```ts\nconst x = 1\n```\n**Shipped** it.'),
        ]);

        expect(marks[0]).toEqual({
            id: 'u1',
            title: 'See the form and src/a.ts',
            reply: 'Done Shipped it.',
        });
    });

    it('ignores whatever came before the first message', () => {
        const marks = turnMarks([
            assistant('a0', 'Hello'),
            item('e1', { kind: 'error', text: 'Nope' }),
            user('u1', 'Now'),
        ]);

        expect(marks).toEqual([{ id: 'u1', title: 'Now', reply: '' }]);
    });
});
