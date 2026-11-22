import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../stores';
import { Markdown } from './Markdown';
import { StreamLinksContext, type StreamLinks } from './StreamLinks';

// A file chip knows the project's folders, so the text is drawn inside a window that has a project selected.
let store: RootStore;

beforeAll(async () => {
    store = new RootStore(new FixtureTransport());
    await store.load();
});

afterAll(() => store.dispose());

const html = (text: string, links: StreamLinks = {}, props: { streaming?: boolean; fromPerson?: boolean } = {}) => renderToStaticMarkup(
    <RootStoreProvider value={ store }><StreamLinksContext value={ links }><Markdown text={ text } { ...props } /></StreamLinksContext></RootStoreProvider>
);

describe('Markdown', () => {
    it('renders emphasis, lists and links as elements', () => {
        const out = html('**Plan** with a [link](https://example.com).\n\n1. first\n2. second\n\n- a\n- b');

        expect(out).toContain('data-streamdown="strong"');
        expect(out).toContain('href="https://example.com/"');
        expect(out).toContain('data-streamdown="ordered-list"');
        expect(out).toContain('data-streamdown="unordered-list"');
        expect(out.match(/data-streamdown="list-item"/g)).toHaveLength(4);
    });

    it('renders a table in a scrolling wrapper', () => {
        const out = html('| a | b |\n|---|---|\n| 1 | 2 |');

        expect(out).toContain('data-streamdown="table-wrapper"');
        expect(out).toContain('data-streamdown="table-header-cell"');
        expect(out).toContain('data-streamdown="table-cell"');
    });

    it('does not run raw HTML', () => {
        const out = html('Hello <img src=x onerror=alert(1)> and\n\n<script>alert(1)</script>');

        expect(out).not.toContain('<script');
        expect(out).not.toContain('onerror');
    });

    it('does not link an unsafe protocol', () => {
        const out = html('[click](javascript:alert(1))');

        expect(out).not.toContain('javascript:');
        expect(out).toContain('click');
    });

    it('links what the app opens in the browser, https, and leaves the rest as text', () => {
        const out = html('[docs](https://example.com/a), [plain](http://example.com/b) and [mail](mailto:a@b.co)');

        expect(out).toContain('href="https://example.com/a"');
        expect(out).not.toContain('href="http://');
        expect(out).not.toContain('mailto:');
        expect(out).toContain('plain');
        expect(out).toContain('mail');
    });

    it('does not make a link of one that is still arriving', () => {
        const out = html('See [the plan](https://exa', {}, { streaming: true });

        expect(out).not.toContain('href=');
        expect(out.replace(/<[^>]*>/g, '')).toContain('See the plan');
    });

    it('shows an image given as data, and drops one with a script for a source', () => {
        const out = html('![chart](data:image/png;base64,iVBORw0KGgo=) ![bad](javascript:alert(1))');

        expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
        expect(out).not.toContain('javascript:');
    });

    it('keeps the formatting HTML of an agent as elements', () => {
        const out = html('Use <b>bold</b> and <script>alert(1)</script>');

        expect(out).toContain('<b>bold</b>');
        expect(out).not.toContain('<script');
    });

    it('keeps a fenced block with a language as code', () => {
        const out = html('```ts\nconst a = 1;\n```');

        expect(out).toContain('data-streamdown="code-block"');
        expect(out).not.toContain('data-streamdown="code-block-header"');
    });

    describe('chips', () => {
        const links: StreamLinks = { taskOfKey: key => (key === 'CAR-24' ? { id: 't-24', key, title: 'Rebuild the form' } : undefined) };

        it('draws a path in code as a file chip with the whole path on hover', () => {
            const out = html('Edit `src/booking/price.ts` next.');

            expect(out).toContain('data-streamdown="inline-code-chip"');
            expect(out).toContain('>price.ts<');
            expect(out).toContain('title="src/booking/price.ts"');
        });

        it('draws a task of the project as a task chip, and any other key as code', () => {
            expect(html('See `CAR-24`.', links)).toContain('title="Rebuild the form"');
            expect(html('See `CAR-99`.', links)).toContain('data-streamdown="inline-code"');
            expect(html('See `CAR-24`.')).toContain('data-streamdown="inline-code"');
        });

        it('leaves code that is not a path as code', () => {
            const out = html('Run `bun test` and read `*.ts` or `/`.');

            expect(out).not.toContain('inline-code-chip');
            expect(out.match(/data-streamdown="inline-code"/g)).toHaveLength(3);
        });

        it('puts the file chip over a fenced block that names its file, with the lines it cites', () => {
            const out = html('```12:20:src/booking/price.ts\nconst a = 1;\n```');

            expect(out).toContain('data-streamdown="code-block-header"');
            expect(out).toContain('price.ts (12-20)');
        });
    });

    describe('a person\'s text', () => {
        it('keeps raw HTML as characters and single line breaks as they are', () => {
            const out = html('first\nsecond <b>x</b>', {}, { fromPerson: true });

            expect(out).not.toContain('<b>');
            expect(out).toContain('&lt;b&gt;');
            expect(out).toContain('first\nsecond');
        });
    });

    it('closes Markdown that is still arriving', () => {
        expect(html('Half **bold', {}, { streaming: true })).toContain('data-streamdown="strong"');
    });
});
