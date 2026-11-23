// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftOf, editDraftKey, messageOf, saveDraft } from './composerDrafts';
import { filesOf, setFiles } from './composerFiles';
import { beginEditSession, endEditSession } from './editSession';

import type { Attachment } from '@clowdy/protocol';

const form: Attachment = { id: 'a-form', name: 'form.png', mediaType: 'image/png', size: 1200 };
const notes: Attachment = { id: 'a-notes', name: 'notes.txt', mediaType: 'text/plain', size: 40 };

const key = editDraftKey('c-session', 'i-1');
const chatKey = 'c-session';

let created: string[];
let revoked: string[];

beforeEach(() => {
    created = [];
    revoked = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        created.push(`blob:preview-${created.length + 1}`);

        return created.at(-1)!;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => void revoked.push(url));
});

afterEach(() => {
    endEditSession(key);
    setFiles(chatKey, []);
    vi.restoreAllMocks();
});

describe('beginEditSession', () => {
    it('seeds the draft with the words of the message and the box with its files as uploaded cards that belong to a sent message', () => {
        beginEditSession(key, { text: 'Use the **blue** one\n\nThen the footer', attachments: [form, notes] });

        expect(messageOf(draftOf(key))).toBe('Use the **blue** one\n\nThen the footer');
        expect(
            filesOf(key).map(file => ({
                name: file.name,
                status: file.status,
                id: file.attachment?.id,
                sent: file.sent,
            }))
        ).toEqual([
            { name: 'form.png', status: 'ready', id: 'a-form', sent: true },
            { name: 'notes.txt', status: 'ready', id: 'a-notes', sent: true },
        ]);
    });

    it("touches nothing of the chat's own draft and files", () => {
        saveDraft(chatKey, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'typed below' }] }],
        });
        setFiles(chatKey, [{ key: 'k', name: 'draft.txt', mediaType: 'text/plain', size: 1, status: 'ready' }]);
        beginEditSession(key, { text: 'Hello', attachments: [notes] });

        expect(messageOf(draftOf(chatKey))).toBe('typed below');
        expect(filesOf(chatKey).map(file => file.name)).toEqual(['draft.txt']);
    });

    it('starts afresh over what an earlier session under the same key left, and lets go of its previews', () => {
        setFiles(key, [
            { key: 'old', name: 'old.png', mediaType: 'image/png', size: 1, status: 'ready', preview: 'blob:old' },
        ]);
        beginEditSession(key, { text: 'New words' });

        expect(revoked).toEqual(['blob:old']);
        expect(filesOf(key)).toEqual([]);
        expect(messageOf(draftOf(key))).toBe('New words');
    });

    it('gives the pictures a preview once the daemon has sent the bytes, and the others none', async () => {
        const blobs = vi.fn(async () => new Blob(['x']));

        beginEditSession(key, { text: 'Hello', attachments: [form, notes] }, blobs);
        await vi.waitFor(() =>
            expect(filesOf(key).find(file => file.name === 'form.png')?.preview).toBe('blob:preview-1')
        );

        expect(blobs).toHaveBeenCalledExactlyOnceWith(form);
        expect(filesOf(key).find(file => file.name === 'notes.txt')?.preview).toBeUndefined();
    });

    it('makes no preview, so leaves none to let go of, for a card that is gone or a session that ended before the bytes came', async () => {
        let arrive!: (blob: Blob) => void;
        const blobs = vi.fn(
            () =>
                new Promise<Blob>(resolve => {
                    arrive = resolve;
                })
        );

        beginEditSession(key, { text: 'Hello', attachments: [form] }, blobs);
        endEditSession(key);
        arrive(new Blob(['x']));
        await Promise.resolve();
        await Promise.resolve();

        expect(created).toEqual([]);
        expect(filesOf(key)).toEqual([]);
    });

    it('shows a picture without a preview when its bytes cannot be had', async () => {
        const blobs = vi.fn(async () => {
            throw new Error('No such attachment');
        });

        beginEditSession(key, { text: 'Hello', attachments: [form] }, blobs);
        await Promise.resolve();
        await Promise.resolve();

        expect(filesOf(key).map(file => file.preview)).toEqual([undefined]);
    });
});

describe('endEditSession', () => {
    it('forgets the draft and the files and lets go of the previews', async () => {
        beginEditSession(key, { text: 'Hello', attachments: [form] }, async () => new Blob(['x']));
        await vi.waitFor(() => expect(filesOf(key)[0].preview).toBe('blob:preview-1'));

        endEditSession(key);

        expect(messageOf(draftOf(key))).toBe('');
        expect(filesOf(key)).toEqual([]);
        expect(revoked).toEqual(['blob:preview-1']);
    });

    it('offers only what the session uploaded and never sent, never the files of the message, which it still has', () => {
        const uploaded: Attachment = { id: 'a-new', name: 'new.txt', mediaType: 'text/plain', size: 3 };
        const discard = vi.fn();

        beginEditSession(key, { text: 'Hello', attachments: [form] });
        setFiles(key, [
            ...filesOf(key),
            { key: 'k-new', name: 'new.txt', mediaType: 'text/plain', size: 3, status: 'ready', attachment: uploaded },
            { key: 'k-failed', name: 'bad.txt', mediaType: 'text/plain', size: 3, status: 'error' },
        ]);
        endEditSession(key, discard);

        expect(discard).toHaveBeenCalledExactlyOnceWith(uploaded);
    });

    it('offers nothing when no one asked, as after an edit that went through, whose files the daemon keeps', () => {
        beginEditSession(key, { text: 'Hello', attachments: [form] });
        setFiles(key, [
            ...filesOf(key),
            {
                key: 'k-new',
                name: 'new.txt',
                mediaType: 'text/plain',
                size: 3,
                status: 'ready',
                attachment: { id: 'a-new', name: 'new.txt', mediaType: 'text/plain', size: 3 },
            },
        ]);

        expect(() => endEditSession(key)).not.toThrow();
        expect(filesOf(key)).toEqual([]);
    });

    it('is harmless to end a session twice', () => {
        beginEditSession(key, { text: 'Hello', attachments: [notes] });
        endEditSession(key);

        expect(() => endEditSession(key)).not.toThrow();
    });
});
