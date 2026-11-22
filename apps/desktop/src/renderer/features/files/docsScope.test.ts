import { describe, expect, it } from 'vitest';

import { DOCS_ROOT, DOCS_SCOPE, isDocumentPath } from './docsScope';

describe('what the Docs tab draws', () => {
    it('is the folder below .clowdy/docs, and says so to a screen reader', () => {
        expect(DOCS_SCOPE.root).toBe(DOCS_ROOT);
        expect(DOCS_SCOPE.root).toBe('.clowdy/docs');
        expect(DOCS_SCOPE.label).toBe('Documents');
    });

    it('takes the folders and the Markdown files, and nothing else', () => {
        const { include } = DOCS_SCOPE;

        expect(include?.('.clowdy/docs/plans', 'directory')).toBe(true);
        expect(include?.('.clowdy/docs/a.md', 'file')).toBe(true);
        expect(include?.('.clowdy/docs/a.MARKDOWN', 'file')).toBe(true);
        expect(include?.('.clowdy/docs/x.png', 'file')).toBe(false);
        expect(include?.('.clowdy/docs/notes.mdx', 'file')).toBe(false);
    });

    it('gives a new file .md unless the name already has a Markdown extension', () => {
        const { fileName } = DOCS_SCOPE;

        expect(fileName?.('idea')).toBe('idea.md');
        expect(fileName?.('idea.md')).toBe('idea.md');
        expect(fileName?.('Plan.Markdown')).toBe('Plan.Markdown');
        expect(fileName?.('data.json')).toBe('data.json.md');
    });

    it('knows a document by its path: Markdown below the docs folder', () => {
        expect(isDocumentPath('.clowdy/docs/decisions/pricing.md')).toBe(true);
        expect(isDocumentPath('.clowdy/docs/x.png')).toBe(false);
        expect(isDocumentPath('docs/pricing.md')).toBe(false);
        expect(isDocumentPath('.clowdy/docsfoo/a.md')).toBe(false);
    });
});
