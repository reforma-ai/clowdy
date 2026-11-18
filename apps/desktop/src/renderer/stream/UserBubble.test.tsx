import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StreamLinksContext } from './StreamLinks';
import { UserBubble } from './UserBubble';

const links = { taskOfKey: (key: string) => (key === 'CAR-24' ? { id: 't-24', key, title: 'Rebuild the form' } : undefined) };
const bubble = (text: string) => renderToStaticMarkup(<StreamLinksContext value={ links }><UserBubble text={ text } at={ 0 } /></StreamLinksContext>);

describe('UserBubble', () => {
    it('keeps the line breaks of a message the daemon wrote in the person\'s name', () => {
        const out = bubble('Complete task CAR-1: Fix it\n\nDescription:\nfirst\nsecond');

        expect(out).toContain('Description:\nfirst\nsecond');
        expect(out).toContain('Complete task CAR-1: Fix it');
    });

    it('renders what the message box wrote as Markdown', () => {
        expect(bubble('Make the **title** bigger')).toContain('data-streamdown="strong"');
    });

    it('shows a mentioned file as a chip, and does not read its name as emphasis', () => {
        const out = bubble('Check @pkg/__init__.py and @src/__tests__/a.ts');

        expect(out).toContain('title="pkg/__init__.py"');
        expect(out).toContain('title="src/__tests__/a.ts"');
        expect(out).not.toContain('data-streamdown="strong"');
        expect(out).not.toContain('data-streamdown="em"');
    });

    it('shows a task of the project as a chip, and any other key as text', () => {
        const out = bubble('Do CAR-24 then CAR-99');

        expect(out).toContain('title="Rebuild the form"');
        expect(out).toContain('CAR-99');
        expect(out).not.toContain('>CAR-99</button>');
    });
});
