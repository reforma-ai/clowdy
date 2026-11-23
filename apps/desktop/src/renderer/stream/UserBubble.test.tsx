import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../stores';
import { StreamLinksContext } from './StreamLinks';
import { UserBubble } from './UserBubble';

// A file chip knows the project's folders, so the message is drawn inside a window that has a project selected.
let store: RootStore;

beforeAll(async () => {
    store = new RootStore(new FixtureTransport());
    await store.load();
});

afterAll(() => store.dispose());

const links = {
    taskOfKey: (key: string) => (key === 'CAR-24' ? { id: 't-24', key, title: 'Rebuild the form' } : undefined),
};
const bubble = (text: string) =>
    renderToStaticMarkup(
        <RootStoreProvider value={store}>
            <StreamLinksContext value={links}>
                <UserBubble text={text} at={0} />
            </StreamLinksContext>
        </RootStoreProvider>
    );

describe('UserBubble', () => {
    it("keeps the line breaks of a message the daemon wrote in the person's name", () => {
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

    it('shows the files of a message above its text, and no bubble for a message of files alone', () => {
        const files = [
            { id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 2048 },
            { id: 'a-2', name: 'error.log', mediaType: 'text/plain', size: 10 },
        ];
        const withText = renderToStaticMarkup(<UserBubble text="See these" attachments={files} at={0} />);
        const alone = renderToStaticMarkup(<UserBubble text="" attachments={files} at={0} />);

        expect(withText).toContain('shot.png');
        expect(withText).toContain('error.log');
        expect(withText.indexOf('shot.png')).toBeLessThan(withText.indexOf('See these'));
        expect(alone).toContain('shot.png');
        expect(alone).not.toContain('data-streamdown');
    });

    it('has no time of its own: it shows one only in the row of actions it is given', () => {
        const bare = renderToStaticMarkup(<UserBubble text="Hello" at={0} turn="i-1" />);
        const withRow = renderToStaticMarkup(<UserBubble text="Hello" at={0} turn="i-1" actions={{ show: 'hover' }} />);

        expect(bare).not.toContain('<time');
        expect(bare).not.toContain('Copy message');
        expect(withRow).toContain('<time');
        expect(withRow).toContain('Copy message');
        // The turn rail finds the message by this mark on the root, whatever the row below it.
        expect(withRow).toMatch(/^<div[^>]* data-turn="i-1"/);
        expect(withRow.indexOf('Hello')).toBeLessThan(withRow.indexOf('<time'));
    });
});
