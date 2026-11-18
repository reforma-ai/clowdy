import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { admitFiles, draftFileOf, filesOf, patchFile, restoreFiles, setFiles, takeFiles, type DraftFile } from './composerFiles';

const file = (name: string, size = 10, type = 'text/plain') => new File([new Uint8Array(size)], name, { type });
const held = (name: string, size = 10): DraftFile => ({ ...draftFileOf(file(name, size)), status: 'ready' });
/** A file that only says how big it is, so the limits can be tried without allocating that much. */
const sized = (name: string, size: number) => ({ name, size, type: '' }) as File;

describe('admitFiles', () => {
    it('takes new files and skips one that is in the box already, or twice in the batch', () => {
        const { accepted, refusals } = admitFiles([held('a.txt')], [file('a.txt'), file('b.txt'), file('b.txt')]);

        expect(accepted.map(candidate => candidate.name)).toEqual(['b.txt']);
        expect(refusals).toEqual([]);
    });

    it('refuses a file over the limit of one file, and says which', () => {
        const { accepted, refusals } = admitFiles([], [sized('big.zip', MAX_ATTACHMENT_BYTES + 1), file('ok.txt')]);

        expect(accepted.map(candidate => candidate.name)).toEqual(['ok.txt']);
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toContain('big.zip');
    });

    it('stops at the count of files one message takes', () => {
        const incoming = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, index) => file(`f${ index }.txt`));
        const { accepted, refusals } = admitFiles([], incoming);

        expect(accepted).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
        expect(refusals).toHaveLength(2);
    });

    it('stops at the bytes one message takes, counting what the box holds already', () => {
        const rest = MAX_ATTACHMENTS_BYTES_PER_MESSAGE - 3 * MAX_ATTACHMENT_BYTES;
        const three = ['a.bin', 'b.bin', 'c.bin'].map(name => ({ ...held(name), size: MAX_ATTACHMENT_BYTES }));
        const { accepted, refusals } = admitFiles(three, [sized('d.bin', rest), sized('e.bin', 1)]);

        expect(accepted.map(candidate => candidate.name)).toEqual(['d.bin']);
        expect(refusals[0]).toContain('e.bin');
    });
});

describe('the stored files of a message box', () => {
    it('hands the files over, puts them back in front of what came meanwhile, and changes only a file that is still there', () => {
        const first = held('first.txt');
        const second = held('second.txt');

        setFiles('chat-1', [first]);

        expect(takeFiles('chat-1')).toEqual([first]);
        expect(filesOf('chat-1')).toEqual([]);

        setFiles('chat-1', [second]);
        restoreFiles('chat-1', [first]);

        expect(filesOf('chat-1').map(candidate => candidate.name)).toEqual(['first.txt', 'second.txt']);
        expect(patchFile('chat-1', first.key, { status: 'error', error: 'no' })).toBe(true);
        expect(filesOf('chat-1')[0]).toMatchObject({ status: 'error', error: 'no' });
        expect(patchFile('chat-1', 'gone', { status: 'ready' })).toBe(false);
        expect(filesOf('chat-2')).toEqual([]);
    });
});
