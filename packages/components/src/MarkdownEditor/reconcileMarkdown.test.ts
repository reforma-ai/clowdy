import { describe, expect, it, vi } from 'vitest';

import { RECONCILE_MAX_LENGTH, reconcileMarkdown } from './reconcileMarkdown';

const source = '* one\n* two\n\nSome _text_ here.\n';
const baseCanonical = '- one\n- two\n\nSome *text* here.';
const edited = '- one\n- two\n\nSome *text* there.';

describe('reconcileMarkdown', () => {
    it('should patch the edit into the source when the result parses back to the edit', () => {
        expect(reconcileMarkdown({ source, baseCanonical, edited, roundTrip: () => edited }))
            .toBe('* one\n* two\n\nSome _text_ there.\n');
    });

    it('should return the canonical edit when the patched source parses to another document', () => {
        expect(reconcileMarkdown({ source, baseCanonical, edited, roundTrip: () => 'something else' })).toBe(edited);
        expect(reconcileMarkdown({ source, baseCanonical, edited, roundTrip: () => null })).toBe(edited);
    });

    it('should return the canonical edit without diffing a document over the size cap', () => {
        const roundTrip = vi.fn(() => edited);
        const filler = 'Filler paragraph.\n\n'.repeat(RECONCILE_MAX_LENGTH / 10);

        expect(reconcileMarkdown({ source: filler + source, baseCanonical: filler + baseCanonical, edited: filler + edited, roundTrip }))
            .toBe(filler + edited);
        expect(roundTrip).not.toHaveBeenCalled();
    });

    it('should keep blank lines at the end of the source', () => {
        expect(reconcileMarkdown({
            source: 'Some _text_ here.\n\n\n',
            baseCanonical: 'Some *text* here.',
            edited: 'Some *text* here!',
            roundTrip: () => 'Some *text* here!',
        })).toBe('Some _text_ here!\n\n\n');
    });

    it('should land an edit after blank lines that the editor shows as an empty last paragraph', () => {
        const edited = '- one\n\nSome *text*\n\nmore';

        expect(reconcileMarkdown({ source: '* one\n\nSome _text_\n\n\n', baseCanonical: '- one\n\nSome *text*\n\n', edited, roundTrip: () => edited }))
            .toBe('* one\n\nSome _text_\n\nmore\n');
    });

    it('should patch an edit after non-ASCII text where it was made', () => {
        const prose = 'Привет, мир 😀 '.repeat(100);
        const edited = `- one\n\n${ prose }\n\nSome *text* there.`;

        expect(reconcileMarkdown({
            source: `* one\n\n${ prose }\n\nSome _text_ here.\n`,
            baseCanonical: `- one\n\n${ prose }\n\nSome *text* here.`,
            edited,
            roundTrip: () => edited,
        })).toBe(`* one\n\n${ prose }\n\nSome _text_ there.\n`);
    });
});
