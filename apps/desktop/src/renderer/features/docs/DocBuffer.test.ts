import { describe, expect, it } from 'vitest';

import { DocBuffer } from './DocBuffer';

const hashOf = (content: string) => `h(${ content })`;
const version = (content: string) => ({ content, hash: hashOf(content) });

function openBuffer(content = 'one\n'): DocBuffer {
    const buffer = new DocBuffer('plan.md');

    buffer.loaded({ path: 'plan.md', ...version(content) });

    return buffer;
}

describe('DocBuffer', () => {
    describe('dirty state', () => {
        it('starts clean once loaded, and is dirty exactly while the text differs from what was loaded', () => {
            const buffer = openBuffer();

            expect([buffer.edited, buffer.dirty]).toEqual([false, false]);

            buffer.edit('one\ntwo\n');
            expect([buffer.edited, buffer.dirty]).toEqual([true, true]);

            buffer.edit('one\n');
            expect([buffer.edited, buffer.dirty]).toEqual([false, false]);
        });

        it('takes no edits before the file has loaded', () => {
            const buffer = new DocBuffer('plan.md');

            buffer.edit('typed too early');
            expect(buffer.text).toBe('');
            expect(buffer.edited).toBe(false);
        });

        it('is clean after a save, and stays dirty for what was typed while the save was under way', () => {
            const buffer = openBuffer();

            buffer.edit('saved text');

            const { content, baseHash } = buffer.startSave();

            expect([content, baseHash, buffer.saving]).toEqual(['saved text', hashOf('one\n'), true]);

            buffer.edit('saved text, and more');
            buffer.finishSave(content, hashOf(content));
            expect(buffer).toMatchObject({ saving: false, text: 'saved text, and more', savedText: 'saved text', baseHash: hashOf('saved text'), edited: true });
        });

        it('keeps the text and says why when a save fails', () => {
            const buffer = openBuffer();

            buffer.edit('mine');
            buffer.startSave();
            buffer.failSave('The daemon cannot be reached');
            expect(buffer).toMatchObject({ saving: false, saveError: 'The daemon cannot be reached', text: 'mine', edited: true });

            buffer.startSave();
            expect(buffer.saveError).toBe('');
        });
    });

    describe('a different version on disk', () => {
        it('replaces clean text silently', () => {
            const buffer = openBuffer('one\n');

            buffer.observe(version('one\nby an agent\n'));
            expect(buffer).toMatchObject({ text: 'one\nby an agent\n', baseHash: hashOf('one\nby an agent\n'), conflict: null, edited: false });
        });

        it('keeps edited text and records a conflict', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('one\nmine\n');
            buffer.observe(version('one\ntheirs\n'));
            expect(buffer).toMatchObject({ text: 'one\nmine\n', conflict: version('one\ntheirs\n'), baseHash: hashOf('one\n'), edited: true });
        });

        it('is no conflict when the disk already holds the edited text', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('same');
            buffer.observe(version('same'));
            expect(buffer).toMatchObject({ conflict: null, edited: false, baseHash: hashOf('same') });
        });

        it('is no change, only a new hash, when the disk holds the version the text started from', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.observe({ content: 'one\n', hash: 'another-hash-of-the-same-text' });
            expect(buffer).toMatchObject({ text: 'mine', conflict: null, edited: true, baseHash: 'another-hash-of-the-same-text' });
        });

        it('follows a conflict to the newest disk version, and ends it when the disk goes back to the base', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.observe(version('theirs 1'));
            buffer.observe(version('theirs 2'));
            expect(buffer.conflict).toEqual(version('theirs 2'));

            buffer.observe(version('one\n'));
            expect(buffer).toMatchObject({ conflict: null, text: 'mine', edited: true });
        });

        it('is ignored while the file has not loaded', () => {
            const buffer = new DocBuffer('plan.md');

            buffer.observe(version('x'));
            expect(buffer).toMatchObject({ status: 'loading', text: '', conflict: null });
        });
    });

    describe('conflict resolution', () => {
        it('takes their version: the edits are dropped and the disk version is the new base', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.observe(version('theirs'));
            buffer.takeTheirs(version('theirs'));
            expect(buffer).toMatchObject({ text: 'theirs', savedText: 'theirs', baseHash: hashOf('theirs'), conflict: null, edited: false });
        });

        it('takes only the version the person was shown', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.observe(version('theirs 1'));

            const shown = version('theirs 1');

            buffer.observe(version('theirs 2'));
            buffer.takeTheirs(shown);
            expect(buffer).toMatchObject({ text: 'mine', conflict: version('theirs 2') });
        });

        it('ends the conflict when keeping mine is saved over the disk version', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.observe(version('theirs'));
            buffer.finishSave('mine', hashOf('mine'));
            expect(buffer).toMatchObject({ conflict: null, edited: false, baseHash: hashOf('mine') });
        });

        it('turns a save that met another version into a conflict, and one that met the same text into a save', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.startSave();
            buffer.conflictedSave(version('theirs'));
            expect(buffer).toMatchObject({ saving: false, conflict: version('theirs'), text: 'mine' });

            const same = openBuffer('one\n');

            same.edit('same');
            same.startSave();
            same.conflictedSave(version('same'));
            expect(same).toMatchObject({ saving: false, conflict: null, edited: false });
        });
    });

    describe('a file that is removed', () => {
        it('keeps the text, is dirty, and no longer has a base', () => {
            const buffer = openBuffer('one\n');

            buffer.observe(null);
            expect(buffer).toMatchObject({ removed: true, baseHash: null, text: 'one\n', edited: false, dirty: true });

            buffer.edit('one\nmore');
            buffer.observe(null);
            expect(buffer).toMatchObject({ removed: true, text: 'one\nmore', edited: true });
        });

        it('forgets a conflict that has no file any more', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.observe(version('theirs'));
            buffer.observe(null);
            expect(buffer).toMatchObject({ conflict: null, removed: true, text: 'mine' });
        });

        it('is saved as a new file: the save has no base hash, and then the buffer is clean again', () => {
            const buffer = openBuffer('one\n');

            buffer.observe(null);

            const { content, baseHash } = buffer.startSave();

            expect(baseHash).toBeNull();
            buffer.finishSave(content, hashOf(content));
            expect(buffer).toMatchObject({ removed: false, dirty: false, baseHash: hashOf('one\n') });
        });

        it('takes the file back when it returns as it was, and keeps the edits', () => {
            const buffer = openBuffer('one\n');

            buffer.edit('mine');
            buffer.observe(null);
            buffer.observe(version('one\n'));
            expect(buffer).toMatchObject({ removed: false, conflict: null, text: 'mine', edited: true, baseHash: hashOf('one\n') });
        });

        it('conflicts with a file that returns changed when there are edits, and takes it silently when there are none', () => {
            const edited = openBuffer('one\n');

            edited.edit('mine');
            edited.observe(null);
            edited.observe(version('rewritten'));
            expect(edited).toMatchObject({ removed: true, conflict: version('rewritten'), text: 'mine' });

            const clean = openBuffer('one\n');

            clean.observe(null);
            clean.observe(version('rewritten'));
            expect(clean).toMatchObject({ removed: false, conflict: null, text: 'rewritten' });
        });
    });
});
