import { docToPlainText, emptyComposerDoc, plainTextToDoc } from '@clowdy/components/RichInput';
import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';

import { NewChatDrafts } from './NewChatDrafts';

import type { KeyValueStorage } from './storage';

function memory(): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}
const text = (value: string) => plainTextToDoc(value);

describe('NewChatDrafts', () => {
    it('keeps documents for separate places and reopens a target', () => {
        const drafts = new NewChatDrafts('p', memory());
        const first = drafts.createOrOpen('folder', null);
        const second = drafts.createOrOpen('folder', { mode: 'new', base: 'main' });
        drafts.updateDoc(first.id, text('First'));
        drafts.updateDoc(second.id, text('Second'));
        expect([drafts.createOrOpen('folder', null).id, drafts.get(first.id)?.doc, drafts.get(second.id)?.doc]).toEqual(
            [first.id, text('First'), text('Second')]
        );
        expect(first.id).not.toBe(second.id);
    });
    it('moves to an occupied place without replacing either document', () => {
        const drafts = new NewChatDrafts('p', memory());
        const first = drafts.createOrOpen('a', null);
        const second = drafts.createOrOpen('b', null);
        drafts.updateDoc(first.id, text('First'));
        drafts.updateDoc(second.id, text('Second'));
        drafts.updatePlace(first.id, 'b', null);
        expect(drafts.drafts).toEqual([
            { id: first.id, folderId: 'b', workspace: null, doc: text('First') },
            { id: second.id, folderId: 'b', workspace: null, doc: text('Second') },
        ]);
    });
    it('removes only the selected draft', () => {
        const drafts = new NewChatDrafts('p', memory());
        const first = drafts.createOrOpen('a', null);
        const second = drafts.createOrOpen('b', null);
        drafts.updateDoc(second.id, text('Keep'));
        drafts.remove(first.id);
        expect([drafts.get(first.id), drafts.get(second.id)?.doc]).toEqual([undefined, text('Keep')]);
    });
    it('restores nonempty documents by project and drops empty drafts', () => {
        const storage = memory();
        const drafts = new NewChatDrafts('p', storage);
        const first = drafts.createOrOpen('a', { mode: 'new', branchName: 'feature' });
        drafts.updateDoc(first.id, text('Saved'));
        drafts.createOrOpen('b', null);
        expect([new NewChatDrafts('p', storage).drafts, new NewChatDrafts('other', storage).drafts]).toEqual([
            [{ id: first.id, folderId: 'a', workspace: { mode: 'new', branchName: 'feature' }, doc: text('Saved') }],
            [],
        ]);
        drafts.updateDoc(first.id, emptyComposerDoc());
        expect(new NewChatDrafts('p', storage).drafts).toEqual([]);
    });
    it('does not persist formatting without content', () => {
        const storage = memory();
        const drafts = new NewChatDrafts('p', storage);
        const list = drafts.createOrOpen('a', null);
        const marked = drafts.createOrOpen('b', null);
        drafts.updateDoc(list.id, {
            type: 'doc',
            content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }],
        });
        drafts.updateDoc(marked.id, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '  ', marks: [{ type: 'bold' }] }] }],
        });
        expect(new NewChatDrafts('p', storage).drafts).toEqual([]);
    });
    it('compares Windows paths and other workspace choices by value', () => {
        const drafts = new NewChatDrafts('p', memory());
        const first = drafts.createOrOpen('a', { mode: 'existing', path: 'C:\\Work\\Tree\\' });
        const next = drafts.createOrOpen('a', { mode: 'new', base: 'main', branchPrefix: 'x' });
        expect(drafts.createOrOpen('a', { mode: 'existing', path: 'c:/work/tree' }).id).toBe(first.id);
        expect(drafts.createOrOpen('a', { branchPrefix: 'x', base: 'main', mode: 'new' }).id).toBe(next.id);
        expect(drafts.createOrOpen('a', { mode: 'new', base: 'main', branchPrefix: 'y' }).id).not.toBe(next.id);
    });
    it('ignores malformed storage and continues after storage failures', () => {
        const storage = memory();
        storage.data.set(
            'new-chat-drafts:p',
            JSON.stringify([{ id: 'bad', folderId: null, workspace: null, doc: { type: 'doc', content: [null] } }])
        );
        expect(new NewChatDrafts('p', storage).drafts).toEqual([]);
        storage.data.set('new-chat-drafts:p', '{');
        expect(new NewChatDrafts('p', storage).drafts).toEqual([]);
        const blocked: KeyValueStorage = {
            getItem: () => {
                throw new Error();
            },
            setItem: () => {
                throw new Error();
            },
        };
        const drafts = new NewChatDrafts('p', blocked);
        const draft = drafts.createOrOpen(null, null);
        drafts.updateDoc(draft.id, text('Still here'));
        expect(docToPlainText(drafts.get(draft.id)!.doc)).toBe('Still here');
    });
    it('notifies observers about creation, edits, moves and removal', () => {
        const drafts = new NewChatDrafts('p', memory());
        const seen: string[] = [];
        const stop = autorun(() =>
            seen.push(drafts.drafts.map(d => `${d.folderId}:${docToPlainText(d.doc)}`).join(','))
        );
        const draft = drafts.createOrOpen('a', null);
        drafts.updateDoc(draft.id, text('Hello'));
        drafts.updatePlace(draft.id, 'b', null);
        drafts.remove(draft.id);
        stop();
        expect(seen).toEqual(['', 'a:', 'a:Hello', 'b:Hello', '']);
    });
});
