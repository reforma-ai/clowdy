import { describe, expect, it } from 'vitest';

import { openQuestion, splitQuestion } from './questionParts';

import type { StreamItem, StreamItemBody } from '@clowdy/protocol';

describe('splitQuestion', () => {
    it('takes the first paragraph as the title and keeps the rest as paragraphs', () => {
        const text =
            'Where should the file live?\n\nThe CLI runs from the project folder.\n\nMy pick: Home folder because it follows the person.';

        expect(splitQuestion(text)).toEqual({
            title: 'Where should the file live?',
            paragraphs: [
                'The CLI runs from the project folder.',
                'My pick: Home folder because it follows the person.',
            ],
        });
    });

    it('keeps the lines of a list together and ignores extra blank lines', () => {
        const text = 'Start with this plan?\n\n\n- One\n- Two\n\n  \nMy pick: Start because it is settled.\n';

        expect(splitQuestion(text).paragraphs).toEqual(['- One\n- Two', 'My pick: Start because it is settled.']);
    });

    it('treats a question without blank lines as a title', () => {
        expect(splitQuestion('Is this fine?')).toEqual({ title: 'Is this fine?', paragraphs: [] });
    });
});

describe('openQuestion', () => {
    const at = (seq: number, body: StreamItemBody): StreamItem => ({ id: `i${seq}`, runId: 'r1', seq, at: 0, body });
    const asking = (questionId: string, fields: Partial<Extract<StreamItemBody, { kind: 'question' }>> = {}) =>
        at(Number(questionId.slice(1)), { kind: 'question', questionId, text: 'Which?', options: [], ...fields });

    it('is the question without an answer or a state', () => {
        const items = [at(0, { kind: 'user', text: 'Hi' }), asking('q1', { answer: 'A' }), asking('q2')];

        expect(openQuestion(items)?.questionId).toBe('q2');
    });

    it('skips a question that was withdrawn, expired or is being stopped', () => {
        const items = [
            asking('q1', { state: 'cancelled' }),
            asking('q2', { state: 'expired' }),
            asking('q3', { state: 'preparing' }),
        ];

        expect(openQuestion(items)).toBeUndefined();
    });

    it('is the newest when several are open', () => {
        expect(openQuestion([asking('q1'), asking('q2')])?.questionId).toBe('q2');
    });

    it('is nothing without questions', () => {
        expect(openQuestion([at(0, { kind: 'assistant', done: true, text: 'Hi' })])).toBeUndefined();
    });
});
