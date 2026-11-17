import { describe, expect, it } from 'vitest';

import { copyPath, initialContent, newDocumentPath } from './names';

describe('newDocumentPath', () => {
    it('adds .md, and keeps .md or .markdown that is there', () => {
        expect(newDocumentPath('plan', [])).toEqual({ path: 'plan.md' });
        expect(newDocumentPath('plan.MD', [])).toEqual({ path: 'plan.MD' });
        expect(newDocumentPath('notes.markdown', [])).toEqual({ path: 'notes.markdown' });
        expect(newDocumentPath('v1.2', [])).toEqual({ path: 'v1.2.md' });
    });

    it('turns slashes into folders and cleans up the segments', () => {
        expect(newDocumentPath('  decisions\\2026 / pricing ', [])).toEqual({ path: 'decisions/2026/pricing.md' });
        expect(newDocumentPath('/./specs//api', [])).toEqual({ path: 'specs/api.md' });
    });

    it('refuses an empty name, a way out of the folder, and characters a file name cannot hold', () => {
        expect(newDocumentPath('  ', [])).toEqual({ error: 'Enter a name for the document.' });
        expect(newDocumentPath('/', [])).toEqual({ error: 'Enter a name for the document.' });
        expect(newDocumentPath('../secret', [])).toMatchObject({ error: expect.stringContaining('..') });
        expect(newDocumentPath('what?', [])).toMatchObject({ error: expect.stringContaining('cannot contain') });
    });

    it('refuses a name that is taken, whatever its case', () => {
        expect(newDocumentPath('Plan', ['plan.md'])).toEqual({ error: 'Plan.md already exists.' });
        expect(newDocumentPath('plan', ['other.md'])).toEqual({ path: 'plan.md' });
    });
});

describe('copyPath', () => {
    it('puts "(my copy)" before the extension, in the same folder', () => {
        expect(copyPath('decisions/pricing.md', ['decisions/pricing.md'])).toBe('decisions/pricing (my copy).md');
    });

    it('numbers the copy when one exists', () => {
        const taken = ['plan.md', 'plan (my copy).md', 'PLAN (MY COPY 2).md'];

        expect(copyPath('plan.md', taken)).toBe('plan (my copy 3).md');
    });
});

describe('initialContent', () => {
    it('makes a heading from the file name', () => {
        expect(initialContent('decisions/booking-flow.md')).toBe('# Booking flow\n\n');
        expect(initialContent('README.md')).toBe('# README\n\n');
        expect(initialContent('api_notes.markdown')).toBe('# Api notes\n\n');
    });
});
