import { describe, expect, it } from 'vitest';

import { splitQuestion } from './questionParts';

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
